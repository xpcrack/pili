# Feed Chain Color Rail Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add a 4px left-edge color rail to every Feed card, using chain colors for blockchain activity and Twitter blue for social activity.

**Architecture:** Keep the existing ActivityCard layout and data flow unchanged. Add one pure source-to-color resolver beside the existing card/social presentation helpers, then render one absolutely positioned rail in each of the four existing card branches. Use the current script-based test runner for resolver coverage and static markup coverage.

**Tech Stack:** React 19, TypeScript, Tailwind utility classes, react-dom/server, Node assert/strict, tsx test runner, Vite/Bun build.

---

## File map

- Modify: lib/activityCardSocial.ts — own the feed-source color constants and pure resolver.
- Modify: components/ActivityCard.tsx — render the shared rail in trade, transfer, social, and fallback card branches.
- Modify: scripts/test-activity-card-social.ts — test every color mapping and fallback behavior.
- Modify: scripts/test-activity-card-render.tsx — verify the rail is present in representative rendered card branches and has the expected inline color.
- Do not modify API routes, database code, types/index.ts, Feed sorting/filtering, or PM2 worker configuration.

### Task 1: Write failing resolver and render tests

Files:
- Modify: scripts/test-activity-card-social.ts
- Modify: scripts/test-activity-card-render.tsx

- [ ] Step 1: Add a test seam and the resolver expectations.

In scripts/test-activity-card-social.ts, keep the existing named imports and add a namespace import plus the Activity type:

    import * as activityCardSocial from '@/lib/activityCardSocial';
    import type { Activity } from '@/types';

Before run(), add this helper so the first run fails with an assertion rather than a module/type error while the new export is not present:

    type FeedSourceColorResolver = (activity: Pick<Activity, 'source' | 'metadata'>) => string;

    function getFeedSourceColorForTest() {
      const candidate = (activityCardSocial as Record<string, unknown>).getFeedSourceColor;
      assert.equal(typeof candidate, 'function', 'getFeedSourceColor should be exported');
      return candidate as FeedSourceColorResolver;
    }

At the start of run(), add these assertions:

    const getFeedSourceColor = getFeedSourceColorForTest();
    const makeActivity = (
      source: Activity['source'],
      chain?: string
    ): Pick<Activity, 'source' | 'metadata'> => ({
      source,
      metadata: chain ? { chain } : {},
    });

    assert.equal(getFeedSourceColor(makeActivity('blockchain', 'solana')), '#9945FF');
    assert.equal(getFeedSourceColor(makeActivity('blockchain', 'ethereum')), '#627EEA');
    assert.equal(getFeedSourceColor(makeActivity('blockchain', 'bsc')), '#F3BA2F');
    assert.equal(getFeedSourceColor(makeActivity('blockchain', 'base')), '#0052FF');
    assert.equal(getFeedSourceColor(makeActivity('blockchain', 'robinhood')), '#CCFF00');
    assert.equal(getFeedSourceColor(makeActivity('blockchain', 'SOL')), '#9945FF');
    assert.equal(getFeedSourceColor(makeActivity('twitter')), '#1D9BF0');
    assert.equal(getFeedSourceColor(makeActivity('telegram')), '#1D9BF0');
    assert.equal(getFeedSourceColor(makeActivity('blockchain', 'unknown')), '#71717A');
    assert.equal(getFeedSourceColor(makeActivity('blockchain')), '#71717A');

In scripts/test-activity-card-render.tsx, add this helper before run():

    function assertFeedSourceRail(markup: string, color: string, label: string) {
      assert.match(markup, /data-feed-source-rail/, label + ' should render a source rail');
      assert.match(
        markup,
        new RegExp('background-color:' + color),
        label + ' should render the ' + color + ' source rail'
      );
    }

After the first Twitter markup assertions, add:

    assertFeedSourceRail(markup, '#1D9BF0', 'twitter cards');

After the existing transfer assertions, add:

    assertFeedSourceRail(transferMarkup, '#9945FF', 'solana transfer cards');

- [ ] Step 2: Run the focused tests and verify the expected RED state.

Run:

    npm test -- --filter=activity-card-social --bail

Expected: FAIL at the new getFeedSourceColor should be exported assertion because the production resolver does not exist yet.

Run:

    npm test -- --filter=activity-card-render --bail

Expected: FAIL because existing Feed markup has no data-feed-source-rail element yet.

### Task 2: Implement and verify the pure color resolver

Files:
- Modify: lib/activityCardSocial.ts

- [ ] Step 1: Add the centralized color table and resolver.

Append this implementation to lib/activityCardSocial.ts:

    const FEED_SOURCE_DEFAULT_COLOR = '#71717A';
    const FEED_SOCIAL_COLOR = '#1D9BF0';
    const FEED_CHAIN_COLORS: Record<string, string> = {
      solana: '#9945FF',
      ethereum: '#627EEA',
      bsc: '#F3BA2F',
      base: '#0052FF',
      robinhood: '#CCFF00',
    };

    const FEED_CHAIN_ALIASES: Record<string, string> = {
      sol: 'solana',
      eth: 'ethereum',
      rh: 'robinhood',
    };

    export function getFeedSourceColor(activity: Pick<Activity, 'source' | 'metadata'>) {
      if (activity.source !== 'blockchain') {
        return FEED_SOCIAL_COLOR;
      }

      const normalizedChain = (activity.metadata.chain || '').trim().toLowerCase();
      const canonicalChain = FEED_CHAIN_ALIASES[normalizedChain] || normalizedChain;
      return FEED_CHAIN_COLORS[canonicalChain] || FEED_SOURCE_DEFAULT_COLOR;
    }

