# Codex CLI Phase Model Switcher — Architecture SPEC

**Version:** `0.0.1`  
**Maturity:** Pre-Alpha / Frozen Architecture Baseline  
**Status:** Architecture Frozen  
**Date:** 2026-09-25  
**Target:** Codex CLI only

---

## 1. Document Purpose

本文档定义一个面向 **Codex CLI** 的极简 Phase Model Switcher 架构。

该工具不再实现完整的 Phase-Aware Planning Harness。它只保留其中最小、最明确的一项能力：

> 根据 Codex 原生 collaboration mode 的切换，在 **Plan** 与 **Default** 两个阶段之间自动切换配置好的模型。

本版本是 `0.0.1`，而不是 `0.1.0`。原因是当前状态属于：

- 顶层架构已经冻结；
- 核心运行语义已经明确；
- 但实现语言、依赖库、CLI 命名、配置文件路径、超时数值、打包方式等仍未冻结；
- 尚未形成首个可视为完整最小产品版本的 `0.1.x`。

因此 `0.0.1` 用作首个 **Pre-Alpha Architecture Freeze** 基线。

---

## 2. Product Definition

### 2.1 Core Goal

在 Codex CLI 中自动实现：

```text
Default mode → execution_model
Plan mode    → planning_model
```

默认概念配置：

```text
planning_model  = Sol
execution_model = Luna
reasoning_effort = xhigh
```

以上三项均可配置。

其中 `Sol` 与 `Luna` 是架构层的默认模型角色/名称表达。实际实现必须把具体 Codex model identifier 作为配置值处理，不应把 provider-specific model slug 硬编码进核心路由逻辑。

---

### 2.2 Product Semantics

本工具提供的是：

> **phase-triggered model switching**

而不是：

> phase-locked model enforcement

也就是说：

1. 启动 managed Codex session 时，为 Default mode 设置 `execution_model`；
2. 首次观察到当前 mode 时，对当前 thread 做一次模型 reconciliation；
3. 当 Codex 原生 mode 从 Default 切换为 Plan 时，设置 `planning_model`；
4. 当 Codex 原生 mode 从 Plan 切换为 Default 时，设置 `execution_model`；
5. mode 未变化时，不干预模型；
6. 用户手动 `/model` 后发生什么，不属于本工具的管理范围；
7. 不进行 per-turn enforcement。

---

## 3. Explicit Non-Goals

以下内容明确不属于 `0.0.1` 架构，也不应在实现过程中被“顺手加入”。

### 3.1 No Full Phase Plan Runtime

不实现：

- PlanningRun
- Proposal / Approval / Commit
- Plan Memory
- Evidence model
- Section DAG
- Synthesis
- Finalization
- Execution Handoff
- Planning state machine
- planning database
- persistent planning session state

### 3.2 No Model Enforcement

不实现：

- 每个 `turn/start` 强制检查模型
- phase model lock
- `/model` override 检测
- `/model` provenance 判断
- automatic model update provenance 判断
- 用户手动模型切换纠正
- `config/batchWrite` 拦截
- model persistence interception

### 3.3 No Proxy

不实现任何位于 TUI 与 app-server 之间的数据面 Proxy。

因此不做：

- JSON-RPC forwarding
- request rewriting
- response rewriting
- transparent protocol proxying
- `turn/start` interception

### 3.4 No Plugin / Hook / MCP Layer

不使用：

- Plugin
- MCP
- Skill
- Hook

来承担模型切换。

### 3.5 No Persistent Runtime Store

不使用：

- SQLite
- state file
- PID registry
- session database
- global daemon registry

Controller state 全部为 session-local、in-memory transient state。

---

## 4. Architecture Principles

### 4.1 Native Phase Authority

Codex 原生 collaboration mode 是唯一 phase authority。

工具不通过以下方式猜测 phase：

- 用户 prompt 内容
- `/plan` 字符串解析
- TUI 按键
- prompt complexity
- LLM semantic classification
- turn content
- tool use

