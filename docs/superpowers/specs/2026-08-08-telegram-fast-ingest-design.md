# Telegram Fast Ingest Design

## Goal

Make an XXYY trade visible from the complete XXYY payload without making the Telegram bridge wait on external historical-price lookups or heavyweight reconciliation work.

## Current bottleneck

`ingestTelegramMonitorUpdate` saves the raw message and rings the live-monitor doorbell, then synchronously builds a provisional Activity. `buildActivityFromSnapshot` may call the OKX historical-price API for native-asset quotes. The bridge processes Telegram updates serially, so one slow lookup or SQLite retry delays every later update.

## Design

1. Keep raw XXYY audit persistence, tracked-user matching, and live-monitor doorbell enqueue in the synchronous ingest path.
2. Add a fast projection mode for the provisional Activity. It uses the XXYY-provided price/amount fields and `buildActivityFromSnapshotSync`; it must not perform network requests. When XXYY provides token quantity plus token price, the USD amount is calculated locally.
3. Use a minimal provisional `events` writer in doorbell mode. It skips historical importance scans, logical rekeying, conflict detection, and raw-payload joins; those remain on canonical/reconciliation paths.
4. Keep the existing full projection behavior for feed reads, reconciliation, and canonical repairs. Those paths may still resolve historical prices when needed.
5. Do not change the transaction aggregation, deduplication, or GMGN ownership rules. The provisional Activity remains replaceable by the canonical live-monitor Activity.
6. If USD conversion is unavailable at render time, show the complete XXYY native quote instead of `金额未知`.
7. Add regression tests that make any network fetch fail, verify local USD calculation, and verify the fast provisional writer.

## Error handling

If the fast provisional write encounters an SQLite lock, doorbell mode keeps its existing fail-soft behavior: the raw audit row and doorbell remain authoritative, while live-monitor/background recovery can later create or repair the feed row. The Telegram cursor must continue advancing when the ingest function returns successfully.

## Verification

- Run the new fast-ingest regression test and the existing Telegram monitor/doorbell tests.
- Run TypeScript checks and the production build.
- Inspect the diff and runtime status; do not restart workers until build and tests pass.
