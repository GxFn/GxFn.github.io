# gaoxuefeng.com

个人博客，基于 [Astro](https://astro.build/) + [AstroPaper](https://github.com/satnaing/astro-paper) 构建。

## 开发

```bash
npm install
npm run dev       # 本地开发 http://localhost:4321
npm run build     # 构建
npm run preview   # 预览构建结果
```

## 写文章

在 `src/data/blog/` 下新建 `.md` 文件，frontmatter 格式：

```yaml
---
author: Gao Xuefeng
pubDatetime: 2026-01-01T00:00:00+08:00
title: 文章标题
slug: url-slug
featured: false
draft: false
tags:
  - 标签
description: 简短描述
---
```

## 部署

推送到 `main` 分支后，GitHub Actions 自动构建并部署到 GitHub Pages。

自定义域名：`gaoxuefeng.com`

## 相关项目

- [AutoSnippet](https://github.com/GxFn/AutoSnippet) — AI 代码知识库
- [AutoSnippet Book](https://docs.gaoxuefeng.com) — 技术架构深度解析

