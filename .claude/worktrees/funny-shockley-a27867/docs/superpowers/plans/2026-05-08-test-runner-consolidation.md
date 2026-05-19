# Test Runner Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 60+ npm `test:*` scripts and the 5KB serial `&&` chain with a single discovery-based test runner that spawns each `scripts/test-*.{ts,tsx}` file as a subprocess and aggregates results.

**Architecture:** A single self-contained Node script (`scripts/lib/runTests.ts`) discovers test files by glob, spawns each via `npx tsx` with a uniform `--require ./scripts/server-only-shim.cjs`, captures stdout/stderr per child, and prints a PASS/FAIL summary. Existing test files are unchanged. The runner is self-tested via three fixtures and `scripts/test-runner.ts`.

**Tech Stack:** Node 24.11.1 stdlib only (`node:fs`, `node:path`, `node:child_process`); `tsx` for TypeScript execution; existing `node:assert/strict` style for the self-test.

---

## File Structure

| Path | Purpose |
|---|---|
| `scripts/lib/runTests.ts` | Runner entrypoint. CLI parsing, discovery, spawn loop, reporter, exit code. |
| `scripts/lib/runTests.fixtures/test-passing.ts` | Fixture: prints to stdout, exits 0. Used by self-test. |
| `scripts/lib/runTests.fixtures/test-failing.ts` | Fixture: prints to stderr, exits 1. Used by self-test. |
| `scripts/lib/runTests.fixtures/test-slow.ts` | Fixture: sleeps 5s. Used by self-test for `--timeout` coverage. |
| `scripts/test-runner.ts` | Runner self-test. Spawns runner against fixtures, asserts on output and exit code. |
| `package.json` | `test` script swap; deletion of 60+ `test:*` lines. |

`scripts/test-runner.ts` lives at the same level as the other 86 test files so it's auto-discovered by the runner. Fixtures live under `scripts/lib/runTests.fixtures/` so default discovery (which only scans `scripts/`, non-recursive) skips them.

---

### Task 1: Add fixtures

**Files:**
- Create: `scripts/lib/runTests.fixtures/test-passing.ts`
- Create: `scripts/lib/runTests.fixtures/test-failing.ts`
- Create: `scripts/lib/runTests.fixtures/test-slow.ts`

- [ ] **Step 1: Create the passing fixture**

```ts
// scripts/lib/runTests.fixtures/test-passing.ts
console.log('passing fixture: ok');
process.exit(0);
```

- [ ] **Step 2: Create the failing fixture**

```ts
// scripts/lib/runTests.fixtures/test-failing.ts
console.error('intentional failure for runner self-test');
process.exit(1);
```

- [ ] **Step 3: Create the slow fixture (used by `--timeout` self-test)**

```ts
// scripts/lib/runTests.fixtures/test-slow.ts
setTimeout(() => {
  console.log('slow fixture finished');
  process.exit(0);
}, 5_000);
```

- [ ] **Step 4: Verify each fixture runs in isolation**

Run:
```bash
npx tsx scripts/lib/runTests.fixtures/test-passing.ts; echo "exit=$?"
npx tsx scripts/lib/runTests.fixtures/test-failing.ts; echo "exit=$?"
```

Expected:
```
passing fixture: ok
exit=0
intentional failure for runner self-test
exit=1
```

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/runTests.fixtures/
git commit -m "Add fixtures for test runner self-test"
```

---

### Task 2: Implement runner MVP (discovery + spawn + summary + flags)

**Files:**
- Create: `scripts/lib/runTests.ts`

This task ships the full runner in one go because `--filter` and `--root` are required by the self-test in Task 3, and the other flags (`--bail`, `--verbose`, `--timeout`) are tightly interleaved with the spawn loop. Splitting them would require shipping intermediate runners that can't be self-tested cleanly.

- [ ] **Step 1: Write the runner**

```ts
// scripts/lib/runTests.ts
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

interface CliFlags {
  root: string;
  filter: string | null;
  bail: boolean;
  verbose: boolean;
  timeoutMs: number;
}

