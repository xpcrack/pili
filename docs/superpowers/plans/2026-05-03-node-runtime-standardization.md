# Node Runtime Standardization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardize this repo and this Mac on Node `24.11.1` so repo scripts, native modules, and AI-driven edits all run under the same verified runtime.

**Architecture:** Use repo-tracked runtime declarations as the source of truth inside the project: `.nvmrc`, `.node-version`, `package.json.engines`, and a dedicated `tsx` regression test that keeps them aligned. Add matching human/agent documentation in `AGENTS.md`, `README.md`, and `TROUBLESHOOTING.md`, then make non-interactive login shells load `nvm` and default to the pinned version via `~/.zprofile`.

**Tech Stack:** zsh, nvm, Node `24.11.1`, npm, Next.js `16.2.3`, TypeScript, `better-sqlite3`, `tsx` script tests

---

## File Map

- `.nvmrc` — exact Node version for `nvm use`
- `.node-version` — exact Node version for tools that read `node-version`
- `package.json` — `engines.node`, `test:node-runtime-policy`, and inclusion in `npm test`
- `scripts/test-node-runtime-policy.ts` — regression test that keeps version files, package metadata, and docs aligned
- `AGENTS.md` — explicit AI runtime rule for this repo
- `README.md` — quick-start runtime instructions for future you
- `TROUBLESHOOTING.md` — recovery path for `better-sqlite3` / `NODE_MODULE_VERSION` mismatches
- `~/.zprofile` — non-interactive login-shell default Node version on this machine

## Interface Changes

- Add a new internal test command: `npm run test:node-runtime-policy`
- Add repo runtime metadata: `.nvmrc`, `.node-version`, `package.json.engines.node`
- No external HTTP API, database schema, or runtime behavior changes in the app itself

### Task 1: Add repo-tracked Node version policy and regression coverage

**Files:**
- Create: `.nvmrc`
- Create: `.node-version`
- Create: `scripts/test-node-runtime-policy.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-node-runtime-policy.ts` with this exact content:

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readRepoFile(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8').trim();
}

function run() {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    engines?: { node?: string };
    scripts?: Record<string, string>;
  };

  assert.equal(readRepoFile('.nvmrc'), '24.11.1', '.nvmrc should pin Node 24.11.1');
  assert.equal(readRepoFile('.node-version'), '24.11.1', '.node-version should pin Node 24.11.1');
  assert.equal(
    packageJson.engines?.node,
    '>=24.11.1 <25',
    'package.json should constrain the repo to Node 24.x'
  );
  assert.equal(
    packageJson.scripts?.['test:node-runtime-policy'],
    'tsx scripts/test-node-runtime-policy.ts',
    'package.json should expose the node runtime policy regression test'
  );
  assert.match(
    packageJson.scripts?.test || '',
    /\bnpm run test:node-runtime-policy\b/,
    'npm test should include the node runtime policy regression test'
  );

  console.log('node runtime policy tests: ok');
}

