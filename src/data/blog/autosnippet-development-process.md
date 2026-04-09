---
author: Gao Xuefeng
pubDatetime: 2026-02-25T08:11:35+08:00
title: AutoSnippet 开发的心路历程
slug: autosnippet-development-process
featured: true
draft: false
tags:
  - AutoSnippet
  - 开发
description: 从 2021 年的 154 行 Bash 脚本到 2026 年的 12 万行 AI 知识平台，AutoSnippet 的故事是一个开发者和"代码复用"这件事死磕五年的过程。
---

# AutoSnippet 一个周五傍晚的 150 行 Shell，和它之后的五年

> 这篇文章讲的不是一个产品，是一个执念。从 2021 年的 154 行 Bash 脚本到 2026 年的 12 万行 AI 知识平台，AutoSnippet 的故事是一个开发者和"代码复用"这件事死磕五年的过程。

---

## 起点：一个不值一提的小烦恼

2021 年某个周五傍晚。

这一周写了太多 Objective-C。不是那种有挑战性的代码——是重复的代码。`UITableView` 的初始化模板，网络请求的封装样板，MVVM 的 ViewModel 骨架。每次新建一个页面，都要去老文件里翻上一遍，复制，改，粘贴。

Xcode 有 Code Snippet 功能，但要一个一个手动加。改了代码得记着去同步。团队里别人想用？把文件拷给他。

这算不上什么"痛点"。顶多算一个"不爽"。大多数人的处理方式是忍一忍，或者记个笔记。

但那天傍晚打开了 Terminal：

```bash
vim build.sh
```

## build.sh：154 行的全部

思路异常简单：在 ObjC 源码的注释里打一个标记，告诉脚本"这段代码值得提取"：

```objc
// AutoSnippetPlaceholder -> TableViewInit|tbinit|UITableView 的标准初始化模板
- (void)setupTableView {
    self.tableView = [[UITableView alloc] initWithFrame:self.view.bounds style:UITableViewStylePlain];
    self.tableView.delegate = self;
    self.tableView.dataSource = self;
    [self.view addSubview:self.tableView];
}
// <- AutoSnippetPlaceholder
```

脚本做三件事：
1. `grep` 递归搜索目录，找到含标记的文件
2. `sed` 按行号截取代码块，提取标题、补全键、摘要
3. 拼成 Xcode 的 `.codesnippet` plist 文件，`mv` 到 `~/Library/Developer/Xcode/UserData/CodeSnippets/`

重启 Xcode，代码补全里就出现了自己提取的 snippet。

154 行 Bash。没有依赖，没有配置文件，没有 README。跑了一下，能用。关机回家。

回头来看，这 154 行里包含了一个将贯穿五年的模式：**在源码旁边做标记 → 机器自动提取 → 注入工具链**。只是当时不知道这三步会膨胀成今天的样子。

## 从脚本到工具：Node.js 时代

build.sh 在团队里传了一段时间。问题很快出现：同事开始问标记格式怎么写、能不能加分类、怎么共享给其他人。

Shell 脚本回答不了这些问题。

于是重写成了 Node.js：

```bash
npm install -g autosnippet
```

v1 有了 6 个命令：`init`、`create`、`install`、`share`、`watch`、`update`。用 `inquirer` 做了交互式创建——给你的 snippet 起个名字，选个分类（@View / @Service / @Tool / @Template），写段摘要。`asd share` 导出 JSON，`asd install` 安装。

CLI 入口命令叫 `asd`——左手食指中指无名指，键盘上最顺手的三个字母。这个名字从第一天起就没变过，到今天依然是 `asd`。

npm 上的描述写的是 *"A iOS module management tool."*。还是个 iOS 工具。还是只能写 Xcode snippet。但已经有了配置文件、分类体系和团队共享。

一个人的脚本变成了一个团队能用的工具。但本质没变——**人**标记代码，**机器**提取，**写入 IDE**。

## 断裂：AI 改变了一切

然后 AI 来了。

Cursor、Copilot、Windsurf——代码不再只是人写的了，AI 也在写。而且写得很快。但 AI 有一个根本问题：**它不知道你的团队怎么写代码**。

它会生成能跑的代码，但不是你们的代码。命名风格不对，错误处理模式不对，架构分层不对。你花在 PR review 里纠正 AI 的时间，快赶上自己写了。

那个 2021 年的老问题，换了一种说法冒出来了：

> 如果 AI 能知道我们团队的编码模式，它写的代码是不是能更好？

这和"少写重复代码"是同一个问题。只是规模放大了 100 倍——从一个人的 Xcode 拓展到整个团队的所有 IDE、所有语言、所有 AI 助手。

但如果要让 AI "知道"这些模式，得解决三个新问题：

1. **提取不能再靠人工标记了**。团队有几十万行代码，没人会一行一行地打注释标记。
2. **存储不能再是 plist 文件了**。AI 不读 XML。它需要结构化的、可语义搜索的知识。
3. **交付不能再写入 Xcode 目录了**。AI 需要一个协议来实时查询——而这个协议到 2024 年才被发明出来，叫 MCP。

