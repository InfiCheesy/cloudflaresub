# 关键函数与调用链

## 1. 说明

本项目几乎没有 class，核心实现以函数为主。因此本节重点说明“关键函数”而不是“关键类”。

## 2. `src/worker.js` 关键函数

## 2.1 接口入口

### `fetch(request, env)`

作用：

- 作为 Worker 的总入口
- 处理 `OPTIONS`
- 把 `POST /api/generate` 路由到 `handleGenerate`
- 把 `GET /sub/:id` 路由到 `handleSub`
- 其他请求交给静态资源服务

调用链：

```text
fetch
├─ OPTIONS -> CORS 响应
├─ POST /api/generate -> handleGenerate
├─ GET /sub/:id -> handleSub
└─ other -> env.ASSETS.fetch(request)
```

### `handleGenerate(request, env, url)`

作用：

- 解析前端提交的数据
- 调用节点解析与优选地址解析函数
- 生成最终节点集合
- 执行去重与短链存储
- 返回所有订阅 URL 与预览信息

核心输入：

- `body.nodeLinks`
- `body.preferredIps`
- `body.namePrefix`
- `body.keepOriginalHost`

核心输出：

- `shortId`
- `urls.auto`
- `urls.raw`
- `urls.clash`
- `urls.surge`
- `counts`
- `preview`
- `warnings`

内部调用链：

```text
handleGenerate
├─ request.json()
├─ parseRawLinks(body.nodeLinks)
├─ parsePreferredEndpoints(body.preferredIps)
├─ buildNodes(baseNodes, preferredEndpoints, options)
├─ buildDedupHash(body)
├─ env.SUB_STORE.get(dedupKey)
├─ createUniqueShortId(env)        # 仅首次写入时
├─ env.SUB_STORE.put(sub:<id>)
└─ env.SUB_STORE.put(dedup:<hash>)
```

### `handleSub(url, env)`

作用：

- 校验访问令牌
- 读取 KV 中的订阅记录
- 根据 `target` 输出相应格式

分支逻辑：

- `target=clash` -> `renderClash(nodes)`
- `target=surge` -> `renderSurge(nodes, ...)`
- 默认 -> `renderRaw(nodes)`

调用链：

```text
handleSub
├─ validateAccessToken(url, env)
├─ env.SUB_STORE.get(sub:<id>)
├─ JSON.parse(raw)
└─ render by target
```

### `validateAccessToken(url, env)`

作用：

- 如果未配置 `SUB_ACCESS_TOKEN`，直接放行
- 如果已配置，则要求请求带有正确的 `?token=...`

它是项目订阅链接第二层访问保护的唯一入口。

## 2.2 解析与展开

### `parseRawLinks(input)`

作用：

- 解析多行节点链接
- 支持 `vmess://`、`vless://`、`trojan://`
- 如果某一行本身是 Base64 订阅文本，则先解码再递归解析

特点：

- 偏容错
- 出现无法解析的内容时会跳过，而不是直接抛错中断

### `parsePreferredEndpoints(input)`

作用：

- 解析用户输入的优选地址列表
- 把每一行转成：

```js
{
  server: string,
  port: number | undefined,
  remark: string
}
```

支持格式：

- `104.16.1.2`
- `104.16.1.2:2053`
- `cf.example.com`
- `cf.example.com:443`
- `104.16.1.2#HK`

### `buildNodes(baseNodes, preferredEndpoints, options)`

作用：

- 对基础节点做批量展开
- 把优选地址替换进 `server`
- 端口优先使用优选地址中显式指定的端口
- 根据 `keepOriginalHost` 决定是否保留原始 `host` / `sni`
- 重新生成节点名称

这是真正完成“优选 IP 替换”的核心函数。

### `buildDedupHash(body)`

作用：

- 对输入做稳定归一化
- 通过 SHA-256 生成去重 hash

归一化字段包括：

- `nodeLinks`
- `preferredIps`
- `namePrefix`
- `keepOriginalHost`

只要这些输入完全一致，理论上就会命中相同去重键，从而复用旧短链。

## 2.3 导出渲染

### `renderRaw(nodes)`

作用：

- 把节点重新编码成 URI 列表
- 用换行拼接
- 最终整体做 Base64 编码

返回结果适用于：

- V2rayN
- Shadowrocket
- 一些直接支持 Base64 订阅的客户端

### `renderClash(nodes)`

作用：

- 把节点转成 Clash YAML
- 输出 `proxies`、`proxy-groups`、`rules`

特点：

- 自动创建“自动选择”和“节点选择”两个分组
- 对 WS 节点写入 `ws-opts`
- 对 TLS 节点写入 `servername`

### `renderSurge(nodes, baseUrl, accessToken)`

作用：

- 输出 Surge 订阅文本
- 只导出 `vmess` 和 `trojan`
- 在注释里写入 token 保护订阅地址

局限：

- 当前不导出 `vless`
- 配置较为简化，偏向轻量可用而非覆盖全部参数

## 3. `src/core.js` 关键函数

