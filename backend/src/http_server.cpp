// HTTP/SSE 服务实现：基于 Boost.Beast 同步读写，每个连接一条线程。
#include "nexus/http_server.hpp" // 引入本类声明

#include <boost/asio/write.hpp> // 需要 asio::write 直接写原始字节（SSE 用）
#include <boost/beast/core.hpp> // 需要 beast::flat_buffer 作为读取缓冲区
#include <boost/beast/http.hpp> // 需要 Beast 的 HTTP 请求/响应类型与解析器

#include <nlohmann/json.hpp> // 用于 JSON 解析与序列化

#include <algorithm>  // 需要 std::all_of，用于判断 prompt 是否全为空白
#include <cctype>     // 需要 std::isspace 做字符空白判断
#include <iostream>   // 需要 std::cout / std::cerr 输出启动信息与错误
#include <optional>   // 需要 std::optional 表达「可能不存在」的返回值
#include <sstream>    // 需要 std::ostringstream 拼装 SSE 文本与分块长度
#include <stdexcept>  // 异常类型，供 catch(const std::exception&) 使用
#include <string_view> // 需要 std::string_view 表示无需拷贝的路径前缀/后缀
#include <thread>     // 需要 std::thread 为每个连接开工作线程
#include <utility>    // 需要 std::move 转移 socket 与字符串

