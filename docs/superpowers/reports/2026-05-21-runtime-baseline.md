# Runtime Baseline Snapshot (2026-05-21)

## Environment Snapshot

Command set:

```bash
node -v
npm -v
git branch --show-current
git status --short
```

Result:

```text
$ node -v
v24.11.1
$ npm -v
11.14.1
$ git branch --show-current
codex/runtime-lightweight-mode
$ git status --short
 M package-lock.json
?? docs/superpowers/plans/2026-05-21-single-mode-runtime.md
```

## Build/Test Baseline

### Build

Command:

```bash
npm run build
```

Result: PASS

Notes:
- Next.js build completed successfully.
- Turbopack warning about multiple lockfiles (`repo root` and current worktree lockfile).

### Test

Command:

```bash
npm test
```

Result: FAIL (`PASS: 95`, `FAIL: 3`)

Pre-existing failures captured before this plan's code changes:

1. `test-node-runtime-policy`
- Assertion: missing README section heading `## Getting Started`
- File reference in stack: `scripts/test-node-runtime-policy.ts`

2. `test-selected-user-details-panel`
- Assertion: expected balance column header `数量` not present
- File reference in stack: `scripts/test-selected-user-details-panel.tsx`

3. `test-telegram-mtproto-upgrades`
- Assertion: `0 !== 2`
- File reference in stack: `scripts/test-telegram-mtproto-upgrades.ts`

## Runtime Resource Baseline

Command set:

```bash
pm2 status
ps -Ao pid,%cpu,%mem,rss,command | sort -k2 -nr | sed -n '1,20p'
top -l 1 -o cpu -stats pid,command,cpu,mem,threads,state,time
```

### PM2 Process Snapshot

```text
id 0  BID-CC4.6-dashboard  stopped
id 1  BID-CC4.6-vite       stopped
id 5  BID-backend          online
id 6  BID-frontend         online
id 7  axonhub              online (pid 4237)
id 3  chatgpt-web          stopped
id 2  cliproxy-api         stopped
id 4  pili                 online (pid 3738)
```

### Top CPU Snapshot (`ps`)

Notable high CPU processes at capture time:
- `Google Chrome Helper (Renderer)` ~112.9% CPU
- `next-server (v16.2.6)` ~105.0% CPU (pid 3751)
- `syspolicyd` ~41.6% CPU
- `WindowServer` ~20.8% CPU
- `Codex Helper (Renderer)` ~12.0% CPU

### System Snapshot (`top`)

```text
Processes: 532 total, 5 running, 527 sleeping, 4606 threads
Load Avg: 6.70, 6.72, 6.59
CPU usage: 25.78% user, 14.89% sys, 59.32% idle
PhysMem: 17G used, 191M unused
```

## Baseline Summary

- Toolchain baseline matches plan requirement (`Node v24.11.1`).
- Build baseline is green.
- Test baseline has 3 failures that pre-date this plan execution and are recorded above.
- PM2 currently has `pili` online and several unrelated processes online/stopped.
