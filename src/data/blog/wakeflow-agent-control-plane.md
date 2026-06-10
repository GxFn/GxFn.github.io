---
author: Gao Xuefeng
pubDatetime: 2026-06-11T02:40:00+08:00
title: Wakeflow：多窗口 Agent 的控制平面
slug: wakeflow-agent-control-plane
featured: true
draft: false
tags:
  - Codex
  - Wakeflow
  - Agent
  - 自动化
  - 架构
description: Wakeflow 是从 Alembic 多仓库并行开发里长出来的本地控制平面：总控拆需求，专职窗口执行，状态机和投递信封保证证据回到总控验收。
---

Wakeflow 的起点不是工作流引擎，而是多仓库并行开发里很现实的协作压力。

一个 Codex 窗口能做很多事，但 Alembic 这种系统很快就会超出单窗口的舒适范围。一个新需求可能同时牵动 Core 协议、Plugin 入口、Agent runtime、Dashboard 展示，还可能需要 Design 澄清和 Test 复验。如果都放在一个窗口里做，窗口会越来越重；如果只是多开几个窗口，又会出现另一个问题：谁来拆需求，谁来派发，谁来验收。

所以我先把仓库拆开，再把窗口拆开。Core 窗口长期理解 Core，Plugin 窗口长期理解插件入口，Agent 窗口长期理解执行链路，Dashboard 窗口长期理解前端消费。每个窗口只守自己的仓库、边界和验证方式。

这样单个窗口轻了很多，但真实需求不会刚好只落在一个仓库里。多个专职窗口不能各自开干，必须有一个总控先判断需求跨了哪些仓库，拆出哪些任务包，决定先后顺序，再把任务交给对应窗口。

Wakeflow 就是在这个地方长出来的。

它解决的不是"怎样多开几个 Codex"，而是多窗口、多仓库并发之后的控制问题：

- 哪个窗口能决定需求完成？
- 哪个窗口能改哪个仓库？
- 一个 target 说"我做完了"，总控能不能直接信？
- 消息发到了目标线程，算不算投递成功？
- 投递成功了，算不算任务完成？

如果这些问题不解决，多窗口 agent 工作就会变成一堆分散 prompt，加上一张靠人脑维护的状态表。并发带来的效率，很快会被协调成本吃掉。

Wakeflow 做的事，是给这套工作加一个本地控制平面。

## 从人工中转到线程回路

最早的时候，这个控制平面其实是我本人。

我会先让总控给出一份统一提示词：每个窗口应该读什么、不能碰什么、任务是什么、完成后怎么汇报。然后我用 `AGENTS.md` 给每个窗口写清楚职责：这个窗口负责哪个仓库，什么情况下能动手，什么情况下只能回报总控。

流程是能跑的，但非常笨。

```text
总控生成提示词
  ↓
我复制给目标窗口
  ↓
目标窗口执行
  ↓
我看到完成结果
  ↓
我再发给总控说哪个窗口完成了
```

我很快发现，自己成了系统里最无聊、也最不该存在的部分：一个人肉消息队列。

我不负责判断实现细节，目标窗口会做；我不负责最终验收，总控会看。我只是把提示词从 A 窗口搬到 B 窗口，再把完成消息从 B 窗口搬回 A 窗口。这个动作重复、低价值，却又必须准确。一旦复制错窗口、漏掉上下文、忘记回报，总控状态就会漂。

所以 Wakeflow 后来引入了 1 分钟一次性的自动化唤醒。

总控不再把提示词交给我，而是创建一条很短的自动化，让它在 1 分钟后唤醒目标窗口，把 dispatch prompt 发过去。目标窗口收到后，第一件事不是长期订阅这条自动化，而是**阅后即弃**：确认自己被唤醒，删除自动化，然后读取 state root 和 task package 开始执行。

完成以后，目标窗口也不等我转述。它创建另一条一次性自动化，1 分钟后唤醒总控，把 `TargetResultEnvelope` 或完成回报带回去。

```text
总控
  → 创建 1 分钟自动化
  → 唤醒目标窗口

目标窗口
  → 删除唤醒自动化
  → 执行任务包
  → 创建 1 分钟自动化
  → 唤醒总控
```

这个设计很土，但很有效。每条自动化都只是一次性信使：把控制权从总控交给目标窗口，或者从目标窗口交还给总控。真正的任务内容不在自动化里，仍然在 state root；真正的验收也不在目标窗口里，仍然回到总控。

