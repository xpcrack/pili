# BID Phase 2 Timeline-Derived Cost Basis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make BID2 compute pili-managed holder/person cost from `pilipili` trade timeline lot-by-lot instead of manual `tokenCosts`, while keeping legacy manual cost only as fallback for non-pili-managed data.

**Architecture:** `pilipili` exports a deterministic internal canonical-trade feed built from persisted canonical blockchain events. BID2 mirrors those trades into workspace-scoped raw trade documents, then fully rebuilds a FIFO-derived position projection per workspace after each sync. Existing holders/person/address readers switch to the projection for pili-managed addresses, and only fall back to legacy `tokenCosts` when the address is outside the pili mirror or the projection is unavailable.

**Tech Stack:** `pilipili`: Next.js 16 App Router, TypeScript, `better-sqlite3`. `BID2`: Express, TypeScript, Mongoose, React, Vite, Vitest, Jest.

---

## Scope Check

This is one feature slice even though it spans two repos: timeline-derived cost basis for existing BID2 views. Keep the work scoped to export, sync, lot projection, read-path adoption, and UI/source-status updates. Do not add a generic accounting module, tax reports, or a separate portfolio history product.

## Worktrees And Branches

- `pilipili`
  - create from latest `main`
  - worktree: `/Users/xp/vibecoding/pilipili/.worktrees/codex-bid-phase2-canonical-trades`
  - branch: `codex/bid-phase2-canonical-trades`
  - Node: `24.11.1`
- `BID2`
  - create from latest mainline branch
  - worktree: `/Users/xp/vibecoding/BID2/.worktrees/codex-bid-phase2-cost-ledger`
  - branch: `codex/bid-phase2-cost-ledger`
- execution order
  1. `pilipili backend export`
  2. `BID2 backend raw trade sync`
  3. `BID2 backend FIFO projection + query adoption`
  4. `BID2 frontend status / display updates`
  5. `cross-repo verification`
- subagent discipline
  - one implementation task at a time
  - `implementer -> spec reviewer -> code-quality reviewer -> next task`
  - workers only write inside their assigned repo worktree

## Behavior Decisions Locked For Phase 2

- `pilipili` remains the only canonical source for pili-managed trade history.
- Phase 2 adds a new internal trade export; it does not repurpose the existing `/api/internal/bid/onchain-events` route used by phase 1 token ingestion.
- BID2 stores mirrored raw trades and rebuilds derived positions from scratch per workspace after sync. Do not build an incremental lot engine first.
- For holder- and person-level `成本(M)` displays, the Phase 2 meaning becomes:
  - remaining-position weighted average entry market cap in millions
  - no longer “sum every address’s manual token cost map”
- Manual `tokenCosts` stay legacy-fallback only:
  - allowed for non-pili-managed addresses
  - not mixed into a pili-derived position
  - not used to “补齐” a partial timeline-derived result
- Phase 2 stores realized PnL data for correctness, but does not add a dedicated realized-PnL UI.

## Non-Goals

- no generic tax/accounting engine
- no cross-chain portfolio book outside pili-managed addresses
- no rewrite of phase 1 mirror/read-only address ownership model
- no new write path in BID2 for person/address cost editing
- no migration of historical manual `tokenCosts` into synthetic trade lots

## File Structure

### `pilipili` new files

- Create: `/Users/xp/vibecoding/pilipili/lib/server/bidTradeExport.ts`
  - internal canonical trade export reader built on persisted events
