# Approx Quick Know

> 给后来接手的人和 Agent 的项目地图。先读这一份，再按任务定位文件；通常不需要先通读 `src/`。
> 最后复核：2026-08-09（v0.1.0）。

## 一句话理解

Approx 是 Windows Terminal 上的 Node.js ESM TUI。它自己负责终端、交互、状态和展示，把模型、工具、会话树、上下文压缩、技能/Prompt 加载交给 Pi runtime。

核心闭环：

```text
键盘/鼠标
  -> App 输入路由
  -> 命令或 turn 队列
  -> PiBackend / scripted / harness
  -> 结构化 backend event
  -> App transcript/state
  -> render -> Screen 双缓冲 diff -> 终端
```

## 先看哪些文件

按这个顺序可理解 80% 的项目：

1. `bin/approx.js`：CLI 参数和运行模式。
2. `src/app.js`：App 构造、生命周期、所有 behavior 的装配点。
3. `src/app-state.js`：完整 UI 状态树及默认值。
4. `src/app-input.js`、`src/app-turns.js`、`src/queue.js`：输入如何变成一轮请求。
5. `src/backend-bridge.js`：backend event 如何落到 UI。
6. `src/app-transcript.js`：消息、WORK、Tool Calls、File Edit、FILE CHANGES 如何成树。
7. `src/app-render.js`、`src/screen.js`：一帧如何组成并只写脏单元格。
8. `src/backends/pi.js` 与 `src/backends/pi/`：Pi 适配层。

只有任务涉及具体页面时，才继续读同名状态模块和 `src/ui/<name>.js`。

## 启动与模式

`bin/approx.js` 是唯一 CLI 入口：

- 默认：创建 `PiBackend`，连接真实 Pi runtime。
- `--scripted`：不用 Pi，走 App 内置的离线演示回复。
- `--harness`：stdin 收 NDJSON 命令，stderr 发事件，stdout 仍是 TUI 帧。
- `--continue`：继续当前目录最近的 Pi 会话。
- `--no-splash`：跳过启动动画。
- `--help` / `--version`：输出元信息，不要求 TTY。
- `approx update`：不启动 TUI，直接进入更新流程。
- `approx update --help`：只输出更新器说明，不连接远端。

`--harness`、`--scripted`、`--live` 是互斥 backend 模式。正常 TUI 要求 stdout 是 TTY；update 和 harness 例外。

## App 是怎样拼起来的

`src/app.js` 只保留构造和生命周期。功能以 `xxxMethods` 对象挂到 `App.prototype`：

| 模块 | 责任 |
| --- | --- |
| `app-input.js` | 顶层按键优先级、输入框、slash、interrupt |
| `app-interaction.js` | 滚动、鼠标、文本选择、消息编辑/rewind |
| `app-turns.js` | submit、命令分流、backend dispatch、scripted 回复 |
| `queue.js` | 忙碌时最多排 4 个 turn，判断何时释放当前 turn |
| `backend-bridge.js` | 消费 backend event，维护 live assistant/tool/context |
| `app-transcript.js` | transcript 树、工具分组、变更摘要、快照 |
| `app-render.js` | 动画推进、布局组合、overlay 顺序、帧请求 |
| `navigation.js` | palette、settings、jump overlay |
| `runtime-settings.js` | model、effort、Markdown、compact、偏好持久化 |
| `file-mentions.js` | `@path` 解析、异步补全和选择状态 |
| `effort-picker.js` | 独立 Effort overlay 与延迟应用 |
| `app-status.js`、`app-updater.js` | 状态页控制与应用内更新流程 |
| `plan.js`、`questionnaire.js`、`approde.js`、`git.js` 等 | 各领域状态和交互 |
| `src/ui/*.js` | 尽量只做 geometry 和 draw，不拥有业务状态 |

所有 behavior 共用 `this.st`。新增方法前先搜索同名方法，prototype 装配不会替你解决命名冲突。

## 一轮请求的真实状态机