后来 Codex 更新了更高级的窗口间线程能力，比如 `send_message_to_thread`。这件事直接改变了 Wakeflow 的实现重心：既然总控可以把 direct-thread prompt 直接发到目标窗口，目标窗口也可以把结果直接发回总控，那么中间那层 1 分钟自动化就不该继续存在。

于是我把定时自动化删掉，换成纯线程派发。

```text
总控
  → send_message_to_thread(target)
  → 目标窗口读取 state root / task package
  → 目标窗口执行并生成 TargetResultEnvelope
  → send_message_to_thread(controller)
  → 总控审查结果并决定下一轮
```

这条链路变短了很多。线程消息本身就是唤醒，目标窗口也可以直接把结果送回总控。Wakeflow 保留的是 state root、task package、delivery record、target result、controller review 这些控制面对象，而不是保留那个定时器技巧。

理想状态下，这个循环像衔尾蛇一样：总控派发给目标，目标完成后回到总控，总控验收后再派发下一环。它可以一圈接一圈持续推进。

但这个"无限执行"不是无边界执行。每一环都必须经过状态文件、目标窗口身份、仓库边界、投递记录和证据回传。没有 task package 就不动，没有 target result 就不验收，没有总控决策就不进入下一轮。循环可以长时间持续，但每一圈都要能停下来、能解释、能恢复。

从这里开始，Wakeflow 才真正像一个本地 delivery loop，而不是一组提示词加几条提醒。

## 和 Goal 模式的差别

Codex 自己的 Goal 模式解决的是另一类问题：给一个窗口一个持续目标，让它在同一个上下文里一直推进，直到目标完成、卡住或被用户打断。

这很好用，但它天然更像单窗口模型。一个窗口拥有目标，一个窗口消耗上下文，一个窗口决定下一步。即使它可以开启子 agent，很多时候也还是从一个主上下文向外扩展：主窗口发起，子 agent 执行，再把结果汇回主窗口。

Wakeflow 的感觉不一样。

它不需要强制把一个窗口一直唤醒，也不要求所有事情都塞回一个主上下文。它靠的是窗口之间的携手传递：总控把当前环节交给目标窗口，目标窗口完成后把证据交回总控；总控验收，再决定下一环交给谁。

```text
Goal 模式：
  一个窗口持续推进一个目标

Wakeflow：
  总控拆目标
  多个专职窗口各自保留上下文
  控制权和证据在窗口之间传递
```

这对 Alembic 这种多仓库系统很重要。每个窗口都有自己的历史、文件视角、验证习惯和上下文缓存，不需要每次都从一个主窗口重新解释一遍。

它和 Goal 模式开子 agent 有一点相似：都是把工作分出去。但 Wakeflow 的窗口不是一次性的分身，而是长期存在的专职窗口。它们的状态更可见，留存信息更多，失败以后也更容易回到对应窗口继续看，而不是只在主窗口里看到一段汇总。

还有一个我很喜欢的差别：Wakeflow 更自由。

总控派发以后，总控窗口会变空闲。这个时候我可以继续和总控聊天，调整方向、补充约束、改变下一轮派发计划，而目标窗口仍然在自己的上下文里执行当前任务。也就是说，系统不是一个关上门以后只能等结果的 Goal，而是一个可以边推进、边调整、边观察的多窗口协作场。

这也是为什么我觉得 Wakeflow 更适合长周期需求。它不是让一个 agent 死磕到底，而是让多个窗口在清晰边界里交接，让总控始终保留调整和验收的位置。

## 不是 Worker Pool

很容易把 Wakeflow 理解成 worker pool：总控把任务丢给几个子窗口，子窗口并行执行，最后汇总结果。

这个理解少了最关键的一层：**验收权**。

Wakeflow 里目标窗口不是自治 worker。目标窗口只执行分配给自己的 task package，只在自己的仓库边界内工作，最后返回 `TargetResultEnvelope`。它不能 claim 下一个任务，不能修改总控状态机，不能把"我本地测试过了"直接升级成需求完成。

总控才是唯一验收权威。

```text
用户目标
  ↓
总控窗口：拆需求、定边界、创建 state root
  ↓
目标窗口：只执行自己的任务包
  ↓
目标结果：带证据返回
  ↓
总控审查：接受、返工、阻塞或继续派发
```

这不是为了增加流程感。恰恰相反，这是为了减少多窗口工作里的暗箱判断。

AI 很擅长干活，也很擅长说自己干完了。Wakeflow 要做的是把"干完了"拆成可审查的证据，而不是让每个窗口各自宣布胜利。

