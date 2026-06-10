---
author: Gao Xuefeng
pubDatetime: 2026-06-11T02:20:00+08:00
title: Lark Remote：一条轻量的 Codex 接续线
slug: lark-remote-local-control-plane
featured: true
draft: false
tags:
  - Codex
  - Lark
  - 远程控制
  - 本地优先
description: Lark Remote 不重做 Codex 手机端，而是把飞书/Lark 变成接续本机 Codex 的轻量通道。简单、依附、可恢复，是它最重要的设计取舍。
---

最开始想做 Lark Remote 的原因很简单：Codex 在本机项目里很好用，但人不一定一直坐在 Mac 前。

我想要的不是另一套完整客户端，而是一条很窄的接续通道。离开 Mac 时，可以在飞书里看一眼本机 Codex 跑到哪了，必要时补一句指令，或者接管一个会话；回到 Mac 之前，工作不要断。

Codex 有手机端，功能很完整。但完整也意味着重：完整应用、完整会话、完整交互面都要加载出来。我的网络环境里，即使开了 VPN，也经常停在加载中。这个体验让我意识到，远程接续不一定需要一个完整 Codex。很多时候我只需要知道本机那个窗口还在不在、卡在哪里、能不能继续下一步。

Lark Remote 的设计目标就是克制。它不试图在手机上重建 Codex Desktop，而是让 Codex 继续留在本机，把飞书/Lark 变成一条轻量控制线。

## 不是远程桌面

远程控制看起来有很多成熟方案：远程桌面、SSH、Webhook、聊天机器人。它们都能把一句话送到另一台机器。但对 Codex 来说，问题不是"消息怎么过去"，而是**消息过去之后控制谁、能做什么、什么时候必须停下来**。

远程桌面解决的是 UI 距离问题。你把 Mac 屏幕搬到手机上，鼠标和键盘也搬过去。这个模型对人是直观的，对 agent 没什么意义。

Codex 的核心工作不在屏幕像素里，而在本地会话、项目路径、工具权限、沙箱边界、MCP 能力和一段正在运行的上下文里。远程桌面看到的是窗口，Lark Remote 要接续的是**线程**。

所以 Lark Remote 的产品形态被刻意收窄：

```text
飞书/Lark 消息
  ↓
本地 Lark Remote bridge
  ↓
Codex 控制窗口
  ↓
被选择的本机 Codex 会话
```

它不是把 Codex Desktop 复制到飞书里，也不是让机器人拥有一台机器的完整操作权。它只做几件事：观察、选择、接管、路由、回传。

这条线越窄，系统越稳。

## 依附 Codex

Lark Remote 最重要的特点是：它完全依附于 Codex。

我没有在 bridge 里重做一套语义理解系统。飞书/Lark 侧的确定性命令由 JavaScript bridge 处理，比如 `控制台`、`status`、`接管 1`、`关闭飞书连接`。这些命令不需要 LLM 理解，自然也不该交给 LLM 发挥。

但更复杂的意图，比如"帮我看一下这个项目现在卡在哪"、"把这条需求投给某个窗口"、"解释一下为什么没消息"，仍然交给 Codex 的控制窗口理解。

这让系统保持了一个很舒服的比例：

```text
确定命令 → bridge 直接处理
模糊意图 → Codex 控制窗口理解
具体执行 → 被选中的目标 Codex 会话完成
```

也就是说，Lark Remote 没有发明一个新的 agent 平台。它只是把 Codex 已经有的智能、工具权限和会话上下文接到飞书/Lark 这条窄通道上。

这个设计简单，却足够智能。简单是因为 bridge 不需要理解所有自然语言；智能是因为一旦需要理解语义，它背后站着的就是 Codex 本身。

## Bridge 必须在本地

Lark Remote 的 bridge 跑在本机。飞书/Lark 只是一条消息通道，真正知道本机有哪些 Codex 会话、哪些项目、哪些 thread id 的，是本地 bridge。

