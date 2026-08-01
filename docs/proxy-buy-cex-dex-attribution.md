# 代理买入归集（CEX 代买、A买B收）——机制与识别

> 起源：2026-08-01 调查「`0x88ef935f…27cde` 持有 76 万 ASTEROID 但 GMGN 显示 buy=0/sell=0」。
> 结论：这是**币安 CEX 用托管资产在 DEX（PancakeSwap）代买、打到用户指定收款地址**，不是空投/分红，也不是 DEX 直连 swap。
> 本文记录机制、合约指纹、识别方法，以及对 pili Feed 买入/卖出归集的可行性评估，供日后归集逻辑参考。

---

## 0. 一句话

用户在 CEX（已坐实币安）下单买链上币、收款地址填自己的钱包。
CEX 用**托管资金**在 DEX 真实 swap，再把币按订单 `recipient` 打到目标地址。
**swap 发起方是 CEX 合约，收币方是用户** —— 二者分离，导致按「发起方归集」的钱包工具（GMGN/dexscreener）在用户地址下完全看不到这笔买入。

---

## 1. 案例链路（BSC / ASTEROID）

- 目标收款地址：`0x88ef935f47bb96f1e7af21c47b42f9cc21227cde`
- 标的币：ASTEROID `0x330990dae53bca4c5811c5362b44c33a47db7777`（BSC，flap 发射，池子用 SPCXB 报价，属链上股票代币 SpaceX 系）
- 持仓：764,174 ASTEROID；GMGN 该地址 buy=0 / sell=0

### 资金流（TX1 `0x9defe654…`，receipt 88 条 log）

```
用户在币安下单：CEX余额(USDT) 买 ASTEROID，recipient = 0x88ef935f
   │
   ▼  币安签 EIP-712 订单 → 币安执行机器人(0x2a58cb, nonce 131409) 调分销合约
log[0]  0x88649f(分销合约) → 0xb300000b72de(买手)    4999.98 USDT    （托管资金出动）
log[29] ASTEROID_POOL      → 0xb300000b72de(买手)    442,162 ASTEROID（PancakeV2 真实买入，Swap@log[34]）
log[75] 0xb300000b72de      → 0x88649f(分销合约)      510,691 ASTEROID（买回汇总）
log[81] 0x88649f            → 0x88ef935f(目标)        510,691 ASTEROID（按订单 recipient 打给用户）
```

TX2 `0xa4fd011d…` 同链路，再打 253,482 ASTEROID。两笔合计 = 当前持仓 764,174。

合约调用 input 解码（铁证 `0x3271ba8d` 的参数结构）：

| 参数位 | 值 | 含义 |
|---|---|---|
| word[1] | USDT 地址 | 卖出币（计价货币） |
| word[3] | ASTEROID 地址 | 买入标的 |
| **word[5]** | **`0x88ef935f…27cde`** | **收款人 = 目标地址** |
| word[4] | `0x5f3851b6…` | 金额/路由参数 |

### 全链都是币安体系（fund_from 全部坐实）

| 角色 | 地址 | 来源 |
|---|---|---|
| 分销代理合约 | `0x88649f4743a758171077b98ee2003f1989b1615a` | BscScan 标 **Binance Wallet: Proxy (EIP-1967 Transparent)**；fund_from=**Binance Hot Wallet 17** |
| 业务逻辑实现 | `0x3a195932caf39fe439522ad5419e85874e334cb3` | Arkham 标 **Binance Wallet** |
| 买手代理合约 | `0xb300000b72deaeb607a12d5f54773d1c19c7028d` | 同为代理合约（362B） |
| 执行机器人 1 | `0x2a58cb…5b278` | nonce 131409；fund_from=**Binance Withdrawals 2** |
| 执行机器人 2 | `0x9f5bbd…17ff0` | nonce 131830；fund_from=**Binance Hot Wallet 19** |
| 签名密钥 | `0x6fa9e206…044ad` | nonce=0（纯 EIP-712 签名，从不发交易） |
| 管理员 | `0xad1b7c3a…38bcb` | nonce=10 |

> ⚠️ 真正的 DEX 是 **PancakeSwap（PancakeV2）**，不是币安自己的 DEX。币安在这里是「券商/代理执行」角色：替用户在 PancakeV2 撮合、结果送到指定地址。

---

## 2. 合约指纹（识别「币安/CEX 代理代买」）

业务逻辑合约 `0x3a195932…`（13KB，UUPS 可升级 + AccessControl + Pausable）反解出的函数选择器特征：

| 函数 | 作用 |
|---|---|
| `signers()` / `admins()` / `ROLE_OPERATOR()` | 服务方多角色权限 |
| `isValidSignature` + `eip712Domain()` | **EIP-712 链下签名授权**（用户/系统签单，合约验签执行） |
| `orderIdUsed(uint256)` | **订单号系统**（防重放，每笔代买是一个 order） |
| `emergencyWithdraw` | 托管资金紧急提款 |
| `pause/unpause` + UUPS 可升级 | 服务方可随时升级/暂停 |
| `0x3271ba8d`（私有，4byte + openchain 均查不到） | 代买执行入口 |

**判定「这是托管型代理代买合约」的指纹组合：**
1. 是 EIP-1967 Transparent Proxy（impl 存在 `0x360894a1…2bbc` slot）；
2. impl 有 `signers`/`orderIdUsed`/`isValidSignature`/`emergencyWithdraw` 这套组合；
3. 该代理（及其 operator）fund_from 来自 CEX 热钱包簇；
4. `0x3271ba8d` 入参含 `recipient` 且 ≠ swap 发起方。

满足 ①②③ 即可判为 CEX 代理代买；④ 是把买入归属到收款人的触发条件。

---

## 3. 为什么 GMGN / 链上钱包工具看不到

