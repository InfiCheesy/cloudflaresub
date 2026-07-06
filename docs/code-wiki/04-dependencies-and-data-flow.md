# 依赖关系与数据流

## 1. 依赖总览

项目依赖非常少，但运行时依赖强烈绑定 Cloudflare 平台能力。

## 1.1 `package.json` 依赖

唯一显式 npm 依赖：

- `wrangler`

用途：

- 本地开发
- Worker 部署
- Worker 调试

这意味着项目本身几乎不依赖第三方业务库，核心逻辑主要由原生 JavaScript 和 Cloudflare Runtime API 构成。

## 1.2 平台依赖

### Cloudflare Workers Runtime

项目直接使用：

- `Request`
- `Response`
- `URL`
- `crypto.subtle`
- `crypto.getRandomValues`
- `atob`
- `btoa`

### Workers KV

绑定名：

- `SUB_STORE`

用途：

- 保存订阅详情
- 保存输入去重映射

### Static Assets Binding

绑定名：

- `ASSETS`

用途：

- 提供 `public/` 下的静态页面和资源文件

### Secret / Variable

- `SUB_ACCESS_TOKEN`

用途：

- 保护 `/sub/:id` 的访问

## 1.3 浏览器端依赖

前端页面没有使用框架，但依赖：

- 浏览器原生 DOM API
- `fetch`
- `navigator.clipboard`
- 第三方二维码脚本 `qrcodejs`

二维码库引入方式是 CDN 脚本：

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
```

这意味着前端构建成本低，但页面在二维码功能上依赖外部 CDN 可达性。

## 2. 模块依赖图

```text
public/index.html
  ├─ 引入 public/styles.css
  ├─ 引入 qrcodejs CDN
  └─ 引入 public/app.js

public/app.js
  └─ 依赖 POST /api/generate 的返回结构

src/worker.js
  ├─ 依赖 Cloudflare Runtime
  ├─ 依赖 env.SUB_STORE
  ├─ 依赖 env.ASSETS
  └─ 依赖 env.SUB_ACCESS_TOKEN

tests/smoke.mjs
  └─ 依赖 src/core.js
