import type { Task } from "./types";

export type Health = { status: string; service: string; milestone: string };

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

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
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
        throw new ApiError(`Server returned a non-JSON response (HTTP ${response.status})`, response.status);
      }
    }
    if (!response.ok) {
      const message = typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
        ? data.error
        : `Request failed with HTTP ${response.status}`;
      throw new ApiError(message, response.status);
    }
    if (data === null) {
      throw new ApiError("Server returned an empty response", response.status);
    }
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError("The backend request timed out after 8 seconds");
    }
    throw new ApiError("Cannot reach the backend. Check that nexus-server is running on port 8080.");
  } finally {
    window.clearTimeout(timeout);
  }
}

export function fetchHealth(): Promise<Health> {
  return requestJson<Health>("/health");
}

export function createTask(prompt: string): Promise<Task> {
  return requestJson<Task>("/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
}

export function fetchTask(taskId: string): Promise<Task> {
  return requestJson<Task>(`/tasks/${encodeURIComponent(taskId)}`);
}

export function taskEventsUrl(taskId: string): string {
  return apiUrl(`/tasks/${encodeURIComponent(taskId)}/events`);
}