namespace nexus { // 进入项目命名空间
namespace { // 匿名命名空间：以下辅助函数仅本文件可见

namespace asio = boost::asio;   // 简化 Boost.Asio 命名空间写法
namespace beast = boost::beast; // 简化 Beast 命名空间写法
namespace http = beast::http;   // 简化 HTTP 消息类型写法
using tcp = asio::ip::tcp;      // TCP socket 的简写
using json = nlohmann::json;    // JSON 类型的简写

// 把一条任务事件转成 JSON 对象，是 REST 响应与 SSE data 共用的序列化入口。
json event_json(const TaskEvent& event) {
    return {
        {"sequence", event.sequence},          // 事件序号，前端用来去重与排序
        {"task_id", event.task_id},            // 所属任务
        {"status", to_string(event.status)},   // 状态字符串，枚举转文本
        {"message", event.message},            // 人类可读的事件描述
        {"timestamp", event.timestamp},        // ISO-8601 UTC 时间戳
    };
}

// 把任务快照（含完整事件历史）转成 JSON，用于 POST 响应和 GET 任务查询。
json task_json(const TaskSnapshot& task) {
    json events = json::array(); // 先建空数组，逐个填充事件
    for (const auto& event : task.events) { // 遍历该任务的全部历史事件
        events.push_back(event_json(event)); // 每条事件转 JSON 后追加
    }
    return {
        {"task_id", task.id},                    // 任务 ID
        {"prompt", task.prompt},                 // 原始提交内容
        {"status", to_string(task.status)},      // 当前状态
        {"created_at", task.created_at},         // 创建时间
        {"updated_at", task.updated_at},         // 最后更新时间
        {"events", events},                      // 事件数组，前端可直接渲染时间线
    };
}

// 构造统一格式的错误响应体：{"error": "..."}。
std::string error_json(const std::string& message) {
    return json{{"error", message}}.dump(); // 序列化成紧凑 JSON 文本
}

// 判断字符串是否为空或只含空白字符，用于拒绝无意义的 prompt。
bool is_blank(const std::string& value) {
    return value.empty() || std::all_of(value.begin(), value.end(), [](char character) {
        return std::isspace(static_cast<unsigned char>(character)) != 0; // 先转 unsigned char，避免负值传给 isspace 造成未定义行为
    });
}

// 给所有 JSON 响应统一加上内容类型与 CORS 头，兼容前端跨域直连。
template <class Body>
void add_common_headers(http::response<Body>& response) {
    response.set(http::field::content_type, "application/json; charset=utf-8"); // 明确 UTF-8，避免中文乱码
    response.set("Access-Control-Allow-Origin", "*"); // M1 开发期允许任意来源
    response.set("Access-Control-Allow-Headers", "Content-Type"); // 允许前端发送 JSON 请求头
    response.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); // 允许实际用到的三个方法
}

// 组装一个 JSON 响应：设置状态码、正文、公共头，并关闭长连接。
http::response<http::string_body> json_response(http::status status,
                                                unsigned version,
                                                const std::string& payload) {
    http::response<http::string_body> response{status, version}; // 用请求方的 HTTP 版本构造响应，保证兼容
    response.body() = payload; // 写入正文
    response.prepare_payload(); // 根据正文自动补上 Content-Length
    add_common_headers(response); // 追加统一的 JSON 与 CORS 头
    response.keep_alive(false); // 本服务一次性处理，响应后即关连接
    return response;
}

// 从路径中解析任务 ID，例如 "/api/tasks/task-abc" → "task-abc"。
std::optional<std::string> task_id_from_path(const std::string& target) {
    constexpr std::string_view prefix = "/api/tasks/"; // 任务路由的固定前缀
    if (!target.starts_with(prefix)) { // 前缀不匹配说明不是任务路由
        return std::nullopt; // 返回空值让调用方继续尝试其他规则
    }
    const auto id = target.substr(prefix.size()); // 去掉前缀，剩下的就是候选 ID
    if (id.empty() || id.find('/') != std::string::npos) { // 空 ID 或含多余斜杠都不合法
        return std::nullopt; // 例如 "/api/tasks/" 或 "/api/tasks/a/b" 都拒绝
    }
    return id; // 合法 ID
}

// 从路径中解析 SSE 订阅用的任务 ID，例如 "/api/tasks/task-abc/events" → "task-abc"。
std::optional<std::string> event_task_id_from_path(const std::string& target) {
    constexpr std::string_view prefix = "/api/tasks/"; // 任务路由前缀
    constexpr std::string_view suffix = "/events";     // SSE 子路径后缀
    if (!target.starts_with(prefix) || !target.ends_with(suffix)) { // 必须同时满足前后缀
        return std::nullopt; // 否则不是事件流路由
    }
    const auto id = target.substr(prefix.size(), target.size() - prefix.size() - suffix.size()); // 掐掉前后缀，只留中间 ID
    if (id.empty() || id.find('/') != std::string::npos) { // ID 不能为空也不能再含斜杠
        return std::nullopt; // 拒绝 "/api/tasks//events" 这类畸形路径
    }
    return id; // 合法的订阅目标 ID
}

// 把事件编码成 SSE 帧：id + event 类型 + data 载荷，末尾空行表示帧结束。
std::string sse_payload(const TaskEvent& event) {
    const auto kind = event.status == TaskStatus::completed || event.status == TaskStatus::failed
                          ? "done"   // 终态用 done，前端据此关闭连接
                          : "status"; // 中间态统一用 status
    std::ostringstream output; // 逐行拼装，SSE 规定每行一个字段
    output << "id: " << event.sequence << "\n"        // 事件 ID，浏览器可用于断线续传定位
           << "event: " << kind << "\n"                // 自定义事件名，前端 addEventListener 按名监听
           << "data: " << event_json(event).dump() << "\n\n"; // 载荷必须是单行 JSON，末尾多一个空行结束本帧
    return output.str(); // 返回完整帧文本
}

// 按 HTTP chunked 编码写一段数据：十六进制长度 + CRLF + 内容 + CRLF。
void write_sse_chunk(tcp::socket& socket, const std::string& payload) {
    std::ostringstream chunk; // 拼装分块
    chunk << std::hex << payload.size() << "\r\n" << payload << "\r\n"; // 长度用十六进制，且必须用 CRLF
    asio::write(socket, asio::buffer(chunk.str())); // 同步写入 socket
}

// 建立 SSE 长连接：先发响应头和重连间隔，再持续推送事件直到终态或客户端断开。
void write_sse_stream(tcp::socket& socket,
                      const std::string& task_id,
                      const std::vector<TaskEvent>& backlog,
                      SseHub& hub) {
    const std::string headers =
        "HTTP/1.1 200 OK\r\n"                              // SSE 必须用 200，不能用 101/206
        "Content-Type: text/event-stream; charset=utf-8\r\n" // 事件流专用 MIME 类型
        "Cache-Control: no-cache\r\n"                      // 禁止任何中间层缓存事件流
        "Connection: keep-alive\r\n"                       // 长连接，不主动关闭
        "Transfer-Encoding: chunked\r\n"                   // 长度未知，必须分块传输
        "Access-Control-Allow-Origin: *\r\n\r\n";          // CORS 头 + 空行结束响应头
    asio::write(socket, asio::buffer(headers)); // 先发响应头，客户端据此进入 EventSource 打开状态
    write_sse_chunk(socket, "retry: 1000\n\n"); // 告诉浏览器断线后 1 秒重连

    const auto subscriber = hub.subscribe(task_id, backlog); // 原子地「回放历史 + 注册订阅」，避免漏事件
    try {
        while (const auto event = hub.wait_for_event(subscriber)) { // 阻塞等待下一条事件，闭合时返回空
            write_sse_chunk(socket, sse_payload(*event)); // 立即推送给客户端
            if (event->status == TaskStatus::completed || event->status == TaskStatus::failed) { // 终态
                break; // 生命周期结束，主动收尾，避免连接挂着不释放
            }
        }
    } catch (...) {
        hub.unsubscribe(task_id, subscriber); // 写失败（例如客户端断开）也要先退订
        throw; // 再向上抛，由 handle_connection 统一记录日志
    }
    hub.unsubscribe(task_id, subscriber); // 正常结束也要退订，防止订阅者泄漏
    asio::write(socket, asio::buffer("0\r\n\r\n")); // 写零长度分块，正式结束 chunked 响应
}

} // namespace

