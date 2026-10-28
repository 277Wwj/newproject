import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

// Integration test only: requires the real C++ server on 8080 and Vite on 5173.
// All traffic uses the frontend's origin, exercising its /api proxy as well.
const origin = "http://127.0.0.1:5173";
async function request(path, init = {}) {
  return fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(8000) });
}
let ready = false;
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
    const health = await response.json();
    if (response.ok && health.status === "ok" && health.service === "nexus-server") {
      ready = true;
      break;
    }
  } catch { /* The two real servers may still be starting. */ }
  await setTimeout(250);
}
assert.ok(ready, "Vite /api proxy did not reach the C++ backend");
const page = await request("/");
assert.equal(page.status, 200);
assert.match(await page.text(), /lang="zh-CN"/);

const prompt = "中文任务：验证真实 HTTP 与 SSE 链路";
const createdResponse = await request("/api/tasks", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }),
});
assert.equal(createdResponse.status, 201);
const created = await createdResponse.json();
assert.equal(created.prompt, prompt);
const taskPath = `/api/tasks/${encodeURIComponent(created.task_id)}`;
const stream = await request(`${taskPath}/events`);
assert.equal(stream.status, 200);
assert.match(stream.headers.get("content-type"), /text\/event-stream/);
const body = await stream.text();
const events = body.split("\n").filter((line) => line.startsWith("data: "))
  .map((line) => JSON.parse(line.slice(6)));
assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
assert.deepEqual(events.map((event) => event.status), ["queued", "running", "completed"]);
assert.ok(events.every((event) => event.task_id === created.task_id));
assert.equal(body.split("\n").filter((line) => line === "event: done").length, 1);
const finalResponse = await request(taskPath);
assert.equal(finalResponse.status, 200);
const finalTask = await finalResponse.json();
assert.equal(finalTask.prompt, prompt);
assert.equal(finalTask.status, "completed");
assert.equal(finalTask.events.length, 3);
console.log("Real integration passed: Chinese page → Vite proxy → C++ task → three SSE events → task query");