## 重建：一切都要推翻

v1 到 v3 不是一次升级，是一次重生。几乎每一层都被替换了：

**提取层**：`grep/sed` → Tree-sitter WASM。给 9 种语言打了 AST 解析器——JavaScript、TypeScript、Python、Go、Rust、Java、Swift、Dart、Vue。不再是"第 47 行到第 63 行"的文本截取，而是"这是一个实现了 `From<T>` trait 的结构体方法，包含错误处理和类型转换"的语义理解。

**智能层**：零 → Agent 双管线。一个 1921 行的 `ChatAgent.js`，跑着 ReAct 推理引擎（思考→工具调用→观察→再思考）。两个 Agent 协作：Analyst 判断代码值不值得提取，Producer 负责结构化加工。这是和 v0 差距最大的一层——154 行 Shell 没有任何"判断"，grep 到了就提取；现在有一整个 AI 管线在评估价值。

**存储层**：`.codesnippet` plist → SQLite + 向量索引。10 张表，语义搜索，质量评分体系。snippet 变成了 Recipe——带 frontmatter、维度标注、Do/Don't clause 的结构化知识文档。

**交付层**：`mv` 到 Xcode 目录 → MCP 协议。19 个工具，通过 stdio/SSE 暴露给任何 MCP 客户端。同时维护 6 个投递通道——`.mdc` 规则文件、Cursor Skills、`.cursorrules`、Wiki 文件、Tab 文件。AI 不需要你手动复制粘贴，它在写代码的时候直接查询知识库。

数字上的变化是惊人的：154 行变成 120,000 行，1 种语言变成 9 种，1 个 IDE 变成所有支持 MCP 的客户端。但往回看，每一步都是上一步的自然延伸，不是拍脑袋的发明。Tree-sitter 是因为 grep 在多语言面前撑不住了。Agent 是因为人工标记在大项目里不可行了。MCP 是因为 Xcode snippet 这个容器已经和时代脱节了。

每一次技术更替，都是旧方法撞到了墙。

## 没有竞争对手？

认真搜索过整个 GitHub——8,086 个 MCP Server 仓库，`code-knowledge-base` topic 下 **0 个仓库**。

不是没有人在做相关的事。`cursor.directory` 有 3.8 万 Star，收集了 150 多个 `.cursorrules` 配置文件。Greptile 做 AI 代码审查，能从 PR 评论中学习团队标准。CodeRabbit 做 PR review。Context7 把第三方文档注入 LLM 上下文。

但 AutoSnippet 做的这条完整链路——**从你自己的代码中自动提取模式 → 结构化为带质量评分的知识库 → 通过 MCP 协议投喂给 AI 编码助手**——没有找到同类项目。

为什么？

想了很久，大概有几个原因：

**第一，这个想法是一条链，不是一个点。** 它需要四步全部到位才有意义：标记/发现代码模式 → 结构化提取 → 知识库管理 → AI 实时查询。2021 年做第一步的时候，第三步的 MCP 协议要到 2024 年才出现。大多数人做事是等基础设施齐了再出发，而不是先铺前两步然后等第三步自己出现。

**第二，做"知识沉淀"不性感。** Greptile 可以说 *"AI catches bugs in your PRs"*，一句话就能讲清楚。AutoSnippet 呢？"从代码中自动提取团队的编码模式，结构化为知识库，通过 MCP 协议投喂给 AI 编码助手，使其遵循团队惯例"——这不是一句话能讲清楚的事。

**第三，行业选择了不同的路径。** 大多数人把"让 AI 写出好代码"定义成一个 **prompt engineering** 问题——写更好的 `.cursorrules` 就行了。AutoSnippet 的赌注是：这应该是一个 **knowledge extraction** 问题——规则不应该人写，应该从代码里长出来。

**第四，时间不站在你这边。** 这条链上每一步的成熟期都不一样。2021 年写 Shell 版提取的时候，Node.js 的 ESM 生态和 Tree-sitter WASM binding 还没稳定。AST 解析做到位了，MCP 协议要到 2024 年底才发布。MCP 出来了，LLM 的长上下文能力（能消化一整份 Recipe spec）才刚刚够用。每一步都在等下一步的基础设施自己长出来。多数人站在 2024 年回看会觉得"啊，现在可以做了"——但如果 2024 年才起步，前面三年积累的 AST 解析器、知识 schema、质量评分体系全都是零。你追不上一个已经走了三年的人。这种"不知道终点在哪但先把前两步铺好"的耐心，才是真正的壁垒。不是技术壁垒，是性格壁垒。

谁是对的？手写规则本质上是 v1 方案——和 2021 年手动创建 Xcode snippet 一样。它终将遇到和 build.sh 一样的问题：覆盖不全、更新滞后、没人愿意长期维护。

