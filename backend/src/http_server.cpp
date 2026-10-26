#include "nexus/http_server.hpp"

#include <boost/asio/write.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <iostream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <utility>

namespace nexus {
namespace {

namespace asio = boost::asio;
namespace beast = boost::beast;
namespace http = beast::http;
using tcp = asio::ip::tcp;
using json = nlohmann::json;

json event_json(const TaskEvent& event) {
    return {
        {"sequence", event.sequence},
        {"task_id", event.task_id},
        {"status", to_string(event.status)},
        {"message", event.message},
        {"timestamp", event.timestamp},
    };
}

json task_json(const TaskSnapshot& task) {
    json events = json::array();
    for (const auto& event : task.events) {
        events.push_back(event_json(event));
    }
    return {
        {"task_id", task.id},
        {"prompt", task.prompt},
        {"status", to_string(task.status)},
        {"created_at", task.created_at},
        {"updated_at", task.updated_at},
        {"events", events},
    };
}

std::string error_json(const std::string& message) {
    return json{{"error", message}}.dump();
}

bool is_blank(const std::string& value) {
    return value.empty() || std::all_of(value.begin(), value.end(), [](char character) {
        return std::isspace(static_cast<unsigned char>(character)) != 0;
    });
}

template <class Body>
void add_common_headers(http::response<Body>& response) {
    response.set(http::field::content_type, "application/json; charset=utf-8");
    response.set("Access-Control-Allow-Origin", "*");
    response.set("Access-Control-Allow-Headers", "Content-Type");
    response.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

http::response<http::string_body> json_response(http::status status,
                                                unsigned version,
                                                const std::string& payload) {
    http::response<http::string_body> response{status, version};
    response.body() = payload;
    response.prepare_payload();
    add_common_headers(response);
    response.keep_alive(false);
    return response;
}

std::optional<std::string> task_id_from_path(const std::string& target) {
    constexpr std::string_view prefix = "/api/tasks/";
    if (!target.starts_with(prefix)) {
        return std::nullopt;
    }
    const auto id = target.substr(prefix.size());
    if (id.empty() || id.find('/') != std::string::npos) {
        return std::nullopt;
    }
    return id;
}

std::optional<std::string> event_task_id_from_path(const std::string& target) {
    constexpr std::string_view prefix = "/api/tasks/";
    constexpr std::string_view suffix = "/events";
    if (!target.starts_with(prefix) || !target.ends_with(suffix)) {
        return std::nullopt;
    }
    const auto id = target.substr(prefix.size(), target.size() - prefix.size() - suffix.size());
    if (id.empty() || id.find('/') != std::string::npos) {
        return std::nullopt;
    }
    return id;
}

std::string sse_payload(const TaskEvent& event) {
    const auto kind = event.status == TaskStatus::completed || event.status == TaskStatus::failed
                          ? "done"
                          : "status";
    std::ostringstream output;
    output << "id: " << event.sequence << "\n"
           << "event: " << kind << "\n"
           << "data: " << event_json(event).dump() << "\n\n";
    return output.str();
}

void write_sse_chunk(tcp::socket& socket, const std::string& payload) {
    std::ostringstream chunk;
    chunk << std::hex << payload.size() << "\r\n" << payload << "\r\n";
    asio::write(socket, asio::buffer(chunk.str()));
}

void write_sse_stream(tcp::socket& socket,
                      const std::string& task_id,
                      const std::vector<TaskEvent>& backlog,
                      SseHub& hub) {
    const std::string headers =
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/event-stream; charset=utf-8\r\n"
        "Cache-Control: no-cache\r\n"
        "Connection: keep-alive\r\n"
        "Transfer-Encoding: chunked\r\n"
        "Access-Control-Allow-Origin: *\r\n\r\n";
    asio::write(socket, asio::buffer(headers));
    write_sse_chunk(socket, "retry: 1000\n\n");

    const auto subscriber = hub.subscribe(task_id, backlog);
    try {
        while (const auto event = hub.wait_for_event(subscriber)) {
            write_sse_chunk(socket, sse_payload(*event));
            if (event->status == TaskStatus::completed || event->status == TaskStatus::failed) {
                break;
            }
        }
    } catch (...) {
        hub.unsubscribe(task_id, subscriber);
        throw;
    }
    hub.unsubscribe(task_id, subscriber);
    asio::write(socket, asio::buffer("0\r\n\r\n"));
}

} // namespace

HttpServer::HttpServer(std::string host,
                       std::uint16_t port,
                       TaskManager& task_manager,
                       SseHub& sse_hub)
    : host_(std::move(host)),
      port_(port),
      task_manager_(task_manager),
      sse_hub_(sse_hub) {}

void HttpServer::run() {
    asio::io_context context;
    const auto address = asio::ip::make_address(host_);
    tcp::acceptor acceptor(context, {address, port_});
    std::cout << "Nexus AI Lab backend listening on http://" << host_ << ':' << port_ << '\n';

    while (true) {
        tcp::socket socket(context);
        acceptor.accept(socket);
        std::thread(&HttpServer::handle_connection, this, std::move(socket)).detach();
    }
}

void HttpServer::handle_connection(tcp::socket socket) {
    try {
        beast::flat_buffer buffer;
        http::request<http::string_body> request;
        http::read(socket, buffer, request);

        const std::string target = std::string(request.target());
        if (request.method() == http::verb::options) {
            auto response = json_response(http::status::no_content, request.version(), "");
            http::write(socket, response);
            return;
        }

        if (request.method() == http::verb::get && target == "/api/health") {
            auto response = json_response(
                http::status::ok, request.version(),
                json{{"status", "ok"}, {"service", "nexus-server"}, {"milestone", "M1"}}.dump());
            http::write(socket, response);
            return;
        }

        if (request.method() == http::verb::post && target == "/api/tasks") {
            try {
                const auto body = json::parse(request.body());
                if (!body.contains("prompt") || !body.at("prompt").is_string()) {
                    auto response = json_response(http::status::bad_request, request.version(),
                                                  error_json("prompt must be a string"));
                    http::write(socket, response);
                    return;
                }
                const auto prompt = body.at("prompt").get<std::string>();
                if (is_blank(prompt) || prompt.size() > 4000) {
                    auto response = json_response(http::status::bad_request, request.version(),
                                                  error_json("prompt must contain 1-4000 non-whitespace characters"));
                    http::write(socket, response);
                    return;
                }
                const auto id = task_manager_.create_task(prompt);
                const auto task = task_manager_.get_task(id);
                auto response = json_response(http::status::created, request.version(),
                                              task ? task_json(*task).dump() : error_json("task creation failed"));
                http::write(socket, response);
                return;
            } catch (const json::exception&) {
                auto response = json_response(http::status::bad_request, request.version(),
                                              error_json("request body must be valid JSON"));
                http::write(socket, response);
                return;
            }
        }

        if (request.method() == http::verb::get) {
            if (const auto event_task_id = event_task_id_from_path(target)) {
                const auto events = task_manager_.get_events(*event_task_id);
                if (!events) {
                    auto response = json_response(http::status::not_found, request.version(),
                                                  error_json("task not found"));
                    http::write(socket, response);
                    return;
                }
                write_sse_stream(socket, *event_task_id, *events, sse_hub_);
                return;
            }

            if (const auto task_id = task_id_from_path(target)) {
                const auto task = task_manager_.get_task(*task_id);
                auto response = task
                                     ? json_response(http::status::ok, request.version(), task_json(*task).dump())
                                     : json_response(http::status::not_found, request.version(),
                                                     error_json("task not found"));
                http::write(socket, response);
                return;
            }
        }

        const bool known_route = target == "/api/health" || target == "/api/tasks" ||
                                 task_id_from_path(target).has_value() ||
                                 event_task_id_from_path(target).has_value();
        if (known_route) {
            auto response = json_response(http::status::method_not_allowed, request.version(),
                                          error_json("method not allowed"));
            http::write(socket, response);
            return;
        }

        auto response = json_response(http::status::not_found, request.version(),
                                      error_json("route not found"));
        http::write(socket, response);
    } catch (const std::exception& exception) {
        std::cerr << "connection error: " << exception.what() << '\n';
    }
}

} // namespace nexus