这个选择带来几个直接后果：

- 启动时不会把已有 Codex 聊天历史发到飞书/Lark
- 私有配置写在 `~/.codex-lark-remote/config.json`
- `allowedUsers` 为空时只能先发现身份，不能直接全项目接管
- Codex 原生权限弹窗仍然必须在 Mac 上处理
- 接管时可以用 `caffeinate -dimsu` 保持本机唤醒，但不会绕过系统权限

这不是"功能不完整"，而是安全边界。

远程控制最危险的错觉是：只要用户在聊天里发了一句话，就等于用户批准了所有后续行为。Lark Remote 不接受这个假设。配置飞书应用、发现 `senderId`、写入 allowed users、确认接管当前线程、选择目标会话，每一步都把"谁在控制什么"拆开。

权限拆得越细，出错时越容易 fail closed。

## 代码里的架构分层

从代码看，Lark Remote 更像一个本地 control plane，而不是一个聊天机器人脚本。

大致分成几层：

```text
lark-ws / lark
  负责飞书事件、WebSocket、消息归一化

bridge-server
  暴露 /bridge/... 本地 HTTP 协议面

control-semantics / intent-router
  把自然语言和按钮事件变成明确动作

takeover / observer / queue
  维护项目选择、会话选择、观察状态、接管状态和 remote command

runner
  消费队列，调用 route / dispatch / reply，把结果回写飞书

MCP tools
  提供诊断、人工控制和兜底入口，不承担日常消息主链路
```

这个分层很关键。飞书消息进来以后，不是立刻丢给一个后台 Codex 回合让它"自己想办法"。普通消息会先进入本地队列，runner 调用 `/bridge/remote-command/route` 判断它是控制动作还是任务派发；如果是派发，再调用 `/bridge/dispatch/execute` 把它送到目标 Codex session；最后用 `/bridge/remote-command/reply` 写回飞书。

MCP 工具仍然存在，比如列项目、选会话、确认接管、查看状态。但它们更像控制台工具和恢复工具，不是每条远程消息都必须经过的中心。这也是后来我把实现改轻的地方：能确定的协议在 bridge 里完成，只有需要解释、确认、恢复时才交给 Codex 控制窗口。

## 自然语言控制台

Lark Remote 的外层是自然语言控制台。它不是一个只能点按钮的菜单，而是能理解一些口语化操作：

```text
看看有哪些项目
进入第 1 个项目
会话列表
观察第 2 个会话
接管第 2 个会话
跳出接管
关闭飞书连接
```

代码里这部分主要在 `control-semantics.mjs` 和 `intent-router.mjs`。前者先做确定性的语义解析：中文、英文、序号、礼貌前缀、项目/会话/观察/接管这些常见表达都会被规整成 action。后者负责把这些 action 放进当前状态里判断：现在是在控制台模式，还是已经接管了某个会话；这句话应该解释为控制命令，还是应该当作普通需求派发给目标窗口。

这里还有两个有用的逃生口：`控制:` 会强制走控制语义，`派发:` 会强制把后面的内容发给目标会话。它们不漂亮，但在远程链路里很实用。远程控制最怕含混，必要时能显式指路，比让系统猜要好。

接管之后，默认语义会反过来：普通飞书消息不再被当作"项目列表"或"会话列表"这种控制台操作，而是进入线程派发模式。只有说 `控制台`、`跳出接管`、`退出接管` 这类明确指令，才会回到外层控制台。

这让交互更接近真实使用：没接管时，飞书是控制台；接管后，飞书就是那个目标 Codex 会话的轻量输入口。

## 项目选择不是配置表

启动 Lark Remote 的 Codex 会话，不一定就是要干活的目标会话。它更像一个本地控制台，负责连接 bridge、诊断状态、维护路由身份、处理明确的控制命令。

真正被操作的目标，要从飞书/Lark 控制台里选。

