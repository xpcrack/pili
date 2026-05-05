import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import { computeCompletenessGlobalStatus, computeGlobalProvenStartMs } from '@/lib/server/completenessStatus';

function run() {
  assert.equal(computeGlobalProvenStartMs([]), null);

  assert.equal(
    computeGlobalProvenStartMs([
      { provenStartMs: 1713000000000 },
      { provenStartMs: 1712500000000 },
      { provenStartMs: 1712800000000 },
    ]),
    1713000000000
  );

  assert.equal(
    computeGlobalProvenStartMs([
      { provenStartMs: 1713000000000 },
      { provenStartMs: null },
    ]),
    null
  );

  assert.equal(
    computeCompletenessGlobalStatus({
      configuredStartMs: 1712000000000,
      sources: [
        { status: 'partial', provenStartMs: 1711900000000 },
        { status: 'blocked', provenStartMs: null },
      ],
    }),
    'blocked'
  );

  assert.equal(
    computeCompletenessGlobalStatus({
      configuredStartMs: 1712000000000,
      sources: [{ status: 'running', provenStartMs: null }],
    }),
    'retrying'
  );

  assert.equal(
    computeCompletenessGlobalStatus({
      configuredStartMs: 1712000000000,
      sources: [
        { status: 'retrying', provenStartMs: null },
        { status: 'partial', provenStartMs: 1711900000000 },
      ],
    }),
    'retrying'
  );

  assert.equal(
    computeCompletenessGlobalStatus({
      configuredStartMs: 1712000000000,
      sources: [
        { status: 'partial', provenStartMs: 1711900000000 },
        { status: 'complete', provenStartMs: 1711500000000 },
      ],
    }),
    'complete'
  );

  assert.equal(
    computeCompletenessGlobalStatus({
      configuredStartMs: null,
      sources: [{ status: 'complete', provenStartMs: 1711500000000 }],
    }),
    'partial'
  );

  assert.equal(
    computeCompletenessGlobalStatus({
      configuredStartMs: 1712000000000,
      sources: [],
    }),
    'partial'
  );

  console.log('completeness status tests: ok');
}

run();
