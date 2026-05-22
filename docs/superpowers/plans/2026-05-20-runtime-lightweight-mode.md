# Runtime Lightweight Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `pili` functionally identical while switching daily usage from long-running development mode to a lighter production-style runtime with AI-friendly mode switching.

**Architecture:** Add a repo-owned runtime contract instead of relying on ad-hoc local `pm2` state. The runtime contract has three pieces: a checked-in `pm2` ecosystem file, thin `npm` runtime commands for switching modes/status, and AI-facing documentation in `AGENTS.md`/`README.md`. Then add bounded worker guardrails for the long-running Telegram channel worker without changing its sync semantics.

**Tech Stack:** Next.js 16.2.6 App Router, Node 24.11.1, `pm2`, TypeScript 5, `tsx` script tests, existing long-running worker scripts under `scripts/`, local Next docs in `node_modules/next/dist/docs/`.

---

## Scope Check

This plan covers one runtime optimization project with two tightly related parts:

1. **Runtime mode contract** — production web by default, dev web only on demand, repo-owned `pm2` setup, AI instructions.
2. **Worker guardrails** — lightweight runtime protection for the Telegram channel worker so it does not grow unbounded in long-running usage.

These belong in one plan because they serve the same goal, touch overlapping runtime files, and can be validated together with the same manual smoke flow.

### Out of Scope

- No UI/feature behavior changes.
- No data model changes.
- No extra infrastructure like Redis or queues.
- No deep Telegram sync refactor.
- No completeness worker algorithm rewrite.

---

## File Structure

### Create
- `pm2/ecosystem.config.cjs` — checked-in process definitions for `pili-web-prod`, `pili-web-dev`, `pili-telegram-channel-worker`, `pili-completeness-worker`.
- `scripts/runtime-mode.ts` — thin CLI wrapper for `pm2` status / dev-on / dev-off commands.
- `scripts/test-runtime-mode.ts` — verifies runtime scripts, package.json wiring, and `pm2` ecosystem contract.
- `scripts/test-runtime-docs.ts` — verifies `AGENTS.md` and `README.md` document the runtime switching contract.
- `scripts/test-telegram-channel-worker-runtime.ts` — verifies new worker guardrail decision logic.
- `docs/superpowers/plans/2026-05-20-runtime-lightweight-mode.md` — this plan.

### Modify
- `package.json` — add runtime commands and new test command entries if needed.
- `AGENTS.md` — add repo runtime background plus explicit AI switching rules.
- `README.md` — replace generic CRA-style dev-only instructions with daily-runtime vs development-mode instructions.
- `scripts/telegram-channel-worker.ts` — add guardrail-aware loop behavior without changing business outcomes.
- `lib/server/telegramMtprotoPolicy.ts` — add env-backed runtime guardrail settings for Telegram worker.
- `scripts/lib/runTests.ts` — only if needed to ensure the new tests are auto-discovered without special casing.

### Reuse Without Structural Change
- `lib/server/telegramChannelWorkerRuntime.ts` — keep sync semantics and inject only minimal runtime metadata if needed.
- `scripts/completeness-maintenance-worker.ts` — no functional change expected.
- `scripts/test-tooling-config.ts` — pattern reference for config contract tests.
- `scripts/test-completeness-worker-runtime.ts` — pattern reference for runtime cycle tests.

---

## Pre-flight

- [ ] **Step 1: Read the local Next CLI/deploying docs required by AGENTS.md**

Run:
```bash
sed -n '1,220p' node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md
```

Expected: local Next CLI docs open successfully.

Run:
```bash
sed -n '1,220p' node_modules/next/dist/docs/01-app/01-getting-started/17-deploying.md
```

Expected: local Next deploying/runtime docs open successfully.

- [ ] **Step 2: Capture the current runtime baseline before editing**

Run:
```bash
git status --short
```

Expected: note any unrelated dirty files and avoid touching them.

Run:
```bash
npm test
```

Expected: current suite passes, or any existing failures are written down before implementation.

