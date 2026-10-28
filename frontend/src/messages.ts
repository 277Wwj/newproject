// Translate known protocol messages only; preserve unknown details as evidence.
const statusMessages = new Map<string, string>([
  ["queued", "排队中"],
  ["running", "运行中"],
  ["completed", "已完成"],
  ["failed", "已失败"],
]);

const eventMessages = new Map<string, string>([
  ["Task accepted by the runtime", "运行时已接收任务"],
  ["Runtime started the M1 execution loop", "运行时已开始 M1 生命周期演示"],
  ["M1 execution completed; no tools are enabled yet", "M1 生命周期演示已完成，尚未启用工具"],
]);

const errorMessages = new Map<string, string>([
  ["prompt must be a string", "任务内容必须是文本。"],
  ["prompt must contain 1-4000 non-whitespace characters", "任务内容不能为空或全为空白，且不能超过 4,000 个 UTF-8 字节。"],
  ["request body must be valid JSON", "请求内容不是有效的 JSON。"],
  ["task creation failed", "任务创建失败，请重试。"],
  ["task not found", "找不到该任务；后端重启会清空内存中的任务，请重新提交。"],
  ["route not found", "找不到该接口，请检查 API 地址。"],
  ["method not allowed", "该接口不支持此请求方法。"],
]);

export function taskStatusText(status: string): string {
  return statusMessages.get(status) ?? `未知状态（${status}）`;
}

export function taskEventText(message: string): string {
  if (message.startsWith("Runtime error: ")) {
    return `运行时错误：${message.slice("Runtime error: ".length)}`;
  }
  return eventMessages.get(message) ?? message;
}

export function apiErrorText(message: string): string {
  return errorMessages.get(message) ?? `服务端返回错误：${message}`;
}
