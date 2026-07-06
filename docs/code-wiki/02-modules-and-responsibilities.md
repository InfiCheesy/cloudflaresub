# 模块与职责

## 1. 模块划分总览

项目可以拆成 4 个主要模块层：

1. Worker 路由与运行时模块：`src/worker.js`
2. 通用核心库模块：`src/core.js`
3. 前端页面模块：`public/*`
4. 测试模块：`tests/smoke.mjs`

## 2. Worker 路由与运行时模块

文件：`src/worker.js`

这是线上实际运行的主模块，负责：

- HTTP 路由分发
- CORS 处理
- 请求体解析
- 节点解析与节点展开
- 订阅内容导出
- KV 去重与短链存储
- 订阅访问令牌校验
- 静态资源回退

### 2.1 内部职责分组

#### 响应封装

- `json(data, status)`
  - 返回 JSON 响应。
  - 同时附加 CORS 头。
- `text(body, status, contentType)`
  - 返回文本响应。

#### 基础编解码

- `b64EncodeUtf8(str)`
- `b64DecodeUtf8(str)`
- `escapeYaml(str)`

这些函数用于：

- `vmess` 编码/解码
- 原始订阅 Base64 输出
- Clash YAML 转义

#### 输入解析

- `parsePreferredEndpoints(input)`
  - 解析多行优选地址。
  - 支持 `host[:port][#remark]`。
- `parseVmess(link)`
  - 解析 `vmess://`。
- `parseUrlLike(link, type)`
  - 解析 `vless://` 与 `trojan://`。
- `parseRawLinks(input)`
  - 解析多行节点。
  - 支持直接粘贴 Base64 订阅文本。

#### 节点展开

- `buildNodes(baseNodes, preferredEndpoints, options)`
  - 把基础节点与优选地址做笛卡尔展开。
  - 生成最终输出节点名。
  - 根据 `keepOriginalHost` 决定是否保留原 `host` / `sni`。

#### 节点序列化

- `encodeVmess(node)`
- `encodeVless(node)`
- `encodeTrojan(node)`
- `renderRaw(nodes)`
- `renderClash(nodes)`
- `renderSurge(nodes, baseUrl, accessToken)`

#### 存储与去重

- `createShortId(length)`
  - 生成随机短 ID。
- `createUniqueShortId(env, tries)`
  - 确保 KV 中不存在冲突。
- `normalizeLines(value)`
  - 对输入做排序与归一化。
- `sha256Hex(input)`
  - 生成去重哈希。
- `buildDedupHash(body)`
  - 基于输入内容生成稳定 hash。

#### 业务路由

- `handleGenerate(request, env, url)`
  - 生成订阅记录。
- `validateAccessToken(url, env)`
  - 校验访问令牌。
- `handleSub(url, env)`
  - 返回对应格式的订阅内容。

#### Worker 入口

- `export default { fetch(request, env) { ... } }`

### 2.2 该模块的边界

它不负责：

- 前端页面渲染逻辑
- 复杂状态管理
- 数据库存储
- 自动查找优选 IP

它只负责“接收输入、生成可复用订阅结果、输出文本格式”。

## 3. 通用核心库模块

文件：`src/core.js`

这是一个更适合复用与测试的纯函数库，特点是：

- 以 `export function` 形式暴露能力
- 职责拆分比 `worker.js` 更细
- 支持更完整的协议字段
- 支持 AES-GCM 载荷加解密
- 支持 `json` 订阅导出

### 3.1 主要能力域

#### 输入标准化与识别

- `normalizeText`
- `splitCsvLike`
- `detectTarget`
- `buildShareUrls`

#### 订阅加解密

- `ensureSecret`
- `encryptPayload`
- `decryptPayload`

#### 节点与优选地址解析

- `parseNodeLinks`
- `parsePreferredEndpoints`
- `parseVmessUri`
- `parseVlessUri`
- `parseTrojanUri`
- `parseEndpoint`

#### 节点展开与预览

