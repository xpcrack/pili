# Transfer Card Text Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reposition the four text fields between the token avatar and user avatar in the transfer/trade card so ticker is top-left, trade amount is bottom-left, wallet name is top-right, and market cap is bottom-right without changing avatar placement, time placement, or existing interactions.

**Architecture:** Keep `components/ActivityCard.tsx` as the single source of truth for transfer-card rendering and preserve all existing data derivation and click handlers. Only remap the JSX layout inside the existing transfer card grid so the middle text block becomes a stable two-column, two-row arrangement while the right avatar block continues to own the timestamp and merged-trade badge.

**Tech Stack:** Next.js App Router client component, React, TypeScript, Tailwind CSS, ESLint

---

### Task 1: Remap The Transfer Card Middle Text Grid

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/components/ActivityCard.tsx`
- Test: No new test file; verify with `eslint` plus manual inspection because this is a JSX layout-only change inside an interaction-heavy client component with existing inline handlers.

- [ ] **Step 1: Capture the current render shape before editing**

Read the transfer-card branch around the middle text grid and confirm the current mapping:

```tsx
<div className="flex min-w-0 items-center justify-between gap-1">
  {trackedAddress ? <button>{displayWalletLabel}</button> : <span>{displayWalletLabel}</span>}
  <span>{[displayActionVariantLabel, displayTradeHeadlineText].filter(Boolean).join(' ')}</span>
</div>

<div className="flex min-w-0 items-center justify-between gap-1">
  {canCopyTokenCa ? <button>{displayTokenSymbol}</button> : <span>{displayTokenSymbol}</span>}
  {displayMarketCapText ? <span>{displayMarketCapText}</span> : null}
</div>
```

Expected finding: wallet name currently sits on the upper-left and ticker on the lower-left, which is the inverse of the requested layout.

- [ ] **Step 2: Replace the two stacked flex rows with a two-by-two grid using the existing nodes**

In `/Users/xp/vibecoding/pilipili/components/ActivityCard.tsx`, rewrite only the middle text block so it keeps the same button/span logic but assigns each item to an explicit grid cell:

```tsx
<div className="grid min-w-0 grid-cols-2 grid-rows-2 gap-x-1 gap-y-0.5">
  <div className="min-w-0">
    {canCopyTokenCa ? <button>{displayTokenSymbol}</button> : <span>{displayTokenSymbol}</span>}
  </div>
  <div className="min-w-0">
    {trackedAddress ? <button>{displayWalletLabel}</button> : <span>{displayWalletLabel}</span>}
  </div>
  <div className="min-w-0">
    <span>{[displayActionVariantLabel, displayTradeHeadlineText].filter(Boolean).join(' ')}</span>
  </div>
  <div className="min-w-0">
    {displayMarketCapText ? <span>{displayMarketCapText}</span> : null}
  </div>
</div>
```

Preserve the current Tailwind classes that control color, truncation, hover, highlight, right alignment, and outgoing/incoming amount tone on each individual node.

- [ ] **Step 3: Keep the right avatar block untouched except for any spacing needed to align with the new middle grid**

If alignment needs a tiny class adjustment, keep it limited to sizing/gap classes on the existing wrapper and do not move the timestamp out of the right avatar block:

```tsx
<div className="row-span-2 grid h-10 w-[8.75rem] grid-cols-[2.5rem_minmax(0,1fr)] grid-rows-2 items-center gap-x-0.5 justify-self-end">
  <Avatar className="row-span-2 h-10 w-10 shrink-0">...</Avatar>
  <div className="flex min-w-0 items-center gap-1.5">...</div>
  <div className="min-w-0 text-zinc-500 leading-none">...</div>
</div>
```

The right-side `user.name`, merged badge, and `timeAgo` handling must remain functionally identical after the refactor.

- [ ] **Step 4: Run verification**

Run: `npx eslint components/ActivityCard.tsx`
Expected: PASS with no lint errors.

Then manually verify in the app that:

```text
left top     = ticker
left bottom  = trade amount
right top    = wallet name
right bottom = market cap
time         = unchanged in the right avatar area
```

- [ ] **Step 5: Commit**

```bash
git add components/ActivityCard.tsx docs/superpowers/plans/2026-04-25-transfer-card-text-grid.md
git commit -m "fix(feed): remap transfer card text grid"
```
