# 夜架 NIGHT SHELF：独立书店地图站

一个从零实现的独立书店地图站：按**书架主题、座位、活动**寻找门店；服务端按**门店自己的 IANA 时区**计算营业实例、临时例外与报名可报性。前端使用原创“墨蓝夜空 + 书签灯 + 等高线星图”视觉方案，地图为内置 SVG，不依赖第三方地图服务。

## 已落实的关键规则

1. **服务端计算，不信浏览者本地日期**：SQL 保存 IANA 时区、周期时段、临时开闭店；所有状态先在服务端换算 UTC。
2. **跨午夜按实际营业实例归属**：周期规则保存“开始分钟 + 持续分钟”，不存在 close 小于 open 后按当天截断的问题。
3. **DST 消歧**：
   - 秋季回拨产生两个实际 UTC 实例，可显式选 first / second；
   - 春季不存在的挂钟时间默认顺延到跳字后，并保持持续分钟数。
4. **临时闭店优先**：有效营业 = 常规营业 + 临时加开，再由临时闭店挖空。
5. **闭店活动显式授权**：闭店时段专场不会自动取消，也不会自动放行；管理员必须逐场授权。营业边界变化后，旧授权自动失效。
6. **同一查询版**：先创建 queryId；地图聚合与列表分页都用它。手工更名/合并后旧版返回 `409 QUERY_VERSION_STALE`。
7. **缓存到期点**：营业状态缓存到“下一状态变化点”；小时版本变更或手工更正立即失效。实时窗口还会与预生成窗口对账，不一致则重建。
8. **并发报名**：SQLite 事务 + 条件更新/触发器保证不超卖。
9. **预约回执绑定实际场次**：回执保存具体 `event_session` 的 UTC 起止、当地时间、时区、DST 选择与当时门店快照；店铺之后合并/更名不回写历史快照。
10. **过期状态不冒充当前**：页面状态始终带服务端 `asOf/computedAt/nextChange`；CSV/JSON 导出也带状态基准时间，历史 `asOf` 只能作为历史查询展示。

## 技术栈

- Node.js 20+（ESM，无 Web 框架）
- better-sqlite3（SQLite，WAL，外键，事务）
- 原生 HTML/CSS/JavaScript + SVG
- Node 内置 test runner

## 本地启动

```bash
npm ci
npm run seed
npm start
# http://localhost:3000
# 管理员令牌默认 dev-admin-token；生产必须通过 ADMIN_TOKEN 覆盖
```

运行测试：

```bash
npm test
```

演示数据会创建：

- 上海/杭州/北京/成都/广州/苏州书店；
- 两个 America/New_York DST 验收门店；
- 一个临时闭店、一个临时加开；
- 一个未授权闭店私场、一个已授权闭店私场；
- 一个容量为 1 的“最后席位”活动。

## 主要 API

### 公共

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 服务端当前 UTC 时间与目录版本 |
| `GET` | `/api/facets` | 城市、主题、座位类型 |
| `POST` | `/api/queries` | 创建查询版 |
| `GET` | `/api/stores?queryId=...` | 与地图同版的分页列表 |
| `GET` | `/api/map?queryId=...&zoom=...` | 与列表同版的聚合点 |
| `GET` | `/api/stores/:id` | 门店、状态、活动 |
| `GET` | `/api/sessions/:id` | 场次详情 |
| `POST` | `/api/sessions/:id/bookings` | 报名 |
| `GET` | `/api/bookings/:code` | 查询回执 |
| `GET` | `/api/export?format=csv|json` | 用当前目录重新查询并导出，带 as-of |

`POST /api/queries` 示例：

```json
{
  "q": "诗歌",
  "city": "上海",
  "theme": "诗歌戏剧",
  "seat": "靠窗座",
  "openOnly": true,
  "upcomingEvents": true
}
```

### 管理员

所有管理接口需要：

```http
Authorization: Bearer <ADMIN_TOKEN>
```

- `POST /api/admin/stores`
- `PATCH /api/admin/stores/:id/hours`
- `POST /api/admin/stores/:id/exceptions`
- `PATCH /api/admin/stores/:id/rename`
- `POST /api/admin/stores/:id/merge`
- `POST /api/admin/events`
- `POST /api/admin/sessions/:id/authorize`

临时例外使用**门店当地挂钟时间**，例如：

```json
{
  "kind": "closed",
  "title": "台风闭店",
  "startsLocal": "2026-10-09T18:00",
  "endsLocal": "2026-10-10T02:00",
  "note": "专场必须逐场授权"
}
```

## SQL 模型摘要

- `stores.timezone`：IANA 时区。
- `weekly_hours(weekday,start_minute,duration_minutes,disambiguation)`：周一为 0；持续分钟表达跨午夜。
- `hours_exceptions(kind, starts_local, ends_local, starts_ms, ends_ms)`：closed/open 两类，closed 优先。
- `open_windows`：预生成 UTC 时间窗及来源。
- `status_cache`：实时状态缓存，缓存到期点为下一状态变化点。
- `catalog_versions` / `query_versions` / `manual_corrections`：手工更正传播和同版查询。
- `event_sessions`：具体 UTC 场次、闭店要求、显式授权、闭店边界 digest。
- `bookings.receipt_snapshot_json`：不可变回执，绑定实际场次。

更多边界说明见 [`docs/boundaries.md`](docs/boundaries.md)，部署见 [`docs/deployment.md`](docs/deployment.md)。