run();
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
tsx scripts/test-node-runtime-policy.ts
```

Expected: FAIL because `.nvmrc` and `.node-version` do not exist yet, and `package.json` does not yet declare the runtime policy.

- [ ] **Step 3: Write the minimal implementation**

Create `.nvmrc`:

```text
24.11.1
```

Create `.node-version`:

```text
24.11.1
```

In `package.json`, insert the `engines` block immediately after `"private": true`:

```json
"private": true,
"engines": {
  "node": ">=24.11.1 <25"
},
```

In the `scripts` block, add this exact command after `"test:tooling-config": "tsx scripts/test-tooling-config.ts",`:

```json
"test:node-runtime-policy": "tsx scripts/test-node-runtime-policy.ts",
```

Replace the full `"test"` script with this exact value:

```json
"test": "npm run test:admin-auth && npm run test:feed-ordering && npm run test:time-format && npm run test:activity-card-view-model && npm run test:activity-importance && npm run test:activity-importance-service && npm run test:activity-importance-ingest && npm run test:activity-importance-backfill && npm run test:trade-usd && npm run test:events-feed-total && npm run test:feed-request-arbiter && npm run test:feed-client-state && npm run test:feed-completeness-visibility && npm run test:feed-prewarm-service && npm run test:activity-feed-retry && npm run test:global-search-wiring && npm run test:feed-page-state && npm run test:tooling-config && npm run test:node-runtime-policy && npm run test:search-filters && npm run test:source-reconciliation && npm run test:sync-failure-notifier && npm run test:manage-users && npm run test:tracked-user-validation && npm run test:tracked-address-ownership && npm run test:address-book && npm run test:address-assets && npm run test:conflict-repo && npm run test:system-config-conflict-chat && npm run test:conflict-notifier && npm run test:parser-fixtures && npm run test:telegram-monitor-reconciliation && npm run test:twitter-fetcher && npm run test:twitter-provider-router && npm run test:twitter-provider-clients && npm run test:twitter-provider-state && npm run test:twitter-identity-service && npm run test:twitter-stable-identity && npm run test:twitter-sync-service && npm run test:twitter-relay-coverage && npm run test:twitter-bridge",
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:node-runtime-policy
```

Expected: PASS with:

```text
node runtime policy tests: ok
```

- [ ] **Step 5: Commit**

Run:

```bash
git add .nvmrc .node-version package.json scripts/test-node-runtime-policy.ts
git commit -m "test: add node runtime policy coverage"
```

### Task 2: Document the runtime rule for humans and agents, and lock it with tests

**Files:**
- Modify: `scripts/test-node-runtime-policy.ts`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `TROUBLESHOOTING.md`

- [ ] **Step 1: Extend the failing test**

Replace `scripts/test-node-runtime-policy.ts` with this exact content:

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readRepoFile(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8').trim();
}

function run() {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    engines?: { node?: string };
    scripts?: Record<string, string>;
  };
  const agents = readRepoFile('AGENTS.md');
  const readme = readRepoFile('README.md');
  const troubleshooting = readRepoFile('TROUBLESHOOTING.md');

  assert.equal(readRepoFile('.nvmrc'), '24.11.1', '.nvmrc should pin Node 24.11.1');
  assert.equal(readRepoFile('.node-version'), '24.11.1', '.node-version should pin Node 24.11.1');
  assert.equal(
    packageJson.engines?.node,
    '>=24.11.1 <25',
    'package.json should constrain the repo to Node 24.x'
  );
  assert.equal(
    packageJson.scripts?.['test:node-runtime-policy'],
    'tsx scripts/test-node-runtime-policy.ts',
    'package.json should expose the node runtime policy regression test'
  );
  assert.match(
    packageJson.scripts?.test || '',
    /\bnpm run test:node-runtime-policy\b/,
    'npm test should include the node runtime policy regression test'
  );

  assert.match(
    agents,
    /Use Node `24\.11\.1` for this repo\./,
    'AGENTS.md should declare the pinned Node version'
  );
  assert.match(
    agents,
    /Do not switch to Node `25\+` unless you first reinstall or rebuild native dependencies and then verify `npm run build` and `npm test` both pass\./,
    'AGENTS.md should warn agents not to jump to Node 25+ without revalidation'
  );

  assert.match(readme, /## Runtime/, 'README.md should expose a Runtime section near the top');
  assert.match(
    readme,
    /Use Node `24\.11\.1` for this repo\./,
    'README.md should document the pinned Node version'
  );
  assert.match(
    readme,
    /npm rebuild better-sqlite3/,
    'README.md should point to the native module recovery command'
  );

  assert.match(
    troubleshooting,
    /This repo is pinned to Node `24\.11\.1`\./,
    'TROUBLESHOOTING.md should explain the pinned runtime'
  );
  assert.match(
    troubleshooting,
    /npm rebuild better-sqlite3/,
    'TROUBLESHOOTING.md should document the rebuild command'
  );
  assert.match(
    troubleshooting,
    /NODE_MODULE_VERSION/,
    'TROUBLESHOOTING.md should mention the ABI mismatch symptom'
  );

  console.log('node runtime policy tests: ok');
}

run();
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:node-runtime-policy
```

Expected: FAIL because `AGENTS.md`, `README.md`, and `TROUBLESHOOTING.md` do not yet contain the new runtime policy text.

- [ ] **Step 3: Write the minimal implementation**

