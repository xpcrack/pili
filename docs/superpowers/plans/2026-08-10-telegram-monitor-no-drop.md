# Telegram Monitor No-Drop Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make missing XXYY monitor transactions recoverable by projecting raw audit events into the provisional feed, and repair the supplied BSC transaction without depending on GMGN.

**Architecture:** Keep the existing fast doorbell projection as the normal first-write path. Add a small server-side repair function that reads one raw XXYY event, resolves its monitored user by tracked wallet, reuses the existing projection service, and reports whether the provisional feed row exists. Expose it through a guarded CLI with dry-run by default and an explicit `--apply` for SQLite writes.

**Tech Stack:** TypeScript, Bun/tsx, better-sqlite3, existing SQLite repositories and test runner.

---

### Task 1: Add a failing regression test for raw-event repair

**Files:**
- Create: `scripts/test-telegram-monitor-backfill.ts`
- Test: `lib/server/telegramMonitorBackfill.ts`

- [ ] Write a temporary SQLite fixture containing a tracked user and a raw `telegram_monitor_events` row with no tx state or feed row.
- [ ] Call the repair function and assert it creates exactly one provisional `events` row and one `telegram_monitor_tx_states` row.
- [ ] Run `npm test -- --filter=telegram-monitor-backfill`; expected initial failure because the repair module does not exist.

### Task 2: Implement the minimal raw-event repair function

**Files:**
- Create: `lib/server/telegramMonitorBackfill.ts`

- [ ] Select a raw XXYY row by transaction hash, reconstruct the parser result from stored text and links, and resolve the monitored user by tracked wallet and compatible chain.
- [ ] Call `projectAndPersistTelegramMonitorUpdate` with `feedMode: 'doorbell'` and `autoReconcile: false`.
- [ ] Return structured counts and reasons for not-found, unmatched-user, already-visible, or projected cases.
- [ ] Run the focused test and verify it passes.

### Task 3: Add a safe CLI for one-off or bounded historical repair

**Files:**
- Create: `scripts/backfill-telegram-monitor-provisional.ts`
- Modify: `package.json`

- [ ] Default to dry-run; require `--apply` for writes and accept `--tx=<hash>`.
- [ ] Use the existing production DB guard for accidental broad writes, and print the selected raw row plus post-repair counts.
- [ ] Add `telegram:monitor:backfill` npm script.
- [ ] Run the focused CLI test/dry-run against a temporary DB.

### Task 4: Repair the supplied production transaction

**Files:**
- No source file changes.

- [ ] Run the CLI in dry-run mode against `0x9b7de16be03ecd3be77dd5e6f9089c91fa13ca975c8cba5482da715c9af5d3d6`.
- [ ] Run the same CLI with `--apply` for that exact hash.
- [ ] Query `events`, `telegram_monitor_tx_states`, and `telegram_monitor_events.projected_activity_json` and verify exactly one visible transaction.

### Task 5: Verify the branch

**Files:**
- No source file changes.

- [ ] Run focused Telegram monitor tests.
- [ ] Run `npx tsc --noEmit`.
- [ ] Run `npm run build`.
- [ ] Run `npm run runtime:status`; do not restart workers by default.
- [ ] Report the exact test/build/database evidence and preserve unrelated worktree changes.
