#include "nexus/sse_hub.hpp"

#include <iostream>
#include <mutex>
#include <vector>

int main() {
    nexus::TaskEvent event;
    event.sequence = 1;
    event.task_id = "task-regression";
    event.status = nexus::TaskStatus::running;
    event.message = "running";
    event.timestamp = "2026-01-01T00:00:00Z";

    nexus::SseHub hub;
    const auto subscriber = hub.subscribe(event.task_id, std::vector<nexus::TaskEvent>{event});

    // This models the HTTP handler taking a backlog snapshot, registering the
    // subscriber, and then receiving the same event from TaskManager::publish.
    // A sequence id is the event identity, so publish must not enqueue it twice.
    hub.publish(event);

    std::size_t queued_events = 0;
    {
        std::lock_guard lock(subscriber->mutex);
        queued_events = subscriber->events.size();
    }
    hub.unsubscribe(event.task_id, subscriber);

    if (queued_events != 1) {
        std::cerr << "duplicate SSE event regression: queued " << queued_events
                  << " copies of sequence 1\n";
        return 1;
    }

    std::cout << "sse-regression: no duplicate event\n";
    return 0;
}
