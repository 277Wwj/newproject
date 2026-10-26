#pragma once

#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>
#include <unordered_map>

namespace nexus {

enum class TaskStatus {
    queued,
    running,
    completed,
    failed,
};

std::string to_string(TaskStatus status);

struct TaskEvent {
    std::uint64_t sequence{};
    std::string task_id;
    TaskStatus status{TaskStatus::queued};
    std::string message;
    std::string timestamp;
};

struct TaskSnapshot {
    std::string id;
    std::string prompt;
    TaskStatus status{TaskStatus::queued};
    std::string created_at;
    std::string updated_at;
    std::vector<TaskEvent> events;
};

class TaskManager {
public:
    using EventSink = std::function<void(const TaskEvent&)>;

    explicit TaskManager(EventSink event_sink);
    ~TaskManager();

    TaskManager(const TaskManager&) = delete;
    TaskManager& operator=(const TaskManager&) = delete;

    std::string create_task(std::string prompt);
    std::optional<TaskSnapshot> get_task(const std::string& id) const;
    std::optional<std::vector<TaskEvent>> get_events(const std::string& id) const;

private:
    struct TaskRecord {
        TaskSnapshot snapshot;
    };

    void run_task(const std::string& id);
    std::optional<TaskEvent> append_event(
        const std::string& id,
        TaskStatus status,
        std::string message);

    mutable std::mutex mutex_;
    std::unordered_map<std::string, TaskRecord> tasks_;
    std::vector<std::thread> workers_;
    EventSink event_sink_;
};

} // namespace nexus
