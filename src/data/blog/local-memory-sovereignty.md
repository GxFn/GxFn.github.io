---
author: Gao Xuefeng
pubDatetime: 2026-04-15T08:00:00+08:00
title: 本地记忆主权：当 AI 平台争夺你的上下文
slug: local-memory-sovereignty
featured: true
draft: false
tags:
  - Alembic
  - AI
  - 隐私
  - 架构思考
description: AI 编程工具的"记忆"功能把你的开发者画像存在别人的服务器上。从 ChatGPT Memory 到 Claude Managed Agents，从 Marcel Bucher 的数据消失事件到 Alembic 的本地优先设计——聊聊知识该属于谁。
---

> Agent 是消耗品，知识是资产。谁控制记忆，谁就控制了 AI 编程的未来。

## 一个正在发生的故事

2024 年 2 月 13 日，OpenAI 为 ChatGPT 加入 [Memory 功能](https://openai.com/index/memory-and-new-controls-for-chatgpt/)。到 2025 年 4 月，Memory 进一步增强——ChatGPT 不仅保存你明确要求它记住的内容，还会**自动回溯所有历史对话**来构建用户画像。同期，Anthropic 将 Claude Code SDK 更名为 Claude Agent SDK，数据收集条款写明：收集"usage data（如代码的采纳或拒绝）以及 associated conversation data"。2026 年，Anthropic 推出 [Managed Agents](https://www.anthropic.com/engineering/managed-agents)——替你在云端长期运行 Agent 的托管服务。Agent 的记忆、上下文、决策历史被打包为持久化 session log，存储在 Anthropic 的基础设施上；你的 agent 积累的上下文越丰富，你就越难迁走。

然后事情发生了。2026 年 1 月，瑞士研究员 Marcel Bucher 在 [*Nature*](https://www.nature.com/articles/d41586-025-04064-7) 上讲述：当他在 ChatGPT 设置中关闭数据同意选项后，**两年的学术对话历史全部消失**。他没有备份——因为那些"记忆"从来就不在他的硬盘上。

你的编码习惯、项目架构理解、技术决策偏好——这些最私密的开发者画像，存储在别人的数据中心里。

## 三个结构性问题

仔细看 Managed Agents 的架构，三个结构性问题已经浮现：

**锁定。** Managed Agents 将 agent 的全部上下文存储为一条 durable append-only session log——日志越长、项目理解越深，你就越难迁移到另一个平台。锁的不是代码，不是数据，而是**上下文本身**。

**失控。** session log 对平台的 harness 开放，但对你不开放。OpenAI 更直白："我们可能会使用您提供给 ChatGPT 的内容（包括记忆）来改进模型。"你无法审计 AI 到底"记住"了什么，更无法导出为通用格式。

**易碎。** Anthropic 自己说，harness 对上下文的压缩和裁剪是"irreversible decisions about what to keep"。Marcel Bucher 关闭一个设置选项，两年对话消失。团队成员 A 花三个月教会 agent 的项目规范，成员 B 完全无法继承——因为那些"记忆"从来就不在你的文件系统里。

公平地说，并非所有设计都走服务器路线。Claude Code 的 `CLAUDE.md`、Cursor 的 `.cursorrules` 存储在项目本地——方向正确，但只覆盖最浅层的"指令偏好"。项目的知识体系、行为信号、质量守卫规则，仍然没有本地化的解决方案。

## Alembic 的回答：知识和记忆都属于项目

Alembic 做了两件事，服务于不同目的，但共享同一个原则——**本地优先，零数据上传**。

**Recipe 是本职。** 经过验证、评分、审核的项目知识——编码规范、架构模式、最佳实践——以 Markdown 存储在 `Alembic/recipes/`，跟代码一起 Git 管理。确定性资产，团队共享，可审计、可迁移。

**记忆同样在本地。** Agent 的行为信号、对话历史、跨会话事实——帮助 Agent 记住你的习惯和项目上下文的"软知识"——存储在 `.asd/`，不提交 Git，不上传到任何服务器。记忆是个人的，每个开发者的 Agent 独立积累。

```
┌─────────────────────────────────────────┐
│  知识（本职·团队共享） Git 版本控制       │
│  Alembic/recipes/   正式 Recipe     │
│  Alembic/skills/    项目技能        │
├─────────────────────────────────────────┤
│  记忆（个人·不提交 Git）.asd/    │
│    ├── signals/       行为信号 JSONL     │
│    ├── conversations/ 对话历史           │
│    └── session-store/ 会话快照           │
├─────────────────────────────────────────┤
│      ↓ 六通道交付（零数据上传）↓          │
│                                         │
│  Cursor · Windsurf · Copilot            │
│  Claude Code · Trae · 任何 MCP IDE      │
└─────────────────────────────────────────┘
```

换 IDE 只是换了一个交付通道。换模型只是换了一个推理引擎。底层的知识和记忆——全部留在本地。

这和 Git 的故事有深层的相似性。Git 之前，版本历史被锁在 SourceSafe、Perforce 里——服务器挂了历史就没了。Git 把版本历史变成了本地优先的可移植资产。Alembic 正在对 AI 编程的"项目记忆"做同样的事。

## 知识与记忆：四层架构

Recipe 是本职，记忆帮 Agent 记住你——两者服务于不同目的，分布在四个层次上：

| 层次 | 性质 | 内容 | 存储 |
|:---|:---|:---|:---|
| **第一层：知识库** | 知识（本职） | 经过验证审核的 Recipe | `Alembic/recipes/` (Git) |
| **第二层：行为信号** | 记忆 | 工具调用、搜索、审计记录 | `.asd/signals/` (JSONL) |
| **第三层：Agent 记忆** | 记忆 | 跨会话的项目事实和行为偏好 | SQLite 本地数据库 |
| **第四层：会话上下文** | 记忆 | 当前对话的工作状态 | 内存 + session-store |

记忆会向上沉淀，最终可能跨越边界成为正式知识：

> Agent 在一次对话中发现"这个项目的错误处理遵循特定模式"（第四层）→ 会话结束后作为信号持久化（第二层）→ 多次积累后确认为项目事实（第三层）→ 代谢引擎检测到足够的信号支撑，生成 Evolution Proposal，经人工审核后成为正式 Recipe（第一层）。

**记忆帮 Agent 记住你，知识帮项目记住自己。** 从临时的行为观察到结构化信号到项目事实到人工审核的正式 Recipe——每一步都伴随着确定性的增强。

> 四层记忆的工程实现细节——包括信号总线设计、三维记忆评分、Token 预算管理和代谢引擎的消费策略——在 [《Alembic Book》](https://github.com/GxFn/alembic-book) 中有完整展开。

## 隐私不是口号，是工程约束

"本地存储"三个字说起来轻松，但要在每个角落防止数据外泄，需要多层工程实现：

- **PathGuard 文件沙箱**：双层路径检查，AI Agent 即使幻觉出不合理的写入操作，也无法写出项目目录
- **Constitution 权限矩阵**：AI Agent 角色被严格约束——不能删除数据，不能修改系统配置，不能访问审计日志
- **零外传架构**：MCP Server 使用 stdio 传输，不开网络端口——知识检索、Guard 审计、信号持久化全在本地完成
- **搜索结果投影**：即使 AI 模型能看到对话中的知识片段，它拿到的也是经过 `SlimSearchResult` 裁剪的摘要，不是完整的 Recipe 内容

> PathGuard 的路径规则、Constitution 的角色定义和 MCP 零外传链路的完整代码分析见 [《Alembic Book》](https://github.com/GxFn/alembic-book) Part 1 & Part 6。

## 飞轮效应：越用越好

本地知识和记忆共同产生了平台方案无法复制的正反馈循环：

**冷启动：知识先行。** 一个项目跑完 Bootstrap，产出 50-200 条 Recipe——这是知识层的即时产出。新来的 Agent 直接享用，不需要重新"教"。同时，Agent 的每次交互都在本地积累行为信号和记忆，让后续的 Agent 越来越懂你的习惯。平台方案的问题是换模型 = 从头开始；Alembic 的知识独立于模型，记忆跟着项目走。

**信号驱动进化。** Agent 的行为记忆反哺知识库：搜索信号发现高频知识 → 提升交付优先级；Guard 信号发现频繁违规 → 增强检测权重；意图信号发现覆盖盲区 → 生成 Gap 分析。记忆越丰富，知识越精准——循环的每一步都发生在本地。

**团队共享。** 知识库跟代码仓库走，`git pull` 就能同步团队最新的 Recipe 和技能。记忆则是个人的——每个开发者的 Agent 独立积累行为信号，但高价值的发现会通过晋升机制变成 Recipe，进而成为团队共识。新成员加入时，Recipe 已经包含了团队积累的所有编码约定；Agent 自己的记忆则从第一次交互开始积累。平台方案做不到这一点——Claude 记住的是某一个用户的偏好，锁在云端连自己都带不走。

## 和平台方案的本质区别

| 维度 | 平台方案 | Alembic |
|:---|:---|:---|
| **所有权** | 平台拥有 | 项目拥有 |
| **可迁移性** | 锁定在单一平台 | `git clone` 即完成 |
| **团队共享** | 个人绑定 | `git pull` 即同步 |
| **模型独立性** | 绑定特定模型 | 任何 MCP 兼容 Agent |
| **存活性** | 平台停运 = 消失 | 文件在 = 知识和记忆都在 |
| **数据用途** | 可能用于模型训练 | 仅供本地消费 |

最深层的区别是**激励对齐**。平台的激励是让你留在平台上——记忆越丰富，迁移成本越高。Alembic 的激励是让你的项目越来越好——知识和记忆增值的受益者是你，不是某个平台。

## 写在最后

AI 工具会更新换代，编程语言会推陈出新，但项目的知识和记忆不应该因为任何外部变动而归零。

这是 Alembic 比 SOUL 原则更底层的存在性选择：**知识和记忆属于创造它的人。**

这篇博客是 [《Alembic Book》](https://github.com/GxFn/alembic-book) Part 1 "本地记忆主权"一章的精简版。完整版包含四层记忆的工程实现、PathGuard / Constitution / MCP 零外传架构的源码分析、记忆整合引擎与遗忘策略的设计蓝图，以及跨项目记忆迁移的规划。感兴趣的可以去翻翻。
