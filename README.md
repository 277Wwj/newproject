# Nexus AI Lab — M1

Nexus AI Lab 是一个 Linux-first 的可观测 AI Agent 执行与性能诊断平台。本轮只交付 M1：React + TypeScript 页面可以提交任务，C++20/Boost.Beast 服务创建内存任务，并通过 SSE 推送真实的 `queued → running → completed` 生命周期事件。

## 环境审计

当前开发机是 Windows PowerShell。已确认 CMake 4.4.1、MinGW-w64 GCC 16.1.0、Node 26.3.0 和 npm 11.16.0 可用，但没有安装 Linux/WSL 发行版，也没有发现 Boost.Beast、nlohmann/json、SQLite 开发头文件。因此本机不能证明 Linux 后端已经编译；以下后端步骤必须在 Ubuntu/Debian Linux 或已安装发行版的 WSL 中执行。本轮没有静默替换技术栈。

如果浏览器提示连接被拒绝，先确认两个服务是否分别启动：前端默认监听 `5173`，后端监听 `8080`。Windows PowerShell 可用下面的命令检查端口：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 5173,8080
```

`5173` 没有监听表示 Vite 没启动；`8080` 没有监听表示 `nexus-server` 没启动。前端页面可以在后端未启动时打开，但任务提交和健康检查会显示离线错误，启动后点击 Retry 即可恢复。

Linux 依赖：

```bash
sudo apt update
sudo apt install -y build-essential cmake libboost-system-dev nlohmann-json3-dev libsqlite3-dev nodejs npm curl
```

## 目录和职责

```text
nexus-ai-lab/
├── CMakeLists.txt                  # C++20 构建、依赖和 CTest
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
│   └── tests/smoke.cpp              # 可重复的任务生命周期测试
├── frontend/
│   ├── src/App.tsx                 # 任务提交、状态和时间线
│   ├── src/api.ts                  # HTTP API 客户端
│   ├── src/types.ts                # 前后端共享的 TS 数据形状
│   ├── src/vite-env.d.ts            # Vite 环境变量类型声明
│   ├── src/styles.css              # M1 操作台界面
│   ├── index.html                  # Vite 入口
│   ├── package.json                # React/Vite 依赖和脚本
│   ├── package-lock.json           # 可重复安装的依赖锁定
│   ├── tsconfig*.json              # TypeScript 配置
│   └── vite.config.ts              # 开发代理 /api → C++ 服务
└── README.md
```

依赖方向是 `main → HttpServer → TaskManager/SseHub`；HTTP 层不执行任意命令，TaskManager 也没有模型或工具依赖。前端只依赖 HTTP 和 SSE，Vite 开发服务器把 `/api` 转发到 `localhost:8080`。

## 构建和启动

后端（Linux/WSL）：

```bash
cd nexus-ai-lab
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j
ctest --test-dir build --output-on-failure
./build/nexus-server 0.0.0.0 8080
```

`nexus_smoke` 检查任务生命周期和延迟建立 SSE 订阅时的事件回放。Linux 上的 `nexus_http_contract` 会启动真实服务并检查健康检查、任务创建、SSE、404，以及空白 prompt 拒绝。全部测试通过后，HTTP 合约中的空白 prompt 检查应返回 HTTP 400。

前端（另一个终端）：

```bash
cd nexus-ai-lab/frontend
npm ci
npm run dev
```

`npm ci` 需要访问 npm registry，并依赖提交的 `package-lock.json`。如果出现 `ENOTFOUND registry.npmjs.org`，这是当前网络/DNS 环境无法访问 npm registry，需要切换到可联网环境后再执行安装。

开发模式不需要设置 API 环境变量，Vite 会把 `/api` 代理到 `http://localhost:8080`。使用 `npm run preview` 或独立静态托管时，可以复制 `frontend/.env.example` 为 `.env`，将 `VITE_API_BASE_URL` 设置为后端 API 的完整地址，例如 `http://localhost:8080/api`。

浏览器打开 <http://localhost:5173>。

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

预期能看到 `retry`、`queued`、`running` 和 `done` 事件。查询任务：

```bash
curl http://localhost:8080/api/tasks/<task_id>
```

异常验收：空 prompt、全空白 prompt 或非法 JSON 返回 HTTP 400；不存在的任务和 SSE 地址返回 HTTP 404；未知路由返回 HTTP 404。停止后端时前端应显示离线/重连提示，重新启动后点击 Retry 可恢复健康状态。

## 本轮尚未实现

M2 工具注册/白名单/真实 CPU 与内存采集，M3 模型适配器，M4 SQLite 事件持久化和历史回放，M5 安全审批/超时/取消，M6 测试服务压力测试与诊断报告，以及 M7 安装、自动化测试和发布文档都没有提前实现。M1 任务状态只在进程内存中保存，服务重启后会消失。