```text
控制台
  → 项目列表
  → 会话列表
  → 观察会话 2
  → 接管 1
```

这里列出的也不是 macOS 窗口句柄。Lark Remote 读的是本地 Codex session 记录：哪个项目、哪个会话、哪个 thread id。代码里的 `listTakeoverProjects()` 会枚举本机 Codex threads，再按 `cwd` 聚合成项目，统计每个项目下面有多少窗口、多少 active 窗口、最近更新的是哪个会话。也就是说，项目列表不是手写配置表，而是从本机 Codex 使用痕迹里生成的。

选中项目以后，`selectTakeoverProject()` 会把 takeover scope 收窄到这个 `cwd`，再刷新会话列表。`listTakeoverTargets()` 会继续枚举这个项目下的 Codex sessions，并用 session 状态判断它是 idle 还是 running。飞书里看到的"窗口"，其实就是这些 Codex session 的可读名字、路径、thread id 和运行状态。

这个设计让"所有窗口"变成一个可控概念：不是去扫描屏幕上所有 App 窗口，而是列出所有可发现、可路由、可恢复的 Codex 会话。它更窄，但更适合 agent。

如果没有选中目标，控制窗口就不能假装自己就是目标。

这个设计在实现时很烦。因为从用户视角看，"我都把需求发到飞书了，你为什么不直接做？"但这是必要的烦。远程链路里一旦目标选择不确定，正确动作不是猜，而是回到控制台让用户选。

## 观察所有窗口，接管目标窗口

观察是只读。你可以把另一个 Codex 会话的进度串流到飞书/Lark，但飞书消息不会进入那个会话。

接管是写入。接管之后，普通飞书/Lark 消息才会变成 remote command，进入本地路由和派发执行器，再投递到被选中的 Codex 会话。

这两个能力不能混在一起。

实现上，观察走 `observer.mjs`。它可以列出可观察的 Codex sessions，也可以用序号、thread id 前缀或会话名匹配目标。开始观察后，bridge 会把选择写进 `observation.json`，再用 session progress watcher 盯住目标 session 的 JSONL 变化，把摘要回传到飞书。接管准备或接管激活时，还会开一个 temporary observer，用来在等待目标空闲、派发执行之间补足可见性。

接管走 `takeover.mjs`。它分成几步：先列项目，再列项目内会话，再选择 target，最后确认执行。`selectTakeoverTarget()` 只把目标标成 selected；`executeTakeoverTarget()` 才会把状态切到 active，并记录 controller thread、controller cwd、目标 thread、目标 cwd、飞书消息身份这些元数据。这样后面每条普通消息都知道自己要派发给谁，也知道是谁在控制。

所以"观察所有窗口、从所有窗口里选择接管目标"在 Lark Remote 里不是广播式能力，而是选择式能力：你可以从所有可发现 Codex 会话中挑一个观察，也可以挑一个接管；但写入永远只进入一个被明确确认的目标。观察可以广，写入必须窄。

观察适合看一个长任务跑到哪里了，适合在外面确认"它是不是还活着"。接管适合真的追加指令、修正方向、让目标窗口继续做下一步。

- 如果观察也能写入，那观察就不是观察。
- 如果接管没有目标选择，那接管就是广播。

Agent 系统最怕这种边界词被用虚。Lark Remote 里的很多实现复杂度，都是为了让这些词在运行时真的有区别。

## 错误设计一：普通消息直接变成工具调用

早期很自然会想到一种实现：飞书收到一条消息，就唤起一个控制窗口回合，让 Codex 调 MCP 工具，把消息投递给目标。

这个方案能跑，但不稳。

控制窗口回合是 LLM 驱动的。每条消息都让 LLM 决定怎么路由，就等于把确定性消息队列交给概率模型。大部分时候它会做对，但远程控制不能建立在"大部分时候"上。

后来的路径改成了本地 runner：