`core.js` 是更纯粹的业务核心层，适合作为后续重构收敛目标。

## 3.1 入口级函数

### `parseNodeLinks(inputText)`

作用：

- 统一解析用户输入的节点文本
- 先尝试展开原始 Base64 订阅
- 对每一行节点逐个解析
- 返回 `{ nodes, warnings, normalizedInput }`

与 `worker.js` 中 `parseRawLinks()` 的差异：

- `core.js` 版本会保留 `warnings`
- 会在完全解析失败时抛出明确错误
- 节点结构更完整

### `parsePreferredEndpoints(inputText)`

作用：

- 支持换行、逗号、分号混合分隔
- 自动去重
- 返回 `{ endpoints, warnings }`

与 `worker.js` 中同名逻辑相比，它的容错和用户提示更友好。

### `expandNodes(baseNodes, endpoints, options)`

作用：

- 对基础节点做批量展开
- 在 `keepOriginalHost` 模式下保留原始 SNI / Host
- 在关闭该选项时尝试把 SNI / Host 替换为目标优选地址
- 返回 `{ nodes, warnings }`

这个版本比 `worker.js` 的 `buildNodes()` 更细致，尤其体现在：

- 保留 `originalServer`
- 明确区分 `hostHeader` 与 `sni`
- 会在 Host/SNI 缺失时给出警告

### `renderSubscription(target, nodes, requestUrl)`

作用：

- 统一根据 `target` 分发输出
- 支持 `raw` / `clash` / `surge` / `json`

相比 `worker.js` 的导出逻辑，它更像一个统一门面函数。

## 3.2 协议级函数

### 解析函数

- `parseVmessUri(node)`
- `parseVlessUri(node)`
- `parseTrojanUri(node)`

职责：

- 把 URI 转成标准节点对象
- 抽取协议字段、TLS 字段、网络字段和附加参数

### 渲染函数

- `renderVmessUri(node)`
- `renderVlessUri(node)`
- `renderTrojanUri(node)`

职责：

- 把标准节点对象重新编码为可导入 URI

这组函数构成了“解析 -> 标准化 -> 再输出”的闭环。

## 3.3 安全相关函数

### `ensureSecret(secret)`

作用：

- 校验加密密钥是否存在且长度足够

### `encryptPayload(payload, secret)`

作用：

- 使用 AES-GCM 加密订阅载荷

### `decryptPayload(token, secret)`

作用：

- 解密并恢复原始订阅载荷

说明：

- 这些函数在当前 `worker.js` 运行链路中没有直接使用。
- 它们体现的是早期或备用的“令牌承载内容”方案。
- 当前线上主方案已经改为“KV 短链 + 访问 token”。

## 4. 前端关键函数

文件：`public/app.js`

### 提交处理函数

位置上表现为对 `form.addEventListener('submit', ...)` 的注册。

作用：

- 从表单读取参数
- 发起 `/api/generate`
- 接收返回 JSON
- 渲染订阅 URL、节点数量统计与前 20 条节点预览
- 处理错误提示

### 复制逻辑

位于 `document.addEventListener('click', ...)` 中的 `data-copy-target` 分支。

作用：

- 使用 `navigator.clipboard.writeText`
- 在失败时降级为 `document.execCommand('copy')`

### 二维码逻辑

位于 `data-qrcode-target` 分支和 `closeQrDialog()` 中。

作用：

- 调用页面中引入的 `QRCode` 库
- 基于订阅 URL 生成二维码
- 控制模态框打开和关闭

### `escapeHtml(value)`

作用：

- 对预览表格中的文本做 HTML 转义
- 避免直接把 API 数据插入 DOM 时造成 HTML 注入

## 5. 关键数据结构

## 5.1 Worker 中的节点结构

`worker.js` 使用的是简化节点结构，典型字段如下：

```js
{
  type,
  name,
  server,
  port,
  uuid,
  password,
  cipher,
  network,
  tls,
  host,
  path,
  sni,
  alpn,
  fp,
  flow
}
```

## 5.2 `core.js` 中的节点结构

`core.js` 节点模型更完整，除了上述字段外，还经常保留：

```js
{
  originalServer,
  hostHeader,
  allowInsecure,
  security,
  alterId,
  headerType,
  serviceName,
  authority,
  endpointLabel,
  endpointSource,
  params
}
```

## 5.3 KV 存储结构

### 主记录

键：

```text
sub:<id>
```

值：

```json
{
  "version": 1,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "options": {
    "namePrefix": "CF",
    "keepOriginalHost": true
  },
  "nodes": []
}
```

### 去重映射

键：

```text
dedup:<sha256>
```

值：

```text
<shortId>
```

TTL 默认是 7 天。

## 6. 最重要的维护结论

- 如果你只关心线上行为，先看 `src/worker.js`。
- 如果你只关心协议解析与导出能力，先看 `src/core.js`。
- 如果你要做长期维护，应该以 `src/core.js` 为收敛中心，把 `worker.js` 逐步瘦身为“路由层 + 存储层”。