Run:
```bash
npm run build
```

Expected: current production build passes, or any existing failures are written down before implementation.

---

## Task 1: Add the Repo-Owned Runtime Contract

**Files:**
- Create: `pm2/ecosystem.config.cjs`
- Create: `scripts/test-runtime-mode.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing runtime contract test**

Create `scripts/test-runtime-mode.ts` with this exact content:

```typescript
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

function readText(relativePath: string) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function run() {
  const ecosystemPath = path.join(repoRoot, 'pm2', 'ecosystem.config.cjs');
  assert.equal(existsSync(ecosystemPath), true, 'pm2 ecosystem config must exist');

  const ecosystem = readText('pm2/ecosystem.config.cjs');
  assert.match(ecosystem, /name:\s*'pili-web-prod'/, 'pm2 config must define pili-web-prod');
  assert.match(ecosystem, /name:\s*'pili-web-dev'/, 'pm2 config must define pili-web-dev');
  assert.match(ecosystem, /name:\s*'pili-telegram-channel-worker'/, 'pm2 config must define pili-telegram-channel-worker');
  assert.match(ecosystem, /name:\s*'pili-completeness-worker'/, 'pm2 config must define pili-completeness-worker');
  assert.match(ecosystem, /npm run start/, 'web prod process should run npm run start');
  assert.match(ecosystem, /npm run dev/, 'web dev process should run npm run dev');

  const packageJson = JSON.parse(readText('package.json')) as {
    scripts?: Record<string, string>;
  };

  assert.equal(typeof packageJson.scripts?.['runtime:status'], 'string', 'package.json must expose runtime:status');
  assert.equal(typeof packageJson.scripts?.['runtime:dev:on'], 'string', 'package.json must expose runtime:dev:on');
  assert.equal(typeof packageJson.scripts?.['runtime:dev:off'], 'string', 'package.json must expose runtime:dev:off');
  assert.match(packageJson.scripts?.['runtime:status'] || '', /tsx scripts\/runtime-mode\.ts status/, 'runtime:status should call runtime-mode.ts status');
  assert.match(packageJson.scripts?.['runtime:dev:on'] || '', /tsx scripts\/runtime-mode\.ts dev-on/, 'runtime:dev:on should call runtime-mode.ts dev-on');
  assert.match(packageJson.scripts?.['runtime:dev:off'] || '', /tsx scripts\/runtime-mode\.ts dev-off/, 'runtime:dev:off should call runtime-mode.ts dev-off');

  console.log('runtime mode contract tests: ok');
}

run();
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:
```bash
npx tsx scripts/test-runtime-mode.ts
```

Expected: FAIL because `pm2/ecosystem.config.cjs` and runtime scripts do not exist yet.

- [ ] **Step 3: Add the checked-in `pm2` ecosystem file**

Create `pm2/ecosystem.config.cjs` with this exact content:

```javascript
const path = require('node:path');

const repoRoot = __dirname ? path.resolve(__dirname, '..') : process.cwd();

function app(name, script, extra = {}) {
  return {
    name,
    cwd: repoRoot,
    script: 'bash',
    args: ['-lc', script],
    autorestart: true,
    kill_timeout: 10000,
    ...extra,
  };
}

module.exports = {
  apps: [
    app('pili-web-prod', 'npm run start', {
      env: {
        NODE_ENV: 'production',
      },
    }),
    app('pili-web-dev', 'npm run dev', {
      env: {
        NODE_ENV: 'development',
      },
    }),
    app('pili-telegram-channel-worker', 'npm run telegram:channel:worker', {
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '1200M',
      exp_backoff_restart_delay: 200,
    }),
    app('pili-completeness-worker', 'npm run completeness:worker', {
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '512M',
      exp_backoff_restart_delay: 200,
    }),
  ],
};
```

- [ ] **Step 4: Add package runtime commands**

In `package.json`, add these exact script entries inside the `scripts` object near the existing runtime commands:

