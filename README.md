# Nexus AI Lab — M1

仓库：[277Wwj/newproject](https://github.com/277Wwj/newproject)。项目初衷：结合上一个高并发项目的知识和新学习的 AI 知识做一个项目。

**演示入口：[DEMO.md — 环境准备、启动命令、讲解脚本与异常验证](DEMO.md)**。

Nexus AI Lab 是一个 Linux-first 的可观测 AI Agent 执行与性能诊断平台。本轮只交付 M1：React + TypeScript 页面可以提交任务，C++20/Boost.Beast 服务创建内存任务，并通过 SSE 推送真实的 `queued → running → completed` 生命周期事件。

当前 M1 的 `completed` 只表示生命周期演示结束，不表示完成了输入中的诊断需求；尚未调用模型或系统工具。Linux 构建、后端测试和真实 Vite→C++ HTTP/SSE 联调已通过 GitHub Actions；浏览器交互仍需本机验收，详见 [DEMO.md](DEMO.md)。

页面现默认使用简体中文，无需额外配置。任务输入、连接提示、状态、已知事件和错误文案均已中文化；`queued/running/completed/failed` 等 HTTP/SSE 字段与值保持原样，未知事件及异常详情保留原文。页面按实际提交内容计算 UTF-8 字节数，与后端的 4,000 字节上限一致。

## 环境审计

2026-10-24 的环境检查记录：开发机使用 Windows PowerShell，检测到 CMake 4.4.1、MinGW-w64 GCC 16.1.0、Node 26.3.0 和 npm 11.16.0。2026-10-28 复核时，`wsl --list --verbose` 仍返回未安装 WSL，未找到可用的 Docker/Podman；现有 Windows 工具链也没有 Boost.Beast 和 nlohmann/json 头文件。Linux 后端仍未在本机完成构建与运行验证，以下后端步骤需要在已安装依赖的 Linux/WSL 中执行。M1 不依赖 SQLite。

如果浏览器提示连接被拒绝，先确认两个服务是否分别启动：前端默认监听 `5173`，后端监听 `8080`。Windows PowerShell 可用下面的命令检查端口：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 5173,8080
```

`5173` 没有监听表示 Vite 没启动；`8080` 没有监听表示 `nexus-server` 没启动。前端页面可以在后端未启动时打开，会显示“后端离线”和具体错误。页面每 10 秒检查一次，也可点击“重试连接”。健康检查与任务事件订阅独立；任务同步异常另有“重试同步”入口。前端恢复逻辑已有回归测试，真实浏览器与 Linux 后端的完整链路仍需按 [DEMO.md](DEMO.md) 实测，后端重启不能恢复旧任务。

Linux 依赖：

```bash
sudo apt update
sudo apt install -y build-essential cmake libboost-system-dev nlohmann-json3-dev nodejs npm curl
```

## 目录和职责

```text
nexus-ai-lab/
├── .github/workflows/m1.yml        # Ubuntu 24.04 / Node 22 的 M1 构建与测试
├── CMakeLists.txt                  # C++20 构建、依赖和 CTest
├── DEMO.md                         # 环境准备、讲解脚本与验证步骤
├── PROGRESS.md                     # 当前进度、实测证据与待验收项目
├── backend/
│   ├── include/nexus/
│   │   ├── http_server.hpp         # HTTP 路由和连接生命周期接口
│   │   ├── sse_hub.hpp             # SSE 订阅者和事件广播
│   │   └── task_manager.hpp        # 内存任务状态和后台生命周期
│   ├── src/
│   │   ├── http_server.cpp         # Boost.Beast HTTP/SSE 实现
│   │   ├── main.cpp                # 组装模块并启动服务
│   │   ├── sse_hub.cpp             # 线程安全 SSE 队列
│   │   └── task_manager.cpp        # queued/running/completed 状态流
│   └── tests/
│       ├── smoke.cpp               # 任务生命周期与延迟订阅测试
│       ├── sse_regression.cpp      # 重复事件入队回归测试
│       └── http_contract.sh        # 真实 HTTP/SSE、非法输入和 UTF-8 边界检查
├── frontend/
│   ├── src/App.tsx                 # 任务提交、状态和时间线
│   ├── src/api.ts                  # HTTP API 客户端、错误转换和响应校验入口
│   ├── src/messages.ts             # 协议状态、事件和错误的中文显示映射
│   ├── src/protocol.ts             # 任务/事件/健康响应校验与事件排序去重
│   ├── src/task-stream.ts          # 单任务订阅、历史补齐、重试与结束清理
│   ├── src/types.ts                # 前后端共享的 TS 数据形状
│   ├── src/vite-env.d.ts            # Vite 环境变量类型声明
│   ├── src/styles.css              # M1 操作台界面
│   ├── tests/runtime.test.mjs      # Node 原生测试：协议、HTTP 与任务恢复逻辑
│   ├── tests/proxy-smoke.mjs        # 经真实 Vite 代理验证中文任务与 C++ SSE
│   ├── index.html                  # Vite 入口
│   ├── package.json                # React/Vite 依赖和脚本
│   ├── package-lock.json           # 可重复安装的依赖锁定
│   ├── tsconfig*.json              # TypeScript 配置
│   └── vite.config.ts              # 开发代理 /api → C++ 服务
└── README.md
```

依赖方向是 `main → HttpServer → TaskManager/SseHub`；HTTP 层不执行任意命令，TaskManager 也没有模型或工具依赖。前端 `App → api/task-stream/messages/types`，`api → protocol/messages`，`task-stream → protocol/types`；`App` 向任务订阅模块注入 HTTP 查询和 EventSource 创建函数。中文映射只改变显示文案。前端通过 HTTP 和 SSE 通信，Vite 开发服务器把 `/api` 转发到 `localhost:8080`。

`protocol.ts` 在数据进入页面前校验字段、事件序号和任务 ID；`task-stream.ts` 为每个任务管理独立订阅，合并重放事件并补齐缺失历史，屏蔽旧任务或旧连接的延迟回调。收到完整终态后关闭订阅；查询返回 404 时停止恢复并提示重新提交；连接进入 `CLOSED` 时可手动重建。未知状态和消息保留显示 fallback。这些行为的前端测试使用受控 HTTP/事件连接，不替代真实后端及浏览器验收。

## 构建和启动

获取代码（将 GitHub 仓库克隆到 `nexus-ai-lab` 目录，保持下文命令一致）：

```bash
git clone https://github.com/277Wwj/newproject.git nexus-ai-lab
```

已有本地项目请直接进入原目录，无需再次克隆。Ubuntu 版本和 Node 版本要求见 [演示环境准备](DEMO.md)。

后端（Linux/WSL）：

```bash
cd nexus-ai-lab
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j
ctest --test-dir build --output-on-failure
./build/nexus-server 0.0.0.0 8080
```

`nexus_smoke` 检查任务生命周期和延迟建立 SSE 订阅时的事件回放；`nexus_sse_regression` 检查 backlog 与发布同一事件时的队列去重；Linux 上的 `nexus_http_contract` 启动真实服务，覆盖非法 JSON、空白及错误类型、ASCII/中文的 4000/4001 字节边界、任务查询、SSE 顺序与终态关闭、完成后重放和未知任务 404。三个测试已在下方记录的 Ubuntu CI 中通过。

前端（另一个终端）：

```bash
cd nexus-ai-lab/frontend
npm ci
npm test
npm run build
npm run dev
```

`npm ci` 需要访问 npm registry，并依赖提交的 `package-lock.json`。如果出现 `ENOTFOUND registry.npmjs.org`，这是当前网络/DNS 环境无法访问 npm registry，需要切换到可联网环境后再执行安装。

开发模式不需要设置 API 环境变量，Vite 会把 `/api` 代理到 `http://localhost:8080`；`npm run preview` 也配置了相同代理。独立静态托管时，可复制 `frontend/.env.example` 为 `.env`，设置 `VITE_API_BASE_URL`（例如 `http://localhost:8080/api`），然后重新运行 `npm run build`。该地址会公开嵌入前端产物，不能包含密钥，远程用户也不能用 `localhost` 访问服务器。

浏览器打开 <http://localhost:5173>。

## 验证记录与 CI

2026-10-28 在 Windows 已完成干净 `npm ci` 安装、`npm test` 和 `npm run build`，退出码均为 0；17 项测试通过，TypeScript/Vite 构建包含 31 个模块，详见 [PROGRESS.md](PROGRESS.md)。2026-10-26 的中文页面和窄屏浏览器结果保留原日期；本轮浏览器工具因 kernel assets 路径故障不可用，未进行视觉复测。

[M1 verification](.github/workflows/m1.yml) 在推送 `main`、提交 PR 或手动触发时运行。2026-10-28，功能提交 `33c410d` 的 [Ubuntu CI 运行记录](https://github.com/277Wwj/newproject/actions/runs/40637798846) 全部通过：C++ 构建、3 项 CTest、前端干净安装、17 项回归测试及生产构建，最后通过真实 C++ 和 Vite 服务执行 `frontend/tests/proxy-smoke.mjs`。实际环境为 Ubuntu 24.04、GNU 13.3、Boost 1.83、nlohmann/json 3.11.3、Node 22。联调校验了中文任务、SSE 的三个有序事件、正常关闭和最终任务查询；不渲染浏览器页面，真实浏览器中的中文任务与断线恢复仍需单独验收。

## API 验收

健康检查：

```bash
curl http://localhost:8080/api/health
```

创建任务并保存返回的 `task_id`：

```bash
curl -i -X POST http://localhost:8080/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Inspect the current service health"}'
```

订阅真实 SSE（把 `<task_id>` 换成返回值）：

```bash
curl -N http://localhost:8080/api/tasks/<task_id>/events
```

预期先收到 `retry: 1000`，随后事件的 JSON `status` 依次为 `queued`、`running`、`completed`；对应的 SSE `event` 类型为 `status`、`status`、`done`。查询任务：

```bash
curl http://localhost:8080/api/tasks/<task_id>
```

异常验收预期：空 prompt、全空白 prompt 或非法 JSON 返回 HTTP 400；不存在的任务和 SSE 地址返回 HTTP 404；未知路由返回 HTTP 404。后端重启会丢失全部任务，旧 task_id 应返回 404，不能通过“重试连接”恢复。演示前请按 [DEMO.md](DEMO.md) 验证完整链路。

## 本轮尚未实现

M2 工具注册/白名单/真实 CPU 与内存采集、M3 模型适配器、M4 SQLite 事件持久化和历史回放、M5 安全审批/超时/取消、M6 测试服务压力测试与诊断报告尚未实现。当前已有 M1 测试、CI 配置和演示文档；M7 所需的产品级安装、完整自动化验收和发布文档仍未完成。M1 任务状态只在进程内存中保存，服务重启后会消失。
