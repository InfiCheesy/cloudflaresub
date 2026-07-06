# Code Wiki

本目录是 `CloudflareSub` 项目的结构化代码文档，面向首次接手仓库的开发者、维护者与二次开发者。

## 适用范围

- 项目整体架构与请求流转
- 主要模块职责与边界
- 关键函数说明
- 依赖关系与数据模型
- 本地运行、测试与部署方式

## 阅读顺序

1. [项目总览](./01-overview-and-architecture.md)
2. [模块与职责](./02-modules-and-responsibilities.md)
3. [关键函数与调用链](./03-key-functions-and-call-chains.md)
4. [依赖关系与数据流](./04-dependencies-and-data-flow.md)
5. [运行、测试与部署](./05-run-test-and-deploy.md)

## 仓库一句话说明

这是一个运行在 Cloudflare Workers 上的“优选 IP 订阅生成器”：

1. 前端收集原始节点与优选 IP / 域名。
2. Worker 解析节点并按优选地址批量展开。
3. 结果写入 Workers KV，并生成 `/sub/:id` 形式的短链订阅。
4. 客户端按 `raw`、`clash`、`surge` 等格式拉取订阅内容。

## 关键入口

- Worker 入口：`src/worker.js`
- 核心库：`src/core.js`
- 前端页面：`public/index.html`
- 前端交互：`public/app.js`
- Worker 配置：`wrangler.toml`
- 冒烟测试：`tests/smoke.mjs`

## 维护提示

- 当前“运行时代码”与“核心库代码”是两套相近实现：`src/worker.js` 未直接复用 `src/core.js`。
- 测试主要覆盖 `src/core.js`，并不直接覆盖 `src/worker.js` 的 HTTP/KV 路由层。
- 后续重构时，优先关注这两处实现的一致性，避免解析与导出行为漂移。