```text
飞书/Lark 普通消息
  ↓
保存为 remote command
  ↓
本地 route endpoint 判断下一步
  ↓
dispatch executor 投递目标线程
  ↓
reply endpoint 回写飞书/Lark
```

LLM 控制窗口仍然保留，但更多是语义诊断、恢复和人工兜底。日常消息路由交给本地确定性代码。

确定的事情确定性地做，不确定的事情才上抛。

## 错误设计二：后台 resume 当成完整窗口

另一个坑更隐蔽：后台调用 Codex 窗口。

一开始我以为，可以在后台用 `codex exec resume` 调起一个已有会话，把飞书消息塞进去，让这个"恢复出来的控制窗口"继续调用 `send_message_to_thread`、继续调用 Lark Remote 的 MCP 工具，再由它把任务派发给真正目标窗口。

这个设计是错的。

`codex exec resume` 恢复出来的输入通道，不等价于 Codex Desktop 里那个完整窗口。它可以让模型接着说话，但它拿不到所有宿主能力。最关键的两个能力都不稳定：一个是 host thread 的 `send_message_to_thread`，另一个是当前会话里已经加载好的 MCP 工具。

于是会出现一种很别扭的失败：语义路由已经判断对了，目标线程也选对了，但后台恢复出来的控制窗口真正要发送时，`send_message_to_thread` 不可用；或者它根本看不到 `codex_lark_*` 工具。这个时候继续让它"再试一次"没有意义，因为错的不是提示词，是运行层级。

后来才把边界想清楚：

```text
Codex Desktop 控制窗口
  适合：人工确认、语义诊断、权限交互、复杂解释

codex exec resume 后台回合
  不适合：承担 host thread 派发器，不适合假设 MCP 工具可用

本地 bridge runner
  适合：确定性 route、dispatch、reply、记录失败状态
```

后台 resume 不能被当成一个可靠 worker。它最多是一次补充性的模型回合，不应该成为远程控制系统的中枢。

这个坑让我删掉了很多看起来"更智能"的设计：每条飞书消息都开一个后台 Codex 回合；让控制窗口在后台完成目标选择、派发、记录和回复；把 MCP 工具可见性当成默认条件。这些设计在本机手动测试时可能能跑，但一到后台链路就会坏。

最后留下来的方案反而简单：bridge runner 自己保存 remote command，自己调用本地 route/dispatch/reply endpoint，能派发就派发，不能派发就记录 `blocked_retryable`。Codex 控制窗口回到它擅长的位置：理解语义、解释问题、让人确认，而不是在后台假装自己拥有所有宿主能力。

## 错误设计三：没想清插件分发模型

真正折腾很久的不是飞书 API，也不是 WebSocket，而是 Codex Marketplace 的层级关系。

一开始我对 Codex 市场的插件模型理解不够清楚：仓库根目录、marketplace catalog、嵌套插件目录、MCP server、runtime cache，这几层到底谁会被安装、谁会被扫描、谁负责携带依赖，并不是一眼能看出来。

Lark Remote 依赖 `@larksuiteoapi/node-sdk`。如果这个包没进入插件运行时，表面上可能已经"接入当前线程"，keep-awake 也启动了，但 WebSocket 会在真正连接飞书时失败。这个错误很容易误判成配置问题、鉴权问题或网络问题，其实只是 runtime 缺依赖。

回头看，依赖安装有两条路。

**第一种：MCP 使用时安装依赖。** 插件包里带 `package.json`，MCP server 第一次启动时检查当前 runtime 目录有没有 `node_modules`，没有就执行一次安装，然后再启动 bridge。

```text
Codex Marketplace 安装插件源码
  ↓
MCP server 启动
  ↓
检查依赖是否存在
  ↓
缺失则在插件 runtime 目录 npm install / npm ci
  ↓
启动 bridge
```

