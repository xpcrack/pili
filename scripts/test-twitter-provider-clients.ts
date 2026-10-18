import assert from 'node:assert/strict';

import {
  createTwitter6551Client,
  parse6551TweetByIdResponse,
  parse6551UserLookupResponse,
  parse6551UserTweetsResponse,
} from '@/lib/server/twitter6551Client';

async function test6551Parsers() {
  const lookup = parse6551UserLookupResponse({
    userId: '44196397',
    screenName: 'elonmusk',
    name: 'Elon Musk',
    description: 'Mars and rockets',
    verified: true,
  });

  assert.equal(lookup.provider, '6551');
  assert.equal(lookup.user.id, '44196397');
  assert.equal(lookup.user.handle, 'elonmusk');
  assert.equal(lookup.user.name, 'Elon Musk');

  const timeline = parse6551UserTweetsResponse(
    {
      tweets: [
        {
          id: '1900000000000000001',
          text: 'Launching soon',
          createdAt: '2026-04-23T12:00:00Z',
          retweetCount: 12,
          favoriteCount: 99,
          replyCount: 4,
          userScreenName: 'elonmusk',
          userId: '44196397',
          userName: 'Elon Musk',
        },
        {
          id: '1900000000000000002',
          text: '@tesla yes',
          createdAt: 1_777_172_100,
          replyCount: 1,
          retweetCount: 2,
          favoriteCount: 10,
          conversationId: '1900000000000000000',
          inReplyToStatusId: '1899999999999999999',
          userScreenName: 'elonmusk',
          userId: '44196397',
          userName: 'Elon Musk',
        },
      ],
      nextCursor: 'cursor-1',
    },
    { expectedHandle: 'elonmusk' }
  );

  assert.equal(timeline.provider, '6551');
  assert.equal(timeline.handle, 'elonmusk');
  assert.equal(timeline.hasMore, true);
  assert.equal(timeline.nextCursor, 'cursor-1');
  assert.equal(timeline.tweets.length, 2);
  assert.equal(timeline.tweets[0]?.tweetId, '1900000000000000001');
  assert.equal(timeline.tweets[0]?.likeCount, 99);
  assert.equal(timeline.tweets[1]?.createdAtMs, 1_777_172_100_000);
  assert.equal(timeline.tweets[1]?.replyToTweetId, '1899999999999999999');
  assert.equal(timeline.tweets[1]?.conversationId, '1900000000000000000');

  const detail = parse6551TweetByIdResponse({
    data: {
      id: '1900000000000000003',
      text: 'Quoting this',
      createdAt: '2026-04-23T12:06:00Z',
      retweetCount: 3,
      favoriteCount: 5,
      replyCount: 1,
      quotedStatusId: '1800000000000000000',
      userScreenName: 'elonmusk',
      userId: '44196397',
      userName: 'Elon Musk',
    },
  });

  assert.equal(detail.provider, '6551');
  assert.equal(detail.tweet?.tweetId, '1900000000000000003');
  assert.equal(detail.tweet?.quoteTweetId, '1800000000000000000');
}

async function test6551Client() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith('/open/twitter_user_info')) {
      return new Response(
        JSON.stringify({
          data: {
            userId: '44196397',
            screenName: 'elonmusk',
            name: 'Elon Musk',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (url.endsWith('/open/twitter_user_tweets')) {
      return new Response(
        JSON.stringify({
          tweets: [
            {
              id: '1900000000000000010',
              text: 'Hello world',
              createdAt: '2026-04-23T12:00:00Z',
              userScreenName: 'elonmusk',
              userId: '44196397',
              userName: 'Elon Musk',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (url.endsWith('/open/twitter_tweet_detail')) {
      return new Response(
        JSON.stringify({
          id: '1900000000000000011',
          text: 'A single tweet',
          createdAt: '2026-04-23T12:00:00Z',
          userScreenName: 'elonmusk',
          userId: '44196397',
          userName: 'Elon Musk',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 });
  };

  const client = createTwitter6551Client(fetchImpl);

  const lookup = await client.lookupUser({
    apiKey: 'test-key',
    username: '@ElonMusk',
  });
  assert.equal(lookup.user.handle, 'elonmusk');

  const tweets = await client.fetchUserTweets({
    apiKey: 'test-key',
    username: 'elonmusk',
    lane: 'replies',
    maxResults: 15,
    cursor: 'cursor-1',
  });
  assert.equal(tweets.tweets.length, 1);

  const detail = await client.fetchTweetById({
    apiKey: 'test-key',
    tweetId: '1900000000000000011',
  });
  assert.equal(detail.tweet?.tweetId, '1900000000000000011');

  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.match(String(calls[0]?.init?.headers && (calls[0]?.init?.headers as Record<string, string>).Authorization), /Bearer test-key/);
  assert.match(String(calls[2]?.url), /twitter_tweet_detail$/);

  const timelineBody = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
  assert.equal(timelineBody.includeReplies, true);
  assert.equal(timelineBody.includeRetweets, true);
  assert.equal(timelineBody.maxResults, 100);
  assert.equal(timelineBody.product, 'Latest');
  assert.equal(timelineBody.cursor, 'cursor-1');
}

async function main() {
  await test6551Parsers();
  await test6551Client();

  console.log('twitter provider client tests: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