只读取 Codex app-server 暴露的 collaboration mode。

当前架构只关心两个 Codex 原生 mode：

```text
Default
Plan
```

---

### 4.2 Model Switching Is an Event Reaction

模型切换由 mode transition 触发：

```text
Default → Plan
    set planning_model

Plan → Default
    set execution_model
```

首次观察真实 thread 的 mode 时，也执行一次 reconciliation：

```text
first observed Default
    set execution_model

first observed Plan
    set planning_model
```

除此之外，Controller 不持续纠正模型。

---

### 4.3 Codex Remains the Authoritative Runtime

Codex app-server 是：

- thread authority
- collaboration-mode authority
- model application authority
- conversation runtime authority

本工具只调用 Codex 已有的 settings control surface。

工具不得创建独立的 conversation truth、phase truth 或 model truth。

---

## 5. Frozen Runtime Topology

最终冻结拓扑：

```text
                 phase-model launcher
                         │
          ┌──────────────┴──────────────┐
          │                             │
          │ internal Model Controller   │
          │                             │
          └──────────────┬──────────────┘
                         │
                         │ WebSocket
                         ▼
                dedicated app-server
                   ▲             ▲
                   │             │
                   │             │
             Codex TUI      Controller
```

更精确地：

```text
Codex TUI
    │
    │ ws://127.0.0.1:<session-port>
    ▼
session-dedicated authoritative app-server
    ▲
    │ ws://127.0.0.1:<session-port>
    │
launcher-internal Model Controller
```

### 5.1 One Dedicated App-Server Per Managed Session

每次启动本工具，都创建一个新的 session-dedicated app-server。

不使用：

- TUI embedded app-server
- shared global daemon
- implicit daemon discovery
- 多 managed TUI 共享同一个 app-server

目的不是增加隔离层，而是消除 thread correlation 复杂度。

---

## 6. Process Model

Launcher 是唯一 supervisor。

其内部包含：

```text
phase-model launcher
│
├── internal async ModelController
│
├── child process: codex app-server
│
└── child process: codex TUI
```

Controller **不是独立 executable / daemon**。

这样避免：

- controller process discovery
- controller PID lifecycle
- third process supervision
- extra IPC between launcher and controller

---

## 7. Transport

### 7.1 Frozen Transport Choice

使用：

```text
Loopback WebSocket
```

固定 bind host：

```text
127.0.0.1
```

不使用：

- Unix domain socket
- public network interface
- remote host
- `0.0.0.0`
- filesystem socket

---

### 7.2 Session Port Allocation

app-server 使用：

```text
ws://127.0.0.1:0
```

让操作系统分配 ephemeral port。

禁止 launcher 自己维护随机端口池。

禁止：

```text
choose candidate P
probe P
close P
spawn app-server(P)
```

避免自行制造 TOCTOU。

---

### 7.3 Endpoint Discovery

启动 app-server 后：

1. launcher 捕获 app-server startup stderr；
2. 从 startup output 中提取第一个有效的 loopback WebSocket endpoint；
3. 提取结果必须满足：

```text
scheme == ws
host   == 127.0.0.1
port   != 0
```

4. 不依赖固定的人类可读前缀，例如：

```text
"listening on:"
```

parser 应只依赖可识别的有效 `ws://127.0.0.1:<port>` token。

实际 endpoint 记为：

```text
E = ws://127.0.0.1:P
```

---

### 7.4 Readiness

发现 P 后，不把 startup banner 等价为 ready。

launcher 必须使用：

```text
GET http://127.0.0.1:P/readyz
```

直到：

```text
HTTP 200
```

才进入 Controller bootstrap。

因此 app-server bootstrap 是两阶段：

```text
endpoint discovered
        ↓
/readyz == 200
        ↓
server ready
```

---

## 8. Startup Lifecycle

冻结启动顺序：

