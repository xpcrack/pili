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

function makeXxyyUpdate(text: string) {
  return makeTwitterUpdate({
    text,
  });
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

async function testParserXxyyTweetFormat() {
  const update = makeXxyyUpdate(
    [
      '[Cooker.hl | Kms.eth | 版本之子 | Cooker] 发推',
      '📝 推文:',
      "it's not even the same pic 😭😭",
      '🔗 https://twitter.com/CookerFlips/status/2050077692759089323',
    ].join('\n')
  );
  const payload = parseTwitterRelayPayload(update.message!);

  assert.ok(payload, 'xxyy tweet: payload should parse');
  assert.equal(payload?.authorHandle, 'cookerflips');
  assert.equal(payload?.tweetId, '2050077692759089323');
  assert.equal(payload?.content, "it's not even the same pic 😭😭");
  assert.equal(payload?.action, 'tweet');
  console.log('PASS twitter-bridge parser xxyy-tweet');
}

async function testParserXxyyMultilineTweetFormat() {
  const content = [
    '这波美股上涨真给了我一点小小的震撼，看了一下之前在TradeXYZ的仓位，如果多拿半个月，到现在利润能多接近$2M。',
    '',
    '这个钱包最开始是为了交互TradeXYZ，大概从去年11月开始，因为听说美股主打一个长牛，所以选择了持有NDX100。',
    '',
    '芒格说过“鱼在哪里，就到哪里钓鱼”，选择大于努力。',
  ].join('\n');
  const update = makeXxyyUpdate(
    [
      '[0xSun] 发推',
      '📝 推文:',
      content,
      '🔗 https://twitter.com/0xSunNFT/status/2050092859215470952',
    ].join('\n')
  );
  const payload = parseTwitterRelayPayload(update.message!);

  assert.ok(payload, 'xxyy multiline tweet: payload should parse');
  assert.equal(payload?.authorHandle, '0xsunnft');
  assert.equal(payload?.tweetId, '2050092859215470952');
  assert.equal(payload?.content, content);
  assert.equal(payload?.action, 'tweet');
  console.log('PASS twitter-bridge parser xxyy-multiline-tweet');
}

async function testParserXxyyReplyFormat() {
  const update = makeXxyyUpdate(
    [
      '[gake] 回复了 @JazzyBearMiner',
      '📝 推文:',
      'Sell',
      '👤 原推作者: @JazzyBearMiner',
      '🔗 https://twitter.com/Ga__ke/status/2050081850602017189',
    ].join('\n')
  );
  const payload = parseTwitterRelayPayload(update.message!);

  assert.ok(payload, 'xxyy reply: payload should parse');
  assert.equal(payload?.authorHandle, 'ga__ke');
  assert.equal(payload?.tweetId, '2050081850602017189');
  assert.equal(payload?.content, 'Sell');
  assert.equal(payload?.action, 'reply');
  console.log('PASS twitter-bridge parser xxyy-reply');
}

async function testParserXxyyQuotePrefersStructuredStatusUrl() {
  const update = makeXxyyUpdate(
    [
      '[LEFF] 引用推文',
      '📝 推文:',
      'structured link should win',
      '👤 原推作者: @other_user',
      '📝 原推:',
      'original text includes https://twitter.com/other_user/status/1111111111111111111 before metadata',
      '🔗 https://twitter.com/0xleff/status/2050081648151298115',
    ].join('\n')
  );
  const payload = parseTwitterRelayPayload(update.message!);

  assert.ok(payload, 'xxyy quote structured url: payload should parse');
  assert.equal(payload?.authorHandle, '0xleff');
  assert.equal(payload?.tweetId, '2050081648151298115');
  assert.equal(payload?.content, 'structured link should win');
  assert.equal(payload?.action, 'quote');
  console.log('PASS twitter-bridge parser xxyy-structured-url');
}

async function testParserXxyyQuoteFormat() {
  const update = makeXxyyUpdate(
    [
      '[LEFF] 引用推文',
      '📝 推文:',
      '$uASTER ATH，这个板块的东西看起来要🔥',
      '👤 原推作者: @0xleff',
      '📝 原推:',
      '$uPEG 和 ethereum:0xf280b16ef293d8e534e370794ef26bf312694126  都在涨',
      '买了点这个 $uASTER ，UNIv4新赛道，还带着太空狗的概念',
      '🔗 https://twitter.com/0xleff/status/2050081648151298115',
    ].join('\n')
  );
  const payload = parseTwitterRelayPayload(update.message!);

  assert.ok(payload, 'xxyy quote: payload should parse');
  assert.equal(payload?.authorHandle, '0xleff');
  assert.equal(payload?.tweetId, '2050081648151298115');
  assert.equal(payload?.content, '$uASTER ATH，这个板块的东西看起来要🔥');
  assert.equal(payload?.action, 'quote');
  console.log('PASS twitter-bridge parser xxyy-quote');
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
  await testParserXxyyTweetFormat();
  await testParserXxyyMultilineTweetFormat();
  await testParserXxyyReplyFormat();
  await testParserXxyyQuotePrefersStructuredStatusUrl();
  await testParserXxyyQuoteFormat();
  await testParserMissingTweetUrl();
  await testRoutingBehavior();

  console.log('\n✅ Twitter bridge tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
