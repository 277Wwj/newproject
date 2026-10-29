// 应用主组件：负责任务提交、后端健康检查、以及把 SSE 事件渲染成时间线。
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"; // React 基础钩子与事件类型
import { ApiError, createTask, fetchHealth, fetchTask, taskEventsUrl } from "./api"; // HTTP 客户端与 SSE 地址构造
import { taskEventText, taskStatusText } from "./messages"; // 把后端英文状态/消息翻译成中文
import { watchTask } from "./task-stream"; // 封装「REST 补取 + EventSource 订阅」的任务观察器
import type { StreamState, TaskWatcher } from "./task-stream"; // 流状态与观察器句柄的类型
import type { Task } from "./types"; // 任务数据结构

// 后端健康状态：检查中 / 在线 / 离线，用于页头提示。
type HealthState = "checking" | "online" | "offline";

// 把 ISO-8601 时间字符串格式化成中文环境下的时分秒。
function formatTime(value: string): string {
  const date = new Date(value); // 解析后端返回的时间戳
  if (Number.isNaN(date.getTime())) return "时间未知"; // 解析失败时给出兜底文案，避免显示 Invalid Date
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date); // 24 小时制时:分:秒
}

// 根组件：所有状态集中在组件内部，数据流是「HTTP 提交 → SSE 推送 → setState 渲染」。
function App() {
  const [prompt, setPrompt] = useState("演示一次任务提交，观察排队、运行和完成事件。"); // 输入框内容，默认给一条示例
  const [task, setTask] = useState<Task | null>(null); // 当前展示的任务快照，null 表示还没有任务
  const [health, setHealth] = useState<HealthState>("checking"); // 后端连通性
  const [streamState, setStreamState] = useState<StreamState>("idle"); // SSE 连接状态：idle/connecting/open/reconnecting/failed
  const [submitting, setSubmitting] = useState(false); // 是否正在提交，用于禁用按钮防重复点击
  const [error, setError] = useState<string | null>(null); // 提交类错误的提示文本
  const [streamError, setStreamError] = useState<string | null>(null); // 事件流错误的提示文本
  const [healthError, setHealthError] = useState<string | null>(null); // 健康检查失败的原因
  const healthCheckRef = useRef(false); // 防止健康检查重入（10 秒轮询与手动重试可能撞车）
  const watcherRef = useRef<TaskWatcher | null>(null); // 当前任务的观察器，切换任务时需先关闭旧流
  const errorRef = useRef<HTMLDivElement | null>(null); // 错误横幅的 DOM 引用，用于自动聚焦
  const mountedRef = useRef(true); // 组件是否仍挂载，避免卸载后 setState 造成警告

  // 查询后端健康状态；用 ref 做互斥，避免并发请求相互覆盖结果。
  const checkHealth = useCallback(async () => {
    if (healthCheckRef.current) return; // 已有请求在飞，直接跳过本次
    healthCheckRef.current = true; // 加锁标记
    try {
      await fetchHealth(); // 请求 /api/health
      setHealth("online"); // 成功即在线
      setHealthError(null); // 清掉上一次的错误
    } catch (checkError) {
      setHealth("offline"); // 失败即离线
      setHealthError(checkError instanceof ApiError ? checkError.message : "无法检查后端状态，请重试。"); // 优先使用 API 层的具体原因
    } finally {
      healthCheckRef.current = false; // 无论成败都要释放标记，否则轮询会永久停摆
    }
  }, []);

  useEffect(() => {
    void checkHealth(); // 首次挂载立即检查一次
    const interval = window.setInterval(() => { void checkHealth(); }, 10_000); // 之后每 10 秒复检，及时反映后端上下线
    return () => { window.clearInterval(interval); }; // 卸载时清定时器，避免泄漏
  }, [checkHealth]); // checkHealth 用 useCallback 固定，effect 只会执行一次

  // Health changes must not tear down the task's event stream.
  // 中文说明：健康检查每 10 秒变化一次，如果把它写进订阅 effect 的依赖里，
  // 每次状态翻转都会关闭并重建 SSE，导致任务事件流被反复打断。
  // 所以订阅生命周期单独放在这个只运行一次的 effect 中。
  useEffect(() => {
    mountedRef.current = true; // 标记已挂载
    return () => { mountedRef.current = false; watcherRef.current?.close(); }; // 卸载时置为未挂载并关闭事件流
  }, []);

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]); // 出现新错误时把焦点移到横幅，方便读屏软件播报

  // 手动重试：重置为检查中，健康检查通过后让观察器重新同步一次事件。
  const retryBackend = useCallback(() => {
    setHealth("checking"); // 立即反馈「正在重试」，避免按钮看起来没反应
    void checkHealth().then(() => watcherRef.current?.refresh()); // 检查完成后让观察器重新拉取一次任务事件
  }, [checkHealth]); // 依赖 checkHealth，其引用稳定

  // 提交表单：先做本地校验，再创建任务，最后交给观察器接管事件流。
  async function handleSubmit(event: FormEvent) {
    event.preventDefault(); // 阻止浏览器默认的表单提交与页面刷新
    if (!prompt.trim() || new TextEncoder().encode(prompt.trim()).length > 4000 || submitting) return; // 空内容、超长或重复提交直接忽略
    setSubmitting(true); setError(null); // 进入提交态并清空旧错误
    try {
      const created = await createTask(prompt.trim()); // POST /api/tasks，先去掉首尾空白
      if (!mountedRef.current) return; // 请求期间组件已卸载，不再更新状态
      watcherRef.current?.close(); // 切换任务前必须关闭上一条 SSE，否则会同时存在两个事件源
      watcherRef.current = watchTask(created, {
        fetchTask, // 注入 REST 查询能力，断线时用于补全事件
        openEvents: (taskId) => new EventSource(taskEventsUrl(taskId)), // 注入 SSE 建连工厂，便于测试替换
      }, { onTask: setTask, onState: setStreamState, onError: setStreamError }); // 观察器把新任务、连接状态、错误回灌到组件状态
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "无法创建任务，请重试。"); // 统一展示提交失败原因
    } finally { setSubmitting(false); } // 无论成败都退出提交态，恢复按钮
  }

  const activeStatus = task?.status ?? "queued"; // 当前状态，无任务时按 queued 展示
  // 进度条只映射生命周期阶段，纯视觉提示，不代表诊断完成度。
  const progress = useMemo(() => !task ? 0 : activeStatus === "queued" ? 18 : activeStatus === "running" ? 58 : activeStatus === "completed" || activeStatus === "failed" ? 100 : 0, [activeStatus, task]); // 依赖状态与任务，避免每次渲染重算
  const events = task?.events ?? []; // 事件列表，无任务时用空数组简化渲染逻辑
  const statusLabel = taskStatusText(activeStatus); // 状态的中文文案
  const connectionLabel = health === "online" ? "后端在线" : health === "offline" ? "后端离线" : "正在检查后端"; // 页头连接状态文案
  const promptBytes = new TextEncoder().encode(prompt.trim()).length; // 按 UTF-8 字节计算长度，与后端 size() 判定一致
  const promptTooLong = promptBytes > 4000; // 与后端 4000 上限保持一致，避免提交后才被拒绝

  return (
    <main className="shell">
      {/* 页头：品牌标识 + 后端连通性指示灯 */}
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true">✳</span><span>NEXUS</span><small>AI 实验室 / M1</small></div>
        <div className="connection" role="status"><span className={`connection-dot ${health}`} />{connectionLabel}</div>
      </header>
      {/* 首屏介绍：明确 M1 的能力边界，避免把「已完成」误解为诊断已完成 */}
      <section className="intro">
        <p className="eyebrow">可观测的 AGENT 运行时</p>
        <h1>提交一个任务，<br /><em>看见每一步。</em></h1>
        <p className="lede">连接 C++ 服务，实时查看任务状态与事件时间线。当前 M1 仅演示任务生命周期，尚未接入模型和诊断工具。</p>
      </section>
      {/* 工作区：左侧表单提交任务，右侧实时监控事件流 */}
      <section className="workspace">
        {/* 01 任务输入：受控 textarea + 字节数提示 + 提交按钮 */}
        <form className="composer" onSubmit={handleSubmit}>
          <div className="section-label"><span>01</span> 任务输入</div>
          <label htmlFor="prompt">这次想提交什么任务？</label>
          {/* 受控组件：value 来自 state，onChange 把每次输入同步回 state */}
          <textarea id="prompt" aria-describedby="prompt-help prompt-count" aria-invalid={promptTooLong || undefined} value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={4000} />
          <div id="prompt-help" className={`composer-help ${promptTooLong ? "input-error" : ""}`}>
            {/* 校验提示：超长时给出具体错误，否则说明规则 */}
            {promptTooLong ? "内容超过 4,000 字节，请缩短后再提交。" : "不能为空或全为空白；最多 4,000 个 UTF-8 字节。通常一个汉字占 3 字节，首尾空白会自动去除。"}
          </div>
          <div className="composer-footer">
            <span id="prompt-count">{promptBytes.toLocaleString("zh-CN")} / 4,000 字节</span>
            {/* 三种情况禁用提交：提交中、内容为空、超出字节上限 */}
            <button type="submit" disabled={submitting || !prompt.trim() || promptTooLong}>{submitting ? "正在提交…" : "提交任务 ↗"}</button>
          </div>
        </form>
        {/* 02 实时监控：aria-live 让状态变化能被读屏软件播报 */}
        <section className="monitor" aria-live="polite" aria-label="任务实时状态">
          <div className="section-label"><span>02</span> 实时监控</div>
          {/* 有任务时渲染头部、进度与时间线；没有任务时显示空状态 */}
          {task ? <>
            <div className="task-heading">
              <div><span className="task-id">{task.task_id}</span><h2>{statusLabel}</h2></div>
              <span className={`status-badge ${activeStatus}`}>{statusLabel}</span>
            </div>
            {/* 进度条宽度由生命周期阶段映射，纯展示用，对读屏隐藏 */}
            <div className="progress-track" aria-hidden="true"><div style={{ width: `${progress}%` }} /></div>
            <p className="stage-note">进度条仅表示生命周期阶段，不代表诊断完成度。</p>
            {/* 重连中：提示用户事件流正在自动恢复 */}
            {streamState === "reconnecting" && <p className="stream-note">连接中断或事件异常，正在尝试恢复任务事件…</p>}
            {/* 流已失败但任务本身未失败：说明是同步问题，引导重新提交 */}
            {streamState === "failed" && task.status !== "failed" && <p className="stream-note">事件同步已停止，请重新提交任务。</p>}
            {/* 时间线：key 用事件序号，既保证 React 正确复用节点，也天然去重 */}
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
      {/* 健康检查失败横幅：提供手动重试入口，检查中禁用按钮防重复点击 */}
      {healthError && <div className="error-banner" role="alert">
        <div><strong>后端连接不可用</strong><p>{healthError}</p><p>每 10 秒自动检查一次；默认服务需监听 8080 端口。</p></div>
        <button type="button" onClick={retryBackend} disabled={health === "checking"}>{health === "checking" ? "正在重试…" : "重试连接"}</button>
      </div>}
      {/* 事件流错误横幅：重连中额外提供「重试同步」按钮 */}
      {streamError && <div className="error-banner" role="alert">{streamError}{streamState === "reconnecting" && <button type="button" onClick={() => { void watcherRef.current?.refresh(); }}>重试同步</button>}</div>}
      {/* 提交错误横幅：ref + tabIndex 配合 effect 可被聚焦，便于读屏软件播报 */}
      {error && <div className="error-banner" ref={errorRef} role="alert" tabIndex={-1}>{error}</div>}
      {/* 底部说明：明确当前能力与后续计划，避免过度承诺 */}
      <section className="lower-grid">
        <div><div className="section-label"><span>03</span> 当前能力</div><p className="muted-copy">本版只验证任务提交、状态流转与实时推送。时间线来自 C++ 服务的真实事件；“已完成”表示演示流程结束，不代表已完成输入中的诊断需求。</p></div>
        <div className="contract-list"><div><span>通信方式</span><strong>Boost.Beast · SSE</strong></div><div><span>任务状态</span><strong>内存保存 · 固定流程</strong></div><div><span>后续计划</span><strong>白名单工具（尚未实现）</strong></div></div>
      </section>
      <footer><span>NEXUS AI LAB · 中文版</span><span>面向 Linux / C++20 / React TS</span><span>任务控制台 · 2026</span></footer>
    </main>
  );
}

export default App;