```text
1. Load local configuration

2. Spawn:
   codex app-server --listen ws://127.0.0.1:0

3. Discover actual loopback WebSocket endpoint E

4. Wait until /readyz == 200

5. Internal Controller connects to E

6. Controller performs app-server initialize
   with experimentalApi = true

7. Controller sends initialized

8. Controller enters listening state

9. Launch Codex TUI
   explicitly connected to E

10. Run managed session
```

关键顺序 invariant：

```text
Controller ready
    BEFORE
Codex TUI launch
```

这保证 Controller 能从 thread 生命周期开始就观察真实 TUI thread，而不需要后补查询当前 thread。

---

## 9. Initial Codex Session Defaults

Launcher 启动 Codex TUI 时，应通过 Codex 原生 startup configuration/CLI override 传入：

```text
model = execution_model
reasoning_effort = configured reasoning_effort
```

默认：

```text
execution_model = Luna
reasoning_effort = xhigh
```

具体 CLI 参数拼装方式属于 implementation detail，不在 Architecture SPEC 中冻结。

Controller 的首次 reconciliation 仍然保留，用于：

- 验证 settings control path；
- 覆盖 resume thread 的实际 mode；
- 对齐首次观测到的 Plan / Default mode。

---

## 10. Controller Responsibilities

Controller 的职责严格限定为：

### Observe

```text
thread/started
thread/settings/updated
```

### Track

```text
current_thread_id
last_mode
```

### Act

```text
first observed Default
    → set execution_model

first observed Plan
    → set planning_model

Default → Plan
    → set planning_model

Plan → Default
    → set execution_model
```

### Ignore

```text
same-mode model changes
manual /model
manual reasoning effort changes
turn lifecycle
prompt content
tool activity
conversation content
```

---

## 11. Minimal Controller State

Controller 最小 session state：

```text
ControllerState {
    current_thread_id: Optional<ThreadId>
    last_mode: Optional<ModeKind>
}
```

架构层明确不需要：

```text
current_model
manual_override
expected_model
pending_transition
planning_run
phase_history
persistent_state
```

---

## 12. Thread Binding

### 12.1 Thread Discovery

Controller 通过：

```text
thread/started
```

获得真实 thread metadata 与 thread ID。

### 12.2 Top-Level Thread Only

Controller 只管理 TUI 的 top-level thread。

child/subagent thread 不进入 model switching scope。

在当前 Codex thread metadata 中，可利用 top-level / parent relationship 过滤 child thread；实现必须依赖 Codex thread metadata，而不是 cwd/time-window 等启发式相关性。

### 12.3 Current Thread

当 dedicated app-server 上的 TUI 启动或恢复新的 top-level thread 时：

```text
current_thread_id = new_top_level_thread_id
last_mode = None
```

随后等待该 thread 的 settings notification 进行首次 reconciliation。

由于该 app-server 是 session-dedicated，因此不需要解决多个独立 TUI client 的 thread attribution 问题。

---

## 13. Collaboration Mode Observation

Controller 从：

```text
thread/settings/updated
```

中读取：

```text
thread_settings.collaboration_mode.mode
```

当前架构识别：

```text
Default
Plan
```

未知 mode 不应被猜测映射到 Default 或 Plan。

未知 mode 的具体错误/降级表现属于 implementation error-handling detail，但不得触发错误模型映射。

---

## 14. Model Application

模型切换通过 Codex app-server settings control surface完成。

概念操作：

```text
thread/settings/update(
    threadId = current_thread_id,
    model = desired_model
)
```

Controller 只更新：

```text
model
```

不得顺带修改：

- collaboration mode
- reasoning effort
- sandbox
- approval policy
- permissions
- cwd
- service tier
- user content
- plugin configuration

---

## 15. Mode Transition Algorithm

核心算法：

```text
on_settings_updated(thread_id, settings):

    if thread_id != current_thread_id:
        ignore
        return

    mode = settings.collaboration_mode.mode

    if last_mode is None:
        apply(model_for(mode))
        last_mode = mode
        return

    if mode == last_mode:
        ignore
        return

    apply(model_for(mode))
    last_mode = mode
```

映射：

