# 部署指南

## Docker Compose（推荐）

```bash
export ADMIN_TOKEN='替换为足够长的随机令牌'
docker compose build
docker compose up -d
docker compose ps
curl http://localhost:3000/api/health
```

SQLite 数据保存在命名卷 `night_shelf_data` 中。首次部署可通过一次性容器初始化演示数据：

```bash
docker compose run --rm \
  -e ADMIN_TOKEN="$ADMIN_TOKEN" \
  night-shelf node src/seed.js
```

生产也可以只保留迁移、不使用演示数据；服务启动时会自动建表。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 端口 |
| `DB_PATH` | `./data/bookstores.sqlite` | SQLite 文件路径 |
| `ADMIN_TOKEN` | `dev-admin-token` | Bearer 管理令牌，生产必须覆盖 |
| `NODE_ENV` | - | Docker 镜像设置为 production |

## 裸机运行

```bash
npm ci --omit=dev
ADMIN_TOKEN="..." DB_PATH=/var/lib/night-shelf/bookstores.sqlite node src/server.js
```

建议使用 systemd、pm2 或容器进程守护，并把数据库目录纳入备份。至少备份：

- `bookstores.sqlite`
- `bookstores.sqlite-wal`
- `bookstores.sqlite-shm`（存在时）

更稳妥的备份方式是 SQLite online backup，或在低峰期执行 `VACUUM INTO '/backup/bookstores-<date>.sqlite'`。

## 反向代理

Nginx 示例：

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

应用本身不提供 HTTPS；证书和 HSTS 放在反向代理或平台边缘处理。

## 运维检查

- 健康检查：`GET /api/health`
- 查询目录版本：响应中的 `catalogVersion`
- 门店状态：`GET /api/stores/:id`
- 导出：`GET /api/export?format=csv`
- 日志：当前镜像输出到 stdout/stderr，可由 Docker/journald 收集

## 数据更正流程

1. 营业时间修改：调用小时/例外接口；
2. 门店更名：调用 rename，保存名称历史；
3. 门店合并：调用 merge，源店标记 inactive，旧名进入承接店 alias，活动转移，回执快照不变；
4. 更正后所有旧 queryId 返回 409；
5. 前端网络恢复后重建 queryId，网络失败时显示“上次更新时间”并标记缓存非实时。

## 容量与扩展

当前实现适合单机轻量部署。SQLite WAL + better-sqlite3 同步事务足以支撑门店目录和报名活动的低到中流量。若未来改为多实例写部署，应把报名和目录写入集中到单主库，或迁移到 Postgres 并保留事务行锁；查询版、窗口生成和缓存模型仍可复用。