## 改变的与未曾改变的

回头看这五年，变化是剧烈的：

技术栈从 Bash 到 Node CJS 到 Node ESM。提取从 `grep/sed` 到 Tree-sitter WASM + LLM Agent。存储从散落的 plist 到 SQLite 关系数据库。交付对象从人类开发者变成了 AI 编码助手。支持 IDE 从 Xcode 一个变成了 Cursor、VS Code、Windsurf、Trae 以及所有 MCP 客户端。

但有些东西从第一天到现在一个字都没变：

**`asd` 命令。** 三个字母，五年。



**核心循环。** 标记 → 提取 → 注入。无论是 `grep` + `sed` + `mv`，还是 Tree-sitter + Agent + MCP，都是这三步。

**npm 包名。** `"name": "autosnippet"`，v1.1.12 到 v3.1.13，从未改过。

**MIT 许可证。** 从第一天起就开放。

**作者。** 一个人开始，一直在做。

## 现在到了哪里

如果用一个公式来评估 AutoSnippet 想验证的假说——"自动提取编码模式 → 结构化为知识库 → 喂给 AI → AI 遵循团队惯例"——自评完成度约为 **69%**。

提取能力做到了 72%：9 种语言的 AST 解析已就位，但自动发现的精准度还需要提升，误报和遗漏都有。结构化做到了 82%：Recipe schema 覆盖了质量评分、维度标注、Do/Don't clause，数据模型是所有环节中最成熟的。MCP 投递做到了 68%：通道铺好了，搜索能用，但 ranking 和推荐还不够智能。AI 遵循做到了 55%：这一步最弱——你把 Recipe 喂给 AI 了，AI 有没有真的遵守，还缺乏系统性的度量。

**55% 到 90% 的距离，可能比 0 到 55% 更难走。** 因为前半程是工程问题——写代码就能解决；后半程是认知问题——要让 AI 真正理解并遵循编码惯例，涉及 prompt 策略、上下文窗口管理、反馈闭环，每一步都在和 LLM 的能力边界博弈。

## 五年沉淀的几个认知

五年做一个东西，技术层面收获太多，不一一列举。真正沉淀下来的认知只有几点：

**想法不值钱，坚持做才值钱。** "从代码里提取可复用模式"这个想法，任何一个被重复代码烦过的程序员都能想到。但从想到到做出来，中间隔着十几个技术世代的迁移、无数个"好像没人需要这个"的怀疑时刻、以及一次又一次的架构推翻重来。真正的壁垒不是那个想法，是你在它还"没用"的时候就做了前几步。

**工具会变，问题不会。** grep 会被 Tree-sitter 替代，Tree-sitter 未来可能会被更好的东西替代，MCP 也不一定是最终形态。但"团队里有一些好的编码模式值得被捕捉和传递"这个问题，只要还有人写代码，就不会消失。选对问题比选对工具重要得多。

**赌问题，别赌方案。** 五年前没人预见 AI 会写代码，没人知道 MCP 协议会出现，Tree-sitter 的 WASM binding 也还不存在。如果当时赌的是"Xcode Snippet 管理工具"这个方案，它已经死了。但赌的是"团队编码模式值得被沉淀和复用"这个问题——AI 时代不但没让这个问题消失，反而放大了一百倍。每次技术换代，方案要推翻，但问题只会换一种更大的方式回来。

**一个人也可以。** 这不是鸡汤。AutoSnippet 没有联合创始人、没有投资、没有团队。12 万行代码全是一个人写的。这听起来很壮烈，但其实大多数时候只是安静地写代码——周末早上写两个小时，工作日晚上调一个 bug，午休时读一篇 Tree-sitter 的文档。不需要 all-in，只需要不停。

## 接下来：第四次转型

前三次转型：Shell→Node（脚本到工具）、单语言→多语言（Xcode 到全平台）、人工标记→AI 自动提取（grep 到 Agent）。每次都是旧方法撞墙，被逼出来的。

第四次已经隐约可见了：从"喂给 AI"到"闭环"。

现在的 AutoSnippet 做到了把知识投递给 AI，但 55% 的遵循度意味着将近一半的时候，AI 读了 Recipe 还是写了自己的版本。**交付知识是不够的，还需要验证执行。** 下一步是 Guard 规则实时校验 AI 生成的代码——不符合 Recipe 的部分在生成瞬间被拦截或修正，而不是等人在 PR review 里挑出来。

做到这一步，AutoSnippet 就不再是一个"知识库"，而是一个**编码惯例的运行时**。Guard 已有 40 多条 AST 校验规则，LLM 能力在快速进步，缺的是把两层缝合起来的中间件。

一个越来越清晰的事实：这个问题在变大，不是在变小。AI 写的代码越来越多，"AI 生成代码的合规性"已经从 nice-to-have 写进了工程规范。趋势在加速，而这个项目已经在路上走了五年。
