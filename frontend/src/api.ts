import type { Task } from "./types";
import { apiErrorText } from "./messages";
import { parseHealth, parseTask } from "./protocol";
import type { Health } from "./protocol";

export class ApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const configuredBase = import.meta.env.VITE_API_BASE_URL?.trim();
const apiBase = (configuredBase || "/api").replace(/\/$/, "");

export function apiUrl(path: string): string {
  return `${apiBase}${path.startsWith("/") ? path : `/${path}`}`;
}

async function requestJson<T>(path: string, decode: (value: unknown) => T, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(apiUrl(path), { ...init, signal: controller.signal });
    const text = await response.text();
    let data: unknown = null;
    if (text.trim()) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        throw new ApiError(`服务端返回的内容不是 JSON（HTTP ${response.status}），请检查后端和 API 地址。`, response.status);
      }
    }
    if (!response.ok) {
      const message = typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
        ? apiErrorText(data.error)
        : `请求失败（HTTP ${response.status}），请检查后端服务和 API 代理。`;
      throw new ApiError(message, response.status);
    }
    if (data === null) {
      throw new ApiError("服务端返回了空响应。", response.status);
    }
    try {
      return decode(data);
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : "服务端响应格式无效。", response.status);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError("请求后端超时（8 秒），请检查服务状态后重试。");
    }
    throw new ApiError("无法连接后端。请确认 nexus-server 已启动，并检查 API 地址；默认后端端口为 8080。");
  } finally {
    window.clearTimeout(timeout);
  }
}

export function fetchHealth(): Promise<Health> {
  return requestJson("/health", parseHealth);
}

export function createTask(prompt: string): Promise<Task> {
  return requestJson("/tasks", (value) => parseTask(value), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
}

export function fetchTask(taskId: string): Promise<Task> {
  return requestJson(`/tasks/${encodeURIComponent(taskId)}`, (value) => parseTask(value, taskId));
}

export function taskEventsUrl(taskId: string): string {
  return apiUrl(`/tasks/${encodeURIComponent(taskId)}/events`);
}