## 总控规则要重，子窗口规则要轻

做 Wakeflow 以后还有一个很深的教训：总控一旦做了错误判断，危害会成倍增长。

单个目标窗口判断错了，总控还有机会纠正回来。它可以在 review 时发现证据不够、边界跑偏、实现方向不对，然后要求返工、阻塞或重新派发。目标窗口的错误通常是局部错误。

总控判断错了就危险得多。它会把错误的需求理解、错误的边界、错误的阶段顺序、错误的验收标准分发给多个窗口。每个目标窗口还会很认真地执行这个错误，于是一个判断失误会被并发放大成一组跨仓库副作用。

所以 Wakeflow 里总控的 `AGENTS.md` 会写得很多。

它不是为了让总控背更多流程，而是为了把最危险的判断边界写在最靠前的位置：什么时候必须停下来问人，什么时候只能做入口同步，什么时候可以创建 state root，什么时候可以派发，什么时候 target result 只能当证据，什么时候 Design/Test 只是输入，什么时候不能把脚本输出当验收。

总控规则厚，是因为总控有放大器效应。

子窗口正好相反。子窗口的 `AGENTS.md` 应该尽量少。

目标窗口只需要非常清楚几件事：我是谁，我负责哪个仓库，我拿到的 task id 和 state root 是什么，我不能碰什么，我要返回什么证据，什么时候必须停止并回报。它不应该理解整套总控策略，也不应该在自己的窗口里重新设计需求、选择下一个目标、决定是否完成整个需求。

如果子窗口规则太厚，它反而容易开始"帮忙判断"。这听起来聪明，但在 Wakeflow 里是危险的。子窗口越聪明，越要把聪明限制在自己的仓库和任务包里；总控越有权，越要用厚规则约束自己的发散。

这也是 Wakeflow 的一个基本形状：总控复杂，目标简单；总控负责判断，目标负责执行；总控规则多，目标上下文轻。

## 一个需求一个 State Root

Wakeflow 的核心对象不是任务列表，而是 state root。

一个需求进来后，总控会创建一个 state root。这个目录下面记录 demand、状态机、任务包、delivery envelope、target result、review pack、controller decision 和人能读的进度投影。

路径大概长这样：

```text
.workspace-active/
  demands/
    <demand-key>/
      demand.json
      wakeflow-state.json
      controller-events.jsonl
      projection.json
      developer-progress.md
      task-packages/
      delivery/
      target-results/
      review/
```

这里最重要的区分是：JSON 和事件是机器真相，Markdown 是人的投影。

`developer-progress.md` 很有用，但它不是权威状态。真正判断现在卡在哪里、哪个 target 已经返回、哪个 envelope 已经发送，要看 state root 里的结构化文件和事件。

这个设计和我做 Alembic 时的判断是一致的：文档可以帮助理解，但不能让自然语言文档承担机器状态的职责。人读 Markdown，机器读 JSON。两者都需要，但不能互相伪装。

## 状态机：每一步只产生有限结论

Wakeflow 的实现里，状态机不是一个抽象概念，而是落在具体脚本和文件上。

这个设计不是一开始就有的。

前期没有状态机时，我让 agent 直接改文档：更新进度、标记状态、补充派发表、回写结果。短任务里这还能凑合，一旦变成长任务，就会浪费大量 agent 的能力和时间。agent 会反复改同一段 Markdown，今天把状态写成"进行中"，明天又改成"等待回传"，后天再补一段"已完成待验收"。这些动作看起来是在推进流程，本质上却是在让 agent 做低价值的文档维护。

更不划算的是，agent 的注意力会被文档格式、措辞、表格同步和状态描述消耗掉。它本来应该用来判断边界、读取证据、设计下一步，却花了很多时间在维护一份自然语言状态表上。文档对人有帮助，但它很难成为可靠的机器状态源。

更麻烦的是，文档一旦被当成状态机，agent 就会开始解释文档。它会从自然语言里推断下一步，推断哪个窗口做完了，推断哪个结果可以验收。推断多了以后，状态就会漂。

所以后来我把机器状态从文档里抽出来，放进 `wakeflow-state.json`、`controller-events.jsonl`、task package、target result 和 transition candidate。Markdown 仍然保留，但它只做人能读的投影，不再承担状态源的职责。

`plugins/codex-wakeflow/scripts/wakeflow-state.mjs` 负责状态根的生命周期。它没有提供一个"自动推进所有事情"的总按钮，而是把控制面拆成几个很窄的命令：

