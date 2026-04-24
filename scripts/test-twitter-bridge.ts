import assert from 'node:assert/strict';

import {
  handleBridgeUpdate,
  looksLikeTwitterRelayMessage,
  parseTwitterRelayPayload,
  type TelegramUpdateLike,
} from './telegram-bridge-core';

function makeTwitterUpdate(params?: {
  text?: string;
  entities?: Array<{ type?: string; url?: string; offset?: number; length?: number }>;
  inlineUrls?: string[];
}) {
  const text =
    params?.text ||
    [
      '✨监控到新推文',
      '你关注的用户: JAMES(备注:JAMES)',
      '用户所属分组: 线程,实盘',
      '推文内容: GM',
    ].join('\n');

  return {
    update_id: 1,
    message: {
      message_id: 9,
      date: 1_713_600_000,
      from: {
        id: 10,
        is_bot: true,
        username: 'bridge_bot',
      },
      chat: {
        id: '-5299035575',
      },
      text,
      entities: params?.entities,
      reply_markup: params?.inlineUrls
        ? {
            inline_keyboard: params.inlineUrls.map((url) => [{ text: 'View Details', url }]),
          }
        : undefined,
    },
  } satisfies TelegramUpdateLike;
}

async function testParserHappyPath() {
  const update = makeTwitterUpdate({
    inlineUrls: ['https://x.com/corleonefnf/status/1912345678901234567'],
  });
  const payload = parseTwitterRelayPayload(update.message!);

  assert.equal(looksLikeTwitterRelayMessage(update.message!), true, 'should detect twitter relay message');
  assert.ok(payload, 'happy path: payload should parse');
  assert.equal(payload?.authorHandle, 'corleonefnf');
  assert.equal(payload?.tweetId, '1912345678901234567');
  assert.equal(payload?.content, 'GM');
  assert.equal(payload?.action, 'tweet');
  console.log('PASS twitter-bridge parser happy-path');
}

async function testParserRtAndReply() {
  const rtUpdate = makeTwitterUpdate({
    text: [
      '✨监控到新推文',
      '你关注的用户: Ga__ke(备注:Ga__ke)',
      '用户所属分组: 实盘',
      '推文内容: RT @Ga__ke: I mean chain agnosia is the way to go',
    ].join('\n'),
    inlineUrls: ['https://x.com/Ga__ke/status/1912345678901234000'],
  });
  const rtPayload = parseTwitterRelayPayload(rtUpdate.message!);
  assert.equal(rtPayload?.action, 'quote', 'RT content should map to quote');

  const replyUpdate = makeTwitterUpdate({
    text: [
      '✨监控到新推文',
      '你关注的用户: replyguy(备注:replyguy)',
      '用户所属分组: 实盘',
      '推文内容: @alice absolutely agree',
    ].join('\n'),
    inlineUrls: ['https://x.com/replyguy/status/1912345678901234001'],
  });
  const replyPayload = parseTwitterRelayPayload(replyUpdate.message!);
  assert.equal(replyPayload?.action, 'reply', 'reply-like content should map to reply');
  console.log('PASS twitter-bridge parser rt-reply');
}

async function testParserMissingTweetUrl() {
  const text = [
    '✨监控到新推文',
    '你关注的用户: JAMES',
    '用户所属分组: 线程,实盘',
    '推文内容: GM',
  ].join('\n');
  const entityUrl = 'https://x.com/corleonefnf';
  const update = makeTwitterUpdate({
    text,
    entities: [
      {
        type: 'text_link',
        url: entityUrl,
        offset: text.indexOf('JAMES'),
        length: 'JAMES'.length,
      },
    ],
  });

  assert.equal(looksLikeTwitterRelayMessage(update.message!), true, 'profile-only message should still look like twitter relay');
  assert.equal(parseTwitterRelayPayload(update.message!), null, 'profile-only message should not parse without tweet ref');
  console.log('PASS twitter-bridge parser missing-tweet-url');
}

async function testRoutingBehavior() {
  const twitterUpdate = makeTwitterUpdate({
    inlineUrls: ['https://x.com/corleonefnf/status/1912345678901234567'],
  });
  const plainMonitorUpdate = {
    update_id: 2,
    message: {
      message_id: 11,
      date: 1_713_600_010,
      from: {
        id: 11,
        is_bot: true,
        username: 'monitor_bot',
      },
      chat: {
        id: '-5108676923',
      },
      text: '[纯鱼#1]\nCA: 0xabc\naction: buy',
    },
  } satisfies TelegramUpdateLike;
  const malformedTwitterUpdate = makeTwitterUpdate({
    text: [
      '✨监控到新推文',
      '你关注的用户: JAMES',
      '用户所属分组: 线程,实盘',
      '推文内容: GM',
    ].join('\n'),
  });

  let forwardedMonitorCount = 0;
  let forwardedRelayCount = 0;

  const twitterResult = await handleBridgeUpdate(twitterUpdate, {
    forwardTelegramMonitor: async () => {
      forwardedMonitorCount += 1;
    },
    forwardTwitterRelay: async () => {
      forwardedRelayCount += 1;
    },
  });
  assert.equal(twitterResult.kind, 'twitter-relay-forwarded');
  assert.equal(forwardedMonitorCount, 0);
  assert.equal(forwardedRelayCount, 1);

  const monitorResult = await handleBridgeUpdate(plainMonitorUpdate, {
    forwardTelegramMonitor: async () => {
      forwardedMonitorCount += 1;
    },
    forwardTwitterRelay: async () => {
      forwardedRelayCount += 1;
    },
  });
  assert.equal(monitorResult.kind, 'telegram-monitor-forwarded');
  assert.equal(forwardedMonitorCount, 1);
  assert.equal(forwardedRelayCount, 1);

  const malformedTwitterResult = await handleBridgeUpdate(malformedTwitterUpdate, {
    forwardTelegramMonitor: async () => {
      forwardedMonitorCount += 1;
    },
    forwardTwitterRelay: async () => {
      forwardedRelayCount += 1;
    },
  });
  assert.equal(malformedTwitterResult.kind, 'twitter-relay-parse-failed');
  assert.equal(forwardedMonitorCount, 1, 'malformed twitter message should not fall through to monitor endpoint');
  assert.equal(forwardedRelayCount, 1, 'malformed twitter message should not call relay endpoint');
  console.log('PASS twitter-bridge routing');
}

async function main() {
  await testParserHappyPath();
  await testParserRtAndReply();
  await testParserMissingTweetUrl();
  await testRoutingBehavior();

  console.log('\n✅ Twitter bridge tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