```text
model_for(Default) = execution_model
model_for(Plan)    = planning_model
```

Controller 自己发出的 model update 可能再次触发：

```text
thread/settings/updated
```

但因为 mode 未变化：

```text
mode == last_mode
```

所以天然不会产生循环。

---

## 16. Manual `/model` Semantics

这是显式冻结的范围边界。

如果用户在当前 mode 中执行：

```text
/model X
```

Controller：

```text
does nothing
```

原因：

```text
mode unchanged
```

用户手动切换后的模型行为不属于本工具保证。

直到下一次真实 mode transition：

```text
Default → Plan
```

或：

```text
Plan → Default
```

Controller 才再次应用 phase configured model。

因此本工具不需要识别：

- `/model`
- model change source
- user intent
- automatic fallback
- config persistence

---

## 17. Reasoning Effort Semantics

`reasoning_effort` 是 configurable startup default。

默认：

```text
xhigh
```

Controller 不做 phase-specific effort switching。

Controller 不持续 enforce effort。

如果用户在 session 中手动改变 reasoning effort：

```text
out of scope
```

不会触发 Controller 纠正。

---

## 18. Capability Verification

采用：

> **runtime capability verification**

而不是：

> static Codex semver allowlist

### 18.1 Pre-TUI Bootstrap Gate

TUI 启动前必须成功：

```text
1. app-server process started
2. endpoint discovered
3. /readyz == 200
4. Controller WebSocket connected
5. initialize succeeded
6. experimentalApi = true requested/accepted
7. initialized sent
```

只有这些条件满足，才启动 managed Codex TUI。

---

### 18.2 First Real Thread Gate

不创建 dummy thread。

不发送 fake thread ID probe。

真实 TUI thread 出现后，第一次正常业务操作本身就是 capability verification：

```text
thread/started
    ↓
thread/settings/updated
    ↓
recognize collaboration mode
    ↓
thread/settings/update(model=desired)
```

如果成功：

```text
Controller ACTIVE
```

这样首次 reconciliation 同时完成：

- capability verification
- initial model alignment

---

### 18.3 Required Protocol Surface

架构真正依赖的 app-server surface 仅限：

```text
initialize / initialized

thread/started

thread/settings/updated

thread/settings/update
```

另外 transport bootstrap 使用：

```text
WebSocket listener
/readyz
```

不把以下 API 纳入核心依赖：

```text
turn/start
turn/started
turn/completed
thread/read
thread/list
thread/resume
thread/fork
model/list
config/*
account/*
MCP/*
plugin/*
approval/*
```

---

## 19. No Static Version Gate

第一版不维护：

```text
Codex >= X
Codex <= Y
```

这样的硬编码 semver allowlist。

原因：

- 核心依赖包含 experimental settings surface；
- 版本号并不能可靠证明某个 experimental behavior 仍然兼容；
- runtime probe 更贴近真正依赖。

Initialize response 中可获取的 Codex/server identity/version 信息仅用于：

```text
diagnostics
logs
error reporting
```

不得作为主要 capability truth。

---

## 20. Optional `model/list`

`model/list` 不属于 architecture-required capability。

第一版可以不调用。

如果未来实现使用它提前验证：

- `planning_model`
- `execution_model`
- reasoning effort support

它只能作为 UX enhancement。

不能把整个 Controller architecture 建立在 `model/list` 上。

配置的 model identifier 最终由 Codex 自己接受或拒绝。

---

## 21. Failure Semantics

### 21.1 Pre-TUI Bootstrap Failure

如果在 TUI 启动前发生：

- app-server 无法启动
- endpoint 无法发现
- `/readyz` 失败
- Controller 无法连接
- initialize 失败

则：

```text
managed session startup fails
Codex TUI is not launched
```

这是启动前置条件失败，不属于 runtime fail-open。

---

### 21.2 Controller Runtime Failure — FAIL OPEN

一旦 TUI 已启动，Controller/control-channel 后续失效时采用：

```text
FAIL OPEN
```

包括但不限于：