```text
init
add-task-package
import-target-result
reduce-results
decide-review
complete-demand
```

每个命令只允许做自己那一步。

`init` 创建 `demand.json`、`wakeflow-state.json`、`controller-events.jsonl`、`projection.json` 和 `developer-progress.md`，但它不会派发任务，也不会代表需求被接受。

`add-task-package` 把需求拆成可执行任务包，必要时创建目标窗口的 target task。它可以把状态推进到 planned，但仍然不是投递。

`import-target-result` 只是把目标窗口返回的 `TargetResultEnvelope` 导入 state root。目标窗口说"完成了"，在这里仍然只是一个待审查材料。

`reduce-results` 会汇总 target result，判断还有没有缺失、阻塞或可审查的结果。如果结果齐了，它生成 transition candidate；但 candidate 也不是验收，只是告诉总控："现在可以做一次显式判断了。"

真正的判断发生在 `decide-review`。总控只能在这里选择 accept、rework 或 blocked。最后的 `complete-demand` 还会再检查一遍：所有 task package 和 target task 都必须被接受，而且必须带着 evidence ref，需求才能关闭。

所以 Wakeflow 的状态机不是为了显得流程完整，而是为了防止阶段之间偷偷升级：

```text
初始化不是投递
任务包不是投递
投递成功不是结果
目标结果不是验收
review candidate 不是验收
总控决策才是状态推进
```

代码里每次状态迁移都会更新 `revision`，追加 `controller-events.jsonl`，设置下一步 `allowedActions`，并写入 `forbiddenConclusions`。我很喜欢这个字段。它像是给 agent 的刹车片：这一步写了什么，同时也明确说明不能从这一步推出什么。

这让 Wakeflow 的恢复能力也更好。长任务断在中间时，总控不用靠聊天记录猜现在到了哪里，只要看 state root 当前 revision、events 和 allowed actions，就知道下一步能做什么、不能做什么。

## 投递信封：语义和传输分开

另一半设计是投递信封。

在早期人工复制提示词的时候，"任务是什么"和"怎么送到窗口"是混在一起的。到了 Wakeflow 现在的实现里，它们被拆成了几层 artifact。

`lib/wakeflow-dispatch-commands.mjs` 先从 state root 生成 `ControllerDispatchPacket`。这个 packet 是语义任务：目标窗口是谁、任务 id 是什么、属于哪个 dispatch group、目标是什么、范围是什么、禁止做什么、需要返回什么证据。

最关键的是 `stateRef`。它把一次派发钉回到具体状态：

```text
stateRoot
demandKey
taskPackageId
targetTaskId
stateRevision
```

这意味着目标窗口收到任务时，不是只收到一段自然语言，而是收到一个可追溯的状态坐标。它知道自己要回到哪个 state root，执行哪个 task package，也知道这次派发基于哪个 state revision。

然后 Wakeflow 再把 packet 包成 `DeliveryEnvelope`。Envelope 负责传输层：目标线程来自本机 `.workspace-local` 的 thread registry，真实 thread id 会被遮蔽；`transport.kind` 是 `direct-thread`；`readbackRequired` 为 true；如果找不到目标线程，策略是 `fail-closed`。

这层区分很重要：

```text
ControllerDispatchPacket：我要谁做什么
DeliveryEnvelope：这一次怎么投递
DirectThreadDeliveryRun：宿主是否真的发送并读回
TargetResultEnvelope：目标窗口交回的结果和证据
ReviewPack / transition candidate：总控能否开始审查
ControllerReturnEnvelope：把控制权唤回总控
```

整个阶段链路大概是这样：

```text
init demand
  -> add task package
  -> prepare dispatch packet
  -> build delivery envelope
  -> host send + record delivery run
  -> target records target result
  -> import target result
  -> reduce results / build review pack
  -> decide review
  -> add next package | complete demand | blocked
```

每一层 artifact 都有自己的边界。

- packet 可以证明总控准备好了任务，但不能证明消息已经发出去。
- envelope 可以证明投递材料准备好了，但不能证明目标收到了。
- delivery run 可以证明 `send_message_to_thread` 这类宿主动作完成并 readback OK，但不能证明目标执行了。
- target result 可以证明目标窗口提交了结果，但不能证明总控接受了。
- review pack 可以证明证据已经足够进入审查，但不能替总控做决定。

Wakeflow 的技术点就在这里：它没有把多窗口协作压成一条 prompt，而是把每个阶段都变成可落盘、可重放、可拒绝误读的信封。这样 direct-thread 只是传递控制权，状态机负责判断下一步，证据负责支撑验收。

