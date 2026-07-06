# 项目总览与架构

## 1. 项目定位

`CloudflareSub` 是一个部署在 Cloudflare Workers 上的轻量订阅生成服务，主要解决“将原始节点批量替换为优选 IP / 域名，并输出不同客户端可直接导入的订阅链接”这一问题。

当前支持的节点协议：

- `vmess`
- `vless`
- `trojan`

当前支持的订阅输出格式：

- Raw Base64
- Clash YAML
- Surge 文本配置

## 2. 目标用户与使用场景

典型场景如下：

- 用户已经有自建的 Xray / 3X-UI / VPS 节点。
- 用户已经自行搜集 Cloudflare 优选 IP 或优选域名。
- 用户希望把这些优选地址批量替换进节点。
- 用户希望输出可被 V2rayN、Shadowrocket、Clash、Surge 等客户端直接导入的订阅链接。

## 3. 部署形态

项目采用 `Worker + Static Assets + Workers KV` 的组合部署方式。

### 3.1 运行面

- `src/worker.js` 作为唯一 Worker 入口。
- `public/` 目录作为静态资源目录，由 `ASSETS` 绑定提供。
- `SUB_STORE` 作为 KV Namespace，负责保存订阅记录与去重映射。

### 3.2 路由分工

- `POST /api/generate`
  - 接收前端提交的节点链接和优选地址。
  - 解析并展开节点。
  - 写入 KV。
  - 返回可访问的短链订阅 URL。
- `GET /sub/:id`
  - 从 KV 读取订阅记录。
  - 根据 `target` 参数输出不同格式的订阅内容。
- 其他路径
  - 交给 `env.ASSETS.fetch(request)`，返回前端页面与静态资源。

## 4. 目录结构

```text
cloudflaresub/
├─ public/
│  ├─ icons/                  # 客户端图标与页面图标
│  ├─ app.js                  # 前端交互逻辑
│  ├─ index.html              # 页面结构
│  └─ styles.css              # 页面样式
├─ src/
│  ├─ core.js                 # 通用解析/展开/渲染核心库
│  └─ worker.js               # Worker 入口与 API 路由
├─ tests/
│  └─ smoke.mjs               # 冒烟测试
├─ docs/
│  └─ code-wiki/              # 本套 Wiki 文档
├─ package.json               # npm 脚本与依赖
├─ README.md                  # 用户向说明文档
└─ wrangler.toml              # Worker 配置
```

## 5. 高层架构图

```text
Browser
  │
  │ 访问 /
  ▼
Cloudflare Worker
  ├─ 非 /api/* 与 /sub/* 路由 -> ASSETS -> public/*
  ├─ POST /api/generate
  │    ├─ 解析节点
  │    ├─ 解析优选地址
  │    ├─ 批量展开节点
  │    ├─ 计算去重哈希
  │    └─ 写入 KV 并返回短链
  └─ GET /sub/:id
       ├─ 校验访问 token
       ├─ 读取 KV 记录
       └─ 渲染 raw / clash / surge

Workers KV
  ├─ sub:<id>      -> 实际订阅记录
  └─ dedup:<hash>  -> 去重映射
```

## 6. 核心业务流程

### 6.1 订阅生成流程

1. 用户在页面填写 `nodeLinks`、`preferredIps`、`namePrefix`、`keepOriginalHost`。
2. 前端向 `POST /api/generate` 发送 JSON。
3. Worker 解析原始节点。
4. Worker 解析优选地址列表。
5. Worker 将“基础节点”与“优选地址”做组合展开。
6. Worker 计算归一化哈希，用于去重。
7. 如 KV 中不存在对应去重键，则创建新的短 ID 并存储记录。
8. Worker 返回自动识别、Raw、Clash、Surge 四类订阅 URL。

### 6.2 订阅获取流程

1. 客户端请求 `/sub/:id?target=<format>&token=<token>`。
2. Worker 校验 `SUB_ACCESS_TOKEN`。
3. Worker 从 `SUB_STORE` 中读取 `sub:<id>`。
4. Worker 根据 `target` 调用不同渲染函数。
5. 返回对应格式的文本内容。

## 7. 配置入口

### 7.1 `wrangler.toml`

关键配置如下：

- `name = "cloudflaresub"`
- `main = "src/worker.js"`
- `compatibility_date = "2026-03-06"`
- `assets.directory = "./public"`
- `assets.binding = "ASSETS"`
- `assets.run_worker_first = ["/api/*", "/sub/*"]`

该配置表明：

- 默认请求由静态资源处理。
- `/api/*` 和 `/sub/*` 会优先进入 Worker 逻辑。

### 7.2 `package.json`

项目脚本非常精简：

- `npm run dev`：本地开发
- `npm run deploy`：部署 Worker
- `npm run check`：运行冒烟测试

## 8. 当前架构特点

### 优点

- 仓库小，理解成本低。
- 运行链路清晰，职责集中。
- 不依赖前端框架，部署简单。
- 以 KV 保存订阅记录，适合轻量场景。

### 风险与现状

- `src/worker.js` 内部实现了一套解析和渲染逻辑。
- `src/core.js` 又维护了另一套更通用、更完整的核心库实现。
- `tests/smoke.mjs` 主要测试 `src/core.js`，不是 `src/worker.js`。

这意味着当前仓库在“运行逻辑”和“测试逻辑”之间存在重复实现，后续新增协议特性或导出格式时需要同步两边，否则可能出现行为不一致。