- `expandNodes`
- `summarizeNodes`

#### 导出渲染

- `renderSubscription`
- `renderRawSubscription`
- `renderClashSubscription`
- `renderSurgeSubscription`
- `renderNodeUri`
- `renderVmessUri`
- `renderVlessUri`
- `renderTrojanUri`

### 3.2 与 `worker.js` 的关系

`src/core.js` 可以理解为“理想的纯业务层”，而 `src/worker.js` 是“当前实际运行的接入层 + 内嵌业务实现”。

当前现状：

- `worker.js` 没有直接 import `core.js`
- 两者功能有明显重叠
- `core.js` 的抽象更细、更适合扩展和测试

这表明仓库存在“尚未完成统一收敛”的代码结构。

## 4. 前端页面模块

文件：

- `public/index.html`
- `public/app.js`
- `public/styles.css`
- `public/icons/*`

### 4.1 `public/index.html`

职责：

- 组织页面结构
- 提供表单输入区
- 提供结果展示区
- 提供二维码弹窗
- 引入前端脚本和二维码库

页面核心区域：

- Hero 介绍区
- 节点与优选地址输入区
- 结果链接区
- 统计卡片区
- 预览表格区
- 二维码弹窗

### 4.2 `public/app.js`

职责：

- 绑定 DOM 事件
- 提交 `/api/generate`
- 渲染 API 返回结果
- 处理复制操作
- 处理二维码弹窗
- 对预览内容做基础 HTML 转义

主要交互流：

1. 用户点击“填入演示数据”时填充示例。
2. 用户点击“生成订阅”时发送请求。
3. 成功后回填各类订阅链接和统计信息。
4. 提供复制与二维码导入能力。

### 4.3 `public/styles.css`

职责：

- 定义整体深色主题
- 定义响应式布局与卡片风格
- 定义表单、按钮、结果卡片、表格和模态框样式

该文件属于纯表现层，没有业务逻辑。

## 5. 测试模块

文件：`tests/smoke.mjs`

职责：

- 验证 `src/core.js` 的关键能力可正常工作
- 作为最低成本的功能回归检查

当前覆盖点：

- 节点解析
- 优选地址解析
- 节点展开
- Raw 导出
- Clash 导出
- Surge 导出
- AES-GCM 加密与解密

### 5.1 测试边界

当前未覆盖：

- `src/worker.js` 的路由行为
- KV 写入与读取
- `SUB_ACCESS_TOKEN` 校验分支
- `env.ASSETS.fetch()` 静态资源回退

因此，它更像是“核心能力 smoke test”，不是完整集成测试。

## 6. 配置模块

### 6.1 `wrangler.toml`

职责：

- 指定 Worker 入口
- 指定兼容日期
- 打开 `workers_dev`
- 绑定静态资源目录
- 让 `/api/*` 与 `/sub/*` 优先进入 Worker

### 6.2 `package.json`

职责：

- 声明 `type: module`
- 提供开发、部署、检查脚本
- 管理唯一开发依赖 `wrangler`

## 7. 模块边界总结

| 模块 | 文件 | 核心职责 | 是否线上直接使用 |
| --- | --- | --- | --- |
| Worker 运行时 | `src/worker.js` | 路由、存储、导出、鉴权 | 是 |
| 核心库 | `src/core.js` | 纯函数解析/展开/渲染/加解密 | 否，当前主要用于测试 |
| 前端页面 | `public/*` | 表单交互、结果展示、二维码 | 是 |
| 测试 | `tests/smoke.mjs` | 核心库冒烟验证 | 否 |
| 配置 | `wrangler.toml` `package.json` | 部署与脚本 | 是 |

## 8. 维护建议

- 如需新增协议字段，优先确认 `worker.js` 与 `core.js` 是否都要同步更新。
- 如需提升测试可信度，建议新增对 `worker.js` 的集成测试。
- 如需长期维护，建议把 `worker.js` 的解析/导出逻辑逐步收敛到 `core.js`。
