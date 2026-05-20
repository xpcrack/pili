# Runtime After Snapshot (2026-05-21)

## Focused Runtime Test Suite

Commands:

```bash
npm run test:runtime-mode
npm run test:runtime-docs
npx tsx scripts/test-telegram-channel-worker-runtime.ts
```

Result: PASS
- `test:runtime-mode`: pass
- `test:runtime-docs`: pass
- `test-telegram-channel-worker-runtime`: pass

## Project-Level Verification

Commands:

```bash
npm run build
npm test
```

### Build
- Result: PASS
- Note: Next.js warning about multiple lockfiles (same as baseline).

### Full Test Suite
- Result: FAIL (`PASS: 96`, `FAIL: 3`)
- Failed tests:
  1. `test-node-runtime-policy`
  2. `test-selected-user-details-panel`
  3. `test-telegram-mtproto-upgrades`

Comparison to baseline:
- Baseline had the same 3 failing tests.
- No new failing tests were introduced by this runtime single-mode implementation.

## Runtime Command Behavior Verification

Commands:

```bash
npm run runtime:status
npm run runtime:refresh
pm2 status
```

Observed behavior:
- `runtime:status` runs successfully and reports current pm2 process table.
- `runtime:refresh` runs build first, then applies pm2 operation only for `pili-web-prod`.
- During refresh, pm2 logs show `pili-web-prod` started/reloaded while other workers/processes were not explicitly restarted by the script.

Post-refresh pm2 snapshot includes:
- `pili-web-prod` online
- Existing unrelated pm2 apps unchanged in status category (online/stopped as before)

## Before/After Resource Comparison

### PM2
- Before: `pili` online; `pili-web-prod` not present.
- After refresh: `pili-web-prod` online (new managed prod web process), existing entries retained.

### CPU Hotspots (`ps` qualitative)
- Before and after both dominated by browser/render processes (Chrome/Codex), not backend workers.
- `next-server` present in both snapshots.

### System (`top`) qualitative
- Baseline: `CPU idle ~59.32%`, `PhysMem used ~17G`.
- After: `CPU idle ~58.94%`, `PhysMem used ~17G`.
- No obvious regression signal from this short sampling window.

## Heat / CPU / Memory Summary

- Runtime contract is now production-refresh oriented and operational.
- `runtime:refresh` behavior matches expected sequence: build first, then web process refresh.
- Short-window CPU/memory snapshots are broadly similar to baseline, with most load from desktop/browser tooling rather than runtime worker churn.

## Residual Risks

1. Full repo tests still contain 3 pre-existing failures unrelated to this runtime scope.
2. pm2 environment contains unrelated legacy apps; operational clarity depends on using `pili-*` names consistently.
3. Resource snapshots are point-in-time and may miss longer-term drift; periodic sampling is still recommended.
