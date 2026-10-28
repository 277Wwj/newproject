import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Run the production TypeScript modules, without adding a test framework.
// Only Vite's environment binding is replaced; network/stream doubles stay here.
const generated = await mkdtemp(join(tmpdir(), "nexus-m1-tests-"));
after(() => rm(generated, { recursive: true, force: true }));
await writeFile(join(generated, "package.json"), '{"type":"module"}');
for (const name of ["protocol", "task-stream", "messages", "api"]) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 },
  });
  const executable = outputText.replace(/from "\.\/(messages|protocol)"/g, 'from "./$1.js"')
    .replaceAll("import.meta.env", "({})");
  await writeFile(join(generated, `${name}.js`), executable);
}
const load = (name) => import(pathToFileURL(join(generated, `${name}.js`)).href);
const { parseTask, parseTaskEvent, parseHealth, mergeEvents } = await load("protocol");
const { watchTask } = await load("task-stream");
const { taskStatusText, taskEventText } = await load("messages");
const api = await load("api");
globalThis.window = { setTimeout, clearTimeout };
after(() => { delete globalThis.window; });

function event(sequence = 1, taskId = "A") {
  return { sequence, task_id: taskId, status: ["queued", "running", "completed"][sequence - 1],
    message: `event ${sequence}`, timestamp: `2026-10-28T08:00:0${sequence}Z` };
}
function snapshot(count = 1, taskId = "A") {
  const events = Array.from({ length: count }, (_, i) => event(i + 1, taskId));
  return { task_id: taskId, prompt: "中文任务", status: events.at(-1).status,
    created_at: events[0].timestamp, updated_at: events.at(-1).timestamp, events };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class TestStream {
  readyState = 0;
  onopen = null;
  onerror = null;
  listeners = new Map();
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  close() { this.readyState = 2; }
  open() { this.readyState = 1; this.onopen?.({}); }
  emit(type, value) {
    this.listeners.get(type)?.({ data: typeof value === "string" ? value : JSON.stringify(value) });
  }
  fail(closed = false) { this.readyState = closed ? 2 : 0; this.onerror?.({}); }
}
function harness(initial = snapshot(), fetch = async () => initial) {
  const tasks = [], states = [], errors = [], sources = [];
  let queries = 0;
  const watcher = watchTask(initial, {
    fetchTask: (id) => { queries++; return fetch(id); },
    openEvents: () => { const source = new TestStream(); sources.push(source); return source; },
  }, { onTask: (task) => tasks.push(task), onState: (state) => states.push(state), onError: (error) => errors.push(error) });
  return { watcher, tasks, states, errors, sources, get queries() { return queries; } };
}

test("protocol rejects malformed objects and cross-task events before rendering", () => {
  for (const value of [null, [], {}, { ...event(), message: undefined }, { ...event(), status: 2 },
    { ...event(), sequence: 0 }, { ...event(), sequence: 1.5 }, event(1, "B")]) {
    assert.throws(() => parseTaskEvent(value, "A"));
  }
  for (const value of [null, { ...snapshot(), events: {} }, { ...snapshot(), prompt: 5 },
    { ...snapshot(), events: [event(1, "B")] }]) assert.throws(() => parseTask(value));
  assert.throws(() => parseTask(snapshot(1, "B"), "A"));
});

test("unknown statuses and timestamp strings retain safe display fallbacks", () => {
  const parsed = parseTaskEvent({ ...event(), status: "future_state", timestamp: "bad-date" }, "A");
  assert.equal(parsed.timestamp, "bad-date");
  assert.equal(taskStatusText(parsed.status), "未知状态（future_state）");
  assert.equal(taskEventText("additional evidence"), "additional evidence");
  assert.equal(taskEventText("Runtime error: details"), "运行时错误：details");
});

test("health validation requires the actual Nexus service", () => {
  assert.throws(() => parseHealth({ status: "ok", service: "unrelated" }));
  assert.throws(() => parseHealth({ status: "down", service: "nexus-server", milestone: "M1" }));
  assert.equal(parseHealth({ status: "ok", service: "nexus-server", milestone: "M1" }).status, "ok");
});

test("history merging sorts sequences and removes replay duplicates", () => {
  assert.deepEqual(mergeEvents([event(2), event(1)], [event(2), event(3)]).map((e) => e.sequence), [1, 2, 3]);
});

test("normal lifecycle closes the stream and ignores subsequent error callbacks", async () => {
  const h = harness();
  h.sources[0].emit("status", event(2));
  h.sources[0].emit("done", event(3));
  assert.equal(h.sources[0].readyState, 2);
  h.sources[0].onerror({});
  await h.watcher.refresh();
  assert.equal(h.states.at(-1), "complete");
  assert.equal(h.tasks.at(-1).status, "completed");
  assert.equal(h.queries, 0);
});

test("terminal initial snapshots never open an unnecessary stream", () => {
  const h = harness(snapshot(3));
  assert.equal(h.sources.length, 0);
  assert.equal(h.states.at(-1), "complete");
});

test("malformed JSON and missing fields trigger recovery without reaching UI state", async () => {
  for (const invalid of ["{", { ...event(2), message: undefined }, event(2, "B")]) {
    const h = harness(snapshot(), async () => snapshot(3));
    h.sources[0].emit("status", invalid);
    await h.watcher.refresh();
    assert.equal(h.queries, 1);
    assert.equal(h.tasks.length, 2);
    assert.equal(h.states.at(-1), "complete");
    assert.equal(h.errors.at(-1), null);
  }
});

test("a terminal SSE event waits for missing history then completes without duplicates", async () => {
  const result = deferred();
  const h = harness(snapshot(), () => result.promise);
  h.sources[0].emit("done", event(3));
  assert.equal(h.states.at(-1), "reconnecting");
  assert.notEqual(h.sources[0].readyState, 2);
  result.resolve(snapshot(3));
  await h.watcher.refresh();
  assert.deepEqual(h.tasks.at(-1).events.map((e) => e.sequence), [1, 2, 3]);
  assert.equal(h.states.at(-1), "complete");
});

test("delayed queued HTTP snapshot cannot regress a running task", async () => {
  const result = deferred();
  const h = harness(snapshot(), () => result.promise);
  const pending = h.watcher.refresh();
  h.sources[0].emit("status", event(2));
  result.resolve(snapshot());
  await pending;
  assert.equal(h.tasks.at(-1).status, "running");
  assert.equal(h.tasks.at(-1).events.length, 2);
});

test("delayed HTTP success after terminal SSE cannot overwrite completion", async () => {
  const result = deferred();
  const h = harness(snapshot(), () => result.promise);
  const pending = h.watcher.refresh();
  h.sources[0].emit("status", event(2));
  h.sources[0].emit("done", event(3));
  result.resolve(snapshot());
  await pending;
  assert.equal(h.tasks.at(-1).status, "completed");
  assert.equal(h.states.at(-1), "complete");
});

test("closing A invalidates both delayed requests and callbacks while B stays active", async () => {
  for (const outcome of ["success", "error"]) {
    const result = deferred();
    const a = harness(snapshot(), () => result.promise);
    const pending = a.watcher.refresh();
    a.watcher.close();
    const b = harness(snapshot(1, "B"));
    const lengths = [a.tasks.length, a.states.length, a.errors.length];
    if (outcome === "success") result.resolve(snapshot(3));
    else result.reject(new Error("old failure"));
    a.sources[0].emit("done", event(3));
    a.sources[0].onerror({});
    await pending;
    assert.deepEqual([a.tasks.length, a.states.length, a.errors.length], lengths);
    assert.equal(b.tasks.at(-1).task_id, "B");
    assert.notEqual(b.sources[0].readyState, 2);
    b.watcher.close();
  }
});

test("404 stops recovery permanently and does not invent a completed task", async () => {
  const h = harness(snapshot(), async () => { throw new api.ApiError("任务已丢失", 404); });
  h.sources[0].fail();
  await h.watcher.refresh();
  assert.equal(h.states.at(-1), "failed");
  assert.equal(h.tasks.at(-1).status, "queued");
  assert.equal(h.sources[0].readyState, 2);
  await h.watcher.refresh();
  assert.equal(h.queries, 1);
});

test("manual retry rebuilds a CLOSED stream and ignores old connection callbacks", async () => {
  const h = harness(snapshot(), async () => snapshot(2));
  h.sources[0].fail(true);
  await h.watcher.refresh();
  assert.equal(h.sources.length, 2);
  const count = h.tasks.length;
  h.sources[0].emit("done", event(3));
  h.sources[0].onerror({});
  assert.equal(h.tasks.length, count);
  h.sources[1].open();
  await h.watcher.refresh();
  assert.equal(h.states.at(-1), "connected");
  h.watcher.close();
});

test("automatic open refreshes history, coalesces requests and clears recovery errors", async () => {
  let fail = true;
  const h = harness(snapshot(), async () => {
    if (fail) throw new Error("offline");
    return snapshot(2);
  });
  h.sources[0].fail();
  await h.watcher.refresh();
  assert.equal(h.states.at(-1), "reconnecting");
  assert.equal(h.errors.at(-1), "offline");
  fail = false;
  h.sources[0].open();
  const first = h.watcher.refresh();
  const second = h.watcher.refresh();
  assert.equal(first, second);
  await first;
  assert.equal(h.queries, 2);
  assert.equal(h.tasks.at(-1).status, "running");
  assert.equal(h.states.at(-1), "connected");
  assert.equal(h.errors.at(-1), null);
  h.watcher.close();
});

test("HTTP client rejects empty, non-JSON and malformed successful bodies", async (t) => {
  for (const body of ["", "<html>proxy error</html>", JSON.stringify({ ...snapshot(), events: {} })]) {
    const mock = t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 200 }));
    await assert.rejects(api.createTask("中文任务"), api.ApiError);
    mock.mock.restore();
  }
});

test("HTTP client normalizes network errors, timeout and server 404", async (t) => {
  for (const failure of [new TypeError("network failed"), new DOMException("aborted", "AbortError")]) {
    const mock = t.mock.method(globalThis, "fetch", async () => { throw failure; });
    await assert.rejects(api.fetchHealth(), (error) => error instanceof api.ApiError &&
      error.message.includes(failure.name === "AbortError" ? "超时" : "无法连接"));
    mock.mock.restore();
  }
  t.mock.method(globalThis, "fetch", async () => new Response('{"error":"task not found"}', { status: 404 }));
  await assert.rejects(api.fetchTask("missing"), (error) => error.status === 404 && error.message.includes("重新提交"));
});

test("HTTP client sends Chinese text intact and validates task identity", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "/api/tasks");
    assert.equal(init.method, "POST");
    assert.equal(JSON.parse(init.body).prompt, "中文任务");
    return Response.json(snapshot(), { status: 201 });
  });
  assert.equal((await api.createTask("中文任务")).task_id, "A");
  assert.equal(api.taskEventsUrl("task/a"), "/api/tasks/task%2Fa/events");
});
