#pragma once

#include "nexus/task_manager.hpp"

#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace nexus {

class SseHub {
public:
    struct Subscriber {
        std::mutex mutex;
        std::condition_variable condition;
        std::deque<TaskEvent> events;
        bool closed{false};
    };

    using SubscriberPtr = std::shared_ptr<Subscriber>;

    SubscriberPtr subscribe(const std::string& task_id,
                            const std::vector<TaskEvent>& backlog);
    std::optional<TaskEvent> wait_for_event(const SubscriberPtr& subscriber);
    void publish(const TaskEvent& event);
    void unsubscribe(const std::string& task_id,
                     const SubscriberPtr& subscriber);

private:
    std::mutex mutex_;
    std::unordered_map<std::string, std::vector<SubscriberPtr>> subscribers_;
    std::unordered_map<std::string, std::vector<TaskEvent>> history_;
};

} // namespace nexus