```json
"runtime:status": "tsx scripts/runtime-mode.ts status",
"runtime:dev:on": "tsx scripts/runtime-mode.ts dev-on",
"runtime:dev:off": "tsx scripts/runtime-mode.ts dev-off",
"test:runtime-mode": "tsx scripts/test-runtime-mode.ts",
```

Keep existing scripts intact.

- [ ] **Step 5: Add the thin runtime mode CLI**

Create `scripts/runtime-mode.ts` with this exact content:

```typescript
import { execFileSync } from 'node:child_process';
import path from 'node:path';

type RuntimeCommand = 'status' | 'dev-on' | 'dev-off';

const repoRoot = process.cwd();
const ecosystemPath = path.join(repoRoot, 'pm2', 'ecosystem.config.cjs');

function runPm2(args: string[]) {
  return execFileSync('pm2', args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
}

function ensureProdWebBuilt() {
  execFileSync('npm', ['run', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
}

function startOrReload(name: string) {
  try {
    runPm2(['start', ecosystemPath, '--only', name]);
  } catch {
    runPm2(['restart', name]);
  }
}

function stopIfPresent(name: string) {
  try {
    runPm2(['stop', name]);
  } catch {
    // Ignore missing process to keep switching idempotent.
  }
}

function status() {
  runPm2(['status']);
}

function devOn() {
  stopIfPresent('pili-web-prod');
  startOrReload('pili-web-dev');
}

function devOff() {
  stopIfPresent('pili-web-dev');
  ensureProdWebBuilt();
  startOrReload('pili-web-prod');
}

const command = process.argv[2] as RuntimeCommand | undefined;

if (command === 'status') {
  status();
} else if (command === 'dev-on') {
  devOn();
} else if (command === 'dev-off') {
  devOff();
} else {
  console.error('Usage: tsx scripts/runtime-mode.ts <status|dev-on|dev-off>');
  process.exit(1);
}
```

- [ ] **Step 6: Run the contract test again**

Run:
```bash
npx tsx scripts/test-runtime-mode.ts
```

Expected: PASS with `runtime mode contract tests: ok`.

- [ ] **Step 7: Run focused verification**

Run:
```bash
npm run test:runtime-mode
```

Expected: PASS.

Run:
```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json pm2/ecosystem.config.cjs scripts/runtime-mode.ts scripts/test-runtime-mode.ts
git commit -m "feat(runtime): add pm2 runtime mode contract"
```

---

## Task 2: Document the AI Switching Rules

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`

- [ ] **Step 1: Write a failing documentation contract test**

Create `scripts/test-runtime-docs.ts` with this exact content:

```typescript
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

function read(relativePath: string) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function run() {
  const agents = read('AGENTS.md');
  assert.match(agents, /pm2/i, 'AGENTS.md should mention pm2 runtime management');
  assert.match(agents, /切开发态|开发态/, 'AGENTS.md should explain switching to development mode');
  assert.match(agents, /切回生产态|生产态/, 'AGENTS.md should explain switching back to production mode');
  assert.match(agents, /不要动 worker|worker 不变|不默认碰 worker/, 'AGENTS.md should tell AI not to restart workers by default');

  const readme = read('README.md');
  assert.match(readme, /Runtime Modes/i, 'README.md should document runtime modes');
  assert.match(readme, /npm run runtime:dev:on/, 'README.md should document switching to dev mode');
  assert.match(readme, /npm run runtime:dev:off/, 'README.md should document switching back to prod mode');
  assert.match(readme, /npm run start/, 'README.md should explain production web runtime');

  console.log('runtime docs tests: ok');
}

run();
```

- [ ] **Step 2: Wire the doc test into `package.json` and confirm failure**

Add this exact script entry to `package.json`:

```json
"test:runtime-docs": "tsx scripts/test-runtime-docs.ts",
```

Run:
```bash
npx tsx scripts/test-runtime-docs.ts
```

Expected: FAIL because the current docs do not describe the runtime mode contract yet.

- [ ] **Step 3: Update `AGENTS.md` with runtime background for future AI sessions**

Append this exact block after the existing runtime section in `AGENTS.md`:

```md
<!-- BEGIN:runtime-mode-rules -->

