import type { Task, TaskEvent } from "./types";
import { isTerminal, mergeEvents, parseTaskEvent } from "./protocol.js";

export type StreamState = "idle" | "connecting" | "connected" | "reconnecting" | "complete" | "failed";
type EventStream = Pick<EventSource, "readyState" | "onopen" | "onerror" | "addEventListener" | "close">;

export type TaskWatcher = { refresh(): Promise<void>; close(): void };
type Dependencies = {
  fetchTask(taskId: string): Promise<Task>;
  openEvents(taskId: string): EventStream;
};
type Handlers = {
  onTask(task: Task): void;
  onState(state: StreamState): void;
  onError(message: string | null): void;
};

function hasGaps(events: TaskEvent[]): boolean {
  return events.some((event, index) => event.sequence !== index + 1);
}

// One watcher owns one task. Closing it also invalidates pending HTTP results.
export function watchTask(initial: Task, dependencies: Dependencies, handlers: Handlers): TaskWatcher {
  let task = { ...initial, events: mergeEvents([], initial.events) };
  let source: EventStream | null = null;
  let closed = false;
  let finished = false;
  let pending: Promise<void> | null = null;
  let reopenRequested = false;

  const active = () => !closed && !finished;

  function publish(next: Task) {
    if (!active()) return;
    const events = mergeEvents(task.events, next.events);
    const latest = events[events.length - 1];
    // HTTP snapshots and replayed SSE events may arrive after newer events.
    task = { ...next, events, status: latest?.status ?? next.status, updated_at: latest?.timestamp ?? next.updated_at };
    handlers.onTask(task);
    if (isTerminal(task.status) && !hasGaps(events)) {
      finished = true;
      source?.close();
      handlers.onState(task.status === "failed" ? "failed" : "complete");
    }
  }

  function refresh(reopen = false): Promise<void> {
    if (!active()) return Promise.resolve();
    reopenRequested ||= reopen;
    if (pending) return pending;
    pending = (async () => {
      try {
        const snapshot = await dependencies.fetchTask(initial.task_id);
        if (!active()) return;
        if (snapshot.task_id !== initial.task_id) throw new Error("查询结果与当前任务不匹配。");
        handlers.onError(null);
        publish(snapshot);
        if (active() && hasGaps(task.events)) {
          handlers.onState("reconnecting");
          handlers.onError("任务事件尚不完整，请重试同步。");
        } else if (active() && source?.readyState === 1) {
          handlers.onState("connected");
        }
        if (active() && (!source || source.readyState === 2)) {
          if (reopenRequested) connect();
          else {
            handlers.onState("reconnecting");
            handlers.onError("事件连接已关闭，请点击“重试同步”。");
          }
        }
      } catch (error) {
        if (!active()) return;
        handlers.onState("reconnecting");
        handlers.onError(error instanceof Error ? error.message : "同步任务失败，请重试。");
        if (typeof error === "object" && error !== null && "status" in error && error.status === 404) {
          closed = true;
          source?.close();
          handlers.onState("failed");
        }
      } finally {
        pending = null;
        reopenRequested = false;
      }
    })();
    return pending;
  }

  const watcher: TaskWatcher = {
    refresh: () => refresh(true),
    close() { closed = true; source?.close(); },
  };
  handlers.onError(null);
  publish(task);
  if (!active()) return watcher;

  function connect() {
    handlers.onState("connecting");
    let current: EventStream;
    try {
      current = dependencies.openEvents(initial.task_id);
    } catch {
      handlers.onState("reconnecting");
      handlers.onError("无法建立事件连接，请检查 API 地址后重试同步。");
      return;
    }
    source = current;
    const ownsConnection = () => active() && source === current;
    current.onopen = () => {
      if (!ownsConnection()) return;
      handlers.onState("connected");
      // Refresh on every open, including automatic reconnects, to fill missed events.
      void refresh();
    };
    const receive = (message: Event) => {
      if (!ownsConnection()) return;
      try {
        const event = parseTaskEvent(JSON.parse((message as MessageEvent<string>).data), initial.task_id);
        handlers.onError(null);
        publish({ ...task, events: [event] });
        if (active()) {
          if (hasGaps(task.events)) {
            handlers.onState("reconnecting");
            void refresh();
          } else {
            handlers.onState("connected");
          }
        }
      } catch {
        handlers.onError("后端事件格式无效，正在查询任务状态。");
        handlers.onState("reconnecting");
        void refresh();
      }
    };
    current.addEventListener("status", receive);
    current.addEventListener("done", receive);
    current.onerror = () => {
      if (!ownsConnection()) return;
      handlers.onState("reconnecting");
      void refresh();
    };
  }
  connect();
  return watcher;
}