Replace `AGENTS.md` with this exact content:

```md
<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:runtime-rules -->
# Runtime

Use Node `24.11.1` for this repo.

Do not switch to Node `25+` unless you first reinstall or rebuild native dependencies and then verify `npm run build` and `npm test` both pass.
<!-- END:runtime-rules -->
```

Insert this section into `README.md` immediately before `## Getting Started`:

```md
## Runtime

Use Node `24.11.1` for this repo.

```bash
nvm use
npm install
npm run dev
```

If you see `better-sqlite3` or `NODE_MODULE_VERSION` errors, switch back to Node `24.11.1` and run `npm rebuild better-sqlite3`.
```

Insert this section at the very top of `TROUBLESHOOTING.md`, before the existing title:

```md
## Node runtime and better-sqlite3

This repo is pinned to Node `24.11.1`. Running under Node `25+` can break the native `better-sqlite3` module with a `NODE_MODULE_VERSION` mismatch.

Recovery:

```bash
nvm use 24.11.1
npm rebuild better-sqlite3
npm run build
npm test
```

If `npm rebuild better-sqlite3` fails, run `npm install` under Node `24.11.1` and repeat the verification commands.
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:node-runtime-policy
```

Expected: PASS with:

```text
node runtime policy tests: ok
```

- [ ] **Step 5: Commit**

Run:

```bash
git add AGENTS.md README.md TROUBLESHOOTING.md scripts/test-node-runtime-policy.ts
git commit -m "docs: document node runtime policy"
```

### Task 3: Make this Mac’s login shells default to Node 24.11.1

**Files:**
- Modify: `/Users/xp/.zprofile`
- Runtime state change: `/Users/xp/.nvm/alias/default`

- [ ] **Step 1: Capture the current failing shell state**

Run:

```bash
zsh -lc 'which node; node -v'
```

Expected on this machine before the change:

```text
/opt/homebrew/bin/node
v25.9.0
```

- [ ] **Step 2: Update the login-shell bootstrap**

Replace `/Users/xp/.zprofile` with this exact content:

```zsh
eval "$(/opt/homebrew/bin/brew shellenv)"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if command -v nvm >/dev/null 2>&1; then
  nvm use --silent default >/dev/null 2>&1 || nvm use --silent 24.11.1 >/dev/null 2>&1 || true
fi

# Added by OrbStack: command-line tools and integration
# This won't be added again if you remove it.
source ~/.orbstack/shell/init.zsh 2>/dev/null || :
```

- [ ] **Step 3: Set the machine-wide nvm default**

Run:

```bash
zsh -lc 'nvm alias default 24.11.1'
```

Expected: output containing:

```text
default -> 24.11.1
```

- [ ] **Step 4: Verify non-interactive login shells now use the pinned runtime**

Run:

```bash
zsh -lc 'which node; node -v'
```

Expected:

```text
/Users/xp/.nvm/versions/node/v24.11.1/bin/node
v24.11.1
```

- [ ] **Step 5: Run the full verification suite under the default shell**

Run:

```bash
zsh -lc 'cd /Users/xp/vibecoding/pilipili/.worktrees/person-level-peak-asset-guard && node -v && npm run build && npm test'
```

Expected:
- The first line is `v24.11.1`
- `npm run build` completes successfully
- `npm test` completes successfully, including `node runtime policy tests: ok`

## Acceptance Criteria

- `zsh -lc 'node -v'` returns `v24.11.1` on this machine
- `.nvmrc`, `.node-version`, and `package.json.engines.node` all agree on the Node 24 policy
- `npm run test:node-runtime-policy` fails if an AI later changes the repo to Node 25+ or removes the docs guidance
- `AGENTS.md` explicitly tells future agents to stay on Node `24.11.1`
- `npm run build` and `npm test` both pass under the default shell without PATH overrides

## Assumptions

- `nvm` is already installed at `~/.nvm`
- `Node v24.11.1` is already installed at `~/.nvm/versions/node/v24.11.1`
- The repo stays on a light-weight policy: version files, docs, and tests only; no `preinstall` hard-fail hook is added
- `package.json.engines.node` intentionally allows `24.x` only, while the machine default stays pinned to exact `24.11.1`
