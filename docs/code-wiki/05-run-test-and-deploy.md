# 运行、测试与部署

## 1. 环境要求

项目运行依赖：

- Node.js
- npm
- Cloudflare Wrangler
- Cloudflare Workers
- Cloudflare Workers KV

仓库本身没有复杂的本地构建链，仅使用 `wrangler` 作为开发与部署工具。

## 2. 安装依赖

在仓库根目录执行：

```bash
npm install
```

安装后会得到 `wrangler`，用于本地调试与部署。

## 3. 本地开发

启动命令：

```bash
npm run dev
```

对应脚本：

```json
"dev": "wrangler dev"
```

本地开发时建议重点验证：

- 页面能否正常打开
- `POST /api/generate` 能否返回结果
- 结果中的各类订阅链接是否可生成

## 4. 配置项说明

## 4.1 `wrangler.toml`

项目关键配置如下：

```toml
name = "cloudflaresub"
main = "src/worker.js"
compatibility_date = "2026-03-06"
workers_dev = true

[assets]
directory = "./public"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*", "/sub/*"]
```

含义：

- `main`
  - Worker 入口文件。
- `assets.directory`
  - 静态页面目录。
- `binding = "ASSETS"`
  - 为 Worker 注入静态资源绑定。
- `run_worker_first`
  - 指定哪些路由优先进入 Worker 逻辑。

## 4.2 必需绑定

### `SUB_STORE`

类型：

- Cloudflare KV Namespace

作用：

- 保存订阅记录
- 保存去重映射

如果缺失：

- `/api/generate` 无法保存结果
- `/sub/:id` 无法读取记录

## 4.3 可选但强烈建议的变量

### `SUB_ACCESS_TOKEN`

类型：

- Secret 或 Variable

作用：

- 为 `/sub/:id` 增加访问校验

行为规则：

- 未设置时：任何人知道短链即可访问
- 已设置时：请求必须带 `?token=<SUB_ACCESS_TOKEN>`

## 4.4 历史兼容项

代码注释和 `core.js` 中仍能看到与 `SUB_LINK_SECRET` 相关的痕迹，但当前主运行链路已经切换为：

- `KV 短链`
- `SUB_ACCESS_TOKEN` 访问保护

因此当前实际部署不依赖 `SUB_LINK_SECRET`。

## 5. 测试方式

运行测试：

```bash
npm run check
```

对应脚本：

```json
"check": "node tests/smoke.mjs"
```

测试内容包括：

- 节点解析
- 优选地址解析
- 节点展开
- Raw 导出
- Clash 导出
- Surge 导出
- AES-GCM 加解密

### 5.1 测试的局限性

当前测试不是完整集成测试，因此不会直接验证：

- Worker 路由
- KV 写入与读取
- `SUB_ACCESS_TOKEN` 分支
- 前端页面交互

如果后续改动集中在 `src/worker.js`，仅执行 `npm run check` 还不够，建议补充集成测试或手工验证。

## 6. 手工验证清单

## 6.1 页面验证

打开 Worker 根路径 `/`，确认：

- 页面可正常加载
- 图标与样式正常
- 表单可填写
- “填入演示数据”按钮有效

## 6.2 生成验证

填写测试数据后点击“生成订阅”，确认：

- `auto` / `raw` / `clash` / `surge` 四类链接均生成
- 节点统计数量正确
- 节点预览表格有内容
- 未配置 `SUB_ACCESS_TOKEN` 时会给出警告

## 6.3 订阅验证

分别请求：

```bash
curl "https://<worker>/sub/<id>?target=raw&token=<token>"
curl "https://<worker>/sub/<id>?target=clash&token=<token>"
curl "https://<worker>/sub/<id>?target=surge&token=<token>"
```

确认：

- `raw` 返回 Base64 文本
- `clash` 返回 YAML
- `surge` 返回文本配置

## 7. 部署方式

## 7.1 命令行部署

执行：

```bash
npm run deploy
```

对应脚本：

```json
"deploy": "wrangler deploy"
```

部署前要确保：

- 已登录 Cloudflare
- `SUB_STORE` 已创建并绑定
- `SUB_ACCESS_TOKEN` 已按需配置

## 7.2 Dashboard 部署

README 中推荐使用 Cloudflare Dashboard 绑定 GitHub 仓库部署。

建议构建设置：

- Framework preset：`None`
- Build command：留空
- Build output directory：留空

原因：

- 这是 Worker 项目，不是传统静态站点打包项目。
- 入口由 `wrangler.toml` 和 Worker 配置决定。

## 8. 运行时常见问题

## 8.1 `/api/generate` 返回错误

优先检查：

- 请求体是否是合法 JSON
- `nodeLinks` 是否至少包含一个有效节点
- `preferredIps` 是否至少包含一个有效优选地址
- `SUB_STORE` 是否已正确绑定

## 8.2 `/sub/:id` 返回 403

优先检查：

- 是否已配置 `SUB_ACCESS_TOKEN`
- 请求 URL 是否带了 `?token=...`
- token 是否与配置值完全一致

## 8.3 `/sub/:id` 返回 404

可能原因：

- `id` 不存在
- 记录已过 TTL 自动过期
- KV 绑定错环境或错命名空间

## 8.4 Surge 导入不符合预期

优先检查：

- 当前节点是否为 `vmess` 或 `trojan`
- 是否误以为 `vless` 也会完整导出到 Surge
- 是否依赖了未覆盖的高级协议参数

## 9. 维护与演进建议

- 若计划增强线上稳定性，优先补充 `worker.js` 的集成测试。
- 若计划长期演进协议能力，优先让 `worker.js` 复用 `core.js`。
- 若计划支持长期固定订阅链接，可考虑把 TTL 设计改为可配置。
- 若计划增强安全性，可重新评估 `core.js` 中的加密载荷方案是否需要恢复使用。