这个方案直接，适合依赖少、网络可用、安装时间可接受的插件。问题也明显：第一次使用会变慢；如果网络不可用，用户看到的是 MCP 启动失败；如果缓存目录和源码目录不是同一个，依赖可能装到了错误层级。

**第二种：做一个市场壳，MCP 使用时安装整个插件 runtime。** Marketplace 里提交一个很薄的壳，只负责声明插件、暴露 MCP 入口和启动 bootstrap。真正的 bridge runtime 是另一个版本化包，MCP 第一次使用时把完整 runtime 安装到本地 cache，再从那个 runtime 里启动 server。

```text
Marketplace 插件壳
  ↓
MCP bootstrap
  ↓
安装完整 runtime（源码 + package.json + dependencies）
  ↓
记录 runtime version/cache path
  ↓
委托给 runtime bridge
```

这个方案重一点，但边界更清楚：市场扫描的是壳，运行的是 runtime；依赖跟 runtime 绑定，不会散在仓库根目录、插件目录和缓存目录之间。代价是要处理版本固定、缓存更新、安装失败和回滚。

对 Lark Remote 这种要长期跑 bridge、依赖平台 SDK、还要进入本地缓存的插件来说，第二种模型更稳。至少要把"插件壳"和"运行时"这两个概念想清楚。否则就会反复调整目录层级：一会儿依赖放仓库根目录，一会儿放插件目录，一会儿以为 marketplace 会帮忙安装，最后缓存里还是缺包。

这个坑本质上不是 npm 的坑，是**插件分发模型没有想清楚**。

## 聊天软件不是权限系统

飞书/Lark 能发消息，不代表它能处理 Codex 的全部交互。

Lark Remote 接管的是对话输入输出链路，不是 Codex Desktop 的原生 UI。它不能点击权限弹窗，不能替用户批准 MCP 授权，不能处理沙箱提权，不能绕过本机网络或安装依赖审批。

这意味着有些远程请求会卡住。正确做法不是隐藏这个事实，而是把边界说清楚：需要什么权限、在哪里批准、当前链路能不能继续。

同样，远程输出也要做过滤。普通进度不应该把内部 task id 全部甩到聊天里，命令输出要摘要，源码查看要压缩，token、secret、password 这类内容要脱敏。聊天软件的转发成本太低，越低越要克制。

远程控制的价值不是让一切都暴露出来，而是让必要的信息刚好到达。

## 失败路径比成功路径重要

Lark Remote 真正难写的是失败路径：

- WebSocket 连上了，但收不到消息
- 飞书和国际版 Lark 的 domain 配错
- App ID 和 App Secret 来自不同开放平台
- 插件没有加载出 `codex_lark_*` MCP tools
- 本地 bridge 已 attach，但依赖缺失导致长连接起不来
- 控制窗口收到远程命令，但 `Selected target session: none`
- host thread dispatch 不可用，只能记录 retryable blockage

这些问题看起来都是工程杂活，但它们决定了系统可信不可信。

一个远程控制系统如果只会在成功时说"已完成"，失败时靠用户猜，那它迟早会把错误投递到错误目标。Lark Remote 的原则是：能诊断就诊断，不能定位就停，目标不明就不做，传输成功也不等于任务成功。

这和我做 Alembic、Wakeflow 时的感受一样。AI 系统真正需要的不是更多魔法，而是更多可解释的停止点。

## 写在最后

Lark Remote 表面上是一个飞书/Lark 插件，实际解决的是本地 agent 的远程接续边界。

它的重点不在"手机上也能给 Codex 发消息"。这只是结果。

更重要的是：Codex 继续留在本地，项目上下文继续留在本地，权限判断继续留在本地。飞书/Lark 只是一个窄的控制通道，负责把人的意图送进来，把必要的结果带出去。

远程控制不是把电脑搬到聊天里。

远程控制是让聊天成为本地 Codex 的一条轻量接续线。

- GitHub: [github.com/GxFn/LarkRemote](https://github.com/GxFn/LarkRemote)
