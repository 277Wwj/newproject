# Nexus AI Lab 进度记录

更新时间：2026-10-28。当前处于 M1 中文版与恢复逻辑的收尾验证阶段，范围仍为 M1，不扩展到 M2。

## 本轮目标与当前状态

本轮目标：完成 M1 中文页面的审查和必要修正，补充可重复运行的测试与 Linux CI，并在检查后提交、上传现有仓库。

- 项目目录：`F:\codexproject\nexus-ai-lab`
- Git 远程：[277Wwj/newproject](https://github.com/277Wwj/newproject)
- 本轮起始 HEAD：`0ee75010238af6a0ad3b3daf836d7e470fd4603d`
- 本轮改动仍在工作区，**待提交、待上传**；最终提交 SHA 和 CI 结果待实际操作后补充。
- Windows 干净安装 `npm ci`、17 项前端回归测试 `npm test`、生产构建 `npm run build` 均已通过，退出码均为 0；构建包含 31 个模块。
- 最终代码审查已通过，包含真实代理联调脚本与 CI 工作流的静态审查，没有剩余 P1/P2 问题；Linux CI 实际运行仍待推送。
- 本机仍没有可用的 Linux/WSL 或 Docker/Podman，真实后端构建与 CTest 待目标环境执行。本轮浏览器工具因 kernel assets 路径故障不可用，未复测最终页面。

## 已保存的文件与职责

| 文件 | 本轮内容 |
| --- | --- |
| `frontend/src/App.tsx` | 中文页面和 UTF-8 字节计数；健康检查与任务订阅独立；分别展示健康、提交和同步错误，连接独立任务订阅模块。 |
| `frontend/src/api.ts` | 网络、超时、非 JSON、空响应和服务端错误的中文提示；调用协议校验后再返回任务与健康响应。 |
| `frontend/src/messages.ts` | 已知协议状态、生命周期事件和后端错误的中文映射；未知消息及异常详情保留显示 fallback。 |
| `frontend/src/protocol.ts` | 任务、事件和健康响应的运行时校验；拒绝不匹配的任务 ID，按事件序号排序去重，识别终态。 |
| `frontend/src/task-stream.ts` | 每任务独立订阅；历史补齐、延迟回调隔离、终态关闭、404 停止恢复和手动重建 `CLOSED` 连接。 |
| `frontend/tests/runtime.test.mjs` | Node 原生测试运行器的 17 项协议、HTTP 与恢复逻辑测试；使用实际模块和受控网络/事件连接。 |
| `frontend/tests/proxy-smoke.mjs` | 经真实 Vite 代理创建中文任务、接收完整 SSE 并查询完成状态；要求真实 C++ 服务，不使用模拟后端。 |
| `frontend/package.json` | 增加 `npm test` 入口，未增加测试框架依赖。 |
| `frontend/src/styles.css` | 中文字体 fallback、行高、字号、窄屏换行和焦点样式；移除外部字体下载。 |
| `frontend/index.html` | `lang="zh-CN"`、中文标题和页面描述。 |
| `backend/tests/http_contract.sh` | 增强非法输入、ASCII/中文 4000/4001 字节边界、任务查询、SSE 顺序和终态关闭、完成后重放检查。 |
| `.github/workflows/m1.yml` | Ubuntu 24.04 / Node 22 执行后端 CMake/CTest、前端安装/测试/构建及真实 Vite→C++ 联调，待上传后实际运行。 |
| `README.md` | 目录职责、模块依赖、启动/测试步骤、环境与 CI 状态。 |
| `DEMO.md` | 中文演示、恢复行为、测试范围、日期明确的实测记录和待验证项目。 |
| `PROGRESS.md`（本文件） | 收尾进度、验证证据与待办。 |

前端依赖为 `App → api/task-stream/messages/types`，`api → protocol/messages`，`task-stream → protocol/types`；后端仍为 `main → HttpServer → TaskManager/SseHub`。HTTP/SSE 协议和 M1 产品范围不变：没有模型、工具执行、CPU/内存采集、SQLite 或诊断报告。

## 本轮实际验证（2026-10-28）

1. Windows 干净安装 `npm ci`、`npm test`、`npm run build` 均返回退出码 0；17 项测试通过，TypeScript/Vite 构建包含 31 个模块。
2. 前端测试覆盖非法协议数据、跨任务隔离、历史补齐、完成后的延迟结果、404 停止恢复、关闭连接的手动重建、重连查询合并、HTTP 错误和中文请求。测试使用受控 HTTP/事件连接，不代表真实后端或浏览器验收。
3. 新增真实联调脚本 `frontend/tests/proxy-smoke.mjs`，本地 `node --check` 语法检查通过；由于没有可运行的 C++ 后端，真实执行待 CI。该脚本检查中文 HTML 标记和 Vite 代理后的真实 HTTP/SSE，不渲染页面。
4. 宿主侧 `wsl --list --verbose` 返回“未安装适用于 Linux 的 Windows 子系统”，退出码 1；未找到可用 Docker/Podman。现有 Windows MinGW 工具链 include 中没有 Boost.Beast 和 nlohmann/json 头文件。
5. 经现有本地代理运行只读 `git ls-remote` 成功，返回远程 HEAD `0ee75010238af6a0ad3b3daf836d7e470fd4603d`；这只证明仓库可达，不表示本轮改动已上传。
6. 浏览器工具因 kernel assets 路径故障不可用。本轮没有产生新的视觉验收或真实浏览器端到端结果。
7. 最终审查覆盖前端恢复逻辑、真实代理联调脚本和 CI 工作流，未报告剩余 P1/P2 问题；静态审查不替代待运行的 Linux CI。

Linux CMake/CTest、真实 Vite→C++ 中文任务/SSE 联调、浏览器中的中文任务及完整断线恢复仍待验证。新增 CI 尚未实际执行，不能将本地前端测试当作 Linux 或 CI 结果。

## 保留的历史验证（2026-10-26）

以下结果来自当时版本，未当作本轮最终改动的复测：

1. Windows `npm run build` 返回退出码 0，TypeScript 检查及 Vite 6.4.5 构建成功，29 个模块。
2. 真实 Vite 页面显示中文、后端离线错误和“重试连接”；点击重试后仍正确显示离线。当时没有启动后端，不是完整端到端验证。
3. 浏览器输入检查：全空白禁用提交；`中文任务` 为 12 字节；1333 个“中”为 3999 字节；1334 个“中”为 4002 字节，提示超限并禁用提交。
4. 原页面健康检查无限循环曾被复现；修改后 Vite 日志显示请求按 10 秒间隔发起。真实 SSE 在健康状态变化时的保持行为未验证。
5. 桌面与 360 像素窄屏检查已执行；窄屏 DOM 内容宽度与可视宽度一致（345 像素，扣除滚动条），无整页横向溢出。
6. 当时对 `messages.ts` 的一次性 Node 断言有 7 项通过；本轮已增加可重复运行的 `npm test`。

## 收尾待办

1. 代码最终审查已通过。检查待提交范围、忽略文件和敏感信息后，按用户已有授权提交并推送到 `277Wwj/newproject`，记录最终 SHA。
2. 等待新提交的 GitHub Actions 实际运行，检查 Linux 后端 CTest、前端检查及真实 Vite→C++ 联调结果；失败时修复并重跑，记录运行链接。
3. 按实际结果更新本文件、`README.md` 和 `DEMO.md`，保留未执行项目及其原因。
4. Linux/WSL 环境和浏览器工具可用后，执行真实浏览器中的中文任务、SSE、断线恢复及最终桌面/窄屏验收。

## 运行与复验命令

PowerShell 前端检查及启动：

```powershell
Set-Location F:\codexproject\nexus-ai-lab\frontend
npm ci
npm test
npm run build
npm run dev -- --host 127.0.0.1
```

浏览器访问 [本地演示页面](http://127.0.0.1:5173/)。后端未启动时显示离线属于预期行为。

真实 C++ 后端监听 `127.0.0.1:8080`、Vite 监听 `127.0.0.1:5173` 后，在另一个终端进入 `frontend`，用 Node 22 执行 `node tests/proxy-smoke.mjs`。完整步骤见 [DEMO.md](DEMO.md)。

Linux/WSL 后端构建、CTest 和真实 HTTP/SSE 步骤见 [DEMO.md](DEMO.md)。M1 CI 配置见 [.github/workflows/m1.yml](.github/workflows/m1.yml)。
