# Feed Time Display And Top Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted feed time display toggle, render exact card times as `MM-DD HH:mm`, and restructure the top navigation so the nav links are centered and feed-specific controls stay inside the feed page.

**Architecture:** Keep the feed page as the source of truth for time display mode, persist the selection in `localStorage`, and pass the mode down into `ActivityCard`. Refactor `TopNav` into a three-column layout so brand, centered nav, and right-side slot have stable alignment across pages without coupling feed-only UI to the global header.

**Tech Stack:** Next.js App Router, React client components, TypeScript, Tailwind CSS, tsx script tests, ESLint

---

### Task 1: Add Time Display Helpers And Regression Tests

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/lib/timeFormat.ts`
- Modify: `/Users/xp/vibecoding/pilipili/scripts/test-time-format.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`

- [ ] **Step 1: Write the failing test**

```ts
assert.equal(
  formatAbsoluteTimeCompact(new Date('2026-04-23T14:06:54.000Z').getTime()),
  '04-23 22:06'
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:time-format`  
Expected: FAIL because `formatAbsoluteTimeCompact` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export function formatAbsoluteTimeCompact(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return '暂无动态';
  }

  const formatter = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date(timestamp));
  const month = parts.find((part) => part.type === 'month')?.value ?? '00';
  const day = parts.find((part) => part.type === 'day')?.value ?? '00';
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  return `${month}-${day} ${hour}:${minute}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:time-format`  
Expected: PASS with `time format tests: ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/timeFormat.ts scripts/test-time-format.ts package.json
git commit -m "test(time): cover exact feed timestamp formatting"
```

### Task 2: Add Persisted Feed Time Mode On The Feed Page

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/app/page.tsx`
- Modify: `/Users/xp/vibecoding/pilipili/components/ActivityCard.tsx`

- [ ] **Step 1: Write the failing test**

Add a new script assertion that proves exact mode can be represented and validated:

```ts
const savedModes = ['relative', 'absolute', 'broken'];
assert.deepEqual(
  savedModes.map((value) => normalizeFeedTimeDisplayMode(value)),
  ['relative', 'absolute', 'relative']
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:time-format`  
Expected: FAIL because `normalizeFeedTimeDisplayMode` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Add helper(s) to `lib/timeFormat.ts`:

```ts
export type FeedTimeDisplayMode = 'relative' | 'absolute';

export function normalizeFeedTimeDisplayMode(value: string | null | undefined): FeedTimeDisplayMode {
  return value === 'absolute' ? 'absolute' : 'relative';
}
```

In `app/page.tsx`, wire the feed page state:

```ts
const FEED_TIME_DISPLAY_MODE_STORAGE_KEY = 'pilipili:feed-time-display-mode';
const [timeDisplayMode, setTimeDisplayMode] = useState<FeedTimeDisplayMode>('relative');

useEffect(() => {
  if (typeof window === 'undefined') return;
  setTimeDisplayMode(
    normalizeFeedTimeDisplayMode(window.localStorage.getItem(FEED_TIME_DISPLAY_MODE_STORAGE_KEY))
  );
}, []);

useEffect(() => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(FEED_TIME_DISPLAY_MODE_STORAGE_KEY, timeDisplayMode);
}, [timeDisplayMode]);
```

In `components/ActivityCard.tsx`, accept the new prop:

```ts
timeDisplayMode?: FeedTimeDisplayMode;
```

and render:

```ts
const timeText =
  timeDisplayMode === 'absolute'
    ? formatAbsoluteTimeCompact(activity.timestamp)
    : getRelativeTimeState(activity.timestamp, now).label;
```

Only schedule relative refresh timers when `timeDisplayMode !== 'absolute'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:time-format`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/page.tsx components/ActivityCard.tsx lib/timeFormat.ts scripts/test-time-format.ts
git commit -m "feat(feed): persist card time display mode"
```

### Task 3: Add The Feed Toggle UI In The Status Bar

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/app/page.tsx`

- [ ] **Step 1: Write the failing test**

Use the existing script coverage from Tasks 1 and 2 as the regression base, then add the UI with no new helper test because the page-level feature is exercised by lint and manual verification.

- [ ] **Step 2: Run current tests before UI changes**

Run: `npm run test:time-format && npm run test:feed-ordering`  
Expected: PASS before UI wiring.

- [ ] **Step 3: Write minimal implementation**

Replace the feed-only status bar body with a two-side layout:

```tsx
<div className="mb-4 flex items-center justify-between rounded-lg border border-zinc-800/60 bg-zinc-900/50 p-3 text-xs text-zinc-400">
  <span>{prewarmLabel}</span>
  <div className="inline-flex rounded-md border border-zinc-700 bg-zinc-950/70 p-0.5">
    <button type="button">相对时间</button>
    <button type="button">精确时间</button>
  </div>
</div>
```

Selected state should visibly highlight the active mode.

- [ ] **Step 4: Run verification**

Run: `npm run test:time-format && npm run test:feed-ordering && npx eslint app/page.tsx components/ActivityCard.tsx lib/timeFormat.ts scripts/test-time-format.ts`  
Expected: PASS with no lint errors.

- [ ] **Step 5: Commit**

```bash
git add app/page.tsx components/ActivityCard.tsx lib/timeFormat.ts scripts/test-time-format.ts
git commit -m "feat(feed): add in-page time format toggle"
```

### Task 4: Center The Global Navigation And Move Manage Actions Back Into The Page

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/components/TopNav.tsx`
- Modify: `/Users/xp/vibecoding/pilipili/app/manage/page.tsx`
- Modify: `/Users/xp/vibecoding/pilipili/app/page.tsx`
- Modify: `/Users/xp/vibecoding/pilipili/app/system/page.tsx`

- [ ] **Step 1: Inspect current `rightSlot` usage**

Verify where `TopNav` is passed `rightSlot` so the nav refactor does not strand any controls.

- [ ] **Step 2: Write minimal implementation**

Refactor `TopNav` into a three-column layout, for example:

```tsx
<div className="mx-auto grid h-14 w-full max-w-7xl grid-cols-[1fr_auto_1fr] items-center gap-4 px-4">
  <div className="flex min-w-0 items-center gap-2">...</div>
  <div className="flex items-center justify-center gap-2">...</div>
  <div className="flex items-center justify-end gap-2">{rightSlot}</div>
</div>
```

Move the manage page buttons out of `TopNav.rightSlot` and render them at the top of the page content area instead.
Remove the feed-page last-update slot from the nav; if still needed, keep it in page content.

- [ ] **Step 3: Run verification**

Run: `npm run test:feed-ordering && npx eslint components/TopNav.tsx app/manage/page.tsx app/page.tsx app/system/page.tsx components/ActivityCard.tsx lib/timeFormat.ts scripts/test-time-format.ts`  
Expected: PASS.

- [ ] **Step 4: Manual visual check**

Confirm:
- nav links are centered on `/`
- nav links are centered on `/manage`
- nav links are centered on `/system`
- manage export/create buttons are below the nav, inside page content
- feed status bar toggle stays in the feed page only

- [ ] **Step 5: Commit**

```bash
git add components/TopNav.tsx app/manage/page.tsx app/page.tsx app/system/page.tsx
git commit -m "refactor(nav): center global navigation layout"
```

## Self-Review

- Spec coverage: this plan covers nav alignment, feed-only toggle placement, persistence, exact time formatting, and regression checks.
- Placeholder scan: no `TODO` or undefined implementation steps remain.
- Type consistency: uses `FeedTimeDisplayMode = 'relative' | 'absolute'` throughout and keeps exact format fixed to `MM-DD HH:mm`.