This keeps social behavior independent of metadata.chain, supports the common SOL/ETH/RH aliases, and returns gray for all unknown blockchain values.

- [ ] Step 2: Run the resolver test and verify GREEN.

Run:

    npm test -- --filter=activity-card-social --bail

Expected: PASS with activity card social tests: ok.

### Task 3: Render the rail in every ActivityCard branch

Files:
- Modify: components/ActivityCard.tsx

- [ ] Step 1: Import the resolver and define the shared rail element.

Add getFeedSourceColor to the existing import from @/lib/activityCardSocial:

    getFeedSourceColor,

Before ActivityCard, add this component:

    function FeedSourceRail({ color }: { color: string }) {
      return (
        <span
          aria-hidden='true'
          data-feed-source-rail
          className='pointer-events-none absolute inset-y-0 left-0 z-10 w-1'
          style={{ backgroundColor: color }}
        />
      );
    }

- [ ] Step 2: Resolve the color once per card.

Immediately after the component props are destructured, add:

    const feedSourceColor = getFeedSourceColor(activity);

- [ ] Step 3: Insert the same rail into all four existing card returns.

Each Card already has a className containing relative. Immediately inside each Card opening tag, before CardContent, add:

    <FeedSourceRail color={feedSourceColor} />

Apply this to exactly these branches:
1. isTransfer && isTradeAction trade row.
2. isTransfer && isSendReceiveTransfer transfer row.
3. isTwitter || isTelegram social row.
4. The final fallback row.

Do not add a grid column, padding, event handler, tooltip, or new card wrapper; the absolutely positioned rail must leave existing layout widths and interactions unchanged.

- [ ] Step 4: Run the static render test.

Run:

    npm test -- --filter=activity-card-render --bail

Expected: PASS with activity card render tests: ok, including the Twitter and Solana rail assertions.

### Task 4: Add branch coverage and perform focused cleanup

Files:
- Modify: scripts/test-activity-card-render.tsx
- Modify: components/ActivityCard.tsx only if the focused test exposes a branch omission.

- [ ] Step 1: Add representative render checks for Telegram and Robinhood.

Extend the existing render test with these activities:

    const telegramRailMarkup = renderToStaticMarkup(
      <ActivityCard
        activity={{
          id: 'telegram:rail-test',
          userId: 'user-1',
          source: 'telegram',
          type: 'post',
          title: 'TG',
          content: 'rail test',
          timestamp: 1_777_912_752_444,
          metadata: { telegramPostUrl: 'https://t.me/channel/rail-test' },
        }}
        user={makeUser()}
      />
    );
    assertFeedSourceRail(telegramRailMarkup, '#1D9BF0', 'telegram cards');

    const robinhoodMarkup = renderToStaticMarkup(
      <ActivityCard
        activity={{
          id: 'robinhood:rail-test',
          userId: 'user-1',
          source: 'blockchain',
          type: 'swap',
          title: 'swap',
          content: 'rail test',
          timestamp: 1_777_912_752_555,
          metadata: { chain: 'robinhood' },
        }}
        user={makeUser()}
      />
    );
    assertFeedSourceRail(robinhoodMarkup, '#CCFF00', 'robinhood cards');

The existing Twitter fixture covers the social branch and the existing Solana transfer fixture covers the transfer branch. The pure resolver test covers all chain mappings and aliases.

- [ ] Step 2: Run the focused tests together.

Run:

    npm test -- --filter=activity-card --bail

Expected: both test-activity-card-render and test-activity-card-social pass with FAIL: 0.

- [ ] Step 3: Review the diff for scope and formatting.

Run:

    git diff --check
    git diff -- lib/activityCardSocial.ts components/ActivityCard.tsx scripts/test-activity-card-social.ts scripts/test-activity-card-render.tsx

Expected: no whitespace errors; only the resolver, rail markup, and their tests are changed.

- [ ] Step 4: Commit the feature implementation.

Run:

    git add lib/activityCardSocial.ts components/ActivityCard.tsx scripts/test-activity-card-social.ts scripts/test-activity-card-render.tsx
    git commit -m 'feat: add feed source color rails'

### Task 5: Full verification and production refresh

Files:
- No additional source changes expected.

- [ ] Step 1: Verify the required Node runtime.

Run:

    node --version

Expected: v24.11.1 (or another Node 24.x version explicitly installed for this repo; do not use Node 25+).

- [ ] Step 2: Run the full test suite and lint.

Run:

    npm test
    npm run lint

Expected: both commands exit with code 0 and report no failed tests or lint errors.

- [ ] Step 3: Build the client before replacing the production process.

Run:

    npm run build

Expected: Vite build exits with code 0.

- [ ] Step 4: Inspect production runtime and refresh only the web process.

Run:

    npm run runtime:status
    npm run runtime:refresh
    npm run runtime:status

Expected: pili-web-prod is the refreshed production web/API process; workers are not restarted. The refresh is performed only after the build succeeds and uses the existing .env.local, .data, and SQLite database.

- [ ] Step 5: Verify the final worktree state.

Run:

    git status --short

Expected: no unexpected generated source changes; the committed feature and design/spec documents remain the only task changes.
