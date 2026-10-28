export type TaskStatus = "queued" | "running" | "completed" | "failed";

// Wire statuses stay open to future server states; the UI supplies a safe fallback.

export type TaskEvent = {
  sequence: number;
  task_id: string;
  status: string;
  message: string;
  timestamp: string;
};

export type Task = {
  task_id: string;
  prompt: string;
  status: string;
  created_at: string;
  updated_at: string;
  events: TaskEvent[];
};
