# 书屿志 Bookbar Atlas

一个从零实现的独立书店地图站：按**书架主题、座位、活动**寻找门店；服务端计算营业实例、预生成时间窗、处理闭店专场报名与最后席位并发抢占；数据持久化在 SQLite（开发使用无原生编译依赖的 `sql.js`）。

## 业务规则

- 门店保存 IANA 时区、按周周期时段、临时闭店/临时改营业例外。
- 所有营业区间都转换为**绝对 UTC 毫秒实例**，并保留门店本地“开场锚日”。
- 跨午夜时段不会按浏览者日期截断：例如本地周五 22:00 至周六 02:00 归属周五。
- 临时闭店优先于常规时间；临时改营业整体替换当日常规时间。
- 夏令时：
  - fall-back 重复墙上时间展开为两个实际 UTC 实例；
  - spring-forward 不存在的墙上时间按“跳到跳钟后首个有效时刻”处理；
  - 活动报名回执绑定实际场次的 UTC 起止、店铺名、标题与场次版本。
- 闭店时段活动不会自动取消，也不会自动放行：`open / mixed / closed` 后必须由店长按排程指纹显式授权。
- 实时规则与预生成时间窗在查询前比较；发现漂移先修复，再冻结查询版。
- 地图聚合、列表分页、CSV 导出共用同一 `queryVersionId`。
- 查询版有精确 `expiresAt`：默认不超过 5 分钟，且不晚于下一次状态切换后 1 秒。
- 手工更名、合并、排程更正、闭店授权传播后，旧查询版返回 `410 Gone`，不得继续把旧状态展示为当前。
- 前端网络失败时读取上次成功缓存，并显示“上次更新时间”，同时声明只是离线参考。

## 快速开始

```bash
npm install
npm start
# http://localhost:3000
```

Node.js 20+。首次启动自动创建 `data/bookbar.sqlite` 并写入演示数据。

其他命令：

```bash
npm test     # 14 个验收/边界测试
PORT=8080 npm start
DB_PATH=/srv/bookbar/bookbar.sqlite ADMIN_TOKEN=$(openssl rand -hex 32) npm start
```

开发管理员令牌默认是 `dev-manager-token`，生产必须通过 `ADMIN_TOKEN` 覆盖。

## API 摘要

### 查询版

```http
POST /api/query-versions
Content-Type: application/json

{"q":"推理","themes":["推理"],"seatFeatures":["插座"],"minSeats":10,"openNow":true}
```

同一查询版：

- `GET /api/query-versions/:id/stores?page=1&pageSize=6`
- `GET /api/query-versions/:id/map?zoom=3&bbox=west,south,east,north`
- `GET /api/query-versions/:id/events`
- `GET /api/query-versions/:id/export.csv`

响应包含：

```json
{
  "queryVersionId": "qv_...",
  "generatedAt": 1790000000000,
  "expiresAt": 1790000300000,
  "dataVersion": 3,
  "scheduleVersion": 2
}
```

### 门店与状态

- `GET /api/stores`
- `GET /api/stores/:idOrSlug`
- `GET /api/stores/:idOrSlug/status?at=1790000000000`

状态响应同时包含 `live-computed` 与 `pregenerated-window` 的比较、是否修复以及下一次状态变更点。

### 报名与闭店专场授权

```http
POST /api/events/event-id/registrations
{"attendeeName":"张三","attendeeContact":"a@example.com","seats":1}
```

未授权闭店专场返回：

```json
{ "code": "CLOSED_EVENT_UNAUTHORIZED", "error": "闭店专场尚未显式授权，不能报名，也不会自动放行" }
```

显式授权：

```http
POST /api/admin/events/event-id/authorize
X-Admin-Token: <token>
{"note":"店长批准作者夜读专场"}
```

回执 `GET /api/receipts/:confirmationCode` 与报名响应都保存实际场次快照，不依赖活动后来的改名或改期结果。

### 店长更正

- `POST /api/admin/stores/:id/exceptions`：临时闭店/改营业，自动重算与失效查询版；
- `DELETE /api/admin/stores/:id/exceptions?localDate=YYYY-MM-DD`：撤销例外；
- `POST /api/admin/stores/:id/rename`：更名并写历史；
- `POST /api/admin/merge`：停用源店、并入目标店；
- `POST /api/admin/schedules/rebuild`：手工重算全部时间窗；
- `GET /api/admin/audit`：查看审计记录。

临时改营业分钟从 00:00 起算；`endMinute < startMinute` 表示跨午夜，锚日仍是开场日。

## 数据模型

核心表：

