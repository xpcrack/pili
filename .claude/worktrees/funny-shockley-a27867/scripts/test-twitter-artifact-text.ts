import assert from 'node:assert/strict';

import { isLikelyTwitterArtifactText } from '@/lib/twitterArtifactText';

function main() {
  assert.equal(isLikelyTwitterArtifactText('[20] /analytics'), true, 'analytics navigation should be rejected');
  assert.equal(isLikelyTwitterArtifactText('[79]'), true, 'bare dokobot counters should be rejected');
  assert.equal(isLikelyTwitterArtifactText('帖子'), true, 'localized navigation labels should be rejected');
  assert.equal(
    isLikelyTwitterArtifactText('在meme币游戏中，人们在大金狗起飞前丢掉筹码'),
    false,
    'real tweet text should remain'
  );

  console.log('twitter artifact text tests: ok');
}

main();
