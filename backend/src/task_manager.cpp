#include "nexus/task_manager.hpp"

#include <chrono>
#include <ctime>
#include <iomanip>
#include <random>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace nexus {
namespace {

std::string now_iso8601() {
    const auto now = std::chrono::system_clock::now();
    const auto time = std::chrono::system_clock::to_time_t(now);
    std::tm utc{};
#if defined(_WIN32)
    gmtime_s(&utc, &time);
#else
    gmtime_r(&time, &utc);
#endif

    std::ostringstream output;
    output << std::put_time(&utc, "%Y-%m-%dT%H:%M:%SZ");
    return output.str();
}

std::string make_task_id() {
    static thread_local std::mt19937_64 generator{std::random_device{}()};
    std::uniform_int_distribution<std::uint64_t> distribution;
    std::ostringstream output;
    output << "task-" << std::hex << distribution(generator);
    return output.str();
}

} // namespace

std::string to_string(TaskStatus status) {
    switch (status) {
    case TaskStatus::queued:
        return "queued";
    case TaskStatus::running:
        return "running";
    case TaskStatus::completed:
        return "completed";
    case TaskStatus::failed:
        return "failed";
    }
    return "failed";
}

TaskManager::TaskManager(EventSink event_sink)
    : event_sink_(std::move(event_sink)) {}

TaskManager::~TaskManager() {
    for (auto& worker : workers_) {
        if (worker.joinable()) {
            worker.join();
        }
    }
}

std::string TaskManager::create_task(std::string prompt) {
    const auto id = make_task_id();
    const auto timestamp = now_iso8601();
    {
        std::lock_guard lock(mutex_);
        TaskRecord record;
        record.snapshot.id = id;
        record.snapshot.prompt = std::move(prompt);
        record.snapshot.status = TaskStatus::queued;
        record.snapshot.created_at = timestamp;
        record.snapshot.updated_at = timestamp;
        tasks_.emplace(id, std::move(record));
    }

    const auto event = append_event(id, TaskStatus::queued, "Task accepted by the runtime");
    if (event && event_sink_) {
        event_sink_(*event);
    }

    {
        std::lock_guard lock(mutex_);
        workers_.emplace_back([this, id] { run_task(id); });
    }
    return id;
}

std::optional<TaskSnapshot> TaskManager::get_task(const std::string& id) const {
    std::lock_guard lock(mutex_);
    const auto iterator = tasks_.find(id);
    if (iterator == tasks_.end()) {
        return std::nullopt;
    }
    return iterator->second.snapshot;
}

std::optional<std::vector<TaskEvent>> TaskManager::get_events(const std::string& id) const {
    std::lock_guard lock(mutex_);
    const auto iterator = tasks_.find(id);
    if (iterator == tasks_.end()) {
        return std::nullopt;
    }
    return iterator->second.snapshot.events;
}

void TaskManager::run_task(const std::string& id) {
    try {
        std::this_thread::sleep_for(std::chrono::milliseconds(250));
        if (const auto event = append_event(id, TaskStatus::running,
                                            "Runtime started the M1 execution loop");
            event && event_sink_) {
            event_sink_(*event);
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(650));
        if (const auto event = append_event(id, TaskStatus::completed,
                                            "M1 execution completed; no tools are enabled yet");
            event && event_sink_) {
            event_sink_(*event);
        }
    } catch (const std::exception& exception) {
        if (const auto event = append_event(id, TaskStatus::failed,
                                            std::string("Runtime error: ") + exception.what());
            event && event_sink_) {
            event_sink_(*event);
        }
    }
}

std::optional<TaskEvent> TaskManager::append_event(const std::string& id,
                                                   TaskStatus status,
                                                   std::string message) {
    std::lock_guard lock(mutex_);
    const auto iterator = tasks_.find(id);
    if (iterator == tasks_.end()) {
        return std::nullopt;
    }

    auto& snapshot = iterator->second.snapshot;
    snapshot.status = status;
    snapshot.updated_at = now_iso8601();

    TaskEvent event;
    event.sequence = snapshot.events.size() + 1;
    event.task_id = id;
    event.status = status;
    event.message = std::move(message);
    event.timestamp = snapshot.updated_at;
    snapshot.events.push_back(event);
    return event;
}

} // namespace nexus