# Runtime Modes

This repo is normally kept running under `pm2`.

Daily usage should default to **production web mode**, not `next dev`:

- `pili-web-prod` runs the normal web/API process
- `pili-telegram-channel-worker` and other workers stay running unless the user explicitly asks to stop them

When the user says they want to switch to development mode to edit code, treat that as a runtime-mode request:

1. Stop `pili-web-prod`
2. Start `pili-web-dev`
3. Do **not** stop or restart background workers unless the user explicitly asks

When the user says they are done and want to switch back to production mode:

1. Stop `pili-web-dev`
2. Run the production build
3. Only if the build succeeds, start `pili-web-prod`

Production mode and development mode must reuse the same `.env.local`, `.data/`, and SQLite database. Do not create a separate development database unless the user explicitly asks for one.

<!-- END:runtime-mode-rules -->
```

- [ ] **Step 4: Replace the generic README runtime section with project-specific runtime modes**

In `README.md`, replace the current generic Next.js getting-started content with this exact top section:

```md
## Runtime

Use Node `24.11.1` for this repo.

```bash
nvm use
npm install
```

If you see `better-sqlite3` or `NODE_MODULE_VERSION` errors, switch back to Node `24.11.1` and run:

```bash
npm rebuild better-sqlite3
```

## Runtime Modes

This project is normally kept running with `pm2`.

Daily usage should stay in production web mode:

```bash
npm run build
npm run start
```

For repo-managed mode switching, use:

```bash
npm run runtime:status
npm run runtime:dev:on
npm run runtime:dev:off
```

- `runtime:dev:on` switches the web process to development mode for code changes.
- `runtime:dev:off` switches the web process back to production mode and runs a fresh build first.
- Background workers should normally stay running during web-mode switches.

Both production mode and development mode reuse the same `.env.local`, `.data/`, and SQLite database.

## Development

If you are actively editing code and want the web app in development mode without `pm2`, you can still run:

```bash
npm run dev
```

