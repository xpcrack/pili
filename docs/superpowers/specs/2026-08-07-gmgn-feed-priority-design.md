# GMGN Feed Priority Design

## Goal

Stop `newone` co-ride holdings refreshes from repeatedly triggering GMGN's shared cooldown, while keeping xxyy-driven Bark and Pili Feed delivery timely. Holdings remain available as delayed enrichment and must never compete with live Feed work.

## Evidence

- The recent `RATE_LIMIT_BANNED` events all came from `/v1/user/wallet_holdings`, not `/v1/user/wallet_activity`.
- The last ban followed 19 holdings attempts in roughly three minutes, including 15 successful requests.
- `newone` enqueues up to eight wallets after Feed ingestion, and each wallet can fan out across several chains.
- A single ban opens the shared `~/.config/gmgn/ban-cooldown.json`, pausing both `newone` and Pili GMGN work.
- Five configured proxy ports currently expose distinct exit IPs, so adding more rotation is not the primary fix.

## Chosen Approach

Live Feed work has strict priority. `newone` co-ride holdings becomes a paced, deduplicated, low-priority queue. Pili projects an xxyy Telegram event into Feed immediately and treats GMGN as asynchronous enrichment.

This preserves useful holdings data without allowing enrichment traffic to block event delivery.

## Architecture

### 1. Newone co-ride holdings scheduler

Replace batch flushing with a scheduler that:

- processes at most one wallet per dispatch;
- waits at least 25 seconds between dispatches;
- suppresses another refresh for the same wallet for ten minutes;
- preserves queued wallets during GMGN cooldown;
- pauses while Pili has pending live doorbells;
- performs no catch-up burst after cooldown or Feed backlog recovery;
- records enough scheduling information to explain queued, deferred, skipped, and completed work.

The existing periodic co-ride holdings fallback uses the same gate and pacing rules. It cannot run independently as a second source of signed request bursts.

### 2. Pili live Feed priority

The xxyy Telegram ingest path continues to persist the raw monitor event and ring the live doorbell. In addition, it immediately writes a provisional Feed event using the parsed xxyy payload.

The later GMGN activity result enriches or reconciles the same logical transaction instead of creating a second Feed card. Transaction hash, tracked wallet, chain, direction, and token identity form the reconciliation identity using the repository's existing canonical event/upsert rules.

If provisional projection cannot safely identify a trade, the raw event and doorbell remain intact and GMGN can still supply the eventual event.

### 3. Shared GMGN protection

The shared cooldown remains fail-closed: a real `RATE_LIMIT_BANNED` still stops all local GMGN callers. The fix prevents known enrichment bursts rather than weakening the safety mechanism.

The global token bucket must not create an impossible acquisition during recovery. Weighted request cost may delay a request, but it must remain attainable within the bucket model; aborted live Feed requests must release without later issuing a request.

## Data Flow

1. xxyy Telegram update arrives.
2. Pili stores `telegram_monitor_events`, enqueues the live doorbell, and upserts a provisional Feed event.
3. `newone` imports the raw event and may deliver Bark immediately.
4. Any affected co-ride wallet is deduplicated into a low-priority holdings queue.
5. The holdings scheduler waits until there are no pending Pili live doorbells, no GMGN cooldown, and the global pacing interval has elapsed.
6. It refreshes one wallet, then schedules the next eligible wallet no sooner than 25 seconds later.
7. Pili's GMGN live monitor later enriches/reconciles the provisional Feed event.

## Failure Handling

- Cooldown: retain queued holdings work and retry only after normal pacing resumes.
- Network timeout: retain or re-enqueue the wallet with normal pacing; never immediately loop.
- Invalid chain/token response: record the terminal error for that target and continue with later queued work.
- Worker restart: rebuilding the queue from later Feed events is acceptable; no durable holdings queue migration is required for this personal tool.
- Provisional Feed projection failure: log the failure without rejecting the raw xxyy event or its doorbell.

## Testing

### Newone

- A Feed burst containing multiple wallets dispatches only one wallet immediately.
- The next wallet cannot dispatch before 25 seconds.
- Repeated events for one wallet within ten minutes produce one refresh.
- Pending Pili doorbells defer holdings without dropping the queue.
- Cooldown defers holdings and recovery does not flush a burst.
- Periodic and Feed-triggered holdings paths share one in-flight/pacing gate.

### Pili

- Doorbell-mode xxyy ingest creates a provisional Feed event immediately.
- A later GMGN event reconciles with the provisional event without duplicating the Feed card.
- An unprojectable raw event still persists and enqueues its doorbell.
- Global token acquisition aborts cleanly when the live activity timeout expires.
- Recovery pacing eventually permits each request cost instead of waiting on an unattainable bucket balance.

## Rollout and Success Criteria

Roll out the `newone` scheduler first because it removes the active ban source. Then roll out Pili provisional projection and reconciliation.

The change is successful when:

- no co-ride holdings run sends more than one wallet dispatch per 25 seconds;
- repeated Feed bursts do not generate a holdings catch-up burst;
- Bark and provisional Pili Feed events normally appear from the same xxyy source without waiting for GMGN;
- GMGN enrichment may lag without making the Feed disappear;
- no new `RATE_LIMIT_BANNED` is attributable to local co-ride holdings during an observation window covering several queue cycles.

## Non-Goals

- Replacing GMGN as the holdings provider.
- Removing the shared cooldown.
- Persisting a durable cross-repo holdings job queue.
- Increasing concurrency, API-key count, or proxy count.
- Refactoring unrelated market, alert, or holdings code.