## 为什么做成 MCP 插件

做 Wakeflow 的时候还有一个很实际的发现：让 agent 直接执行一段纯 JS，效率并不稳定。

理论上，很多事情都可以让 agent 自己跑脚本：读 state root、拼参数、执行 Node 命令、等待 stdout、判断退出码，再把 JSON 结果读回来。这个方式在开发早期很方便，因为改脚本快，验证也快。

但一旦进入真实使用，它会变得很重。

agent 执行纯 JS 的时候，经常会卡在"等待结果"或"等待进程退出"这个边界上。脚本本身可能已经做完了，或者输出已经足够判断下一步了，但 agent 还在盯着终端生命周期。对人来说这只是几十秒，对多窗口控制面来说就是很大的摩擦：总控慢一拍，目标窗口就慢一拍，整个 delivery loop 都会被拖住。

所以 Wakeflow 后来没有把这些能力停留在"一组可运行 JS 脚本"上，而是做成了 Codex 插件里的 MCP 工具面。

代码里 `mcp/server.cjs` 提供很薄的一层 JSON-RPC server，真正的工具声明在 `lib/wakeflow-mcp-tools.mjs`。这些工具不是重新实现一套逻辑，而是把稳定动作包成 agent 能直接调用的能力：

```text
wakeflow_status
wakeflow_init_demand
wakeflow_add_task
wakeflow_prepare_delivery
wakeflow_record_delivery
wakeflow_record_target_result
wakeflow_review_pack
wakeflow_reduce_results
wakeflow_decide_review
wakeflow_complete_demand
```

内部仍然复用 runtime 脚本，MCP 背后还是调用 JS 去读写状态机；但对 agent 暴露的是结构化 tool call。参数是 schema，结果是结构化 JSON，读写意图也通过 tool annotations 标出来：哪些是 read-only，哪些是本地写入，哪些不是 open-world 操作。

这个变化的体感非常明显。

以前 agent 像是在临时开一个 Node 小工地：命令怎么拼、工作目录在哪、什么时候算结束、输出应该读哪一段，都要在对话里临时处理。做成 MCP 之后，agent 只是在调用一个已经声明好的本地能力。大部分控制面动作都能秒级返回，窗口不用长时间等一个终端过程自然结束。

这比纯 JS 更契合 agent 的工作方式。agent 擅长做判断和选择，不擅长长期盯一个进程生命周期，也不应该把大量时间花在反复改文档上；MCP 刚好把机械动作包成短调用，把文件读写、状态迁移、JSON 输出这些事情藏到工具后面。状态机越稳定，MCP 的收益越明显；MCP 越顺手，agent 就越少被拖进低价值的文档维护里。

这不是单纯的性能优化，而是控制面的形态变化。

- 纯 JS 脚本适合做内部实现。
- MCP 工具适合做 agent 的操作界面。

Wakeflow 真正需要 agent 判断的是：现在该不该推进、证据够不够、要不要返工。至于"创建 state root""准备 envelope""记录 delivery run""生成 review pack"这些机械动作，就应该变成稳定工具，而不是每次让 agent 在终端里重新组织一遍。

## 本地边界和安全阀

Wakeflow 初始化一个工作区时，会创建几个 surface：

```text
MyWorkspace/
  AGENTS.md
  workspace.config.json
  .workspace-active/
  .workspace-local/
  wakeflow-ledger/
  ProductRepo/
  Design/
  Test/
```

其中 `.workspace-active/` 是当前需求状态，`.workspace-local/` 是本机运行时，`wakeflow-ledger/` 是长期记录。

真实 thread id 只放在 `.workspace-local` 的 thread registry 里。`workspace.config.json` 可以记录窗口名、角色、仓库路径、默认语言，但不能变成第二份 thread-id 权威。

这个边界很小，但非常关键。

Thread id 是本机事实，不是项目事实。它跟某台机器、某个 Codex Desktop、某次线程创建有关。把它提交到 Git 里，其他机器拿到也没意义，还会制造假的确定性。

Direct-thread 也是一样。它只是唤醒，不是任务本身。

Wakeflow 的投递 prompt 不应该塞满所有细节。它的作用是唤醒正确窗口，让目标窗口读取自己的 task package 和 state root。真正的任务内容在 state root 里，真正的边界在目标窗口的 `AGENTS.md` 和 Wakeflow skills 里，真正的完成标准在总控创建的需求状态里。