- `stores`：门店、IANA 时区、主题/座位 JSON、合并目标、名称历史；
- `weekly_hours`：周期时段，支持跨午夜；
- `schedule_exceptions`：`closed` 与 `modified`；
- `business_windows`：预生成绝对 UTC 区间及本地锚日；
- `event_sessions`：实际活动场次、容量、剩余席位、闭店授权要求与排程指纹；
- `event_closed_authorizations`：针对某一排程指纹的显式授权；
- `registrations`：预约回执及实际场次快照；
- `query_versions / query_store_matches / query_event_matches`：同一查询版的冻结结果；
- `admin_audit_log`：手工更正审计。

## 缓存与一致性

1. 查询前向滚动 90 天排程。
2. 比较每个活跃门店的实时状态与 `business_windows`。
3. 漂移时重建窗口，然后再次比较。
4. 过滤门店并冻结状态、状态变更点、店铺快照、活动快照。
5. `expiresAt = min(now + 5min, earliestStateChange + 1s)`。
6. 排程/名称/授权等手工更正立即标记旧版 `invalidated_at`；已到期旧版返回 410 与到期点。
7. CSV 不写“当前营业中”，只写 `frozenStatusAtGeneration` 与生成/到期 UTC，避免把过期状态导出为当前。

## 原创视觉方案

- 主题：**海图上的书架群岛**。深色海面、手绘感陆地、暖金色书灯标记。
- 元素：纯 CSS 木质书架雕塑、纸张颗粒、书脊徽章、暖色灯球。
- 地图未依赖第三方瓦片/Key，使用原创 SVG 世界图与经纬度投影；生产可替换为自托管瓦片，同时保留同一查询版接口。
- 状态语义：暖金表示营业，灰褐表示休息；红橙聚合点显示门店数量和座位总量。

## 部署

### 单机 systemd / Node

```bash
adduser --system bookbar
mkdir -p /srv/bookbar
cp -r . /srv/bookbar
cd /srv/bookbar
npm ci --omit=dev
chown -R bookbar:bookbar /srv/bookbar
```

`/etc/systemd/system/bookbar.service`：

```ini
[Unit]
Description=Bookbar Atlas
After=network.target

[Service]
Type=simple
User=bookbar
WorkingDirectory=/srv/bookbar
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=DB_PATH=/srv/bookbar/data/bookbar.sqlite
Environment=ADMIN_TOKEN=replace-with-long-random-token
ExecStart=/usr/bin/node server.js
Restart=always
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/srv/bookbar/data

[Install]
WantedBy=multi-user.target
```

Nginx 反向代理：

```nginx
server {
  listen 443 ssl http2;
  server_name bookbar.example.com;
  ssl_certificate     /etc/letsencrypt/live/bookbar.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/bookbar.example.com/privkey.pem;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

### 容器

运行时只需复制项目、安装依赖、持久化 `/app/data`。生产构建时可使用 Node 20 slim 基础镜像，启动命令 `node server.js`，健康检查 `GET /api/health`。

### 生产扩展建议

当前 `sql.js` 将数据库写入本地文件，适合单机演示与轻量部署。横向扩展时可将 `src/db.js` 替换为 SQLite WAL 原生驱动或 PostgreSQL，保持以下事务边界不变：

- 报名：`BEGIN IMMEDIATE` 后读取活动，再执行条件更新 `remaining >= seats`，最后插入回执；
- 更正：更新排程、重算窗口、失效查询版必须在同一事务；
- 合并：源店存在未来已报名活动时阻止自动合并，避免回执实际场次被静默改写。

## 测试覆盖

`npm test` 覆盖：

1. fall-back 重复时段两个 UTC 实例；
2. spring-forward gap 调整且不生成幽灵实例；
3. 跨午夜锚日；
4. 临时闭店优先与临时改营业替换/撤销；
5. 实时状态与预生成窗口比较、漂移修复；
6. 查询版缓存到期点；
7. 手工更正传播和 410；
8. 闭店专场未授权拒绝、授权后可报名；
9. 三个并发请求抢占一个最后席位；
10. 店铺更名、合并、历史名称与结果移除；
11. 两个 DST 实际活动场次的回执快照；
12. CSV 明确“生成时冻结”而非当前；
13. 404、400 等结构化错误。

## 目录

```text
server.js              # HTTP 服务入口
src/tz.js              # IANA 时区、DST gap/fold 原语
src/db.js              # SQLite schema、事务与持久化
src/seed.js            # 演示数据
src/schedule.js        # 营业实例、状态比较、排程指纹
src/queries.js         # 查询版、分页、地图聚合
src/events.js          # 报名、席位抢占、闭店授权
src/admin.js           # 例外、更名、合并与审计
src/http.js            # API/CSV/静态文件路由
public/                # 原创无框架前端
test/acceptance.test.js
```