- Controller WebSocket disconnect
- settings protocol parsing failure
- first-real-thread settings capability 不兼容
- later settings update failure
- Controller internal runtime error

行为：

```text
emit one prominent warning
        ↓
disable automatic phase model switching
        ↓
Codex TUI continues normally
```

警告语义应清楚表达：

```text
Automatic phase model switching is disabled
for the remainder of this session.
```

之后：

- 不再尝试恢复 Controller；
- 不重连；
- 不 restart app-server；
- 不重建 state；
- 用户可以继续使用普通 Codex，包括手动 `/model`。

---

### 21.3 App-Server Failure — TERMINAL

如果 authoritative app-server 在 TUI 运行期间意外退出：

```text
managed runtime no longer exists
```

因此：

```text
terminate/allow TUI to fail
stop Controller
cleanup child processes
launcher exits with error
```

不做：

- app-server restart
- thread reconstruction
- auto resume
- transparent session recovery

---

## 22. Shutdown Lifecycle

正常退出：

```text
Codex TUI exits
        ↓
cancel Controller task
        ↓
close Controller WebSocket
        ↓
terminate dedicated app-server
        ↓
launcher exits
```

app-server cleanup 允许：

```text
graceful termination
        ↓
if still alive
        ↓
force kill fallback
```

禁止遗留 managed orphan app-server。

---

## 23. Security Boundary

本工具只对：

```text
127.0.0.1
```

创建 session-local WebSocket listener。

不得监听：

```text
0.0.0.0
public interface
LAN interface
remote host
```

Controller 只能修改：

```text
thread model
```

不得修改：

- authentication
- account
- entitlements
- rate limits
- sandbox policy
- approval policy
- permission profile
- tool permissions
- safety behavior
- conversation payload
- user messages
- server capability responses

工具不代理 app-server 到 OpenAI 的网络通信，也不拦截 OpenAI HTTPS traffic。

---

## 24. Data and Persistence Model

该工具没有自己的持久业务数据。

Session transient values包括：

```text
app_server_endpoint
app_server_child_handle
tui_child_handle
current_thread_id
last_mode
controller_health
```

这些数据：

```text
exist only in launcher memory
```

Launcher 退出后全部消失。

Codex thread/history persistence 继续完全由 Codex 自己负责。

---

## 25. Configuration Contract

架构层最小配置：

```toml
planning_model = "<planning model id>"
execution_model = "<execution model id>"
reasoning_effort = "xhigh"
```

概念默认值：

```text
planning_model  → Sol
execution_model → Luna
reasoning_effort → xhigh
```

以下内容在 `0.0.1` Architecture SPEC 中故意不冻结：

- 配置文件名
- 配置文件路径
- TOML / YAML / JSON 最终格式
- environment variable names
- CLI flag names
- config precedence
- provider-specific validation
- exact model slugs

---

## 26. Architecture Invariants

### A1 — Codex Native Mode Is Authoritative

```text
phase := Codex collaboration mode
```

不得使用语义分类器替代。

### A2 — Dedicated Runtime

一个 managed CLI session 对应一个 dedicated app-server。

### A3 — Same Explicit Endpoint

TUI 与 Controller 必须显式连接同一个 endpoint。

### A4 — Loopback Only

endpoint 必须是：

```text
ws://127.0.0.1:<nonzero-port>
```

### A5 — OS Port Allocation

app-server bind 使用 port `0`。

### A6 — Controller Before TUI

Controller 完成 bootstrap initialization 后才能启动 TUI。

### A7 — Event-Triggered Switching

只有：

```text
first observed mode
mode transition
```

触发自动模型设置。

### A8 — No Per-Turn Enforcement

Controller 不检查每个 turn 的 effective model。

### A9 — Manual Model Changes Are Out of Scope

same-mode model changes不得触发“纠正”。

### A10 — Model-Only Mutation

Controller settings action只修改 `model`。

### A11 — No Persistent Controller State

Controller 不创建业务数据库或 state file。