```text
delivery prompt：你是谁，任务包在哪，state root 在哪
task package：你要做什么，边界是什么，返回什么证据
target window：执行并返回 TargetResultEnvelope
```

普通 prompt 派发经常把所有信息塞进一条消息，然后期待目标窗口记住。Wakeflow 反过来：消息尽量轻，状态尽量落盘，身份和边界尽量可验证。

一个真实发送被记录为 `sent` 且有 readback 证据后，总控本轮就该停止。它不应该在同一轮 sleep、poll、猜测目标是不是完成了。

投递是副作用，readback 是传输证据，不是验收。

这也解释了 Wakeflow 里看似啰嗦的一条规则：没有 active demand、state root、task package 或 dispatch packet 时，窗口只报告"入口同步完成，等待总控任务"，然后停止。

一个目标窗口启动后，看到自己在某个仓库里，知道自己是 ProductRepo 窗口，不等于它应该开始干活。它必须收到带 `currentWindow`、`taskId`、`stateRoot` 的 Wakeflow wakeup 或 delivery prompt，才算拿到真实任务。否则它只能做只读身份确认。

Wakeflow 宁愿多停一次，也不能让窗口自己发明任务。

## Design、Test 和证据

很多流程系统喜欢加 Design、Test、Review 这些角色，最后变成文档工厂。

Wakeflow 里的 Design 和 Test 不应该这样用。

Design 的价值是澄清需求、比较方案、识别风险、产出 handoff 候选。它不自动等于产品真相，也不直接投递实现。

Test 的价值是提供总控或产品仓库窗口不方便复现的真实场景证据。它不是为了补一张测试表，而是为了让验收有更硬的证据。

所以 Wakeflow 的原则是：推荐不等于调用。

当一个需求真的需要需求澄清、方案比较、真实场景验证时，就让 Design/Test 介入。否则不要为了流程完整而制造材料。流程不能替代判断，流程只能保护判断不被长任务冲散。

Wakeflow 里有很多看起来像"完成"的东西：

- delivery envelope 已生成
- host thread send 成功
- readback OK
- target result 已导入
- review pack 已生成
- controller-return envelope 已发送

这些都不是产品完成。

它们分别只是不同层级的证据。投递证据说明消息到了；target result 说明目标窗口提交了自己的说法；review pack 说明总控可以开始审查；controller-return 说明控制权回到了总控。

真正的完成，需要总控看原始证据：diff、测试输出、运行结果、错误日志、截图、用户要求和完成标准之间的关系。

这句话听起来保守，但它是 agent 自动化里最容易丢的东西。

- 传输成功不是语义成功。
- 回传完成不是验收完成。
- 目标窗口满意不是需求完成。

Wakeflow 的很多文件、envelope、事件和 review artifact，都是为了把这几层成功拆开。

## 为什么不是一个大工作流引擎

Wakeflow 很容易继续长成一个完整工作流引擎：自动选择下一个任务、自动派发、自动重试、自动验收、自动归档。

但这不是我想要的方向。

Agent 工作最危险的不是它不自动，而是它在不该自动的时候继续自动。尤其在代码仓库里，自动化一旦跨过权限、范围和证据边界，后面的修复成本会很高。

Wakeflow 更像一个本地 reconciliation controller：

- state root 描述当前状态
- 总控决定目标状态
- 工具准备和记录副作用
- target 提供证据
- 总控根据证据推进下一步

它应该把状态机、投递、证据和投影做扎实，而不是把判断藏进一个"advance everything"按钮里。

- 确定性越强的部分，越应该交给脚本。
- 判断越重的部分，越应该留给总控。
- 证据越关键的部分，越应该落盘。

## 写在最后

Wakeflow 解决的不是"让 Codex 同时开几个窗口"。

多窗口只是表象。真正的问题是：当 agent 工作跨仓库、跨角色、跨时间持续推进时，系统怎样知道自己在做哪个需求、哪个窗口负责什么、哪个结果能被信任、什么时候必须停下来等人判断。

Wakeflow 给出的答案是本地控制平面：一个需求一个 state root，总控拥有验收权，目标窗口只做边界内的任务，所有副作用都有 envelope 和 evidence，所有不确定的身份、范围、证据都 fail closed。

Agent 可以越来越强，但越强越需要边界。

Wakeflow 做的就是把这些边界变成文件、状态和工具契约。

- GitHub: [github.com/GxFn/Wakeflow](https://github.com/GxFn/Wakeflow)
