---
author: Gao Xuefeng
pubDatetime: 2026-02-09T01:42:37+08:00
title: AutoSnippet 将代码库中的模式提取为知识库
slug: autosnippet-manual
featured: true
draft: false
tags:
  - AutoSnippet
  - 工具
description: 介绍开源项目 AutoSnippet——一个代码模式知识库，让 Cursor、Copilot 等 AI 助手按你团队的规范生成代码。
---

# 我写了一个工具，让 AI 写代码终于像「我们团队的人」写的了

> 这篇文章介绍我开发的开源项目 [AutoSnippet](https://github.com/GxFn/AutoSnippet)——一个代码模式知识库，让 Cursor、Copilot 等 AI 助手按你团队的规范生成代码。

---

## 问题：AI 写的代码「能跑」但「不对味」

用 Cursor 或 Copilot 写了大半年代码，我发现一个越来越严重的问题——**AI 生成的代码永远不像我们团队写的**。

命名风格不一样，错误处理的方式不一样，架构分层不一样，甚至 import 的顺序都不一样。它写出来的东西从技术上是对的，但放到代码库里一眼就能看出「这不是我们的人写的」。

结果就是两个选择：要么花时间重写 AI 的输出让它符合规范，要么在每次 Code Review 里反复解释同样的约定。时间长了，AI 带来的效率提升被改代码的成本吃掉了一大半。

我想解决这个问题。

## 思路：把团队的「暗知识」变成 AI 能查的知识库

每个团队都有很多「心照不宣」的规范：

- 网络请求统一用哪个封装？超时怎么设？
- ViewModel 里状态管理用什么模式？
- 日志怎么打？错误怎么向上透传？
- 这个项目里 `Manager` 和 `Service` 的命名边界在哪？

这些东西写在 Wiki 里没人看，写在 Code Review 评论里随着 PR 沉底，存在每个老员工的脑子里随时可能流失。

**AutoSnippet 做的事情就是：把这些知识从代码里提取出来，结构化存储，然后在 AI 写代码时自动喂给它。**

流程很简单：

```
你的代码 → AI 提取模式 → 你审核 → 知识库
                                ↓
                  Cursor / Copilot / VS Code / Xcode
                                ↓
                        AI 按你的规范生成代码
```

## 三条命令跑起来

```bash
npm install -g autosnippet

cd your-project
asd setup        # 初始化工作空间 + 数据库 + IDE 配置
asd coldstart    # AI 扫描代码库，提取模式候选
asd ui           # 打开 Dashboard 审核
```

`asd setup` 会自动检测你装了哪些 IDE（Cursor、VS Code、Trae、Qoder），配好 MCP 连接。`asd coldstart` 会从 14 个维度扫描你的代码——架构模式、命名风格、设计模式、最佳实践、事件流、错误处理……扫描完生成一堆 **Candidate**（候选），等你审核。

打开 Dashboard，看到候选列表。每一条都是 AI 从你代码里提取出来的模式，有代码示例、使用说明、适用场景。你觉得好的，点通过，它就变成一条 **Recipe**（知识条目）进入知识库。觉得不好的就拒绝。

从此以后，IDE 里的 AI 写代码之前会先查你的 Recipe。

## 它不只是「提示词工程」

我知道你在想什么——「这不就是把规范塞进 system prompt 吗」。不是的。

AutoSnippet 做的事情比往 prompt 里塞文本复杂得多：

### 1. 真正理解代码结构

底层用 **Tree-sitter**（WASM 版本，不需要编译 C++）做 AST 解析，支持 9 种语言：JavaScript、TypeScript、Python、Swift、Objective-C、Java、Kotlin、Go、Ruby。不是正则匹配，是真的在解析语法树。

项目里有 11 个 Discoverer 自动识别项目类型（Node 项目、Flutter 项目、Spring 项目、Rust 项目……），还有 17 个 Enhancement Pack 针对具体框架（React、Vue、Next.js、Django、FastAPI、Spring、Android、Go gRPC、LangChain……）加上额外的分析逻辑。

### 2. 四层检索，不是全塞进去

AI 问「网络请求怎么写」的时候，不是把整个知识库塞给它。搜索引擎有四层漏斗：

```
关键词匹配 → BM25 评分 → 语义向量重排 → 多信号融合排序
```

先精确匹配，再语义理解，最后综合质量评分、使用频率、新鲜度等多个信号排出最相关的几条。支持中英文。

### 3. 有 Token 预算控制

AI 的上下文窗口是有限的。AutoSnippet 有一个 `KnowledgeCompressor`，会根据当前情况动态压缩知识内容，确保在 token 预算内塞进最有价值的信息，而不是简单地截断。

### 4. Guard —— 规范不止要建议，还要检查

提取出来的 Recipe 不仅用来「告诉 AI 怎么写」，还会衍生出 Guard 规则用来「检查代码有没有按规范写」。

Guard 引擎内置了 50+ 规则，涵盖：
- **正确性**：ObjC `dispatch_sync(main queue)` 死锁、Swift `DispatchQueue.main.sync` 死锁
- **安全性**：`eval()`、SQL 注入、硬编码密钥
- **性能**：循环内的不必要分配、Dart 的 `setState` 调用
- **风格**：命名约定、代码组织方式

可以接到 CI 流水线（`asd guard:ci`）和 git pre-commit hook（`asd guard:staged`），在代码合入前自动卡住不合规的。

## IDE 深度集成

AutoSnippet 通过 [MCP（Model Context Protocol）](https://modelcontextprotocol.io/) 和 IDE 通信。MCP 是 Anthropic 推出的开放协议，让 AI 模型能够访问外部工具和数据。

共 16 个 MCP 工具：搜索知识库、浏览知识、Guard 检查、项目结构探查、知识创建、候选管理……IDE 里的 AI 可以按需调用这些工具。

### Cursor

效果最好的 IDE。除了 MCP，还支持：
- **Cursor Rules**——把 Recipe 摘要写入 `.cursor/rules/`，AI 自动遵守
- **Agent Skills**——20 个 Skill 包，AI 不只查知识库，还能扫描代码、创建候选、执行 Guard 检查
- **自然语言驱动**——在 Cursor 里直接说「帮我提取一下 network 模块的规范」，AI 会自动调 MCP 完成

### VS Code (Copilot)

MCP Server + 自研 VS Code 扩展，支持：
- **CodeLens**——在代码上方直接显示关联的 Recipe
- **文件指令**——在代码里写 `// as:s network timeout` 自动搜索并插入相关知识
- **保存时检查**——保存文件自动触发 Guard 审计

### Xcode

通过 `asd watch` 文件监听实现，支持文件指令检测、代码片段同步。

## Dashboard —— 不只是个列表页

`asd ui` 启动的 Dashboard 是一个功能完整的 Web 管理界面（React + Vite + Tailwind），包含：

- **Recipe 浏览器**——搜索、过滤、查看完整知识条目
- **Candidate 审核台**——审核 AI 扫描出来的候选，通过/拒绝/编辑
- **AI Chat**——内置的 AI 对话，背后是一个 ReAct 推理引擎 + DAG 任务管线，支持 54 个内置工具
- **知识图谱**——可视化展示知识之间的关联关系
- **Guard 报告**——合规检查的可视化结果
- **模块探查器**——浏览项目的模块结构和依赖关系
- **Wiki 生成**——一键从知识库生成项目 Wiki
- **LLM 配置**——在界面上切换 AI Provider，不用改 `.env`

## 架构设计

我花了很多心思在架构上。采用分层领域驱动设计（Layered DDD）：

```
IDE 接入层       Cursor · VS Code · Trae · Qoder · Xcode · Dashboard
                                     │
                             MCP Server + HTTP API
                                     │
服务层           Search · Knowledge · Guard · Chat · Bootstrap · Wiki
                                     │
核心层           AST (9 lang) · KnowledgeGraph · RetrievalFunnel · QualityScorer
                                     │
基础设施层       SQLite · VectorStore · EventBus · AuditLog · DI Container (40+)
```

几个我比较满意的设计决策：

- **Markdown 是真相来源**——Recipe 存为 Markdown 文件，SQLite 只是读缓存。数据库坏了 `asd sync` 重建，但 Markdown 文件能直接看、直接改、直接进 Git
- **无编译步骤**——纯 JavaScript（ESM），不用 TypeScript 编译（Dashboard 除外）。Node.js ≥ 20 直接跑
- **WASM AST**——`web-tree-sitter` 替代原生 `tree-sitter`，彻底摆脱 C++ 编译依赖，`npm install` 就能用
- **自研 DI 容器**——40+ 服务的懒加载单例注入，不依赖任何外部 DI 框架。支持 AI Provider 热重载
- **宪法系统（RBAC）**——三层权限架构：能力层（运行时探测）、角色层（IDE AI / 内置 AI / 开发者）、治理层（4 条硬规则）。确保 AI 不会在没有你确认的情况下删除数据或发布内容

## AI Provider 支持

不绑定任何一家。支持 Google Gemini、OpenAI、Claude、DeepSeek、Ollama（本地）。配多个 Key 会自动 fallback——Gemini 挂了切 OpenAI，OpenAI 挂了切 DeepSeek。

甚至不配 AI 也能用——知识库本身不依赖 AI。你手动写 Recipe Markdown 文件，`asd sync` 进库，搜索和 Guard 照样工作。AI 只是让「从代码里提取模式」这一步自动化了。

## 跨平台

最初是 macOS Only（因为有 Xcode 功能），3.0.9 版本做了一次深度跨平台审计，修复了 7 处 macOS 专属依赖：

- 剪贴板操作：macOS `pbcopy` / Linux `wl-copy` + `xclip` / Windows PowerShell
- 通知：macOS `osascript` / Linux `notify-send` / Windows UWP Toast
- IDE 发现：三个平台各自的路径探测
- 路径解析：`readlink -f` → Node.js 原生 `fs.realpathSync()`

现在 macOS / Linux / Windows 都能用了（Xcode 功能除外）。

## 和现有工具的区别

| | AutoSnippet | ESLint / Biome | .cursorrules 手写 |
|--|-------------|----------------|-------------------|
| 知识来源 | AI 从代码提取 + 人工审核 | 手写规则 | 手写 |
| 覆盖范围 | 架构/模式/惯例/最佳实践 | 语法/格式 | 自由文本 |
| 维护方式 | 持续从代码演化 | 手动更新配置 | 手动更新文件 |
| AI 交付 | MCP 协议自动推送 | 不涉及 AI | 仅限 Cursor |
| 合规检查 | Guard (正则 + AST) | 有 | 无 |
| 多 IDE 支持 | Cursor/VS Code/Trae/Qoder/Xcode | IDE 无关 | 仅 Cursor |

**AutoSnippet 不替代 ESLint**，它们覆盖的层次不同。ESLint 管代码格式和语法规则，AutoSnippet 管「我们团队怎么写网络请求」「ViewModel 里状态怎么管」这种更高层的东西。

## 真实使用场景

我自己在几个项目上跑 AutoSnippet。举几个场景：

**场景一：新人入职**

新人 clone 代码后跑 `asd setup && asd coldstart`，知识库自动建好了。在 Cursor 里写代码的时候，AI 直接按团队规范生成。以前新人需要一两周摸索的「团队暗知识」，现在第一天就能用上。

**场景二：大型重构**

重构前先 `asd guard:ci` 生成合规报告，看看哪些模块偏离了规范。重构过程中 Guard 实时检查，确保新代码符合模式。重构完再扫描一遍，把新模式沉淀进知识库。

**场景三：跨模块开发**

你要改一个不熟的模块。在 Cursor 里问「这个模块的错误处理规范是什么」，MCP 自动搜索知识库返回相关 Recipe，附带代码示例和使用指南。不用翻 Wiki，不用问人。

## 写在最后

AutoSnippet 解决的核心问题是：**AI 编码助手缺乏团队上下文**。

它不是另一个 prompt 模板工具，而是一个完整的知识管理基础设施——从提取、审核、存储、检索到交付的全链路。

项目开源（MIT），欢迎试用和反馈：

- **GitHub**: [github.com/GxFn/AutoSnippet](https://github.com/GxFn/AutoSnippet)
- **npm**: `npm install -g autosnippet`
- **文档**: 项目内 `docs/` 目录有完整的架构设计、CLI 参考、配置指南、IDE 集成说明

![AutoSnippet 架构图](../../assets/images/20260205232116_66_167.png)
