# Twitter Relay-Aware 6551 Polling Design

Date: 2026-04-30

## Goal

Twitter ingestion should combine fast relay coverage with API coverage while keeping 6551 free-account usage readable and predictable.

The desired behavior is:

- Accounts with historical xxyy/TG relay records use relay as the primary path and API as low-frequency reconciliation.
- Accounts without relay records use API polling at the normal cadence.
- 6551 free daily quota is intentionally consumed before Xread, because there are four 6551 accounts with 100 pts/day each.
- 6551 keys are consumed sequentially, not evenly rotated, so daily usage is easy to inspect in the 6551 dashboard.
- System settings control the relay-covered and non-relay polling intervals.
- The people management page shows which tracked Twitter accounts have relay records.

## Confirmed Provider Facts

6551 free WebSocket is unavailable for the current keys. A WebSocket handshake to `wss://ai.6551.io/open/twitter_wss?token=...` returned `403` with the message `please upgrade to a paid plan to unlock this content`.

6551 REST `twitter_user_tweets` requests charge even when repeated with identical results:

- `includeReplies: false` charged 1 pt.
- `includeReplies: true` charged 2 pts.
- `maxResults` is capped by 6551 at 100 in the dashboard.

All four local 6551 keys are present and usable:

- `TWITTER_6551_API_KEY_1`
- `TWITTER_6551_API_KEY_2`
- `TWITTER_6551_API_KEY_3`
- `TWITTER_6551_API_KEY_4`

## Provider Priority

Automatic Twitter fetches should use this provider order:

1. `6551`
2. `xread`
3. `noop`

`opencli` and `dokobot` remain available only through explicit provider modes. They are not automatic fallbacks.

If all structured providers fail for a sync/backfill/detail request, the existing Telegram provider-failure alert behavior should fire.

## 6551 Key Selection

6551 keys should be treated as ordered daily buckets:

1. `6551-key-1`
2. `6551-key-2`
3. `6551-key-3`
4. `6551-key-4`

The router should pick the first available key with remaining local daily budget and no active cooldown. It should not prefer the freshest success, lowest failure timestamp, or balanced distribution when multiple keys are usable.

This intentionally drains one key before moving to the next. That makes the 6551 dashboard easy to reconcile: key 1 should fill first, then key 2, then key 3, then key 4.

The local budget model should count 6551 user tweet requests using the observed free-account rule:

- timeline lane: 1 unit
- replies lane: 2 units
- user detail lookup: 1 unit
- tweet-by-id detail: keep one unit per tweet detail request unless a later measurement proves otherwise

Budget accounting is a local guardrail, not a replacement for 6551's dashboard. It should be conservative enough to avoid accidentally burning through all four keys in a tight loop.

## Request Shape

6551 user tweet requests should be explicit and stable:

```json
{
  "username": "<handle>",
  "includeReplies": true,
  "includeRetweets": false,
  "maxResults": 100,
  "product": "Latest"
}
```

For timeline lane, `includeReplies` is `false`; for replies lane, `includeReplies` is `true`.

The sync service can still internally request at most 200 items per lane for provider-agnostic behavior, but the 6551 client must cap its own request to 100 to match the provider's real limit and dashboard records.

## Relay Coverage

A tracked Twitter account is relay-covered if `twitter_tweets.source_json.provider = 'bot2bot'` exists for its normalized Twitter handle.

The system should expose relay coverage per handle, including:

- normalized Twitter handle
- latest relay tweet id
- latest relay `last_seen_at_ms`
- relay tweet count, if cheap to compute

This can be derived from existing `twitter_tweets` rows. A separate table is unnecessary for the first version.

## Polling Cadence

System config adds two editable minute-based settings:

- `twitterRelayCoveredPollingIntervalMinutes`, default `360`
- `twitterUncoveredPollingIntervalMinutes`, default `30`

Automatic sync should skip a user when both of these are true:

- the user is not due under the interval assigned by relay coverage
- the current run is a normal automatic `sync`

Manual syncs should force execution and ignore these intervals. This keeps the system page useful for debugging and one-off recovery.

The cadence decision is per user, not per entire run:

- relay-covered users are due after the relay-covered interval
- users without relay history are due after the uncovered interval

The due check should use the user's Twitter sync cursor state, preferably the minimum `last_success_at_ms` across timeline/replies, so a user is not considered fully fresh if one lane has not run.

## System Page

The system page should add controls for:

- relay-covered Twitter polling interval, minutes
- non-relay Twitter polling interval, minutes

Values should be normalized on save:

- empty or invalid values fall back to defaults
- minimum should be at least 1 minute
- maximum should be bounded to a sane value, such as 7 days

The labels should make clear that these settings affect automatic Twitter sync, not manual sync.

## People Page

The people management page should show relay coverage for tracked Twitter accounts.

Recommended display:

- If a user has a Twitter handle and relay coverage: show a compact `Relay` badge near the Twitter line, with latest relay time.
- If a user has a Twitter handle and no relay coverage: show no badge by default, or a subtle `未 relay` marker if the layout needs clarity.
- Users without Twitter handles do not show relay status.

The page should get this data from the server rather than inferring it from local client state.

## Data Flow

Automatic bridge interval:

1. `scripts/telegram-bridge.ts` triggers `runTwitterSyncAction({ action: 'sync' })`.
2. `twitterSyncService` loads tracked Twitter users.
3. For each user, it reads relay coverage and sync cursor freshness.
4. If the user is not due, it logs a skip event and moves on.
5. If due, it fetches timeline and replies through the provider router.
6. Provider router tries sequential 6551 keys first, then Xread.
7. Successful 6551 requests increment local budget by observed units.
8. If all structured providers fail, Telegram provider failure alert is sent.

Relay ingestion:

1. `twitterRelayIngest` receives xxyy/TG forwarded tweet payloads.
2. It writes the tweet with `source.provider = 'bot2bot'`.
3. The relay coverage query automatically sees that handle as relay-covered.

People page:

1. UI loads tracked users.
2. UI also loads relay coverage by handle, or receives users enriched with relay coverage.
3. User cards render the relay badge for covered Twitter handles.

## Error Handling

- Missing 6551 keys are skipped.
- 6551 keys in cooldown are skipped.
- 6551 keys at local daily budget are skipped.
- Xread is attempted after all usable 6551 keys fail or are exhausted.
- If 6551 and Xread all fail, send the existing Telegram alert.
- A malformed relay source row should not break sync; relay coverage queries should ignore invalid handles.

## Testing

Add or update focused tests for:

- four 6551 keys are discovered from `TWITTER_6551_API_KEY_1..4`
- router consumes 6551 keys sequentially by remaining budget
- Xread comes after all usable 6551 keys
- 6551 user tweet request caps `maxResults` at 100 and includes `product: "Latest"` plus `includeRetweets: false`
- 6551 timeline success records 1 local unit
- 6551 replies success records 2 local units
- relay-covered users are skipped until the configured covered interval elapses
- uncovered users use the configured uncovered interval
- manual sync bypasses due-interval skips
- system config persists both interval settings
- people page/API exposes relay coverage for users with bot2bot tweet rows

## Out Of Scope

- Paid 6551 WebSocket support.
- A new relay coverage table.
- Automatic opencli or dokobot fallback.
- Exact 6551 dashboard scraping or remote quota synchronization.