interface TestResult {
  name: string;
  file: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_SEC = 60;

function printHelp() {
  console.log(`Usage: tsx scripts/lib/runTests.ts [--flags]

Flags:
  --root=<dir>       Directory to scan (default: scripts)
  --filter=<substr>  Only run tests whose basename contains <substr> (case-insensitive)
  --bail             Stop at first failure
  --verbose          Print every test's stdout/stderr
  --timeout=<sec>    Per-test timeout (default: ${DEFAULT_TIMEOUT_SEC})
  -h, --help         Show this help`);
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    root: 'scripts',
    filter: null,
    bail: false,
    verbose: false,
    timeoutMs: DEFAULT_TIMEOUT_SEC * 1000,
  };
  for (const arg of argv) {
    if (arg === '--bail') flags.bail = true;
    else if (arg === '--verbose') flags.verbose = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith('--filter=')) {
      flags.filter = arg.slice('--filter='.length);
    } else if (arg.startsWith('--root=')) {
      flags.root = arg.slice('--root='.length);
    } else if (arg.startsWith('--timeout=')) {
      const sec = Number.parseInt(arg.slice('--timeout='.length), 10);
      if (!Number.isFinite(sec) || sec <= 0) {
        console.error(`runTests: invalid --timeout value: ${arg}`);
        process.exit(2);
      }
      flags.timeoutMs = sec * 1000;
    } else {
      console.error(`runTests: unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  return flags;
}

function discoverTests(root: string, filter: string | null): string[] {
  const lowerFilter = filter ? filter.toLowerCase() : null;
  const entries = readdirSync(root, { withFileTypes: true });
  const matched: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.startsWith('test-')) continue;
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue;
    if (lowerFilter && !name.toLowerCase().includes(lowerFilter)) continue;
    matched.push(path.join(root, name));
  }
  matched.sort();
  return matched;
}

function runOne(file: string, timeoutMs: number, verbose: boolean): Promise<TestResult> {
  const name = path.basename(file).replace(/\.tsx?$/, '');
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn('npx', ['tsx', file], {
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ./scripts/server-only-shim.cjs`.trim(),
      },
      stdio: verbose ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    if (!verbose) {
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve({
        name,
        file,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        name,
        file,
        exitCode: -1,
        stdout,
        stderr: stderr + (error instanceof Error ? error.message : String(error)),
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
    });
  });
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function reportPass(name: string, durationMs: number) {
  console.log(`  ✓ ${name} (${durationMs}ms)`);
}

function reportFail(result: TestResult, timeoutSec: number) {
  if (result.timedOut) {
    console.log(`  ✗ ${result.name} (timed out after ${timeoutSec}s)`);
  } else {
    console.log(`  ✗ ${result.name} (${result.durationMs}ms)`);
  }
  if (result.stdout.trim()) {
    console.log(indent(result.stdout));
  }
  if (result.stderr.trim()) {
    console.log(indent(result.stderr));
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const files = discoverTests(flags.root, flags.filter);

  if (files.length === 0) {
    const where = flags.filter ? ` matching '${flags.filter}'` : '';
    console.error(`runTests: no tests found under ${flags.root}${where}`);
    process.exit(1);
  }

  const timeoutSec = Math.round(flags.timeoutMs / 1000);
  console.log(
    `Running ${files.length} test${files.length === 1 ? '' : 's'} serially with ${timeoutSec}s timeout each.\n`
  );

  const results: TestResult[] = [];
  const startedAt = Date.now();
  for (const file of files) {
    const result = await runOne(file, flags.timeoutMs, flags.verbose);
    results.push(result);
    if (result.exitCode === 0 && !result.timedOut) {
      reportPass(result.name, result.durationMs);
    } else {
      reportFail(result, timeoutSec);
      if (flags.bail) break;
    }
  }

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const passed = results.filter((r) => r.exitCode === 0 && !r.timedOut).length;
  const failed = results.filter((r) => r.exitCode !== 0 || r.timedOut);

  console.log('\n──────────────────────────────────────');
  console.log(`PASS: ${passed}   FAIL: ${failed.length}   TIME: ${totalSec}s`);
  console.log('──────────────────────────────────────');

  if (failed.length > 0) {
    console.log('\nFailed:');
    for (const result of failed) {
      console.log(`  - ${result.name}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

void main().catch((error) => {
  console.error(`runTests: fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
```

- [ ] **Step 2: Smoke-test against fixtures (manual)**

Run:
```bash
npx tsx scripts/lib/runTests.ts --root=scripts/lib/runTests.fixtures
```

Expected output (timing values will vary):
```
Running 3 tests serially with 60s timeout each.

  ✗ test-failing (XXms)
    intentional failure for runner self-test
  ✓ test-passing (XXms)
  ✓ test-slow (5000ms+)

──────────────────────────────────────
PASS: 2   FAIL: 1   TIME: ~5.5s
──────────────────────────────────────

Failed:
  - test-failing
```

Exit code: `1` (verify with `echo "exit=$?"`).

- [ ] **Step 3: Smoke-test --filter (manual)**

Run:
```bash
npx tsx scripts/lib/runTests.ts --root=scripts/lib/runTests.fixtures --filter=passing; echo "exit=$?"
```

Expected:
```
Running 1 test serially with 60s timeout each.

  ✓ test-passing (XXms)

──────────────────────────────────────
PASS: 1   FAIL: 0   TIME: 0.Xs
──────────────────────────────────────
exit=0
```

- [ ] **Step 4: Smoke-test --bail (manual)**

Run:
```bash
npx tsx scripts/lib/runTests.ts --root=scripts/lib/runTests.fixtures --bail; echo "exit=$?"
```

Expected: `test-failing` runs first (alphabetical), `--bail` triggers, `test-passing` and `test-slow` are NOT run.
```
Running 3 tests serially with 60s timeout each.

  ✗ test-failing (XXms)
    intentional failure for runner self-test

──────────────────────────────────────
PASS: 0   FAIL: 1   TIME: 0.Xs
──────────────────────────────────────

Failed:
  - test-failing
exit=1
```

- [ ] **Step 5: Smoke-test --timeout against slow fixture (manual)**

Run:
```bash
npx tsx scripts/lib/runTests.ts --root=scripts/lib/runTests.fixtures --filter=slow --timeout=1; echo "exit=$?"
```

Expected:
```
Running 1 test serially with 1s timeout each.

  ✗ test-slow (timed out after 1s)

──────────────────────────────────────
PASS: 0   FAIL: 1   TIME: 1.Xs
──────────────────────────────────────

Failed:
  - test-slow
exit=1
```

- [ ] **Step 6: Type-check the runner**

Run: `npx tsc --noEmit`
Expected: clean (no output, exit 0)

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/runTests.ts
git commit -m "Add discovery-based test runner with --filter / --bail / --verbose / --timeout"
```

---

### Task 3: Add runner self-test

**Files:**
- Create: `scripts/test-runner.ts`

- [ ] **Step 1: Write the self-test**

```ts
// scripts/test-runner.ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const FIXTURES_ROOT = 'scripts/lib/runTests.fixtures';

function spawnRunner(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'scripts/lib/runTests.ts', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('exit', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

function describeResult(result: RunResult): string {
  return `\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

async function testPassingFixtureExits0() {
  const result = await spawnRunner([`--root=${FIXTURES_ROOT}`, '--filter=passing']);
  assert.equal(result.exitCode, 0, `expected exit 0${describeResult(result)}`);
  assert.match(result.stdout, /✓ test-passing/);
  assert.match(result.stdout, /PASS: 1\s+FAIL: 0/);
}

async function testFailingFixtureExits1AndReplaysStderr() {
  const result = await spawnRunner([`--root=${FIXTURES_ROOT}`, '--filter=failing']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /✗ test-failing/);
  assert.match(result.stdout, /intentional failure for runner self-test/);
  assert.match(result.stdout, /PASS: 0\s+FAIL: 1/);
  assert.match(result.stdout, /Failed:[\s\S]+- test-failing/);
}

async function testCollectAllRunsBothBeforeReportingFailure() {
  // Default discovery picks all 3 fixtures (passing/failing/slow).
  // Restrict via --filter=test- to keep slow out (it sleeps 5s) — wait, that
  // matches all three. Use a narrower filter that captures both passing and
  // failing but not slow.
  const result = await spawnRunner([`--root=${FIXTURES_ROOT}`, '--filter=ing']);
  // Substring 'ing' matches: test-passing, test-failing. Not test-slow.
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /✓ test-passing/);
  assert.match(result.stdout, /✗ test-failing/);
  assert.match(result.stdout, /PASS: 1\s+FAIL: 1/);
}

async function testBailStopsAfterFirstFailure() {
  // Alphabetical order under fixtures: test-failing < test-passing < test-slow.
  // Filter to passing+failing so we don't sit through the slow fixture.
  const result = await spawnRunner([`--root=${FIXTURES_ROOT}`, '--filter=ing', '--bail']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /✗ test-failing/);
  assert.equal(
    result.stdout.includes('✓ test-passing'),
    false,
    `expected test-passing to be skipped under --bail${describeResult(result)}`
  );
  assert.match(result.stdout, /PASS: 0\s+FAIL: 1/);
}

async function testFilterCaseInsensitive() {
  const result = await spawnRunner([`--root=${FIXTURES_ROOT}`, '--filter=PASSING']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /✓ test-passing/);
}

async function testNoMatchExits1() {
  const result = await spawnRunner([`--root=${FIXTURES_ROOT}`, '--filter=nonexistent-marker']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /no tests found/);
}

async function testTimeoutKillsSlowFixture() {
  const result = await spawnRunner([`--root=${FIXTURES_ROOT}`, '--filter=slow', '--timeout=1']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /✗ test-slow \(timed out after 1s\)/);
  assert.match(result.stdout, /PASS: 0\s+FAIL: 1/);
}

async function run() {
  await testPassingFixtureExits0();
  await testFailingFixtureExits1AndReplaysStderr();
  await testCollectAllRunsBothBeforeReportingFailure();
  await testBailStopsAfterFirstFailure();
  await testFilterCaseInsensitive();
  await testNoMatchExits1();
  await testTimeoutKillsSlowFixture();
  console.log('runner self-test: ok');
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Run the self-test directly**

Run: `npx tsx scripts/test-runner.ts`

Expected (~10-15s, due to nested subprocess spawns):
```
runner self-test: ok
```

Exit code: `0`.

If any case fails, the assertion error message includes the actual stdout/stderr of the inner runner invocation — debug from there.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add scripts/test-runner.ts
git commit -m "Add runner self-test covering discovery, filter, bail, timeout, and stderr replay"
```

---

### Task 4: Run runner against the existing 86 tests (verification before continuing)

This task does not modify code. It verifies the runner produces the same overall result (all PASS) as the existing `npm test` chain, before we throw the existing scripts away.

**Files:** none modified; this is verification only.

- [ ] **Step 1: Run the runner against the real `scripts/` directory**

Run:
```bash
npx tsx scripts/lib/runTests.ts | tee /tmp/runner-fullrun.log
echo "exit=$?"
```

Expected: roughly 87 lines starting with `  ✓ test-...`, summary line `PASS: 87   FAIL: 0   TIME: ~XXXs`, exit `0`. (86 originals + 1 new `test-runner`.)

- [ ] **Step 2: If any test fails, diagnose before continuing**

If `FAIL > 0`:
1. Inspect `/tmp/runner-fullrun.log` for the failing test names.
2. Run that test directly with the runner shim to compare:
   ```bash
   NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' npx tsx scripts/test-<name>.ts
   ```
3. If the direct invocation passes but the runner reports failure, the runner has a bug — fix it in `scripts/lib/runTests.ts` before continuing.
4. If the direct invocation also fails, the test was already broken — capture the failure separately, do NOT attempt to "fix" it as part of this slice. Decide with the user whether to skip-list, fix, or pause this slice.

Stop here and report to the user before moving to Task 5.

- [ ] **Step 3: Compare runner totals against the legacy aggregate `test`**

Run the legacy chain for parity:
```bash
npm test 2>&1 | tee /tmp/legacy-test.log
echo "exit=$?"
```

Expected: legacy chain exits `0` (matching the runner's `0`). The legacy chain runs only the 60+ tests wired into the aggregate; the runner's count will be slightly higher because it also runs `test-bid-trades-api.ts` (orphaned from aggregate) and `test-runner.ts` (new). Confirm the runner has ≥ 86 PASS entries.

- [ ] **Step 4: No commit (pure verification)**

---

### Task 5: Swap `package.json`

**Files:**
- Modify: `package.json` (replace `test`, delete 60+ `test:*` lines)

- [ ] **Step 1: Replace the aggregate `test` script**

Open `package.json`. Find the `test` line (around line 90). Replace:
```json
"test": "npm run test:admin-auth && npm run test:api-response && npm run test:feed-ordering && ... && npm run test:twitter-bridge"
```
with:
```json
"test": "tsx scripts/lib/runTests.ts"
```

- [ ] **Step 2: Delete every `test:*` script entry**

Delete every line in `"scripts": { ... }` that starts with `"test:` or `"test-bid-trades-api":`. Specifically delete:

```
test:admin-auth
test:api-response
test:feed-ordering
test:time-format
test:activity-importance
test:activity-importance-service
test:activity-importance-ingest
test:activity-importance-backfill
test:trade-usd
test:events-feed-total
test:feed-request-arbiter
test:feed-query-mode
test:feed-client-state
test:feed-completeness-visibility
test:feed-prewarm-service
test:activities-api
test:activity-feed-retry
test:global-search-wiring
test:feed-page-state
test:user-bar
test:tooling-config
test:node-runtime-policy
test:source-reconciliation
test:sync-window-state
test:sync-failure-notifier
test:manage-users
test:search-filters
test:tracked-user-validation
test:tracked-address-ownership
test:asset-anomaly-rules
test:asset-peak-validation
test:asset-sync-pipeline
test:asset-peak-audit
test:tracked-user-assets
test:tracked-user-evm-expansion
test:address-book
test:address-management
test:addresses-api
test:address-assets
test:user-holdings-details
test:user-details-route
test:user-details-api
test:selected-user-details-hook-contract
test:selected-user-details-panel
test:feed-selected-user-details-contract
test:conflict-repo
test:system-config-conflict-chat
test:completeness-repo
test:completeness-status
test:completeness-maintenance-service
test:completeness-source-adapters
test:completeness-api
test:conflict-notifier
test:parser-fixtures
test:telegram-monitor-reconciliation
test:telegram-channel-provider
test:telegram-channel-migration
test:telegram-channel-sync-live
test:telegram-mtproto-upgrades
test:telegram-agent-authorization
test:twitter-fetcher
test:twitter-provider-router
test:twitter-provider-clients
test:twitter-provider-state
test:twitter-identity-service
test:twitter-stable-identity
test:twitter-enrichment
test:twitter-linked-ingest
test:twitter-sync-service
test:twitter-relay-coverage
test:twitter-bridge
test:activity-card-social
test:activity-card-view-model
test:activity-card-render
test-bid-trades-api
```

KEEP these (they are not test scripts):
- `dev`, `build`, `start`, `lint`
- `telegram:*`
- `completeness:worker`
- `audit:historical-asset-peaks`
- `importance:backfill`

After the edit, run:
```bash
node -e "const s = require('./package.json').scripts; const tests = Object.keys(s).filter(k => k.startsWith('test')); console.log(tests);"
```

Expected output:
```
[ 'test' ]
```

- [ ] **Step 3: Run `npm test`**

Run: `npm test 2>&1 | tail -10`

Expected:
```
  ✓ test-twitter-stable-identity (XXms)
  ✓ test-twitter-sync-service (XXms)
  ✓ test-twitter-relay-coverage (XXms)
  ✓ test-twitter-bridge (XXms)

──────────────────────────────────────
PASS: 87   FAIL: 0   TIME: ~XXXs
──────────────────────────────────────
```

Exit code: `0` (verify `echo "exit=$?"`).

- [ ] **Step 4: Run `npm test -- --filter=completeness`**

Run: `npm test -- --filter=completeness`

Expected: only completeness-named tests run (5 of them: `test-completeness-api`, `test-completeness-maintenance-service`, `test-completeness-repo`, `test-completeness-source-adapters`, `test-completeness-status`). Plus `test-feed-completeness-visibility`. Total 6.
```
Running 6 tests serially with 60s timeout each.

  ✓ test-completeness-api (XXms)
  ✓ test-completeness-maintenance-service (XXms)
  ✓ test-completeness-repo (XXms)
  ✓ test-completeness-source-adapters (XXms)
  ✓ test-completeness-status (XXms)
  ✓ test-feed-completeness-visibility (XXms)

──────────────────────────────────────
PASS: 6   FAIL: 0   TIME: X.Xs
──────────────────────────────────────
```

- [ ] **Step 5: Type-check + build**

Run:
```bash
npx tsc --noEmit
npm run build
```

Expected: both clean (build prints `✓ Compiled successfully`).

- [ ] **Step 6: Commit**

```bash
git add package.json
git commit -m "Replace 60+ test:* npm scripts with discovery-based runner"
```

---

### Task 6: Final end-to-end verification

**Files:** none modified.

- [ ] **Step 1: Fresh clone simulation**

Run from a fresh shell to ensure the runner doesn't depend on any session env:
```bash
unset NODE_OPTIONS
npm test 2>&1 | tail -5
echo "exit=$?"
```

Expected: PASS=87, FAIL=0, exit 0.

- [ ] **Step 2: Verify `--bail` against full suite**

Inject a temporary sentinel test (sorts to the top alphabetically so `--bail` triggers on it before any real test runs):
```bash
cat > scripts/test-AAA-bail-sentinel.ts <<'EOF'
console.error('intentional bail-sentinel failure');
process.exit(1);
EOF
npm test -- --bail 2>&1 | tail -20
echo "exit=$?"
rm scripts/test-AAA-bail-sentinel.ts
```

Expected: runner reports `✗ test-AAA-bail-sentinel`, includes `intentional bail-sentinel failure` in the replayed stderr, prints `PASS: 0   FAIL: 1`, exit `1`. The next test in alphabetical order (`test-activities-api`) is NOT run (verify by absence of any `✓` line).

Confirm sentinel was removed:
```bash
ls scripts/test-AAA* 2>&1
# Expected: "ls: scripts/test-AAA*: No such file or directory"
```

- [ ] **Step 3: No commit (pure verification)**

---

## Verification Checklist

Tick after Task 6 completes:

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run build` — `✓ Compiled successfully`
- [ ] `npm test` — PASS=87, FAIL=0, exit 0
- [ ] `npm test -- --filter=completeness` — runs only 6 completeness-named tests
- [ ] `npm test -- --bail` — stops at first injected failure (and `git checkout --` restores cleanly)
- [ ] `node -e "const s = require('./package.json').scripts; console.log(Object.keys(s).filter(k => k.startsWith('test')))"` — prints `[ 'test' ]`
- [ ] `scripts/lib/runTests.ts` exists; `scripts/test-runner.ts` exists; fixtures exist under `scripts/lib/runTests.fixtures/`
- [ ] No worker process broken: `launchctl list | grep pilipili` shows three rows, `completeness-maintenance` heartbeat in DB ≤ 6 minutes old

---

## Risks & Rollback

**Risk:** A test relies on env vars set by the legacy `npm run test:*` line that the runner doesn't replicate. Detection: Task 4 catches this — any test that passes legacy but fails runner reveals the dependency. Resolution: either inject env in `runOne()` or fix the test to read its own env.

**Risk:** `npx tsc --noEmit` includes the new fixtures and self-test in compilation. If a fixture or self-test has a type error, the whole build breaks. Detection: every commit step runs `npx tsc --noEmit`. Resolution: fix in place.

**Risk:** Per-test `npx tsc` resolution overhead inflates total runtime. Detection: Task 4 captures total time; if > 10× the legacy chain, investigate. Resolution: switch from `npx tsx` to a resolved binary path, or use a tsx-as-loader approach.

**Rollback:** `git revert <commit-sha>` of the package.json swap (Task 5 commit) restores all 60+ scripts. The runner code can stay (harmless, unreferenced).
