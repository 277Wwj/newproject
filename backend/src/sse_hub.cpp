// SSE 事件中枢：负责把 TaskManager 产生的事件分发给所有订阅者，并保留历史用于回放。
#include "nexus/sse_hub.hpp" // 引入本类声明

#include <algorithm> // 需要 std::any_of / std::remove 做去重与删除

namespace nexus { // 进入项目命名空间

// 建立订阅：先回放历史事件，再把订阅者挂到广播列表上。
SseHub::SubscriberPtr SseHub::subscribe(const std::string& task_id,
                                         const std::vector<TaskEvent>& backlog) {
    auto subscriber = std::make_shared<Subscriber>(); // 用共享指针管理订阅者，广播时可直接复制指针
    // Hold the hub lock while installing the backlog and registering the
    // subscriber. A worker can publish between the task snapshot and this
    // call; this ordering guarantees that the event is either in the backlog
    // or queued by publish(), never silently dropped.
    // 中文说明：整个「装载历史 + 注册订阅者」过程都在 hub 锁内完成。
    // 否则工作线程可能在查询快照之后、注册之前发布事件，导致该事件既不在
    // backlog 里也没被 publish 送达，客户端就会永久丢失一条状态。
    std::lock_guard hub_lock(mutex_); // 先锁住中枢，冻结发布路径
    {
        std::lock_guard subscriber_lock(subscriber->mutex); // 再锁订阅者自身的队列
        for (const auto& event : backlog) { // 第 1 步：把调用方传入的 backlog（任务快照里的历史事件）装入队列
            subscriber->events.push_back(event); // 按原有顺序入队，保证客户端事件序号连续
        }
        const auto history_iterator = history_.find(task_id); // 第 2 步：再补齐中枢自己保存的最近事件
        if (history_iterator != history_.end()) { // 只有该任务出现过事件才需要补
            for (const auto& event : history_iterator->second) { // 遍历中枢历史
                const auto already_queued = std::any_of(
                    subscriber->events.begin(), subscriber->events.end(),
                    [&event](const TaskEvent& queued) { return queued.sequence == event.sequence; }); // 用序号判断是否已入队
                if (!already_queued) { // 未入队才补充，避免客户端收到重复事件
                    subscriber->events.push_back(event); // 追加到队列尾部
                }
            }
        }
    } // 释放订阅者锁
    subscribers_[task_id].push_back(subscriber); // 第 3 步：注册到广播列表，之后的 publish 能命中它
    subscriber->condition.notify_one(); // 唤醒可能已在 wait_for_event 上阻塞的写线程
    return subscriber; // 返回订阅者句柄，调用方用它取事件并在结束时退订
}

// 取一条事件：队列为空且未关闭时阻塞等待，返回 nullopt 表示流应结束。
std::optional<TaskEvent> SseHub::wait_for_event(const SubscriberPtr& subscriber) {
    std::unique_lock lock(subscriber->mutex); // 需要 unique_lock 才能配合条件变量等待
    subscriber->condition.wait(lock, [&subscriber] {
        return subscriber->closed || !subscriber->events.empty(); // 谓词：已关闭或有新事件时才被唤醒，避免虚假唤醒
    });

    if (subscriber->events.empty()) { // 被唤醒但队列仍为空，说明是关闭信号
        return std::nullopt; // 通知上层结束 SSE 循环
    }
    auto event = subscriber->events.front(); // 取出队首事件（FIFO 保证序号顺序）
    subscriber->events.pop_front(); // 出队，避免同一事件被重复发送
    return event; // 返回事件副本
}

// 广播一条事件：写入历史，并投递到该任务的所有活跃订阅者。
void SseHub::publish(const TaskEvent& event) {
    std::vector<SubscriberPtr> subscribers; // 先在锁内拷贝订阅者列表，锁外再逐个投递
    {
        std::lock_guard lock(mutex_); // 保护 history_ 与 subscribers_
        auto& history = history_[event.task_id]; // 取该任务的历史列表（不存在则创建）
        const auto in_history = std::any_of(
            history.begin(), history.end(),
            [&event](const TaskEvent& existing) { return existing.sequence == event.sequence; }); // 用序号判断是否重复发布
        if (!in_history) { // 只记录没出现过的事件
            history.push_back(event); // 保存下来供后续订阅者回放
        }
        const auto iterator = subscribers_.find(event.task_id); // 查找该任务的订阅者集合
        if (iterator != subscribers_.end()) { // 有订阅者才需要投递
            subscribers = iterator->second; // 拷贝一份指针列表，缩小持锁范围
        }
    } // 释放中枢锁，之后的投递不会阻塞其他 publish/subscribe

    for (const auto& subscriber : subscribers) { // 逐个订阅者投递
        {
            std::lock_guard lock(subscriber->mutex); // 保护该订阅者自己的队列
            if (!subscriber->closed) { // 已关闭的订阅者不再接收，避免向死连接写数据
                const auto already_queued = std::any_of(
                    subscriber->events.begin(), subscriber->events.end(),
                    [&event](const TaskEvent& queued) { return queued.sequence == event.sequence; }); // 检查是否与 backlog 重复
                if (!already_queued) { // 未重复才入队
                    subscriber->events.push_back(event); // 追加到该订阅者队列
                }
            }
        }
        subscriber->condition.notify_one(); // 唤醒该订阅者的写线程去发送
    }
}

// 退订：从广播列表移除并标记关闭，让阻塞中的写线程尽快退出。
void SseHub::unsubscribe(const std::string& task_id,
                         const SubscriberPtr& subscriber) {
    {
        std::lock_guard lock(mutex_); // 保护 subscribers_
        const auto iterator = subscribers_.find(task_id); // 查找该任务的订阅者列表
        if (iterator != subscribers_.end()) { // 列表存在才需要处理
            auto& subscribers = iterator->second; // 取引用，原地修改
            subscribers.erase(
                std::remove(subscribers.begin(), subscribers.end(), subscriber),
                subscribers.end()); // erase-remove 惯用法：先搬移再截断，真正删除该订阅者
            if (subscribers.empty()) { // 该任务已无订阅者
                subscribers_.erase(iterator); // 顺手删掉空列表，避免哈希表无限增长
            }
        }
    } // 释放中枢锁
    {
        std::lock_guard lock(subscriber->mutex); // 保护 closed 标志，避免与 publish 的检查竞争
        subscriber->closed = true; // 标记关闭，publish 之后会跳过它
    }
    subscriber->condition.notify_all(); // 唤醒所有等待者，让 wait_for_event 返回 nullopt 并结束循环
}

} // namespace nexus