1. `app-input.onKey()` 最先处理当前 overlay，再处理 transcript/composer。
2. `app-turns.submitText()` 先识别 `/command`，否则调用 `sendTurn()`。
3. 若 `queue.turnInFlight()` 为真，请求进入 `st.messageQueue`；否则 `dispatchTurn()` 创建 `_activeTurn`。
4. 真实 backend 调用 `PiBackend.prompt()`；它先注入最新 Plan 快照，再调用 Pi session。
5. Pi event 经 `PiEventMethods.onPiEvent()` 归一成 `assistant_*`、`tool_*`、`context`、`usage` 等事件。
6. `backend-bridge.onBackendEvent()` 更新 live message/tool，`app-transcript` 随后把完成项归档成 WORK 树。
7. 当前 turn 只有在“最终 assistant delivery、runtime settled、prompt Promise 完成”满足对应条件后才释放；`toolUse` 结尾只是中间段，不是最终答案。
8. release 后生成 FILE CHANGES，应用挂起的 model/effort，再 drain 下一个 queued turn。

改 turn 生命周期时，必须同时看 `app-turns.js`、`queue.js`、`backend-bridge.js`，否则最容易出现早退队、重复释放或工具卡落到下一轮。

## PiBackend 模块

`src/backends/pi.js` 是小型 composition root：构造共享字段、提供 `subscribe/emit`，再安装这些 behavior：

| 文件 | 责任 |
| --- | --- |
| `pi/resources.js` | DefaultResourceLoader、技能/Prompt catalog、Approde 热切换 |
| `pi/planning.js` | Plan 注入、更新、持久化、审批/驳回、结构化提问 |
| `pi/session.js` | 启动、登录设置、会话/目录切换、model/effort、compact、dispose |
| `pi/history.js` | user entry 定位、rewind/redo、文件快照恢复 |
| `pi/events.js` | Pi 原生事件到 Approx event 的适配、assistant/tool 流 |
| `pi/helpers.js` | transcript 复水、mutation 快照、标题解析、格式化纯函数 |
| `pi/instructions.js` | 注入 Pi 的 Tool title、Plan、文件提及、Approde host 约定 |

App 只依赖 Approx event，不应直接理解 Pi 原生 event。新增/修改事件时至少同步：

```text
src/backends/pi/events.js 或其他 Pi behavior
  -> src/backend-bridge.js
  -> scripts/smoke/backend.test.js 或 runtime-*.test.js
```

## 三条最重要的双向同步链

### Plan

- App 侧状态和编辑交互在 `src/plan.js`，视觉在 `src/ui/plan.js`。
- Pi 侧权威快照和 branch 持久化在 `src/backends/pi/planning.js`。
- `src/pi-host-tools.js` 暴露 `set_mode`、`update_plan`、`ask_questions` 给模型。
- 每个真实 prompt 前都注入 Plan；用户在模型工作时改 Plan，会 abort 当前流并用最新快照触发续跑。
- Plan 批准进入 Go 并触发执行；驳回保持 Plan，要求模型重写后再次等待批准。

不要只改 App 侧字段。Plan schema 变更要同步 create/serialize/hydrate、host tool schema、Pi behavior、UI 和测试。

### Approde

- App 侧 preset、开关和 sidebar 在 `src/approde.js` / `src/ui/approde.js`。
- 用户偏好只保存禁用集合和 preset，不保存凭据。
- Backend 的 `DefaultResourceLoader` override 每次 reload 都读取当前 filter；完整 catalog 与过滤后的 live catalog 合并，保证已禁用项仍可见。
- 用户工作中切换集合，会重载 resource/system prompt，并让模型基于新能力集重新评估；模型也可通过 `manage_approde` 请求变更。

### 文件提及

- `src/file-mentions.js` 解析 composer caret 所在的 `@path` 或 `@"path with spaces"`，复用 composer suggestion 层展示候选。
- 裸查询会递归项目源码，但跳过 `.git`、`node_modules` 和符号链接目录，避免依赖树扫描与目录环；显式输入目录路径时仍可进入对应目录。
- `src/file-mention-highlight.js` 只负责显示分段，不改 Prompt 文本；发送给 Pi 的内容保持原样。
- Pi system instruction 要求可见回复引用真实项目文件，并在需要内容时再调用 read。

