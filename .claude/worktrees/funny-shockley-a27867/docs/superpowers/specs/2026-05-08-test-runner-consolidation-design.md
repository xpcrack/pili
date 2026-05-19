# Test Runner Consolidation

## Context

`scripts/` contains 86 ad-hoc test files (`test-*.ts` / `test-*.tsx`) and `package.json` exposes 60+ `test:*` npm scripts plus a 5KB serial `&&` chain as the aggregate `test` script. The pattern is uniform — every test file ends in:

```ts
async function run() {
  await testCaseA();
  await testCaseB();
  console.log('foo tests: ok');
}
void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

There is no shared scaffolding. Adding a test means: write the file, add an `npm test:foo` line, paste it into the aggregate chain. The aggregate uses `&&` so the first failure stops the rest, you never see the full failure surface in one run, and the chain is unmaintainable to read or audit.

This design replaces the 60+ scripts with a single discovery-based runner that spawns each test file as a subprocess and aggregates results.

## Goals

- One `npm test` command runs every `scripts/test-*.{ts,tsx}` file
- One run reports every failure (collect-all by default)
- Failures show the failing test's full stdout/stderr; passes stay quiet
- 60s default timeout per test prevents one hang from blocking the suite
- `--filter=<substr>` for targeted reruns; `--bail` for fail-fast; `--verbose` for full output
- Zero changes inside any of the 86 test files (non-invasive)
- Runner is self-tested via fixtures so `npm test` covers the runner too

## Non-goals

- No parallel execution (deferred — sqlite is shared, parallelism needs analysis)
- No test framework (no `describe` / `it`) — keeps existing `assert + console.log` style
- No coverage reporting
- No watch mode
- No migration of the test files to a new authoring API

## Architecture

```
scripts/
  lib/
    runTests.ts              ← runner entrypoint (spawns subprocesses)
    runTests.fixtures/
      passing.ts             ← prints "ok", exits 0
      failing.ts             ← prints to stderr, exits 1
      hanging.ts             ← never resolves (exists for future timeout test)
  test-runner.ts             ← runner self-test (uses fixtures)
  test-*.ts                  ← 86 unchanged test files
```

The runner has no business-logic dependencies. It uses only `node:fs`, `node:path`, `node:child_process`, `node:util`. It can run in any environment that has `tsx` on PATH.

## Discovery

```ts
glob: scripts/test-*.ts, scripts/test-*.tsx
```

- Includes the existing `test-bid-trades-api.ts` that was orphaned from the old aggregate chain
- Implementation: simple `fs.readdirSync('scripts')` + filter; no glob library

## Subprocess execution

For each discovered file, in order (alphabetical for determinism):

```ts
spawn('npx', ['tsx', filePath], {
  env: {
    ...process.env,
    NODE_OPTIONS: '--require ./scripts/server-only-shim.cjs',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
```

- `server-only-shim` is loaded for every test. It is a no-op for tests that don't import `'server-only'`, so the unification is safe.
- stdout / stderr are buffered per test (default; `--verbose` inherits instead).
- Timeout: `setTimeout(timeoutMs)` → if it fires, `child.kill('SIGKILL')` → record as failure with reason `timeout`.
- Result fields: `{ name, file, exitCode, stdout, stderr, durationMs, timedOut }`.

## CLI

```
npm test [-- <flags>]

  --filter=<substr>   Run only tests whose basename contains <substr> (case-insensitive)
  --bail              Stop at the first failure
  --verbose           Print every test's stdout/stderr (default: only on failure)
  --timeout=<sec>     Per-test timeout (default: 60)
  --help              Print usage and exit
```

Argv parsing: small inline parser; no dependency. Flags use `--key=value` form (no positional args).

## Output

```
Running 86 tests serially with 60s timeout each.

  ✓ test-admin-auth (213ms)
  ✓ test-api-response (89ms)
  ✓ test-completeness-status (45ms)
  …
  ✗ test-twitter-fetcher (1024ms)
    [stdout/stderr replayed verbatim, indented]
  ✓ test-twitter-bridge (612ms)

──────────────────────────────────────
PASS: 85   FAIL: 1   TIME: 287.4s
──────────────────────────────────────

Failed:
  - test-twitter-fetcher
```

- Pass line: `  ✓ <name> (<ms>ms)`
- Fail line: `  ✗ <name> (<ms>ms)` followed by indented stdout then stderr
- Timeout failure: `  ✗ <name> (timed out after 60s)`
- Final summary lists failed test names so they can be re-run via `npm test -- --filter=<name>`

Exit code: `0` if all passed, `1` if any failed (or runner errored).

## Runner self-test

`scripts/test-runner.ts` invokes the runner against `scripts/lib/runTests.fixtures/`:

| Fixture | Expected runner behavior |
|---|---|
| `passing.ts` | Reports PASS, exit 0 |
| `failing.ts` | Reports FAIL, replays stderr, exit 1 |
| `passing.ts` + `failing.ts` together | PASS=1 FAIL=1 in summary, exit 1 |
| `--bail` with passing → failing → passing | Stops after failing.ts; third fixture not invoked |
| `--filter=passing` | Only passing.ts runs |

`hanging.ts` exists in fixtures but is **not** invoked by the self-test (a 60s hang would block the suite). It documents intended timeout coverage for a future improvement.

## package.json changes

Remove all 60+ `test:*` scripts. Replace `test` with:

```json
"test": "tsx scripts/lib/runTests.ts"
```

Keep: `dev`, `build`, `start`, `lint`, `telegram:*`, `completeness:worker`, `audit:*`, `importance:backfill` (non-test utilities).

## Migration steps

1. Write `scripts/lib/runTests.ts`, fixtures, and `scripts/test-runner.ts`
2. Run `npx tsx scripts/lib/runTests.ts` against current 86 files → must report 86 PASS
3. Edit `package.json`: replace aggregate `test` and delete the 60+ `test:*` lines
4. Run `npm test` → must report 87 PASS (86 originals + new test-runner)
5. Verify selected flags: `npm test -- --filter=completeness` should run only completeness tests; `npm test -- --bail` should stop on injected failure (manual smoke)

## Verification

| Check | Command | Expected |
|---|---|---|
| Type-check | `npx tsc --noEmit` | clean |
| Build | `npm run build` | clean |
| All tests via runner | `npm test` | 87 PASS, exit 0 |
| Filter | `npm test -- --filter=completeness` | 4 tests run |
| Self-test only | `npx tsx scripts/test-runner.ts` | "runner self-test: ok" |
| Bail behavior | Manual: temporarily break one test, `npm test -- --bail` | Stops at first failure |
| Timeout (manual) | `npm test -- --filter=hanging --timeout=2` (with hanging fixture invoked manually) | Reports `timed out after 2s` |

## Risks

- **Single-writer sqlite contention:** Tests are run serially so this is unchanged from today's behavior.
- **Hidden cwd assumptions:** Some tests may assume `process.cwd() === repo root`. Runner spawns from the repo root (where `npm test` runs), so this is preserved.
- **Stdout volume on failure:** A noisy failing test could dump megabytes. We accept this — it matches "show me what broke" intent. Future improvement: cap to last N KB.
- **`--require` overhead:** ~50ms per process × 86 = ~4s extra vs running the chain. Acceptable.
- **Test that depends on order:** None observed in survey, but if one exists and breaks, fix the test (real bug — tests should be order-independent).

## Out of scope (future)

- Parallel execution (needs sqlite serialization or per-test DB isolation)
- Watch mode (`--watch` triggering on file changes)
- JUnit XML output for CI
- Per-test sub-case granularity (would require defineTests-style invasive migration)
