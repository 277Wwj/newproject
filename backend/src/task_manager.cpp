// 任务管理器的实现：任务状态保存在内存中，每个任务用一条独立线程驱动生命周期。
#include "nexus/task_manager.hpp" // 引入本类的声明，保证定义与声明一致

#include <chrono>   // 需要 system_clock / sleep_for 等时间工具
#include <ctime>    // 需要 time_t 与 std::tm，用于把时间格式化成 ISO-8601
#include <iomanip>  // 需要 std::put_time 控制时间输出格式
#include <random>   // 需要 std::mt19937_64 与 std::random_device 生成随机任务 ID
#include <sstream>  // 需要 std::ostringstream 拼接字符串
#include <stdexcept> // 需要 std::exception，run_task 里要捕获并转成 failed 事件
#include <utility>  // 需要 std::move 转移字符串所有权，避免多余拷贝

namespace nexus { // 进入项目命名空间
namespace { // 匿名命名空间：以下函数只在本文件可见，等价于 static 内部链接

// 生成 ISO-8601 格式的 UTC 时间戳，例如 "2026-01-29T07:23:59Z"。
// 所有事件与任务的时间字段都用它，保证前后端时间格式统一、可直接排序。
std::string now_iso8601() {
    const auto now = std::chrono::system_clock::now(); // 取当前系统时钟的原始时间点
    const auto time = std::chrono::system_clock::to_time_t(now); // 转成 C 风格的 time_t 秒数
    std::tm utc{}; // 存放拆分后的年月日时分秒，先整体清零避免残留脏值
#if defined(_WIN32)
    gmtime_s(&utc, &time); // Windows 的线程安全版本：先写结果指针，再传时间
#else
    gmtime_r(&time, &utc); // POSIX 的可重入版本，避免 gmtime 共用静态缓冲区导致多线程串数据
#endif

    std::ostringstream output; // 用输出流做格式化拼接
    output << std::put_time(&utc, "%Y-%m-%dT%H:%M:%SZ"); // 按 ISO-8601 基本式输出，末尾 Z 表示 UTC
    return output.str(); // 把流内容转成 std::string 返回
}

// 生成任务 ID：随机 64 位十六进制数加 "task-" 前缀，例如 "task-9b3ebf1ad32fb05d"。
std::string make_task_id() {
    static thread_local std::mt19937_64 generator{std::random_device{}()}; // 每线程一份随机引擎，避免共享同一引擎时的数据竞争
    std::uniform_int_distribution<std::uint64_t> distribution; // 默认范围就是 uint64 全域，冲突概率可忽略
    std::ostringstream output; // 拼接成字符串
    output << "task-" << std::hex << distribution(generator); // 以十六进制输出随机数并加前缀
    return output.str(); // 返回最终的任务 ID
}

} // namespace

// 把枚举状态转成字符串，用于 JSON 序列化和 SSE 事件内容。
std::string to_string(TaskStatus status) {
    switch (status) { // 逐个枚举分支返回对应的字面量
    case TaskStatus::queued:
        return "queued"; // 已入队，等待执行线程开始
    case TaskStatus::running:
        return "running"; // 执行线程已开始处理
    case TaskStatus::completed:
        return "completed"; // 生命周期正常结束
    case TaskStatus::failed:
        return "failed"; // 执行过程中抛出异常
    }
    return "failed"; // 兜底：枚举出现未定义值时按失败处理，避免返回空串
}

// 构造函数：接收「事件发布回调」，后续每个状态事件都会通过它推给 SseHub。
TaskManager::TaskManager(EventSink event_sink)
    : event_sink_(std::move(event_sink)) {} // 移动构造回调，避免拷贝 std::function

// 析构函数：等待所有任务线程结束，防止线程仍在使用 this 时对象被销毁。
TaskManager::~TaskManager() {
    for (auto& worker : workers_) { // 遍历所有工作线程
        if (worker.joinable()) { // 只有仍可 join 的线程才等待
            worker.join(); // 阻塞到该线程执行完 run_task
        }
    }
}

// 创建任务：写入内存记录 → 发出 queued 事件 → 启动后台线程执行生命周期。
std::string TaskManager::create_task(std::string prompt) {
    const auto id = make_task_id(); // 先生成唯一任务 ID
    const auto timestamp = now_iso8601(); // 创建时间与初始更新时间相同
    {
        std::lock_guard lock(mutex_); // 加锁保护共享的 tasks_ 容器
        TaskRecord record; // 栈上先构造完整记录，减少持锁期间的构造开销
        record.snapshot.id = id; // 任务 ID
        record.snapshot.prompt = std::move(prompt); // 转移 prompt 所有权，避免拷贝
        record.snapshot.status = TaskStatus::queued; // 初始状态为排队中
        record.snapshot.created_at = timestamp; // 记录创建时间
        record.snapshot.updated_at = timestamp; // 初始更新时间等于创建时间
        tasks_.emplace(id, std::move(record)); // 移入哈希表，任务从此对查询可见
    } // 作用域结束自动解锁

    const auto event = append_event(id, TaskStatus::queued, "Task accepted by the runtime"); // 追加第 1 条事件
    if (event && event_sink_) { // 事件存在且已注册回调时才发布
        event_sink_(*event); // 通知 SseHub 广播给订阅者
    }

    {
        std::lock_guard lock(mutex_); // 再次加锁保护 workers_ 容器
        workers_.emplace_back([this, id] { run_task(id); }); // 启动工作线程，按值捕获 id 保证生命周期安全
    }
    return id; // 返回 ID 给 HTTP 层组装 201 响应
}

// 查询单个任务快照：不存在时返回 nullopt，由 HTTP 层转成 404。
std::optional<TaskSnapshot> TaskManager::get_task(const std::string& id) const {
    std::lock_guard lock(mutex_); // 加锁读取，避免与工作线程的写入冲突
    const auto iterator = tasks_.find(id); // 在哈希表中查找任务
    if (iterator == tasks_.end()) { // 未找到说明 task_id 无效或服务已重启
        return std::nullopt; // 用空值表达「不存在」，而不是抛异常
    }
    return iterator->second.snapshot; // 返回快照副本，调用方拿到后不再受锁保护影响
}

// 查询任务的事件列表：SSE 连接建立时用它回放历史事件，避免晚订阅丢失状态。
std::optional<std::vector<TaskEvent>> TaskManager::get_events(const std::string& id) const {
    std::lock_guard lock(mutex_); // 加锁读取事件数组
    const auto iterator = tasks_.find(id); // 查找目标任务
    if (iterator == tasks_.end()) { // 任务不存在
        return std::nullopt; // 让上层返回 404
    }
    return iterator->second.snapshot.events; // 返回事件副本，上层交给 SseHub 作为 backlog
}

// 任务执行体：在工作线程中跑完 queued → running → completed 的完整生命周期。
void TaskManager::run_task(const std::string& id) {
    try {
        std::this_thread::sleep_for(std::chrono::milliseconds(250)); // 模拟排队耗时，让前端能看到 queued 阶段
        if (const auto event = append_event(id, TaskStatus::running,
                                            "Runtime started the M1 execution loop"); // 追加第 2 条事件：开始运行
            event && event_sink_) { // C++17 的 if 初始化语句，顺带判断事件是否有效
            event_sink_(*event); // 广播 running 事件
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(650)); // 模拟执行耗时，让 running 状态可被观察到
        if (const auto event = append_event(id, TaskStatus::completed,
                                            "M1 execution completed; no tools are enabled yet"); // 追加第 3 条事件：完成
            event && event_sink_) {
            event_sink_(*event); // 广播 completed 事件，前端收到后会关闭 SSE 连接
        }
    } catch (const std::exception& exception) { // 捕获任何标准异常，保证线程不会因异常直接终止进程
        if (const auto event = append_event(id, TaskStatus::failed,
                                            std::string("Runtime error: ") + exception.what()); // 把异常信息写进 failed 事件
            event && event_sink_) {
            event_sink_(*event); // 广播 failed 事件，前端据此进入失败态
        }
    }
}

// 追加一条状态事件：更新任务状态与更新时间，并让事件序号自增。
std::optional<TaskEvent> TaskManager::append_event(const std::string& id,
                                                   TaskStatus status,
                                                   std::string message) {
    std::lock_guard lock(mutex_); // 加锁，状态与事件必须原子地一起更新
    const auto iterator = tasks_.find(id); // 查找任务
    if (iterator == tasks_.end()) { // 任务已被移除或 ID 无效
        return std::nullopt; // 返回空值，调用方不会再广播
    }

    auto& snapshot = iterator->second.snapshot; // 取快照引用，直接原地修改避免拷贝
    snapshot.status = status; // 推进任务状态
    snapshot.updated_at = now_iso8601(); // 刷新更新时间

    TaskEvent event; // 构造要返回并广播的事件
    event.sequence = snapshot.events.size() + 1; // 序号从 1 开始，用当前事件数加一保证严格递增
    event.task_id = id; // 归属的任务 ID
    event.status = status; // 事件对应的状态
    event.message = std::move(message); // 转移消息字符串
    event.timestamp = snapshot.updated_at; // 与任务更新时间保持完全一致
    snapshot.events.push_back(event); // 存入历史，供后续订阅者回放
    return event; // 返回副本给调用方去广播（此时仍持锁，但发布在锁外进行）
}

} // namespace nexus
