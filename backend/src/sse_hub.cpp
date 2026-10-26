#include "nexus/sse_hub.hpp"

#include <algorithm>

namespace nexus {

SseHub::SubscriberPtr SseHub::subscribe(const std::string& task_id,
                                         const std::vector<TaskEvent>& backlog) {
    auto subscriber = std::make_shared<Subscriber>();
    // Hold the hub lock while installing the backlog and registering the
    // subscriber. A worker can publish between the task snapshot and this
    // call; this ordering guarantees that the event is either in the backlog
    // or queued by publish(), never silently dropped.
    std::lock_guard hub_lock(mutex_);
    {
        std::lock_guard subscriber_lock(subscriber->mutex);
        for (const auto& event : backlog) {
            subscriber->events.push_back(event);
        }
        const auto history_iterator = history_.find(task_id);
        if (history_iterator != history_.end()) {
            for (const auto& event : history_iterator->second) {
                const auto already_queued = std::any_of(
                    subscriber->events.begin(), subscriber->events.end(),
                    [&event](const TaskEvent& queued) { return queued.sequence == event.sequence; });
                if (!already_queued) {
                    subscriber->events.push_back(event);
                }
            }
        }
    }
    subscribers_[task_id].push_back(subscriber);
    subscriber->condition.notify_one();
    return subscriber;
}

std::optional<TaskEvent> SseHub::wait_for_event(const SubscriberPtr& subscriber) {
    std::unique_lock lock(subscriber->mutex);
    subscriber->condition.wait(lock, [&subscriber] {
        return subscriber->closed || !subscriber->events.empty();
    });

    if (subscriber->events.empty()) {
        return std::nullopt;
    }
    auto event = subscriber->events.front();
    subscriber->events.pop_front();
    return event;
}

void SseHub::publish(const TaskEvent& event) {
    std::vector<SubscriberPtr> subscribers;
    {
        std::lock_guard lock(mutex_);
        auto& history = history_[event.task_id];
        const auto in_history = std::any_of(
            history.begin(), history.end(),
            [&event](const TaskEvent& existing) { return existing.sequence == event.sequence; });
        if (!in_history) {
            history.push_back(event);
        }
        const auto iterator = subscribers_.find(event.task_id);
        if (iterator != subscribers_.end()) {
            subscribers = iterator->second;
        }
    }

    for (const auto& subscriber : subscribers) {
        {
            std::lock_guard lock(subscriber->mutex);
            if (!subscriber->closed) {
                const auto already_queued = std::any_of(
                    subscriber->events.begin(), subscriber->events.end(),
                    [&event](const TaskEvent& queued) { return queued.sequence == event.sequence; });
                if (!already_queued) {
                    subscriber->events.push_back(event);
                }
            }
        }
        subscriber->condition.notify_one();
    }
}

void SseHub::unsubscribe(const std::string& task_id,
                         const SubscriberPtr& subscriber) {
    {
        std::lock_guard lock(mutex_);
        const auto iterator = subscribers_.find(task_id);
        if (iterator != subscribers_.end()) {
            auto& subscribers = iterator->second;
            subscribers.erase(
                std::remove(subscribers.begin(), subscribers.end(), subscriber),
                subscribers.end());
            if (subscribers.empty()) {
                subscribers_.erase(iterator);
            }
        }
    }
    {
        std::lock_guard lock(subscriber->mutex);
        subscriber->closed = true;
    }
    subscriber->condition.notify_all();
}

} // namespace nexus
