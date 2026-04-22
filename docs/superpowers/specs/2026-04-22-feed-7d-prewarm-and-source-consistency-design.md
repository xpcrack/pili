# Feed 7-Day Prewarm and Multi-Source Consistency Design

Date: 2026-04-22
Status: Draft (Validated in brainstorming)
Owner: Feed pipeline

## 1. Context and Problem
Current behavior can block user switching when selected-user history backfill is running. In practice, users click profile B but still see profile A feed for a long period. This is amplified by thin local data.

At the same time, timeline data comes from multiple sources:
- Twitter: TG forwarding + OpenCLI
- On-chain: TG forwarding + API
- TG channel can only listen (cannot backfill)

For the same event/time window, normalized output must be consistent across sources.

## 2. Goals and Non-Goals
Goals:
- Instant user switch ("秒切"): switching profiles must not wait for backfill.
- Startup auto prewarm: background coverage to recent 7 days.
- Top lightweight progress UI: `补齐中 x/y 地址（近7天）` and completion status.
- Multi-source normalization consistency with deterministic conflict resolution.
- Real-time per-conflict Telegram notification via built-in notifier bot.

Non-goals:
- Monthly/90-day historical backfill in this iteration.
- New modal/toast-heavy UX for progress.
- TG source retrospective recovery (not possible by design).

## 3. Product Decisions (Confirmed)
- Coverage target: recent 7 days.
- Trigger: auto background prewarm on app startup.
- Progress UI: lightweight top status.
- Conflict default winner:
  - On-chain: API wins.
  - Twitter: OpenCLI wins.
- Conflict alerting: real-time per-event push (no batching).
- Settings add field: Telegram group chat id for conflict notifications.

## 4. Architecture
### 4.1 Frontend/Backend Decoupling for Instant Switch
- Foreground query path is local-snapshot-first and never blocks on backfill.
- Background prewarm/backfill runs in a separate channel/state machine.
- User switch only changes selected user + local read request; any in-flight deep backfill for previous user must be cancelable/preempted.

### 4.2 7-Day Timeline Prewarm
- On startup, scheduler starts a global prewarm job.
- Job scans timeline near-to-far until `earliestCoveredAt <= now - 7d`.
- Persist window cursor/checkpoint after each successful step.
- Incremental snapshot writes make new data visible immediately to foreground reads.

### 4.3 Unified Canonical Event Normalization
All sources map into a single canonical schema and shared render metadata pipeline.
No source-specific display branches are allowed for equivalent events.

Canonical identity requirements:
- On-chain: `chain + trackedAddress + txHash + signature(token/action/amount)`
- Twitter: `tweetId` (with unified reply/quote normalization)

## 5. Multi-Source Reconciliation and Consistency
### 5.1 Source Roles
- TG forwarding data is first-arrival/live-listen snapshot.
- API/OpenCLI is backfillable reconciliation source.

### 5.2 Reconciliation Rules
When two sources produce same canonical identity:
- If normalized fields match: merge source footprint only.
- If mismatch: create conflict record with field-level diff and resolve by policy:
  - On-chain => API result is canonical final.
  - Twitter => OpenCLI result is canonical final.

### 5.3 Consistency Metrics
Track and expose:
- `match_rate` and `mismatch_rate` per domain (on-chain/twitter)
- conflict count in active prewarm window

## 6. Conflict Notification Design
### 6.1 Settings
Add settings field:
- `conflictNotificationTelegramChatId` (string)

Behavior:
- Configured: push each conflict in real time.
- Missing: store conflict log only; show settings hint (`未配置通知群ID`).

### 6.2 Message Contract
Each conflict notification includes:
- event time
- canonical event key
- domain (on-chain/twitter)
- source A / source B
- conflicted fields
- chosen winner source

### 6.3 De-duplication and Retry
- De-dup key: `canonical_key + diff_signature`
- Push each unique conflict once.
- Delivery retry (exponential backoff, e.g. up to 3 attempts).
- If still failed: persist pending-notification record for later resend.

## 7. State Machines
### 7.1 Prewarm Job State
`idle -> running -> partial|done`
- `partial`: some addresses failed, but job continues.
- `done`: 7-day boundary fully covered.

### 7.2 Foreground Read State
Foreground list rendering does not depend on prewarm state transitions.
Foreground failures only affect local message/placeholder, never lock switching.

## 8. Error Handling
- Address-level failures do not abort global prewarm.
- Conflict push failure does not block conflict resolution.
- Snapshot read failures do not block user switching to another user.

## 9. Testing Strategy
Unit tests:
- canonical key/signature generation
- source normalization parity for same fixture
- conflict detection and winner policy
- conflict dedupe key generation

Integration tests:
- startup prewarm running while rapid user switching
- foreground instant switch during in-flight backfill
- mismatch triggers real-time Telegram push
- push retry + pending queue behavior

Regression:
- feed rendering/search/filter
- pull-more behavior
- diagnostics/progress summaries

## 10. Acceptance Criteria
- Switching users is instant under active prewarm/backfill.
- Top status shows lightweight progress and completion for 7-day prewarm.
- Same event from dual sources converges to deterministic canonical output.
- Every unique conflict pushes one real-time Telegram message to configured chat id.
- If chat id missing, conflict is logged and user sees clear config hint.

## 11. Scope for Next Implementation Plan
Implementation planning should decompose into independent tracks:
1. Request-state preemption and foreground/background channel split.
2. 7-day prewarm scheduler + checkpoint persistence.
3. Canonical reconciliation + conflict repository.
4. Settings UI + config persistence for Telegram conflict chat id.
5. Notifier integration, dedupe, retries, and pending resend.
6. Progress UI and observability metrics.

