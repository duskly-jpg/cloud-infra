# 个人云基础设施 · Cloudflare 边缘服务集

跑在 Cloudflare 免费档上的个人基础设施：6 个站点与服务共享一套边缘架构与发布流程，同一套纪律贯穿部署全链路。本仓库收录其中两个可独立复用的通用组件；其余服务（浏览器客户端的验签后端见 [huandou-attest](https://github.com/duskly-jpg/huandou-attest)，客户端见 [huandou](https://github.com/duskly-jpg/huandou)）独立成仓。

[![tests](https://github.com/duskly-jpg/cloud-infra/actions/workflows/tests.yml/badge.svg)](https://github.com/duskly-jpg/cloud-infra/actions/workflows/tests.yml)
[![release](https://img.shields.io/github/v/release/duskly-jpg/cloud-infra)](https://github.com/duskly-jpg/cloud-infra/releases)
[![license](https://img.shields.io/github/license/duskly-jpg/cloud-infra)](LICENSE)
[![dependencies](https://img.shields.io/badge/dependencies-0%20npm-blue)](#services)

## 服务拓扑

```
                         ┌────────────────────────┐
  外部事件 ──POST────────▶│  hooks-bridge           │──▶ 微信推送
  (HMAC 签名+防重放)      │  验签 / 防重放 / KV 去重 │
                         └────────────────────────┘
                         ┌────────────────────────┐
  定时触发 ──cron────────▶│  cron-scheduler         │──▶ 微信推送
  (UTC 排程)             │  拉取数据 / AI 钩子生成  │
                         └────────────────────────┘

  同一 zone 下的在役服务：Telegram 机器人（webhook + KV 信箱）、
  游戏站（D1 排行榜 + 每日挑战）、留言墙（先审后发 + AI 审核）、
  设备完整性验证（Key Attestation）、记忆中枢（MCP + R2 快照）
```

## 通用纪律

- **部署断言闸门**：发布前逐脚本语法检查、部署物字节数断言，FAIL 拒发
- **Secrets 双录**：token/cookie 只进 `wrangler secret`，本地 vault 留底档；代码里只出现变量名
- **域名即配置**：route 全部走 wrangler 配置，代码零硬编码域名（仓库内示例域名用 `example.com`）
- **可观测性**：每个 worker 开启 observability，失败路径降级不阻塞主链

## services/

| 组件 | 行数 | 职责 |
|---|---|---|
| `hooks-bridge` | 140 | 接收外部 webhook：HMAC-SHA256 验签（容忍 `whsec_` 前缀）、时间戳防重放窗口、KV 事件去重，转发到微信推送 |
| `cron-scheduler` | 246 | Workers cron triggers 排程层：按 `event.cron` 分发任务，拉取热榜数据、用 Workers AI（免费档 llama-3.1-8b）批量生成看点文案，解析容错 + 无 AI 降级路径 |

两个组件均为零 npm 依赖的单文件 worker，`node --check` 可独立验证语法。

## 测试

```bash
node --check services/hooks-bridge/index.js
node --check services/cron-scheduler/worker.js
python3 -c "import json,re; s=re.sub(r'//.*','',open('services/cron-scheduler/wrangler.jsonc').read()); json.loads(s); print('jsonc ok')"
```

CI 对全部服务跑以上检查（`.github/workflows/tests.yml`）。

## 部署（每个服务目录内）

```bash
npx wrangler deploy
npx wrangler secret put PUSHPLUS_TOKEN     # 微信推送 token
npx wrangler secret put WEBHOOK_SECRET     # hooks-bridge 的签名密钥（whsec_...）
npx wrangler secret put MANUAL_TOKEN       # cron-scheduler 手动触发端点的鉴权 token
```

## 许可

MIT