- Create: `/Users/xp/vibecoding/pilipili/app/api/internal/bid/trades/route.ts`
  - admin-only paginated trade export route
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-bid-trades-api.ts`
  - route-level trade export coverage

### `pilipili` existing files to modify

- Modify: `/Users/xp/vibecoding/pilipili/package.json`
  - register new trade export test
- Modify: `/Users/xp/vibecoding/pilipili/lib/canonical.ts`
  - only if export needs a small helper split for canonical trade serialization
- Modify: `/Users/xp/vibecoding/pilipili/scripts/test-bid-users-api.ts`
  - keep phase 1 users export coverage aligned if shared helpers move

### `BID2` new files

- Create: `/Users/xp/vibecoding/BID2/backend/src/models/WorkspaceTradeEvent.ts`
  - immutable mirrored canonical trades keyed by `workspaceId + eventId`
- Create: `/Users/xp/vibecoding/BID2/backend/src/models/WorkspaceTradePosition.ts`
  - fully rebuilt per-address-per-token derived position projection with embedded open lots
- Create: `/Users/xp/vibecoding/BID2/backend/src/services/pilipiliTradeSyncService.ts`
  - paginated mirror sync from `pilipili` trade export
- Create: `/Users/xp/vibecoding/BID2/backend/src/services/workspaceTradeProjector.ts`
  - pure FIFO projector + persistence wrapper
- Create: `/Users/xp/vibecoding/BID2/backend/src/services/workspaceTradeQueryService.ts`
  - read helpers used by controllers to fetch derived cost/PnL
- Create: `/Users/xp/vibecoding/BID2/backend/test/pilipiliTradeSyncService.test.ts`
- Create: `/Users/xp/vibecoding/BID2/backend/test/workspaceTradeProjector.test.ts`
- Create: `/Users/xp/vibecoding/BID2/backend/test/workspaceTradeCostViews.test.ts`

### `BID2` existing files to modify

- Modify: `/Users/xp/vibecoding/BID2/backend/src/models/PilipiliSyncCursor.ts`
  - allow a separate cursor source for canonical trades
- Modify: `/Users/xp/vibecoding/BID2/backend/src/services/pilipiliClient.ts`
  - add `listBidTrades()`
- Modify: `/Users/xp/vibecoding/BID2/backend/src/index.ts`
  - run trade sync + projection rebuild inside the existing pili sync cron
- Modify: `/Users/xp/vibecoding/BID2/backend/src/controllers/tokenController.ts`
  - use derived holder cost/PnL for same-car data and searched holder PnL
- Modify: `/Users/xp/vibecoding/BID2/backend/src/controllers/personController.ts`
  - use derived person token positions instead of summing manual `tokenCosts`
- Modify: `/Users/xp/vibecoding/BID2/backend/src/controllers/addressController.ts`
  - enrich address holdings read with derived cost data; keep write endpoints read-only
- Modify: `/Users/xp/vibecoding/BID2/backend/src/types/index.ts`
  - add trade-position-derived response types/status fields
- Modify: `/Users/xp/vibecoding/BID2/frontend/src/types/index.ts`
  - add cost source/status fields
- Modify: `/Users/xp/vibecoding/BID2/frontend/src/components/TokenTable.tsx`
  - surface derived same-car status
- Modify: `/Users/xp/vibecoding/BID2/frontend/src/components/PersonHoldingsModal.tsx`
  - explain timeline-derived `成本(M)` meaning
- Modify: `/Users/xp/vibecoding/BID2/frontend/src/components/HoldingsModal.tsx`
  - keep read-only cost column, but show derived/fallback provenance instead of edit affordance
- Modify: `/Users/xp/vibecoding/BID2/frontend/src/__tests__/HoldingsModal.test.tsx`
- Modify: `/Users/xp/vibecoding/BID2/frontend/src/__tests__/TokenTable.test.tsx`
- Modify: `/Users/xp/vibecoding/BID2/frontend/src/__tests__/useDashboardModals.test.ts`

### Docs to read before editing route files in `pilipili`

- `/Users/xp/vibecoding/pilipili/node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`

## Data Contracts To Introduce

### `pilipili` internal trade export payload

```ts
interface BidCanonicalTrade {
  eventId: string;
  userId: string;
  userName: string;
  sourceAddressName: string | null;
  chain: 'solana' | 'ethereum' | 'bsc' | 'base';
  trackedWalletAddress: string;
  trackedWalletAddressRaw: string;
  tokenAddress: string;
  tokenSymbol: string;
  txHash: string;
  action: 'buy' | 'sell';
  actionVariant: 'open' | 'add' | 'reduce' | 'close';
  eventTimeMs: number;
  tokenAmount: number;
  amountUsd: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  quoteSymbol: string | null;
  quoteAmount: number | null;
  costDataStatus: 'complete' | 'missing-usd' | 'missing-market-cap' | 'partial';
}
```

### `BID2` derived position projection

```ts
interface WorkspaceTradePosition {
  workspaceId: string;
  holderUserId: string;
  holderUserName: string;
  trackedWalletAddress: string;
  trackedWalletAddressLower: string;
  relationChain: 'solana' | 'evm';
  tokenChain: 'solana' | 'ethereum' | 'bsc' | 'base';
  tokenAddress: string;
  tokenAddressLower: string;
  tokenSymbol: string | null;
  openQuantity: number;
  openCostUsd: number | null;
  avgEntryPriceUsd: number | null;
  avgEntryMarketCapUsd: number | null;
  costBasisStatus: 'complete' | 'partial' | 'missing';
  realizedPnlUsd: number | null;
  lots: Array<{
    sourceEventId: string;
    openedAtMs: number;
    remainingQuantity: number;
    remainingCostUsd: number | null;
    entryPriceUsd: number | null;
    entryMarketCapUsd: number | null;
  }>;
  firstBuyAtMs: number | null;
  lastTradeAtMs: number | null;
}
```

## Task 1: Add a Deterministic Canonical Trade Export in `pilipili`

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/server/bidTradeExport.ts`
- Create: `/Users/xp/vibecoding/pilipili/app/api/internal/bid/trades/route.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-bid-trades-api.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Modify: `/Users/xp/vibecoding/pilipili/lib/canonical.ts` only if helper extraction is needed

- [ ] Build the export reader on top of `readEventsFeed()` rather than `readBidOnchainEvents()`, so Phase 2 reads repaired canonical blockchain activity instead of the thinner phase 1 telegram-monitor export.
- [ ] Filter to `source=blockchain`, convert each row with `legacyFeedItemToCanonicalEvent()`, then keep only `type === 'trade'` with non-empty `chain`, `walletAddress`, `tokenAddress`, and positive `tokenAmount`.
- [ ] Return the cursor from `readEventsFeed()` as an opaque string; do not invent a second cursor format for this route.
- [ ] Include `amountUsd`, `priceUsd`, `quoteSymbol`, `quoteAmount`, and `marketCapUsd` in the payload, plus a small `costDataStatus` field so BID2 can distinguish complete vs partial lots.
- [ ] Reuse existing admin auth (`requireAdmin` / `ADMIN_API_TOKEN`) and existing query filters (`userIds`, `fromMs`, `toMs`, `limit`).
- [ ] Add a route test that proves:
  - unauthorized requests get `401`
  - non-trade blockchain events are excluded
  - `buy/open`, `buy/add`, `sell/reduce`, `sell/close` are exported
  - the export carries `tokenAmount`, `amountUsd`, and `marketCapUsd`
  - paging returns a stable `nextCursor`
- [ ] Run:
  - `npm run test-bid-trades-api`
  - `npm test`

## Task 2: Mirror Canonical Trades into BID2 Raw Storage

**Files:**
- Create: `/Users/xp/vibecoding/BID2/backend/src/models/WorkspaceTradeEvent.ts`
- Create: `/Users/xp/vibecoding/BID2/backend/src/services/pilipiliTradeSyncService.ts`
- Modify: `/Users/xp/vibecoding/BID2/backend/src/models/PilipiliSyncCursor.ts`
- Modify: `/Users/xp/vibecoding/BID2/backend/src/services/pilipiliClient.ts`
- Modify: `/Users/xp/vibecoding/BID2/backend/src/index.ts`
- Test: `/Users/xp/vibecoding/BID2/backend/test/pilipiliTradeSyncService.test.ts`

- [ ] Add `listBidTrades()` to the BID2 `PilipiliClient` using the new `/api/internal/bid/trades` route and the existing `PILIPILI_BASE_URL` + `PILIPILI_ADMIN_API_TOKEN`.
- [ ] Store mirrored rows in `WorkspaceTradeEvent` with a unique index on `workspaceId + eventId`.
- [ ] Reuse `PilipiliSyncCursor` with a separate source value such as `trades`, rather than creating a second cursor model.
- [ ] Keep raw trade sync separate from phase 1 `WorkspaceOnchainEvent` sync. Do not overload the phase 1 model or service.
- [ ] Sync descending pages from `pilipili`, insert idempotently, and update the `trades` cursor after each page.
- [ ] Keep the first pass conservative:
  - no transform-heavy logic in the sync service
  - only normalize addresses and persist the export contract
  - let the projector own lot math
- [ ] Extend the existing pili cron in `/Users/xp/vibecoding/BID2/backend/src/index.ts` so each workspace does:
  1. phase 1 onchain event sync
  2. phase 2 canonical trade sync
  3. trade position rebuild
- [ ] Add tests for:
  - first sync backfill
  - duplicate events
  - opaque cursor persistence
  - multi-page sync
  - source-user/address name persistence
- [ ] Run:
  - `npm --prefix backend test -- backend/test/pilipiliTradeSyncService.test.ts`
  - `npm --prefix backend test`

## Task 3: Build a Full-Rebuild FIFO Projector

**Files:**
- Create: `/Users/xp/vibecoding/BID2/backend/src/models/WorkspaceTradePosition.ts`
- Create: `/Users/xp/vibecoding/BID2/backend/src/services/workspaceTradeProjector.ts`
- Test: `/Users/xp/vibecoding/BID2/backend/test/workspaceTradeProjector.test.ts`

- [ ] Implement the lot engine as a pure reducer over `WorkspaceTradeEvent[]` sorted ascending by `eventTimeMs, eventId`.
- [ ] Full-rebuild the entire workspace projection after sync. Do not start with incremental mutation; correctness and replayability matter more than micro-optimization in phase 2.
- [ ] FIFO rules:
  - `open` / `add` create new lots
  - `reduce` / `close` consume earliest remaining lots first
  - if a sell exceeds remaining quantity, consume what exists, clamp at zero, and log a drift warning instead of crashing the rebuild
- [ ] Derive and persist:
  - open quantity
  - open cost USD
  - average entry price USD
  - weighted average entry market cap USD
  - realized PnL USD
  - cost-basis status (`complete | partial | missing`)
  - embedded open lots
- [ ] Treat EVM correctly:
  - holder identity matches the mirrored workspace relation by address
  - token identity stays chain-specific (`bsc`, `ethereum`, `base`)
  - do not collapse same CA across different EVM chains
- [ ] Partial-data policy:
  - if a lot lacks `amountUsd` but has `priceUsd`, derive USD cost from `priceUsd * quantity`
  - if a lot lacks market cap, keep the lot but mark the position `partial`
  - never backfill a missing timeline lot with manual `tokenCosts`
- [ ] Add focused reducer tests for:
  - single buy
  - multi-buy then partial sell
  - full close
  - sell larger than position
  - two addresses under one person
  - same token symbol on different chains
  - partial lots missing market cap
- [ ] Run:
  - `npm --prefix backend test -- backend/test/workspaceTradeProjector.test.ts`
  - `npm --prefix backend test`

## Task 4: Switch BID2 Read Paths to Derived Cost Basis

**Files:**
- Create: `/Users/xp/vibecoding/BID2/backend/src/services/workspaceTradeQueryService.ts`
- Modify: `/Users/xp/vibecoding/BID2/backend/src/controllers/tokenController.ts`
- Modify: `/Users/xp/vibecoding/BID2/backend/src/controllers/personController.ts`
- Modify: `/Users/xp/vibecoding/BID2/backend/src/controllers/addressController.ts`
- Modify: `/Users/xp/vibecoding/BID2/backend/src/types/index.ts`
- Test: `/Users/xp/vibecoding/BID2/backend/test/workspaceTradeCostViews.test.ts`

- [ ] Add one query service that hides the projection lookup rules from controllers.
- [ ] Fallback order must be explicit and shared:
  1. if the address/token is pili-managed and a derived position exists, use it
  2. if the derived position exists but is `partial`, return it as partial and surface the status
  3. if the address is not pili-managed, keep legacy manual `tokenCosts` behavior
  4. if the address is pili-managed but no derived position exists, return no cost and log/debug it as stale or missing
- [ ] `tokenController.ts`
  - same-car holder states use derived `avgEntryMarketCapUsd`
  - searched holder PnL uses the person-level aggregation of derived positions
  - `holderNames` color only turns green/red when the derived or fallback cost is complete enough
- [ ] `personController.ts`
  - stop summing raw `tokenCosts`
  - aggregate remaining open lots across all of the person’s matching addresses
  - `成本(M)` becomes weighted average remaining entry market cap in millions
- [ ] `addressController.ts`
  - enrich the address holdings response with derived cost/PnL where a mirrored position exists
  - keep cost editing blocked for pili-managed data; phase 2 is read-path replacement, not write reintroduction
- [ ] Extend response types with provenance:
  - `costSource: 'timeline' | 'manual-fallback' | 'unavailable'`
  - `costStatus: 'complete' | 'partial' | 'missing'`
- [ ] Add controller tests for:
  - token holders prefer timeline-derived cost over manual maps
  - person holdings aggregate multiple lots correctly
  - pili-managed addresses do not silently fall back when timeline data is partial
  - non-pili-managed addresses still use legacy manual cost logic
- [ ] Run:
  - `npm --prefix backend test -- backend/test/workspaceTradeCostViews.test.ts`
  - `npm --prefix backend test`

## Task 5: Update BID2 UI to Explain Provenance and Partial Data

**Files:**
- Modify: `/Users/xp/vibecoding/BID2/frontend/src/types/index.ts`
- Modify: `/Users/xp/vibecoding/BID2/frontend/src/components/TokenTable.tsx`
- Modify: `/Users/xp/vibecoding/BID2/frontend/src/components/PersonHoldingsModal.tsx`
- Modify: `/Users/xp/vibecoding/BID2/frontend/src/components/HoldingsModal.tsx`
- Modify: `/Users/xp/vibecoding/BID2/frontend/src/services/api.ts` only if type wiring requires it
- Modify: `/Users/xp/vibecoding/BID2/frontend/src/__tests__/HoldingsModal.test.tsx`
- Modify: `/Users/xp/vibecoding/BID2/frontend/src/__tests__/TokenTable.test.tsx`
- Modify: `/Users/xp/vibecoding/BID2/frontend/src/__tests__/useDashboardModals.test.ts`

- [ ] Keep the UI conservative. The main product win is correctness, not a large redesign.
- [ ] `TokenTable.tsx`
  - same-car tooltip or inline badge should distinguish `时间线成本`, `手工回退`, and `部分`
  - if cost is partial or missing, do not render a misleading green/red profit color
- [ ] `PersonHoldingsModal.tsx`
  - add one short note that `成本(M)` now means timeline-derived weighted entry market cap for remaining lots
  - if a row is partial, show the status instead of pretending the number is complete
- [ ] `HoldingsModal.tsx`
  - keep the cost column read-only
  - remove any dead manual-edit affordance for pili-managed rows if phase 1 guard left UI remnants
  - show provenance/status next to the cost cell
- [ ] Frontend tests should prove:
  - timeline-derived rows render with the new status
  - partial rows do not show false profit/loss colors
  - non-pili-managed/manual fallback rows still render
- [ ] Run:
  - `npm --prefix frontend test`
  - `npm --prefix frontend run build`

## Task 6: Cross-Repo Verification And Smoke Coverage

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Modify: `/Users/xp/vibecoding/BID2/backend/package.json` only if focused test scripts are added
- Modify: `/Users/xp/vibecoding/BID2/frontend/package.json` only if focused test scripts are added

- [ ] `pilipili` verification
  - `npm run test-bid-trades-api`
  - `npm test`
- [ ] `BID2 backend` verification
  - `npm --prefix backend test`
- [ ] `BID2 frontend` verification
  - `npm --prefix frontend test`
  - `npm --prefix frontend run build`
- [ ] Manual cross-repo smoke
  1. create or locate one pili-managed address with multiple buys at different market caps for the same token
  2. sync `pilipili`, then let BID2 cron or manual sync pull the new trades
  3. verify token same-car shows derived cost state for that holder
  4. verify person holdings show weighted remaining entry market cap, not summed legacy manual costs
  5. verify a partial-data trade shows `部分` rather than a fake PnL color
  6. verify a non-pili-managed address still uses manual fallback if present

## Implementation Notes

- Reuse `readEventsFeed()` + `legacyFeedItemToCanonicalEvent()` in `pilipili`; do not build a second raw-event reader from scratch.
- Reuse the existing BID2 pili auth/config. No new required secret should be introduced for phase 2.
- Keep phase 1 token ingestion independent. A bad phase 2 projector must not block phase 1 address mirror or token auto-add.
- Prefer one pure reducer file for FIFO math and keep controller changes thin.
- Full rebuild is the deliberate first implementation. Optimize to incremental projection only after phase 2 correctness is stable in production.

## Risks And Guardrails

- Historical feed rows with missing `amountUsd` or `marketCapUsd` can make derived cost partial. Surface this; do not silently hide it.
- EVM address mirroring is collapsed at the workspace relation layer but trades are chain-specific. Query helpers must match by address for holder identity and by chain for token identity.
- Person-level `成本(M)` semantics change from “sum of manual caps” to “weighted average remaining entry cap”. Treat this as intended Phase 2 behavior, not a regression.
- If rebuild time becomes an issue, measure first; do not pre-emptively build an incremental projector in this phase.

## Handoff

Plan complete when this document exists and the next session starts from fresh `main` worktrees in both repos. Use `subagent-driven-development` in the new session and keep each task serial with review gates.
