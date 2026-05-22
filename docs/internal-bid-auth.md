# /api/internal/bid/* 鉴权

`/api/internal/bid/{users,trades,onchain-events}` 三个接口走 **HMAC-SHA256 短期签名 token + IP allowlist** 双层鉴权，与 pilipili 自身的 `ADMIN_API_TOKEN`（feed、system-config 等其他 admin 路由）分开管理。

完整协议、环境变量、密钥旋转流程见 BID 仓库的权威文档：
`BID2/docs/security/pilipili-internal-api-auth.md`

## 本仓库需要配置的环境变量

```
INTERNAL_BID_HMAC_SECRET=<与 BID 端一致的 64 位十六进制>
INTERNAL_BID_HMAC_SECRET_PREVIOUS=<旋转过渡期使用，平时留空>
INTERNAL_BID_ALLOWED_IPS=<逗号分隔的 IP/CIDR，生产必填>
```

生产环境下：

- `INTERNAL_BID_HMAC_SECRET` 缺失 → 三个接口返回 503
- `INTERNAL_BID_ALLOWED_IPS` 缺失 → 三个接口返回 503（fail-closed）
- 源 IP 不在 allowlist → 返回 403
- 签名不通过或过期 → 返回 401

## 相关代码

- 中间件：`lib/server/internalBidAuth.ts`
- 路由：`app/api/internal/bid/{users,trades,onchain-events}/route.ts`
- 测试：`scripts/test-internal-bid-auth.ts`、`scripts/test-bid-{users,trades,onchain-events}-api.ts`