### Rewind / Redo

- 可见 user message 通过 `entryId` 对应 Pi append-only session tree。
- Write/Edit 开始前捕获 before，结束后捕获 after，内容以 base64 snapshot 记在 mutation journal。
- rewind 先跳到目标 user entry 的父节点，再恢复 abandoned suffix 的 before。
- redo 回到旧 leaf，先撤销新分支 mutation，再重放旧分支 after；UI 只保留一步 redo token。
- Plan 状态也从切换后的 branch 重新恢复。

改消息编辑时必须同时维护 session tree、UI transcript、mutation call id 和 Plan branch，不能只删屏幕上的消息。

## Transcript 与渲染

Transcript 不是扁平消息数组。常见节点：

- `user` / `approx` / `system`
- `tool`
- `toolgroup`：连续同类工具调用
- `fileeditgroup`：Write/Edit 的实时文件变更
- `workgroup`：一轮工作，内部可含普通 tools 和 file edits
- `system + subtype=changeset`：该 turn 的最终 FILE CHANGES

统一遍历工具树用 `src/message-tree.js`，不要自己猜嵌套层级。布局缓存字段是 `_lines` / `_lw`；内容、宽度、展开态变化后要调用 transcript invalidation。

`Screen` 是终端 cell 双缓冲。几个硬约束：

- CJK/emoji 宽字符的 head/tail 必须成对修复。
- Windows IME 跟随原生 cursor anchor；空闲 composer 不应持续 repaint。
- 动画帧用同步更新和 save/restore cursor，overlay 打开时要隐藏原生 caret。
- `requestFrame()` 表示有意义的状态变化；Clock 走时不等于每 tick 都写终端。
- `T.accent` 是可变全局主题色；测试里临时修改后必须恢复。

## Git、目录、配置、更新

### Git

`src/git.js` 用 `spawn('git', args, { shell: false })`，解析 porcelain v1 `-z` 数据，维护 worktree/staged 两条 lane。masthead 的 `+`/`−` 是 HEAD 到 worktree 的净行数，未跟踪文本另行计数。二进制内容先检查 NUL；未跟踪文件超过 4 MiB 时跳过读取，tracked diff 输出也限制为 4 MiB。discard 必须走 questionnaire 确认。

### 目录切换

`src/directories.js` 负责 picker；真正切换交给 `PiSessionMethods.changeDirectory()`。成功切换必须同时更新：`process.cwd()`、backend cwd、resource loader、session、Plan、App workspace state；失败会清理半初始化 session 并尝试回滚原会话。会话切换和新建对话使用同一恢复约束。

### 持久化

- UI 偏好：`%APPDATA%/Approx/settings.json`，`src/persistence.js` 用临时文件 + rename 原子写入。
- 会话正文：Pi 的 append-only session 文件，不进 settings。
- Provider 凭据：Pi 用户配置，不进项目、偏好或 transcript。

### 更新

`src/updater.js` 自动识别安装形态：

- Git checkout：fetch 后比较 commit；工作树必须干净；只允许 `pull --ff-only`；随后 `npm ci`/`npm install`。
- npm 安装：读取 dist-tags，选版本最高的 release，按精确版本全局安装。

CLI、Settings 和 `/update` 最终共用这一层。

### 状态与用量

- `src/usage-history.js` 归一化并保存最多 90 天的 input/output/cache/cost，以及 model/effort 分布。
- `src/app-status.js` 管理四个 sheet；`src/ui/status-dashboard.js` 负责 context、activity、models、costs 的完整绘制。
- usage backend event 同时更新本轮统计和持久历史；状态页里的更新检查复用 `app-updater.js`。

## 测试地图

```powershell
$ErrorActionPreference = 'Stop'
npm test
```

执行顺序：updater workflow -> smoke -> Pi backend 模块启动 -> Pi Plan revision。

`scripts/smoke.js` 只是顺序入口；suite 在 `scripts/smoke/`：

