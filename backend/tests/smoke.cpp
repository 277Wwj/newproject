#include "nexus/task_manager.hpp"
#include "nexus/sse_hub.hpp"

#include <chrono>
#include <iostream>
#include <thread>

int main() {
    nexus::SseHub hub;
    nexus::TaskManager manager([&hub](const nexus::TaskEvent& event) {
        hub.publish(event);
    });
    const auto task_id = manager.create_task("smoke test");

    for (int attempt = 0; attempt < 20; ++attempt) {
        const auto task = manager.get_task(task_id);
        if (task && task->status == nexus::TaskStatus::completed) {
            if (task->events.size() != 3) {
                std::cerr << "expected three lifecycle events\n";
                return 1;
            }

            // A browser can open EventSource after POST has already returned.
            // The SSE hub must replay the completed task without losing events.
            const auto subscriber = hub.subscribe(task_id, {});
            for (std::uint64_t sequence = 1; sequence <= 3; ++sequence) {
                const auto event = hub.wait_for_event(subscriber);
                if (!event || event->sequence != sequence) {
                    std::cerr << "late SSE subscription lost or reordered an event\n";
                    return 1;
                }
            }
            hub.unsubscribe(task_id, subscriber);
            std::cout << "nexus-smoke: completed\n";
            return 0;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    std::cerr << "task did not complete within the test window\n";
    return 1;
}