// 构造函数：注入任务管理器与事件中枢的引用，服务本身不持有它们的所有权。
HttpServer::HttpServer(std::string host,
                       std::uint16_t port,
                       TaskManager& task_manager,
                       SseHub& sse_hub)
    : host_(std::move(host)),      // 监听地址，如 "0.0.0.0"
      port_(port),                 // 监听端口，如 8080
      task_manager_(task_manager),  // 任务管理器的引用
      sse_hub_(sse_hub) {}          // 事件中枢的引用

// 启动服务：绑定端口后进入 accept 循环，每个连接交给独立线程处理。
void HttpServer::run() {
    asio::io_context context; // Asio 的上下文，同步模式下主要用于构造 socket
    const auto address = asio::ip::make_address(host_); // 把字符串地址解析成 IP 对象，失败会抛异常
    tcp::acceptor acceptor(context, {address, port_}); // 创建监听器并立即绑定端口；端口占用会抛异常
    std::cout << "Nexus AI Lab backend listening on http://" << host_ << ':' << port_ << '\n'; // 打印启动信息，便于确认服务已就绪

    while (true) { // 无限 accept 循环，直到进程被终止
        tcp::socket socket(context); // 为下一个连接准备 socket
        acceptor.accept(socket); // 阻塞等待客户端连接
        std::thread(&HttpServer::handle_connection, this, std::move(socket)).detach(); // 交给独立线程处理并分离，主线程继续 accept
    }
}

