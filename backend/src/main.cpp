#include "nexus/http_server.hpp"

#include <cstdlib>
#include <iostream>
#include <string>

int main(int argc, char* argv[]) {
    std::string host = "0.0.0.0";
    std::uint16_t port = 8080;

    if (argc > 1) {
        host = argv[1];
    }
    if (argc > 2) {
        const auto parsed_port = std::strtoul(argv[2], nullptr, 10);
        if (parsed_port == 0 || parsed_port > 65535) {
            std::cerr << "port must be between 1 and 65535\n";
            return 2;
        }
        port = static_cast<std::uint16_t>(parsed_port);
    }

    try {
        nexus::SseHub sse_hub;
        nexus::TaskManager task_manager([&sse_hub](const nexus::TaskEvent& event) {
            sse_hub.publish(event);
        });
        nexus::HttpServer server(host, port, task_manager, sse_hub);
        server.run();
    } catch (const std::exception& exception) {
        std::cerr << "fatal: " << exception.what() << '\n';
        return 1;
    }
    return 0;
}