```

## 3. 前后端契约

## 3.1 请求契约：`POST /api/generate`

前端发送：

```json
{
  "nodeLinks": "vmess://...\nvless://...",
  "preferredIps": "104.16.1.2#HK\n104.17.2.3:2053#US",
  "namePrefix": "CF",
  "keepOriginalHost": true
}
```

字段语义：

- `nodeLinks`
  - 多行节点链接，支持直接粘贴 Base64 订阅内容。
- `preferredIps`
  - 多行优选地址，格式为 `host[:port][#remark]`。
- `namePrefix`
  - 展开后的节点备注前缀。
- `keepOriginalHost`
  - 是否保留原始 Host / SNI。

## 3.2 响应契约

Worker 返回：

```json
{
  "ok": true,
  "storage": "kv",
  "deduplicated": true,
  "shortId": "AbC123xYz9",
  "urls": {
    "auto": "https://example.workers.dev/sub/AbC123xYz9?token=...",
    "raw": "https://example.workers.dev/sub/AbC123xYz9?target=raw&token=...",
    "clash": "https://example.workers.dev/sub/AbC123xYz9?target=clash&token=...",
    "surge": "https://example.workers.dev/sub/AbC123xYz9?target=surge&token=..."
  },
  "counts": {
    "inputNodes": 1,
    "preferredEndpoints": 2,
    "outputNodes": 2
  },
  "preview": [],
  "warnings": []
}
```

前端依赖这些字段来更新：

- 订阅链接输入框
- 节点数量统计卡片
- 节点预览表格
- 警告提示区域

## 4. 数据流详解

## 4.1 页面初始化

数据流：

```text
Browser -> GET / -> Worker -> ASSETS -> public/index.html
index.html -> 加载 styles.css / qrcodejs / app.js
```

前端初始化时不主动请求业务数据，页面是静态渲染。

## 4.2 生成订阅的数据流

```text
用户输入
  -> app.js 读取表单
  -> fetch('/api/generate')
  -> worker.js: handleGenerate
  -> parseRawLinks
  -> parsePreferredEndpoints
  -> buildNodes
  -> buildDedupHash
  -> SUB_STORE.get(dedup:<hash>)
  -> 如果不存在则:
       -> createUniqueShortId
       -> SUB_STORE.put(sub:<id>)
       -> SUB_STORE.put(dedup:<hash>)
  -> 返回 urls / counts / preview / warnings
  -> app.js 渲染页面
```

## 4.3 拉取订阅的数据流

```text
客户端请求 /sub/:id?target=clash&token=...
  -> worker.js: handleSub
  -> validateAccessToken
  -> SUB_STORE.get(sub:<id>)
  -> JSON.parse(record)
  -> renderClash / renderSurge / renderRaw
  -> 返回文本
```

## 5. 数据持久化模型

项目只有 KV 持久化，没有数据库和对象存储。

### 5.1 为什么需要两个键

#### `sub:<id>`

用途：

- 保存完整订阅记录
- 供 `/sub/:id` 读取

#### `dedup:<hash>`

用途：

- 对同样的输入结果进行去重
- 避免重复生成多个不同短链

### 5.2 TTL 设计

TTL 为 7 天，意味着：

- 主记录 7 天后自动失效
- 去重键也会同时过期
- 过期后再次提交相同输入，会重新生成新短链

这种设计适合轻量、短周期、低成本场景，但不适合长期稳定订阅链接场景。

## 6. 参数在系统中的流转

## 6.1 `keepOriginalHost`

这是整个项目最关键的业务选项之一。

流转过程：

1. 前端读取 checkbox 状态。
2. 通过 JSON 提交给 `/api/generate`。
3. Worker 在 `buildNodes()` 中依据它决定：
   - 是否保留原 Host / SNI。
   - 是否让优选 IP 只替换 `server`。

业务意义：

- 对 Cloudflare CDN / TLS 场景来说，通常应保留原 Host / SNI。
- 如果错误关闭，节点可能能连上 IP 但 TLS 握手失败。

## 6.2 `namePrefix`

流转过程：

1. 前端从输入框读取。
2. Worker 在展开节点时拼进备注名。
3. 导出到 Raw / Clash / Surge 时继承到最终节点名。

结果：

- 用户可以识别一组由同一批优选地址生成的节点。

## 6.3 `preferredIps`

流转过程：

1. 输入文本被解析成端点数组。
2. 每个端点与每个基础节点做笛卡尔组合。
3. 优选端点上的端口优先覆盖原节点端口。

结果：

- `N` 个基础节点与 `M` 个优选地址会生成 `N x M` 个输出节点。

## 7. `worker.js` 与 `core.js` 的依赖错位

这是当前仓库最值得注意的设计现状。

## 7.1 现状

- `worker.js` 自己维护解析、展开和导出逻辑。
- `core.js` 也维护相近功能，但更完整。
- `tests/smoke.mjs` 依赖的是 `core.js`。

## 7.2 直接影响

- 测试通过，不一定代表线上 Worker 行为完全一致。
- 新增协议参数时，可能只改了 `core.js`，却遗漏 `worker.js`。
- 文档维护时需要同时关注两套实现。

## 7.3 推荐演进方向

理想依赖关系应是：

```text
worker.js
  ├─ 路由
  ├─ 鉴权
  ├─ KV 读写
  └─ 调用 core.js

core.js
  ├─ 解析
  ├─ 展开
  ├─ 渲染
  └─ 安全工具
```

这样可以让测试和线上逻辑使用同一套核心能力。

## 8. 外部依赖风险点

- Cloudflare KV 未绑定时，生成与读取订阅会失败。
- `SUB_ACCESS_TOKEN` 设置后，外部客户端必须携带正确 token。
- 二维码库依赖 CDN，若网络不可达则页面二维码功能失效。
- `Surge` 导出能力只覆盖部分协议场景，不宜假设与 Clash 导出完全等价。

## 9. 依赖关系总结

- npm 依赖极少，复杂度主要来自业务逻辑而非包管理。
- 运行时强依赖 Cloudflare 平台能力。
- 前端与后端通过固定 JSON 契约耦合。
- 测试与线上代码当前未完全共享同一实现，是架构上的主要维护风险点。