| Suite | 覆盖 |
| --- | --- |
| `core.test.js` | ANSI、宽度、输入 decoder、动画、Screen、composer |
| `workflows.test.js` | Plan、questionnaire、effort、Approde |
| `rendering.test.js` | splash、palette、Markdown/transcript layout |
| `app-navigation.test.js` | 完整 App drive、rail、wheel、mouse |
| `settings-jump.test.js` | Settings、applySetting、quick jump |
| `runtime-queue.test.js` | turn queue、backend bridge、session UI |
| `runtime-history.test.js` | rewind/redo、history replacement、tool groups |
| `backend.test.js` | Pi 标题消费、compact、mutation snapshot |
| `file-mentions.test.js` | `@path` 解析、补全、引用高亮、依赖树边界 |
| `workspace.test.js` | FILE CHANGES、status、Git、harness |

共享断言和 Fake TTY 在 `scripts/smoke/shared.js`。suite 必须串行，因为会暂时修改终端尺寸、主题和 timers。

## 常见改动落点

| 要改什么 | 先改/先读 |
| --- | --- |
| 新增 slash/palette 命令 | `commands.js`，再看对应 behavior |
| 新增全局按键 | `app-input.js`，确认 overlay 优先级 |
| 新增 overlay | state 模块 + behavior + `ui/` draw + `app-render.js` 层级 |
| 新增设置项 | `settings.js` + `runtime-settings.js` + persistence + settings smoke |
| 新增 backend event | Pi behavior + `backend-bridge.js` + runtime/backend smoke |
| 改消息/工具卡结构 | `app-transcript.js` + `message-tree.js` + `ui/transcript.js` |
| 改 Plan schema | `plan.js` + Pi planning + host tools + UI + tests |
| 改工作目录行为 | `directories.js` + Pi session + workspace event |
| 改 Git 操作 | `git.js` + `ui/git.js` + `workspace.test.js` |
| 改 updater | `updater.js` + `app-updater.js` + updater workflow test |

## 发布 v0.x

发布提交必须让 `package.json` 与 `package-lock.json` 版本一致，并从同一个 commit 生成 Git tag、GitHub Release 和 npm 包。推荐顺序：

```powershell
$ErrorActionPreference = 'Stop'
npm test
npm pack --dry-run --json
git tag -a vVERSION -m "Approx vVERSION"
git push origin main
git push origin vVERSION
gh release create vVERSION --verify-tag --title "Approx vVERSION" --notes-file RELEASE_NOTES
npm publish --access public
```

发布后用 `gh release view vVERSION` 和 `npm view @bgtbeigulol-png/approx version dist-tags --json` 核对两个通道。正式版应让 npm `latest` 指向该版本；预发布版显式使用 `--tag beta`。

## Review 结论与风险

当前结构的主链清楚，`src/` 静态本地 import 图没有环。Pi 和 Smoke 拆分后，两个原始超大文件都变成薄入口；npm 测试脚本现在显式串联 updater、smoke、Pi backend 与 Plan revision。

仍需留意：

- 项目是纯 JavaScript，没有类型检查或事件 schema；backend event 字段改名属于高风险改动，Smoke 是主要契约保护。
- 没有 lint/format script；提交前至少跑 `node --check`（新文件）和 `npm test`。
- App 依赖多个 prototype behavior 共享状态，新增同名方法可能静默覆盖；改 composition root 时先全局搜索方法名。
- 仍有几个复杂热点：`plan.js`、`questionnaire.js`、`app-transcript.js`、`ui/transcript.js`、`ui/status-dashboard.js`。它们各自内部耦合较强，按任务拆，不要顺手大改。
- Smoke 是共享进程状态下的串行集成测试；suite 若改 `process.stdout.columns/rows`、`T.accent`、Clock 或 timer，必须在本 suite 收尾恢复。

## 完成定义

一次改动至少满足：

1. state 默认值、行为、绘制、输入路由没有漏一层。
2. backend/UI 双向契约同步。
3. 宽字符、窄终端、IME cursor、overlay 层级不回归。
4. `npm test` 全绿。
5. 新增行为落到对应 smoke suite；不要再把测试堆回 `scripts/smoke.js`。
