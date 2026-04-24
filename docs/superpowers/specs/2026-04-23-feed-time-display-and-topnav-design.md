# Feed Time Display And Top Navigation Design

## Summary

This change introduces a persisted feed time display toggle and restructures the top navigation layout.

- Top navigation becomes a stable three-part layout on every page:
  - brand on the left
  - `Feed / 人物 / 系统` centered
  - right side reserved for page-level content, but empty for this feature
- The feed time display toggle lives only on the feed page, inside the feed status bar that currently shows the prewarm/completeness label.
- The toggle persists the user's preference across refreshes.
- Exact time format is fixed to `MM-DD HH:mm`.

## Goals

- Make the top navigation visually consistent across pages.
- Keep feed-specific controls out of the global navigation.
- Let the user switch all feed cards between relative time and exact time with one click.
- Preserve the user's selected mode after refresh.

## Non-Goals

- No change to feed ordering logic.
- No new global settings page entry for time display.
- No time format customization beyond the two approved modes.
- No changes to manage-page action buttons beyond the nav realignment.

## UX Design

### Top Navigation

`components/TopNav.tsx` will use a three-column layout:

- left: brand icon and title
- center: navigation links
- right: optional slot area with fixed alignment, unused for this feature

The centered navigation should remain visually centered regardless of whether the right slot is empty.

### Feed Status Bar Toggle

`app/page.tsx` will update the prewarm/completeness status bar so it displays:

- left: existing status text such as `近7天已补齐`
- right: a compact segmented toggle with:
  - `相对时间`
  - `精确时间`

The toggle appears only when the status bar is rendered on the feed page.

### Card Time Rendering

`components/ActivityCard.tsx` will render time according to a `timeDisplayMode` prop:

- `relative`: existing compact relative labels such as `刚刚`, `1m`, `2h`
- `absolute`: exact local time formatted as `MM-DD HH:mm`

Only relative mode continues to schedule automatic time refreshes.
Absolute mode is static for a given timestamp.

## State Design

### Source of Truth

The feed page owns the selected time display mode.

Suggested shape:

```ts
type TimeDisplayMode = 'relative' | 'absolute';
```

The selected mode is:

- initialized from `localStorage` on the client
- defaulted to `'relative'` if no saved preference exists
- written back to `localStorage` whenever the user changes it

### Persistence Key

A dedicated storage key will be used, for example:

```ts
const FEED_TIME_DISPLAY_MODE_STORAGE_KEY = 'pilipili:feed-time-display-mode';
```

## Component Changes

### `components/TopNav.tsx`

- update layout to center the navigation links
- keep the existing `active` prop
- preserve optional `rightSlot` support for future use, but this feature will not use it

### `app/page.tsx`

- add local state for `timeDisplayMode`
- hydrate it from `localStorage` on the client
- persist changes back to `localStorage`
- render the segmented toggle inside the prewarm/completeness status bar
- pass `timeDisplayMode` to every `ActivityCard`

### `components/ActivityCard.tsx`

- accept `timeDisplayMode`
- use relative time state only in `relative` mode
- use absolute formatted time in `absolute` mode
- avoid unnecessary timers when exact time mode is selected

### `lib/timeFormat.ts`

- add a small formatter for exact time `MM-DD HH:mm`
- keep relative time helpers as the shared logic for compact labels

## Data Flow

1. Feed page mounts.
2. Client reads persisted display mode from `localStorage`.
3. Feed page renders the selected mode in the status-bar toggle.
4. Feed page passes the mode to each activity card.
5. Each card renders either relative or exact time.
6. When the user toggles the mode, the feed page updates state and persists the new value.

## Error Handling

- If `localStorage` is unavailable or throws, the page falls back to `'relative'`.
- Invalid persisted values are ignored and replaced with the default mode.
- The toggle must not block feed rendering if persistence fails.

## Testing Plan

### Unit / Script Tests

- add a test for exact time formatting in `lib/timeFormat.ts`
- add a test for persisted mode normalization if extracted into a helper
- keep existing relative time regression coverage

### Verification

- run the time-format test script
- run the existing feed-ordering test script to ensure the sorting behavior stays untouched
- run eslint on the touched files

### Manual Checks

- feed page loads with default `相对时间`
- switching to `精确时间` updates all visible cards
- refreshing the page preserves the selected mode
- exact time shows `MM-DD HH:mm`
- navigation remains centered on feed, manage, and system pages
- manage page top action buttons remain in page content, not in the nav

## Risks

- Centering nav links while preserving a flexible left brand and right slot can drift visually if the layout is not symmetric.
- Reading persistence too early can cause client hydration mismatch if not gated behind client-safe initialization.
- Relative-time timers must be disabled in exact mode to avoid unnecessary renders.

## Recommended Implementation Order

1. Add time-format helpers and tests.
2. Add feed-page persisted mode state.
3. Thread the mode through activity cards.
4. Update the feed status bar UI.
5. Refactor top navigation layout.
6. Run verification and do a quick manual visual pass.
