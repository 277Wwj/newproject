import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, createTask, fetchHealth, fetchTask, taskEventsUrl } from "./api";
import { taskEventText, taskStatusText } from "./messages";
import { watchTask } from "./task-stream";
import type { StreamState, TaskWatcher } from "./task-stream";
import type { Task } from "./types";

type HealthState = "checking" | "online" | "offline";

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

function App() {
  const [prompt, setPrompt] = useState("演示一次任务提交，观察排队、运行和完成事件。");
  const [task, setTask] = useState<Task | null>(null);
  const [health, setHealth] = useState<HealthState>("checking");
  const [streamState, setStreamState] = useState<StreamState>("idle");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const healthCheckRef = useRef(false);
  const watcherRef = useRef<TaskWatcher | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);

  const checkHealth = useCallback(async () => {
    if (healthCheckRef.current) return;
    healthCheckRef.current = true;
    try {
      await fetchHealth();
      setHealth("online");
      setHealthError(null);
    } catch (checkError) {
      setHealth("offline");
      setHealthError(checkError instanceof ApiError ? checkError.message : "无法检查后端状态，请重试。");
    } finally {
      healthCheckRef.current = false;
    }
  }, []);

  useEffect(() => {
    void checkHealth();
    const interval = window.setInterval(() => { void checkHealth(); }, 10_000);
    return () => { window.clearInterval(interval); };
  }, [checkHealth]);

  // Health changes must not tear down the task's event stream.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; watcherRef.current?.close(); };
  }, []);

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  const retryBackend = useCallback(() => {
    setHealth("checking");
    void checkHealth().then(() => watcherRef.current?.refresh());
  }, [checkHealth]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || new TextEncoder().encode(prompt.trim()).length > 4000 || submitting) return;
    setSubmitting(true); setError(null);
    try {
      const created = await createTask(prompt.trim());
      if (!mountedRef.current) return;
      watcherRef.current?.close();
      watcherRef.current = watchTask(created, {
        fetchTask,
        openEvents: (taskId) => new EventSource(taskEventsUrl(taskId)),
      }, { onTask: setTask, onState: setStreamState, onError: setStreamError });
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "无法创建任务，请重试。");
    } finally { setSubmitting(false); }
  }

  const activeStatus = task?.status ?? "queued";
  const progress = useMemo(() => !task ? 0 : activeStatus === "queued" ? 18 : activeStatus === "running" ? 58 : activeStatus === "completed" || activeStatus === "failed" ? 100 : 0, [activeStatus, task]);
  const events = task?.events ?? [];
  const statusLabel = taskStatusText(activeStatus);
  const connectionLabel = health === "online" ? "后端在线" : health === "offline" ? "后端离线" : "正在检查后端";
  const promptBytes = new TextEncoder().encode(prompt.trim()).length;
  const promptTooLong = promptBytes > 4000;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true">✳</span><span>NEXUS</span><small>AI 实验室 / M1</small></div>
        <div className="connection" role="status"><span className={`connection-dot ${health}`} />{connectionLabel}</div>
      </header>
      <section className="intro">
        <p className="eyebrow">可观测的 AGENT 运行时</p>
        <h1>提交一个任务，<br /><em>看见每一步。</em></h1>
        <p className="lede">连接 C++ 服务，实时查看任务状态与事件时间线。当前 M1 仅演示任务生命周期，尚未接入模型和诊断工具。</p>
      </section>
      <section className="workspace">
        <form className="composer" onSubmit={handleSubmit}>
          <div className="section-label"><span>01</span> 任务输入</div>
          <label htmlFor="prompt">这次想提交什么任务？</label>
          <textarea id="prompt" aria-describedby="prompt-help prompt-count" aria-invalid={promptTooLong || undefined} value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={4000} />
          <div id="prompt-help" className={`composer-help ${promptTooLong ? "input-error" : ""}`}>
            {promptTooLong ? "内容超过 4,000 字节，请缩短后再提交。" : "不能为空或全为空白；最多 4,000 个 UTF-8 字节。通常一个汉字占 3 字节，首尾空白会自动去除。"}
          </div>
          <div className="composer-footer">
            <span id="prompt-count">{promptBytes.toLocaleString("zh-CN")} / 4,000 字节</span>
            <button type="submit" disabled={submitting || !prompt.trim() || promptTooLong}>{submitting ? "正在提交…" : "提交任务 ↗"}</button>
          </div>
        </form>
        <section className="monitor" aria-live="polite" aria-label="任务实时状态">
          <div className="section-label"><span>02</span> 实时监控</div>
          {task ? <>
            <div className="task-heading">
              <div><span className="task-id">{task.task_id}</span><h2>{statusLabel}</h2></div>
              <span className={`status-badge ${activeStatus}`}>{statusLabel}</span>
            </div>
            <div className="progress-track" aria-hidden="true"><div style={{ width: `${progress}%` }} /></div>
            <p className="stage-note">进度条仅表示生命周期阶段，不代表诊断完成度。</p>
            {streamState === "reconnecting" && <p className="stream-note">连接中断或事件异常，正在尝试恢复任务事件…</p>}
            {streamState === "failed" && task.status !== "failed" && <p className="stream-note">事件同步已停止，请重新提交任务。</p>}
            <div className="timeline">
              {events.map((item) => <div className="event-row" key={item.sequence}>
                <span className="event-seq">{String(item.sequence).padStart(2, "0")}</span>
                <span className={`event-marker ${item.status}`} />
                <div><strong>{taskEventText(item.message)}</strong><small>{formatTime(item.timestamp)} · {taskStatusText(item.status)}</small></div>
              </div>)}
            </div>
          </> : <div className="empty-state"><span className="empty-glyph" aria-hidden="true">○</span><p>还没有任务</p><small>提交任务后，真实执行事件将在这里显示。</small></div>}
        </section>
      </section>
      {healthError && <div className="error-banner" role="alert">
        <div><strong>后端连接不可用</strong><p>{healthError}</p><p>每 10 秒自动检查一次；默认服务需监听 8080 端口。</p></div>
        <button type="button" onClick={retryBackend} disabled={health === "checking"}>{health === "checking" ? "正在重试…" : "重试连接"}</button>
      </div>}
      {streamError && <div className="error-banner" role="alert">{streamError}{streamState === "reconnecting" && <button type="button" onClick={() => { void watcherRef.current?.refresh(); }}>重试同步</button>}</div>}
      {error && <div className="error-banner" ref={errorRef} role="alert" tabIndex={-1}>{error}</div>}
      <section className="lower-grid">
        <div><div className="section-label"><span>03</span> 当前能力</div><p className="muted-copy">本版只验证任务提交、状态流转与实时推送。时间线来自 C++ 服务的真实事件；“已完成”表示演示流程结束，不代表已完成输入中的诊断需求。</p></div>
        <div className="contract-list"><div><span>通信方式</span><strong>Boost.Beast · SSE</strong></div><div><span>任务状态</span><strong>内存保存 · 固定流程</strong></div><div><span>后续计划</span><strong>白名单工具（尚未实现）</strong></div></div>
      </section>
      <footer><span>NEXUS AI LAB · 中文版</span><span>面向 Linux / C++20 / React TS</span><span>任务控制台 · 2026</span></footer>
    </main>
  );
}

export default App;
