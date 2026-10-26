export type TaskStatus = "queued" | "running" | "completed" | "failed";

export type TaskEvent = {
  sequence: number;
  task_id: string;
  status: TaskStatus;
  message: string;
  timestamp: string;
};

export type Task = {
  task_id: string;
  prompt: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  events: TaskEvent[];
};
