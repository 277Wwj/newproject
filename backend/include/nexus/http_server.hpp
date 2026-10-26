#pragma once

#include "nexus/sse_hub.hpp"
#include "nexus/task_manager.hpp"

#include <boost/asio/ip/tcp.hpp>

#include <cstdint>
#include <string>

namespace nexus {

class HttpServer {
public:
    HttpServer(std::string host,
               std::uint16_t port,
               TaskManager& task_manager,
               SseHub& sse_hub);

    void run();

private:
    void handle_connection(boost::asio::ip::tcp::socket socket);

    std::string host_;
    std::uint16_t port_;
    TaskManager& task_manager_;
    SseHub& sse_hub_;
};

} // namespace nexus
