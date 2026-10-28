# Nexus AI Lab：M1 演示指南

本指南演示 **React 页面 → C++ HTTP API → 内存任务 → SSE 事件** 的真实链路，适合本地操作、录屏和项目讲解。

当前 `completed` 表示 M1 生命周期流程结束，**不表示已经完成输入文字中的诊断要求**。运行时会等待约 250 ms 后进入 `running`，再等待约 650 ms 后进入 `completed`。没有调用模型、读取系统指标、执行工具或生成诊断报告。页面进度条的 18%、58%、100% 是状态对应的固定视觉提示，不是实测工作量或性能数据。

下文的命令和“预期结果”是验收方法，不代表已经在 Linux 上执行通过。本次文档编写没有在 Linux/WSL 中完成后端构建及浏览器端到端验证。

中文版实际验证记录（2026-10-26）：Windows 开发机执行 `npm run build` 返回退出码 0，Vite 6.4.5 完成 29 个模块的构建。浏览器已打开真实 Vite 页面，显示中文内容和后端离线错误。Linux CMake/CTest、真实 C++ HTTP/SSE 完整链路仍待在目标环境验证。

收尾验证记录（2026-10-28）：Windows 上干净 `npm ci` 安装、`npm test` 和 `npm run build` 均返回退出码 0；17 项协议、HTTP 和事件恢复测试通过，TypeScript/Vite 构建包含 31 个模块。本机复核仍未安装 WSL，也没有可用 Docker/Podman；本轮浏览器工具因 kernel assets 路径故障不可用，因此没有复测 10 月 26 日的视觉结果。Ubuntu CI 配置及真实 Vite→C++ 联调脚本已加入本地工作区，后者本地仅完成语法检查，真实执行待上传后的 CI。受控连接的前端测试不代表真实后端或浏览器端到端测试已经通过。

## 1. 环境准备

推荐使用 Ubuntu 24.04，或者 Windows 上的 WSL2 + Ubuntu 24.04。CMake 要求至少 3.20，C++ 标准为 C++20，Boost 至少 1.74，nlohmann/json 至少 3.11。M1 尚未链接或使用 SQLite。

### Windows 用户先准备 WSL2

在管理员 PowerShell 中执行；已有 Ubuntu 24.04 的用户无需重复安装：

```powershell
wsl --list --online
wsl --install -d Ubuntu-24.04
```

按提示重启并设置 Linux 用户名和密码，检查发行版并进入 Linux：

```powershell
wsl --list --verbose
wsl -d Ubuntu-24.04
```