### A12 — Runtime Capability Verification

不依赖静态版本号证明 settings capability。

### A13 — Controller Failure Is Fail-Open

TUI 已启动后 Controller 失败：

```text
warn once → disable automation → TUI continues
```

### A14 — App-Server Failure Is Terminal

authoritative runtime 退出后不尝试透明恢复。

---

## 27. Reference Runtime Sequence

### 27.1 Fresh Session

```text
Launcher
   |
   | spawn app-server :0
   v
App-Server
   |
   | report actual 127.0.0.1:P
   |
Launcher
   |
   | GET /readyz
   | 200
   |
   | connect Controller
   v
Controller
   |
   | initialize(experimentalApi=true)
   | initialized
   |
Launcher
   |
   | launch Codex TUI
   | initial model = execution_model
   | initial effort = configured effort
   v
Codex TUI
   |
   | starts top-level thread
   v
App-Server
   |
   | thread/started
   | thread/settings/updated(Default)
   v
Controller
   |
   | first reconciliation
   | thread/settings/update(execution_model)
   v
ACTIVE
```

---

### 27.2 Enter Plan

```text
Codex TUI
   |
   | native mode change
   | Default → Plan
   v
App-Server
   |
   | thread/settings/updated(mode=Plan)
   v
Controller
   |
   | planning_model
   | thread/settings/update(model=planning_model)
   v
App-Server
```

---

### 27.3 Manual `/model`

```text
Current mode = Plan
Current model = planning_model

User:
    /model X

App-Server:
    settings model changes to X

Controller:
    observes mode == Plan
    last_mode == Plan
    does nothing
```

---

### 27.4 Leave Plan

```text
Current:
    Plan / manually-selected X

Codex TUI:
    Plan → Default

Controller:
    sees mode transition

Controller:
    set execution_model
```

---

### 27.5 Controller Failure

```text
Controller WebSocket
        X

Launcher:
    warn once
    mark controller disabled

Codex TUI:
    continues using Codex normally
```

---

## 28. Implementation Decisions Deferred

以下问题不再属于 architecture blocking decisions。

它们应在 Implementation SPEC 中决定。

### 28.1 Programming Language

未冻结：

- Rust
- Go
- Python
- other

### 28.2 Library Choices

未冻结：

- WebSocket client library
- HTTP readiness client
- subprocess supervisor library
- async runtime

### 28.3 CLI/Product Naming

“Codex CLI Phase Model Switcher”是本文档 working architecture name。

最终 binary name / package name 未冻结。

### 28.4 Configuration Surface

未冻结：

- file location
- file syntax
- CLI override syntax
- environment variables
- precedence

### 28.5 Timeouts

未冻结：

- endpoint discovery timeout
- `/readyz` timeout
- WebSocket connect timeout
- shutdown grace period

### 28.6 Logging

未冻结：

- structured vs text logging
- log levels
- file logging
- diagnostic bundle

### 28.7 Packaging

未冻结：

- single binary
- pip/npm/cargo packaging
- installer
- release channel

### 28.8 Compatibility Testing

未冻结 exact CI matrix，但实现测试至少应覆盖：

```text
fresh Default session
Default → Plan
Plan → Default
manual /model within same mode
resume into Plan
controller disconnect
app-server crash
parallel launcher sessions
```

---

## 29. Acceptance Criteria for the First Implementation

实现可以被视为符合本 Architecture SPEC，当且仅当：

1. 能启动一个 session-dedicated Codex app-server；
2. app-server 使用 `127.0.0.1:0`；
3. launcher 能发现 OS 分配的实际 WebSocket endpoint；
4. `/readyz` 成功后才继续；
5. Controller 在 TUI 前完成 initialize；
6. TUI 与 Controller 连接同一个 explicit endpoint；
7. Controller 能识别 top-level thread；
8. Controller 能读取 Default / Plan collaboration mode；
9. first observed Default 会设置 `execution_model`；
10. first observed Plan 会设置 `planning_model`；
11. Default → Plan 会设置 `planning_model`；
12. Plan → Default 会设置 `execution_model`；
13. same-mode `/model` 不会被 Controller 撤销；
14. reasoning effort 不被 Controller持续 enforce；
15. Controller 不拦截 `turn/start`；
16. 不存在 Proxy；
17. 不创建持久化 runtime store；
18. Controller runtime failure 后 TUI 继续；
19. Controller failure 会出现明确一次性 warning；
20. app-server failure 不会被透明隐藏或自动重建；
21. TUI 退出后 dedicated app-server 被确定性清理。

