import type { Task, TaskEvent } from "./types";

export type Health = {
  status: "ok";
  service: "nexus-server";
  milestone: string;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}格式无效：应为对象。`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && value.trim().length === 0)) {
    throw new Error(`${label}格式无效：应为${nonempty ? "非空" : ""}字符串。`);
  }
  return value;
}

export function parseTaskEvent(value: unknown, expectedTaskId: string): TaskEvent {
  const event = record(value, "任务事件");
  if (typeof event.sequence !== "number" || !Number.isSafeInteger(event.sequence) || event.sequence <= 0) {
    throw new Error("任务事件序号格式无效：应为正安全整数。");
  }
  const taskId = stringField(event.task_id, "任务事件标识", true);
  if (taskId !== expectedTaskId) {
    throw new Error("任务事件标识不匹配：收到其他任务的数据。");
  }
  return {
    sequence: event.sequence,
    task_id: taskId,
    status: stringField(event.status, "任务事件状态", true),
    message: stringField(event.message, "任务事件消息"),
    timestamp: stringField(event.timestamp, "任务事件时间"),
  };
}

export function parseTask(value: unknown, expectedTaskId?: string): Task {
  const task = record(value, "任务响应");
  const taskId = stringField(task.task_id, "任务标识", true);
  if (expectedTaskId !== undefined && taskId !== expectedTaskId) {
    throw new Error("任务标识不匹配：收到其他任务的数据。");
  }
  if (!Array.isArray(task.events)) {
    throw new Error("任务事件列表格式无效：应为数组。");
  }
  return {
    task_id: taskId,
    prompt: stringField(task.prompt, "任务指令"),
    status: stringField(task.status, "任务状态", true),
    created_at: stringField(task.created_at, "任务创建时间"),
    updated_at: stringField(task.updated_at, "任务更新时间"),
    events: task.events.map((event) => parseTaskEvent(event, taskId)),
  };
}

export function parseHealth(value: unknown): Health {
  const health = record(value, "健康检查响应");
  if (health.status !== "ok") {
    throw new Error("健康检查状态无效：服务尚未就绪。");
  }
  if (health.service !== "nexus-server") {
    throw new Error("健康检查服务不匹配：需要 nexus-server 服务。");
  }
  return {
    status: "ok",
    service: "nexus-server",
    milestone: stringField(health.milestone, "健康检查里程碑"),
  };
}

export function mergeEvents(current: TaskEvent[], incoming: TaskEvent[]): TaskEvent[] {
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  incoming.forEach((event) => bySequence.set(event.sequence, event));
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

export function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed";
}
