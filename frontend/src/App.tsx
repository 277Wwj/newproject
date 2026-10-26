import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, createTask, fetchHealth, fetchTask, taskEventsUrl } from "./api";
import type { Task, TaskEvent, TaskStatus } from "./types";

type HealthState = "checking" | "online" | "offline";
type StreamState = "idle" | "connecting" | "reconnecting" | "complete" | "failed";

const statusCopy: Record<TaskStatus, string> = { queued: "Queued", running: "Executing", completed: "Complete", failed: "Failed" };

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function mergeEvents(current: TaskEvent[], incoming: TaskEvent[]): TaskEvent[] {
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  incoming.forEach((event) => bySequence.set(event.sequence, event));
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

function isTerminal(status: TaskStatus): boolean { return status === "completed" || status === "failed"; }

function App() {
  const [prompt, setPrompt] = useState("Inspect the current service health and explain the first diagnostic step.");
  const [task, setTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [health, setHealth] = useState<HealthState>("checking");
  const [streamState, setStreamState] = useState<StreamState>("idle");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<EventSource | null>(null);
  const terminalRef = useRef(false);
  const recoveryRef = useRef(false);

  const checkHealth = useCallback(async () => {
    setHealth("checking");
    try {
      await fetchHealth();
      setHealth("online");
      setError((current) => current?.startsWith("Cannot reach") ? null : current);
    } catch (healthError) {
      setHealth("offline");
      if (healthError instanceof ApiError) setError(healthError.message);
    }
  }, []);

  const recoverTask = useCallback(async (taskId: string) => {
    if (recoveryRef.current || terminalRef.current) return;
    recoveryRef.current = true;
    try {
      const recovered = await fetchTask(taskId);
      setTask(recovered);
      setEvents((current) => mergeEvents(current, recovered.events ?? []));
      if (isTerminal(recovered.status)) {
        terminalRef.current = true;
        streamRef.current?.close();
        setStreamState(recovered.status === "failed" ? "failed" : "complete");
      }
    } catch (recoveryError) {
      if (recoveryError instanceof ApiError) setError(recoveryError.message);
    } finally {
      recoveryRef.current = false;
    }
  }, []);

  useEffect(() => {
    void checkHealth();
    const interval = window.setInterval(() => { if (health !== "online") void checkHealth(); }, 10_000);
    return () => { window.clearInterval(interval); streamRef.current?.close(); };
  }, [checkHealth, health]);

  const connectToTask = useCallback((nextTask: Task) => {
    streamRef.current?.close();
    terminalRef.current = isTerminal(nextTask.status);
    setStreamState(nextTask.status === "completed" ? "complete" : nextTask.status === "failed" ? "failed" : "connecting");
    const source = new EventSource(taskEventsUrl(nextTask.task_id));
    streamRef.current = source;
    const receive = (message: Event) => {
      try {
        const nextEvent = JSON.parse((message as MessageEvent<string>).data) as TaskEvent;
        setEvents((current) => mergeEvents(current, [nextEvent]));
        setTask((current) => current ? { ...current, status: nextEvent.status, updated_at: nextEvent.timestamp } : current);
        if (isTerminal(nextEvent.status)) {
          terminalRef.current = true;
          source.close();
          setStreamState(nextEvent.status === "failed" ? "failed" : "complete");
        }
      } catch {
        setError("The backend sent an invalid SSE event. The stream will be retried.");
        setStreamState("reconnecting");
      }
    };
    source.onopen = () => setStreamState("connecting");
    source.addEventListener("status", receive);
    source.addEventListener("done", receive);
    source.onerror = () => {
      if (terminalRef.current) return;
      setStreamState("reconnecting");
      void recoverTask(nextTask.task_id);
    };
  }, [recoverTask]);

  const retryBackend = useCallback(() => {
    setError(null);
    void checkHealth().then(() => { if (task && !terminalRef.current) void recoverTask(task.task_id); });
  }, [checkHealth, recoverTask, task]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || submitting) return;
    setSubmitting(true); setError(null); setEvents([]);
    try {
      const created = await createTask(prompt.trim());
      setTask(created); setEvents(created.events ?? []); connectToTask(created);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Unable to create task");
    } finally { setSubmitting(false); }
  }

  const activeStatus = task?.status ?? "queued";
  const progress = useMemo(() => !task ? 0 : activeStatus === "queued" ? 18 : activeStatus === "running" ? 58 : 100, [activeStatus, task]);
  const statusLabel = task ? statusCopy[activeStatus] ?? "Unknown status" : "Queued";
  const connectionLabel = health === "online" ? "Backend online" : health === "offline" ? "Backend offline" : "Checking backend";

  return (
    <main className="shell">
      <header className="topbar"><div className="brand"><span className="brand-mark">✳</span><span>NEXUS</span><small>AI LAB / M1</small></div><div className="connection" aria-live="polite"><span className={`connection-dot ${health}`} />{connectionLabel}</div></header>
      <section className="intro"><p className="eyebrow">OBSERVABLE AGENT RUNTIME</p><h1>Give the runtime<br /><em>a question to investigate.</em></h1><p className="lede">A real-time control surface for AI-assisted systems work. M1 connects the task queue, execution stream, and operator timeline.</p></section>
      <section className="workspace">
        <form className="composer" onSubmit={handleSubmit}><div className="section-label"><span>01</span> TASK INPUT</div><label htmlFor="prompt">What should Nexus investigate?</label><textarea id="prompt" aria-describedby="prompt-help" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={4000} /><div id="prompt-help" className="composer-help">Use 1–4,000 non-whitespace characters.</div><div className="composer-footer"><span>{prompt.length.toLocaleString()} / 4,000 characters</span><button type="submit" disabled={submitting || !prompt.trim()}>{submitting ? "Starting…" : "Launch task ↗"}</button></div></form>
        <section className="monitor" aria-live="polite"><div className="section-label"><span>02</span> LIVE MONITOR</div>{task ? <><div className="task-heading"><div><span className="task-id">{task.task_id}</span><h2>{statusLabel}</h2></div><span className={`status-badge ${activeStatus}`}>{activeStatus}</span></div><div className="progress-track"><div style={{ width: `${progress}%` }} /></div>{streamState === "reconnecting" && <p className="stream-note">Connection interrupted. Recovering task events…</p>}<div className="timeline">{events.map((item) => <div className="event-row" key={item.sequence}><span className="event-seq">{String(item.sequence).padStart(2, "0")}</span><span className={`event-marker ${item.status}`} /><div><strong>{item.message}</strong><small>{formatTime(item.timestamp)} · {item.status}</small></div></div>)}</div></> : <div className="empty-state"><span className="empty-glyph">○</span><p>No task is running.</p><small>Submit a prompt to open a live execution stream.</small></div>}</section>
      </section>
      {error && <div className="error-banner" role="alert" tabIndex={-1}>{error}{health === "offline" && <button type="button" onClick={retryBackend}>Retry backend</button>}</div>}
      <section className="lower-grid"><div><div className="section-label"><span>03</span> RUNTIME CONTRACT</div><p className="muted-copy">M1 exposes only the task lifecycle. Every event shown here came from the C++ service over HTTP and SSE.</p></div><div className="contract-list"><div><span>Transport</span><strong>Boost.Beast · SSE</strong></div><div><span>State</span><strong>In-memory · deterministic</strong></div><div><span>Next surface</span><strong>Whitelisted tools</strong></div></div></section>
      <footer><span>NEXUS AI LAB</span><span>Linux-first / C++20 / React TS</span><span>Operator console · 2026</span></footer>
    </main>
  );
}

export default App;