---

## 30. Relationship to the Original Phase-Aware Planning Harness

本架构不是完整 Phase-Aware Planning Harness 的 Codex port。

它只抽取其中：

```text
phase → model
```

这一层最小 Model Policy 概念，并把 phase authority 交给 Codex 原生 collaboration mode。

因此：

```text
Original concept:
    Planning Harness
        ├─ planning protocol
        ├─ state
        ├─ memory
        ├─ evidence
        ├─ approval
        ├─ synthesis
        ├─ finalization
        └─ model policy

Codex v0.0.1:
    native Codex collaboration mode
        ↓
    minimal model switcher
```

这是主动的产品范围收缩，而不是未完成的 Harness 实现。

---

## 31. Upstream Codex Dependency Notes

本文档在 2026-09-25 生成时，架构所依赖的 Codex upstream concepts 已对照 `openai/codex` 当前源码确认，包括：

```text
codex-rs/protocol/src/config_types.rs
    ModeKind::{Default, Plan}
    CollaborationMode

codex-rs/app-server-protocol/src/protocol/v2/thread.rs
    ThreadSettings
    ThreadSettingsUpdatedNotification
    thread settings update structures

codex-rs/app-server-protocol/src/protocol/common.rs
    thread/started
    experimental settings protocol registration
    initialize experimentalApi capability

codex-rs/app-server/
    WebSocket app-server transport
    /readyz

codex-rs/tui/
    native collaboration-mode state
```

这些是 implementation dependency，而不是本工具自己重新定义的协议。

由于 settings control surface 包含 experimental API，本工具采用 runtime capability verification；未来 Codex upstream schema 变化时，应更新 adapter implementation，而不是扩大本 Architecture SPEC 的职责范围。

---

## 32. Frozen Architecture Summary

最终架构可以压缩为：

```text
CONFIG
    planning_model
    execution_model
    reasoning_effort

        ↓

Launcher
    ├─ spawn dedicated app-server
    │      ws://127.0.0.1:0
    │
    ├─ discover actual endpoint
    ├─ /readyz
    │
    ├─ initialize Controller
    │
    └─ launch Codex TUI

                ↓

Native Codex collaboration mode

    Default ───────────────► execution_model
       ▲
       │
       │
       ▼
     Plan ─────────────────► planning_model

Rules:
    first observed mode → reconcile once
    mode transition     → switch once
    same-mode /model    → ignore
    no per-turn enforcement
    no Proxy
    no persistence

Failure:
    Controller → fail-open
    app-server → terminal
```

---

## 33. Architecture Freeze Statement

`v0.0.1` 冻结以下核心决策：

- Codex CLI only
- phase-triggered model switching only
- native collaboration mode as phase authority
- Plan → configurable planning model
- Default → configurable execution model
- configurable startup reasoning effort
- side Controller, not Proxy
- Controller embedded inside launcher
- session-dedicated authoritative app-server
- Loopback WebSocket
- OS-assigned ephemeral port via `127.0.0.1:0`
- endpoint discovery + `/readyz`
- Controller initializes before TUI
- first-real-thread runtime capability verification
- no static Codex semver gate
- no manual `/model` management
- no per-turn enforcement
- no persistent state
- Controller failure = fail-open
- app-server failure = terminal

任何改变以上项目的后续设计，都应视为 Architecture SPEC revision，而不是普通 implementation detail。

---

**End of Codex CLI Phase Model Switcher Architecture SPEC v0.0.1**