Open [http://localhost:3005](http://localhost:3005).
```

Leave the rest of the README unchanged unless it conflicts with the new runtime contract.

- [ ] **Step 5: Run the new docs test**

Run:
```bash
npx tsx scripts/test-runtime-docs.ts
```

Expected: PASS with `runtime docs tests: ok`.

- [ ] **Step 6: Run focused verification**

Run:
```bash
npm run test:runtime-docs
```

Expected: PASS.

Run:
```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md README.md package.json scripts/test-runtime-docs.ts
git commit -m "docs(runtime): add AI runtime mode instructions"
```

---

## Task 3: Add Telegram Worker Guardrail Settings

**Files:**
- Modify: `lib/server/telegramMtprotoPolicy.ts`
- Create: `scripts/test-telegram-channel-worker-runtime.ts`

- [ ] **Step 1: Write the failing worker runtime test**

Create `scripts/test-telegram-channel-worker-runtime.ts` with this exact content:

```typescript
import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import { readTelegramMtprotoPolicy } from '@/lib/server/telegramMtprotoPolicy';

function withEnv<T>(env: Record<string, string>, run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (typeof value === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function run() {
  const policy = withEnv(
    {
      TELEGRAM_CHANNEL_WORKER_MAX_CYCLES_BEFORE_RESTART: '9',
      TELEGRAM_CHANNEL_WORKER_MAX_IDLE_MS_BEFORE_RESTART: '600000',
    },
    () => readTelegramMtprotoPolicy()
  );

  assert.equal(policy.channelWorkerMaxCyclesBeforeRestart, 9);
  assert.equal(policy.channelWorkerMaxIdleMsBeforeRestart, 600000);

  const fallback = withEnv(
    {
      TELEGRAM_CHANNEL_WORKER_MAX_CYCLES_BEFORE_RESTART: '0',
      TELEGRAM_CHANNEL_WORKER_MAX_IDLE_MS_BEFORE_RESTART: '-5',
    },
    () => readTelegramMtprotoPolicy()
  );

  assert.equal(fallback.channelWorkerMaxCyclesBeforeRestart, 120);
  assert.equal(fallback.channelWorkerMaxIdleMsBeforeRestart, 1800000);

  console.log('telegram channel worker runtime tests: ok');
}

run();
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:
```bash
npx tsx scripts/test-telegram-channel-worker-runtime.ts
```

Expected: FAIL because the policy fields do not exist yet.

- [ ] **Step 3: Extend the Telegram runtime policy type and reader**

In `lib/server/telegramMtprotoPolicy.ts`, update the interface to this exact shape:

```typescript
export interface TelegramMtprotoPolicy {
  requestDelayMs: number;
  floodSleepThresholdSec: number;
  channelSyncLimit: number;
  bridgeBackfillLimit: number;
  channelSyncIntervalMs: number;
  channelSyncLeaseTtlMs: number;
  channelWorkerMaxCyclesBeforeRestart: number;
  channelWorkerMaxIdleMsBeforeRestart: number;
}
```

And return these extra fields inside `readTelegramMtprotoPolicy()`:

```typescript
channelWorkerMaxCyclesBeforeRestart: readPositiveInt(
  process.env.TELEGRAM_CHANNEL_WORKER_MAX_CYCLES_BEFORE_RESTART,
  120
),
channelWorkerMaxIdleMsBeforeRestart: readPositiveInt(
  process.env.TELEGRAM_CHANNEL_WORKER_MAX_IDLE_MS_BEFORE_RESTART,
  30 * 60_000
),
```

- [ ] **Step 4: Run the test again**

Run:
```bash
npx tsx scripts/test-telegram-channel-worker-runtime.ts
```

Expected: PASS with `telegram channel worker runtime tests: ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/server/telegramMtprotoPolicy.ts scripts/test-telegram-channel-worker-runtime.ts
git commit -m "feat(runtime): add telegram worker guardrail policy"
```

---

## Task 4: Add Telegram Worker Self-Rotation Guardrails

**Files:**
- Modify: `scripts/telegram-channel-worker.ts`
- Modify: `package.json` (only if a dedicated test script entry is desired)

- [ ] **Step 1: Add a dedicated test script entry**

If not already added, insert this exact `package.json` script entry:

```json
"test:telegram-channel-worker-runtime": "tsx scripts/test-telegram-channel-worker-runtime.ts",
```

- [ ] **Step 2: Implement bounded self-rotation in `scripts/telegram-channel-worker.ts`**

Update the file with these exact additions.

Add this block after the existing `status` declaration:

```typescript
const EXIT_CODE_RESTART = 75;

function shouldRestartWorker(params: {
  completedCycles: number;
  idleSinceMs: number;
  nowMs: number;
}) {
  const policy = readTelegramMtprotoPolicy();
  return (
    params.completedCycles >= policy.channelWorkerMaxCyclesBeforeRestart ||
    params.nowMs - params.idleSinceMs >= policy.channelWorkerMaxIdleMsBeforeRestart
  );
}
```

Then replace the current `run()` body with this exact version:

```typescript
async function run() {
  await lease.waitForAcquire();

  let completedCycles = 0;
  let idleSinceMs = Date.now();

  while (lease.shouldRun()) {
    if (lease.isLost()) {
      console.warn(`${LOG_PREFIX} lease lost, reacquiring...`);
      lease.release();
      await lease.waitForAcquire();
      idleSinceMs = Date.now();
      continue;
    }

    const cycle = await runTelegramChannelWorkerCycle();
    completedCycles += 1;

    if (lease.isShuttingDown()) {
      break;
    }

    if (cycle.status === 'missing-credentials' || cycle.status === 'auth-required') {
      lease.release();
    }

    if (cycle.status !== 'error') {
      idleSinceMs = Date.now();
    }

    if (
      !lease.isShuttingDown() &&
      shouldRestartWorker({ completedCycles, idleSinceMs, nowMs: Date.now() })
    ) {
      console.log(`${LOG_PREFIX} restarting to keep long-running footprint bounded`);
      lease.release();
      process.exit(EXIT_CODE_RESTART);
    }

    await sleep(cycle.sleepMs);
    if (!lease.isOwned() && !lease.isShuttingDown()) {
      await lease.waitForAcquire();
      idleSinceMs = Date.now();
    }
  }
}
```

Finally, replace the existing `.catch(...)` block with this exact version:

```typescript
void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (lease.isOwned()) {
    status.set('failed', { lastError: message });
  }
  console.error(`${LOG_PREFIX} failed: ${message}`);
  lease.release();
  process.exit(1);
});
```

No additional behavior change is required beyond the bounded restart exit.

- [ ] **Step 3: Run focused tests**

Run:
```bash
npm run test:telegram-channel-worker-runtime
```

Expected: PASS.

Run:
```bash
npm run test:runtime-mode
```

Expected: PASS.

Run:
```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Manually verify runtime commands on the local machine**

Run:
```bash
npm run runtime:status
```

Expected: `pm2` process table prints.

Run:
```bash
npm run runtime:dev:on
```

Expected: `pili-web-prod` stops if present, `pili-web-dev` starts, worker processes remain untouched.

Run:
```bash
npm run runtime:dev:off
```

Expected: `pili-web-dev` stops, `npm run build` succeeds, then `pili-web-prod` starts.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/telegram-channel-worker.ts
git commit -m "feat(runtime): add telegram worker self-rotation"
```

---

## Task 5: Final End-to-End Verification

**Files:**
- No new files unless verification exposes a mismatch.

- [ ] **Step 1: Run the focused runtime test set**

Run:
```bash
npm run test:runtime-mode
npm run test:runtime-docs
npm run test:telegram-channel-worker-runtime
```

Expected: all three commands PASS.

- [ ] **Step 2: Run the project-wide verification required before completion**

Run:
```bash
npm test
```

Expected: PASS.

Run:
```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Manual smoke test the user-visible flow**

1. Confirm the normal app still opens at `http://localhost:3005` in production mode.
2. Confirm feed data still loads from the existing database.
3. Confirm Telegram channel worker keeps running after a web-mode switch.
4. Say out loud the intended natural-language flow for future AI sessions:
   - “我要转开发态改代码了” → AI should run `npm run runtime:dev:on`
   - “改完了，切回生产态” → AI should run `npm run runtime:dev:off`

Expected: no functional behavior difference besides lower daily runtime overhead.

- [ ] **Step 4: Final commit if any verification fixes were needed**

```bash
git status --short
```

Expected: either clean working tree or only intentional final verification fixes.

If verification required code/doc fixes, commit them with:

```bash
git add AGENTS.md README.md package.json pm2/ecosystem.config.cjs scripts/runtime-mode.ts scripts/telegram-channel-worker.ts scripts/test-runtime-mode.ts scripts/test-runtime-docs.ts scripts/test-telegram-channel-worker-runtime.ts lib/server/telegramMtprotoPolicy.ts
git commit -m "chore(runtime): finish runtime lightweight rollout"
```

---

## Self-Review

### Spec Coverage Check

- Repo-owned `pm2` topology: covered in Task 1.
- AI switching rules in repo docs: covered in Task 2.
- Shared `.env.local` / `.data` / SQLite contract: documented in Task 2.
- Telegram worker guardrails: covered in Tasks 3-4.
- No feature/experience change and runtime verification: covered in Task 5.

### Placeholder Scan

- No `TODO` / `TBD` placeholders left in tasks.
- All file paths are explicit.
- All commands are explicit.
- All code-edit steps include exact snippets.

### Type Consistency Check

- New runtime script names match across `package.json`, tests, README, and AGENTS.
- New Telegram policy names match between test and implementation.
- `pili-*` process names match between ecosystem config, docs, and runtime CLI.