GMGN 按发起 swap 的地址归集交易。这笔 swap 发起方是**币安合约/买手**（`0xb300000b72de`），不是用户 `0x88ef935f`。于是：
- 币安合约名下有这笔买入（淹没在币安海量交易里）；
- 用户名下 GMGN 只看到「被动收到一笔 transfer」，不识别为 buy → `buy=0`。

**结论：任何按「swap 发起方」归集的工具，对这类「A 买 B 收」都是盲的。** GMGN portfolio activity API 拿不到 recipient 归属。

---

## 4. 在 pili 里解析成正常买/卖 ——可行性评估

### 买入：✅ 能，要改归集口径

加一条**代理买入归属规则**：

> 若一笔买入 tx 的 receipt：
> ① Swap 发起方是已知代理合约簇（`0x88649f` / `0xb300000b72de` 等满足第 2 节指纹的合约）；
> ② 且最终标的币 ERC-20 Transfer 的 `to` ≠ swap 发起方；
> ③ 该 `to` 是 user 地址（非 CEX/合约）；
> → 把这笔买入**归属到 `to`（收款方）**，按 swap 实际 cost_usd 计入它的买入成本。

效果：`0x88ef935f` 名下出现一笔「PancakeV2 买入 76 万 ASTEROID，成本 ~5000 USDT」的正常记录，口径与直连 swap 一致。

**三个坑（决定要不要做前先想清楚）：**

1. **必须拉 receipt log 才能判定**，GMGN activity API 不够（它已把这笔算给币安）。要么 pili 直接 ingest 链上 tx，要么用能看到「swap→transfer 链路」的数据源。
2. **币安合约簇得维护已知列表**（用第 2 节指纹），币安会扩合约，列表会过时 → 需定期补 + 用特征兜底识别。
3. **规则要写成通用的「代理买入」**，别写死「币安」。当前只坐实了币安，但别的 CEX/代买 bot 很可能同模式。

### 卖出：❌ 基本识别不了

关键限制，务必先知晓。本案例**全程没有卖出**（receipt 里全是 `0x3271ba8d` 代买入，无反向卖出调用）。

机制上也讲不通：代理卖出的链上形态会是
```
用户 EOA 把 ASTEROID 转进币安合约（一笔普通 ERC-20 Transfer，无 Swap）
   → 币安合约在 DEX 卖掉
   → USDT 打回用户
```
第一步那个「转进币安」的 transfer，**和普通转账、提现到交易所，链上长得一模一样**，单看 transfer 区分不出「这是拿去卖」还是「就是提现」。

所以除非：
- 币安合约有专门的「代理卖出」函数（本案例未见，也未发生卖出），且 pili 维护其 reverse 合约指纹；或
- 能拿到币安侧订单号/账本对账（拿不到）；

否则**代理卖出在 pili 里只能识别成「一笔普通转出」，认不出是卖**。

**净影响：买入能修平、卖出修不平** → PnL 引擎对这类地址：成本算得对、但「已卖出」算不准，排行榜里这类地址**已实现盈亏会偏低**（它卖了你看不见，只看到它仍「持仓」）。

### 成本计价陷阱（报价腿）

币安代买是 **USDT 计价**（~5000 USDT），但 ASTEROID 池子用 **SPCXB** 报价（链上股票代币）。若 PnL 引擎按「持仓 × 当前 SPCXB 价格」算成本，会和实际 USDT 成本对不上 ——
这是 [[project_pnl_quote_leg_trap]] 报价腿陷阱的新变种（USDT 成本 vs SPCXB 报价腿）。算这类地址盈亏必须**用 swap 当时的 USDT 成本**，别混进 SPCXB 报价腿。

---

## 5. 复现/验证方法（备查）

```bash
# 1. 收款地址在某币上的 GMGN activity 查不到买入，但 token-balance 非零 → 疑似代理买入
gmgn-cli portfolio activity   --chain bsc --wallet <USER> --token <TOKEN> --limit 50 --raw   # 返回 []
gmgn-cli portfolio token-balance --chain bsc --wallet <USER> --token <TOKEN> --raw            # balance 非零

# 2. 改用能看到 transfer-in 的源（OKX Web3）找出收款 tx 与来源合约
okx-web3 transactions <USER> bsc <hours>   # 找 symbol=目标币、from=某合约 的 tx

# 3. 拉 receipt，确认「Swap 事件存在 + 最终 Transfer.to = USER」→ 坐实代理买入
#    (BSC RPC: eth_getTransactionReceipt；看 topics[0]==Swap(0xd78ad95f…) 且末尾 ERC20 Transfer.to)
# 4. 确认发起方合约是不是 CEX 代理：读 EIP-1967 impl slot + 看 fund_from 是否 CEX 热钱包
gmgn-cli portfolio stats --chain bsc --wallet <DISTRIBUTOR_CONTRACT> --raw   # fund_from: Binance Hot Wallet N
```

数据源备注：BscScan API v1 已废弃，v2 对 BSC 需付费 key；本案例无 key 时用 **OKX Web3 transactions**（能拿到 transfer-in 的来源与 txHash）+ **公开 BSC RPC**（拿 receipt log 解析 swap/transfer 链路）组合解决。

---

## 6. 待办（若 pili 要纳入）

- [ ] 决策：是否值得为这类「CEX 代理买入」做买入归集修正（收益=真实买入不再漏算；成本=要 ingest receipt + 维护合约簇 + 只修得买入半边）。
- [ ] 若做：归集规则按第 4 节，写成通用「代理买入」，指纹按第 2 节，**不要硬编码币安地址**。
- [ ] 若不做：至少在 PnL 排行榜对「持仓非零但 buy=0 的地址」加一个标记，提示「可能是 CEX 代买持仓，成本/盈亏不可信」。