// 处理单个连接：读请求 → 按方法和路径分发 → 写响应。
void HttpServer::handle_connection(tcp::socket socket) {
    try {
        beast::flat_buffer buffer; // 读取缓冲区，flat_buffer 是 Beast 推荐的连续内存实现
        http::request<http::string_body> request; // 请求对象，正文以 std::string 保存
        http::read(socket, buffer, request); // 同步读到完整请求为止（含头部与正文）

        const std::string target = std::string(request.target()); // 取出请求路径（不含主机）
        if (request.method() == http::verb::options) { // 预检请求：浏览器跨域时先发 OPTIONS
            auto response = json_response(http::status::no_content, request.version(), ""); // 204 表示无需正文
            http::write(socket, response); // 写回预检响应
            return; // 结束本次连接
        }

        if (request.method() == http::verb::get && target == "/api/health") { // 健康检查路由
            auto response = json_response(
                http::status::ok, request.version(),
                json{{"status", "ok"}, {"service", "nexus-server"}, {"milestone", "M1"}}.dump()); // 返回服务标识与里程碑
            http::write(socket, response); // 写回 200
            return; // 结束本次连接
        }

        if (request.method() == http::verb::post && target == "/api/tasks") { // 创建任务路由
            try {
                const auto body = json::parse(request.body()); // 解析正文；失败会抛 json::exception
                if (!body.contains("prompt") || !body.at("prompt").is_string()) { // 字段缺失或类型不对
                    auto response = json_response(http::status::bad_request, request.version(),
                                                  error_json("prompt must be a string")); // 返回 400 及明确原因
                    http::write(socket, response); // 写回错误响应
                    return; // 结束本次连接
                }
                const auto prompt = body.at("prompt").get<std::string>(); // 取值，此时已确认是字符串
                if (is_blank(prompt) || prompt.size() > 4000) { // 空白内容或超出长度上限
                    auto response = json_response(http::status::bad_request, request.version(),
                                                  error_json("prompt must contain 1-4000 non-whitespace characters")); // 返回 400
                    http::write(socket, response); // 写回错误响应
                    return; // 结束本次连接
                }
                const auto id = task_manager_.create_task(prompt); // 创建任务，返回新任务 ID
                const auto task = task_manager_.get_task(id); // 立刻回读快照，确保响应里带上完整初始状态与事件
                auto response = json_response(http::status::created, request.version(),
                                              task ? task_json(*task).dump() : error_json("task creation failed")); // 201 携带任务 JSON
                http::write(socket, response); // 写回响应
                return; // 结束本次连接
            } catch (const json::exception&) { // 正文不是合法 JSON，或字段类型转换失败
                auto response = json_response(http::status::bad_request, request.version(),
                                              error_json("request body must be valid JSON")); // 返回 400
                http::write(socket, response); // 写回错误响应
                return; // 结束本次连接
            }
        }

        if (request.method() == http::verb::get) { // GET 分支：先试 SSE，再试任务查询
            if (const auto event_task_id = event_task_id_from_path(target)) { // 命中 "/api/tasks/{id}/events"
                const auto events = task_manager_.get_events(*event_task_id); // 取历史事件作为 backlog
                if (!events) { // 任务不存在
                    auto response = json_response(http::status::not_found, request.version(),
                                                  error_json("task not found")); // 返回 404
                    http::write(socket, response); // 写回错误响应
                    return; // 结束本次连接
                }
                write_sse_stream(socket, *event_task_id, *events, sse_hub_); // 升级为 SSE 长连接，直到任务终态
                return; // 流结束后关闭连接
            }

            if (const auto task_id = task_id_from_path(target)) { // 命中 "/api/tasks/{id}"
                const auto task = task_manager_.get_task(*task_id); // 查询任务快照
                auto response = task
                                     ? json_response(http::status::ok, request.version(), task_json(*task).dump()) // 存在：200 + 任务 JSON
                                     : json_response(http::status::not_found, request.version(),
                                                     error_json("task not found")); // 不存在：404
                http::write(socket, response); // 写回响应
                return; // 结束本次连接
            }
        }

        const bool known_route = target == "/api/health" || target == "/api/tasks" ||
                                 task_id_from_path(target).has_value() ||
                                 event_task_id_from_path(target).has_value(); // 路径存在但方法不匹配
        if (known_route) { // 路由认识，只是这个 HTTP 方法不被支持
            auto response = json_response(http::status::method_not_allowed, request.version(),
                                          error_json("method not allowed")); // 返回 405，比 404 更能说明问题
            http::write(socket, response); // 写回响应
            return; // 结束本次连接
        }

        auto response = json_response(http::status::not_found, request.version(),
                                      error_json("route not found")); // 完全未知的路径返回 404
        http::write(socket, response); // 写回响应
    } catch (const std::exception& exception) { // 读写出错、客户端断开、解析异常等都收敛到这里
        std::cerr << "connection error: " << exception.what() << '\n'; // 只记录日志，绝不让异常逃出线程导致进程终止
    }
}

} // namespace nexus