预期 Ubuntu-24.04 的 `VERSION` 为 `2`；若为 `1`，在 PowerShell 执行 `wsl --set-version Ubuntu-24.04 2`。参考：[微软 WSL 命令说明](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)、[Ubuntu 的 WSL2 安装指南](https://documentation.ubuntu.com/wsl/latest/howto/install-ubuntu-wsl2/)。

**后续标记为 Bash 的命令都在 Ubuntu 终端执行，不是在 PowerShell 中执行。**

### 安装编译和演示依赖

```bash
sudo apt update
sudo apt install -y build-essential cmake libboost-system-dev \
  nlohmann-json3-dev git curl python3 nodejs npm

g++ --version
cmake --version
node --version
npm --version
```

`python3` 仅供下面的演示命令解析 JSON；应用后端仍然是 C++。当前锁文件使用 Vite 6.4.5，其 Node 要求是 `^18.0.0 || ^20.0.0 || >=22.0.0`；Node 22 或 24 也满足这一范围。若已有 Node，请先确认版本满足要求，不要仅依据 `npm` 命令可用来判断兼容性。

### 获取项目

```bash
cd ~
git clone https://github.com/277Wwj/newproject.git nexus-ai-lab
cd ~/nexus-ai-lab
```

远程仓库名为 `newproject`，上述命令将本地目录明确命名为 `nexus-ai-lab`。如果目录已经存在，直接进入已有项目，不要重复 clone。已有 Windows 项目在 WSL 中对应 `/mnt/f/codexproject/nexus-ai-lab`；以下命令统一以新克隆的 `~/nexus-ai-lab` 为例。

## 2. 分别启动后端和前端

### 终端 A：编译并启动后端

```bash
cd ~/nexus-ai-lab
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j2
./build/nexus-server 127.0.0.1 8080
```

预期最后显示：

```text
Nexus AI Lab backend listening on http://127.0.0.1:8080
```

保持这个终端运行。若编译失败，先处理 CMake 或编译器的实际错误，不要继续把后端当作已经启动。

### 终端 B：安装并启动前端

```bash
cd ~/nexus-ai-lab/frontend
npm ci
npm test
npm run dev -- --host 127.0.0.1
```

保持这个终端运行，在浏览器打开 [本地演示页面](http://localhost:5173)。开发模式使用 Vite 将 `/api` 代理到后端的 `8080` 端口，通常不需要创建 `.env`。

若已有 `.env` 设置了 `VITE_API_BASE_URL`，确认它指向本次后端，或者移除该设置以使用开发代理。环境变量在前端启动或构建时读取，修改后需要重新启动 Vite 或重新构建。

另开终端 C 执行 `curl -i http://127.0.0.1:8080/api/health`，预期 HTTP 200，JSON 包含 `status: "ok"`、`service: "nexus-server"` 和 `milestone: "M1"`。

停止时，在终端 B 按 `Ctrl+C` 停止 Vite，在终端 A 按 `Ctrl+C` 停止后端。停止后端会丢失该进程中全部任务和事件。不要用停止后端的方式演示“历史恢复”。

## 3. 3–5 分钟演示脚本

建议在正式讲解前完成依赖安装、编译和一次实际排练；安装时间不计入演示。

| 时间 | 操作 | 可以准确说明的内容 |
| --- | --- | --- |
| 0:00–0:40 | 展示页面和两个服务终端 | 目标是可观测 Agent 平台；本版先验证 C++ HTTP、内存任务与 SSE 链路。 |
| 0:40–1:20 | 输入 `演示一次任务生命周期`，点击“提交任务” | 请求发送给 C++ 服务，服务生成任务 ID；输入只被保存，尚未执行诊断语义。 |
| 1:20–2:00 | 展示时间线；页面异常时立即改用下一节的 curl | 页面预期依次显示“排队中、运行中、已完成”，协议仍为 queued、running、completed；事件含序号、时间、状态和消息。三个阶段总计约 0.9 秒，实际耗时受调度影响。 |
| 2:00–3:00 | 使用 curl 新建任务、订阅 SSE、查询任务 | 页面背后有可独立调用的真实 API；已完成任务仍可在同一后端进程中订阅已有事件。 |
| 3:00–4:00 | 演示空白输入的 400 和未知任务的 404 | 服务端负责校验输入与路由，不能仅依赖页面禁用按钮。 |
| 4:00–4:40 | 展示 CTest 命令和实际运行输出 | 只讲述本机已执行的结果；模型、系统工具、SQLite 和诊断报告属于后续里程碑。 |

**中文页面说明：** 页面默认中文，品牌名、技术名称、任务 ID 和协议保持原样。健康检查每 10 秒运行，与单任务 SSE 订阅独立。后端离线时可点击“重试连接”；任务同步异常时使用“重试同步”，关闭的连接会在查询成功且任务未结束时重建。任务完成且历史齐全后关闭订阅，查询旧任务返回 404 时停止恢复并提示重新提交。正式录屏前仍需验证完整时间线；如果页面只显示部分事件，使用下面的 HTTP/SSE 命令核对后端。

## 4. 可复制的 API 演示

以下命令在同一个 Bash 终端连续执行。后端必须保持运行。

### 创建任务并自动提取任务 ID

```bash
api_base=http://127.0.0.1:8080/api
task_json=$(curl -fsS "$api_base/tasks" \
  -H 'Content-Type: application/json' \
  --data '{"prompt":"exercise the lifecycle"}')
printf '%s\n' "$task_json" | python3 -m json.tool
task_id=$(printf '%s\n' "$task_json" | python3 -c \
  'import json, sys; print(json.load(sys.stdin)["task_id"])')
printf 'task_id=%s\n' "$task_id"
```

预期创建请求返回 HTTP 201，响应包含非空 `task_id`、原始 `prompt`、状态、时间和事件数组。以上 `curl -f` 在 HTTP 错误时会报错；没有成功提取 ID 时，应先修复创建请求再继续。

### 接收 SSE

```bash
curl --no-buffer --max-time 10 "$api_base/tasks/$task_id/events"
```

预期先收到 `retry: 1000`，随后收到序号 1、2、3 的事件。事件类型与 JSON 中的状态不同：

| `sequence` / `id` | SSE `event` 类型 | JSON `status` |
| --- | --- | --- |
| 1 | `status` | `queued` |
| 2 | `status` | `running` |
| 3 | `done` | `completed` |

最终事件消息是 `M1 execution completed; no tools are enabled yet`，随后服务端结束此 SSE 响应。即使在任务完成后执行订阅，也会从当前进程的内存中发送已有事件；这不代表已经有 SQLite 持久化或跨重启回放。

### 查询同一任务

```bash
curl -fsS "$api_base/tasks/$task_id" | python3 -m json.tool
```

在 SSE 正常结束后，预期 `status` 为 `completed`，`events` 包含三个生命周期事件。

### 验证输入和错误响应

```bash
# 空字符串：预期 400
curl -i "$api_base/tasks" -H 'Content-Type: application/json' \
  --data '{"prompt":""}'

# 全空白：预期 400
curl -i "$api_base/tasks" -H 'Content-Type: application/json' \
  --data '{"prompt":"   "}'

# 非法 JSON：预期 400
curl -i "$api_base/tasks" -H 'Content-Type: application/json' --data '{'

# prompt 类型错误：预期 400
curl -i "$api_base/tasks" -H 'Content-Type: application/json' \
  --data '{"prompt":123}'

# 不存在的任务及 SSE 地址：预期 404
curl -i "$api_base/tasks/task-does-not-exist"
curl -i "$api_base/tasks/task-does-not-exist/events"

# 已知路由的错误方法：预期 405
curl -i -X PUT "$api_base/health"
```

当前服务端通过 `std::string::size()` 限制输入，实际最大长度是 **4000 个 UTF-8 字节**，并拒绝全部为空白的字符串。中文页面使用 `TextEncoder` 对去除首尾空白后的内容计算字节数，超限时禁用提交。通常一个汉字占 3 字节，因此 1333 个“中”为 3999 字节，1334 个“中”为 4002 字节。不能把“4000 个中文字符也可提交”作为已支持能力。

### 连接中断与后端重启的区别

在后端进程仍然运行的情况下，重新执行同一任务的 SSE 命令，预期仍收到已有事件；这是本版可以直接检验的重新订阅行为。前端先校验事件的字段和任务 ID，再按 `sequence` 排序去重；连接打开、重连或收到缺失/无效事件时查询任务以补齐历史，完整终态后关闭订阅。切换任务后，旧连接和未完成 HTTP 请求的回调不能覆盖新任务。对应的受控连接回归测试见 `frontend/tests/runtime.test.mjs`，浏览器中的完整恢复链路仍需在 Linux 后端上验证。

若停止并重新启动后端，再查询原来的 `$task_id`，预期返回 HTTP 404。任务数据已经丢失，健康检查恢复在线不会恢复旧任务。短暂网络中断后的恢复测试必须保持原后端进程存活；由于任务约 0.9 秒完成，本指南不把人工切换网络作为必过的自动化验收。

## 5. 构建和验证清单

后端测试必须在已经安装依赖的 Linux/WSL 中执行：

```bash
cd ~/nexus-ai-lab
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j2
ctest --test-dir build --output-on-failure
```

预期注册并通过三个测试：

- `nexus_smoke`：任务完成且包含三个事件，延迟订阅可收到它们。
- `nexus_sse_regression`：已有事件与发布事件重复时，不重复入队。
- `nexus_http_contract`：启动真实测试后端，检查健康接口、非法 JSON、空白及错误类型、ASCII/中文 4000 字节接受与 4001 字节拒绝、任务查询、SSE 事件顺序与去重、终态关闭、完成后重放和未知任务 404。

单独重跑 HTTP 合约测试：

```bash
bash backend/tests/http_contract.sh build/nexus-server
```

它使用 `127.0.0.1:18080`，不需要停止演示用的 `8080` 服务；完成后结束自己启动的测试进程。若测试端口被占用，在命令前加 `NEXUS_TEST_PORT=18081` 指定另一个空闲端口。

前端安装、回归测试及生产构建检查：

```bash
cd ~/nexus-ai-lab/frontend
npm ci
npm test
npm run build
```

`npm test` 使用 Node 原生测试运行器，对实际 TypeScript 模块转译后测试，不增加测试框架依赖。当前 17 项测试覆盖字段和任务 ID 校验、中文/未知消息 fallback、事件合并、终态关闭、历史补齐、延迟响应隔离、404 停止恢复、手动重建关闭的连接、重连查询合并，以及 HTTP 错误转换。HTTP 和事件连接由测试替身控制，因此这些测试不访问真实 C++ 服务，也不验证浏览器渲染。

预期 `npm test`、TypeScript 检查和 Vite 构建均以退出码 0 结束，构建生成 `frontend/dist/`。需要本地预览构建产物时执行 `npm run preview -- --host 127.0.0.1`。

打开 [本地构建预览](http://localhost:4173)，同时保持后端运行。当前 preview 配置也提供 `/api` 代理；普通静态托管不自动具备这个代理，需要单独配置 API 地址或反向代理。

构建通过只证明相应构建步骤成功，不等于页面的断线恢复或 Linux 端到端测试通过。记录自己实际执行的命令、退出码及失败输出；不要把本文件的预期描述作为测试记录。

### 真实 Vite 代理与 C++ 联调

保持终端 A 的真实 C++ 后端监听 `127.0.0.1:8080`，终端 B 的 Vite 监听 `127.0.0.1:5173`，再在另一个终端用 Node 22 执行：

```bash
cd ~/nexus-ai-lab/frontend
node tests/proxy-smoke.mjs
```

该脚本检查页面 HTML 的 `lang="zh-CN"`，通过 Vite `/api` 代理向真实后端创建中文任务，校验 SSE 序号 `1/2/3`、状态 `queued/running/completed` 和终态后的正常关闭，再查询任务确认中文内容与 `completed` 状态。它不使用模拟后端，也不运行浏览器或验证页面渲染。2026-10-28 本地只通过 `node --check tests/proxy-smoke.mjs` 语法检查，真实运行结果待 CI。

### GitHub Actions

`.github/workflows/m1.yml` 在推送 `main`、提交 PR 或手动触发时运行，环境为 Ubuntu 24.04 / Node 22。它先安装 Boost/json 开发包、构建真实 C++ 后端并执行三个 CTest，再执行前端 `npm ci`、`npm test` 和 `npm run build`，最后启动两个真实服务执行上述代理联调。本轮工作流待上传后执行；CI 结果应关联实际提交和运行记录，不能依据配置文件存在宣称通过。该工作流不包含真实浏览器端到端测试。

### 中文页面验收

1. 保持后端关闭，打开前端。预期显示“后端离线”、中文错误和“重试连接”，时间线为空。网络面板中健康检查应约每 10 秒一次，不应连续刷屏。
2. 点击“重试连接”。预期发起一次检查；后端尚未启动时仍显示离线，不能虚报在线。
3. 清空输入或只输入空格。预期“提交任务”不可用。输入 `中文任务`，预期计数为 12 字节且可提交。
4. 输入 1333 个“中”，预期 3999 字节且可提交；再增加一个“中”，预期 4002 字节、中文超限提示且禁止提交。
5. 启动真实 C++ 后端，等待自动检查或点击“重试连接”，预期“后端在线”；提交中文任务，预期中文状态和三条真实生命周期事件。
6. 查询原始 API 响应，确认 `prompt` 保留中文，协议状态仍是英文。已完成事件在网页显示“M1 生命周期演示已完成，尚未启用工具”。
7. 在窄屏和桌面宽度检查中文换行、按钮、长文本和错误提示，不应出现整页横向滚动。

第 1–4、7 项的已有视觉/交互记录来自 2026-10-26；2026-10-28 浏览器工具不可用，未对最终改动复测。第 5–6 项依赖真实 Linux 后端，本机仍未验证。最终版本还需检查异常同步时的“重试同步”、任务切换后的事件隔离和完成后的连接关闭；前端回归测试不能代替这些浏览器验收。

## 6. 打不开时按现象排查

Linux/WSL 中先检查监听端口：

```bash
ss -ltnp '( sport = :5173 or sport = :8080 or sport = :4173 )'
curl -i http://127.0.0.1:8080/api/health
curl -I http://127.0.0.1:5173
```

| 现象 | 优先检查 | 处理方式 |
| --- | --- | --- |
| 浏览器 `ERR_CONNECTION_REFUSED`，5173 无监听 | 终端 B 的 Vite 输出 | 在 `frontend` 执行 `npm ci` 后启动 `npm run dev`，保持终端运行。 |
| 页面能开，8080 无监听 | 终端 A 是否编译成功、有无启动错误 | 修复实际构建错误，启动 `nexus-server`。 |
| `Port 5173 is already in use` | `ss` 显示的监听进程 | 找到此前启动的 Vite，在它的终端停止或直接使用它；不要盲目终止其他程序。 |
| `ENOTFOUND registry.npmjs.org` 或安装超时 | DNS、代理和网络连接 | 修复当前网络后重试 `npm ci`；没有依赖时页面无法正常启动。 |
| CMake 找不到 Boost/json | 依赖安装输出及版本 | 在 Ubuntu 安装对应开发包，确认 Boost ≥ 1.74、json ≥ 3.11。 |
| 页面一直显示“后端离线”或时间线不完整 | 8080 服务、API 代理、curl 是否可收到三个事件 | 启动后端后点击“重试连接”；如果仍失败，保留实际错误和 curl 输出，不将前端构建成功解释为 SSE 已验证。 |
| 重启后旧任务返回 404 | 是否更换了后端进程 | 这是内存任务的边界，重新提交任务。 |
| Ubuntu 内访问成功，Windows 浏览器访问失败 | WSL 网络配置及 localhost 转发 | 先确认两个服务在同一 WSL 发行版中运行，再按 [WSL 网络文档](https://learn.microsoft.com/en-us/windows/wsl/networking) 排查；不必先更换项目技术栈。 |

本轮演示止于 M1。工具白名单、CPU/内存/日志读取、模型 API Key、SQLite、压力测试和诊断报告均不需要配置，也尚未实现。
