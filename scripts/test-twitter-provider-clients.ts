import assert from 'node:assert/strict';

import {
  createTwitter6551Client,
  parse6551TweetByIdResponse,
  parse6551UserLookupResponse,
  parse6551UserTweetsResponse,
} from '@/lib/server/twitter6551Client';
import {
  createTwitterXreadClient,
  parseXreadTweetDetailResponse,
  parseXreadUserIdResponse,
  parseXreadUserTweetsResponse,
} from '@/lib/server/twitterXreadClient';

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
  assert.equal(timelineBody.includeRetweets, false);
  assert.equal(timelineBody.maxResults, 100);
  assert.equal(timelineBody.product, 'Latest');
  assert.equal(timelineBody.cursor, 'cursor-1');
}

async function testXreadParsers() {
  const lookup = parseXreadUserIdResponse({
    data: {
      user_results: {
        rest_id: '44196397',
        result: {
          core: {
            name: 'Elon Musk',
            screen_name: 'elonmusk',
          },
          avatar: {
            image_url: 'https://pbs.twimg.com/profile_images/example.jpg',
          },
          profile_bio: {
            description: 'Mars and rockets',
          },
          verification: {
            is_blue_verified: true,
          },
        },
      },
    },
  });

  assert.equal(lookup.provider, 'xread');
  assert.equal(lookup.user.id, '44196397');
  assert.equal(lookup.user.handle, 'elonmusk');
  assert.equal(lookup.user.avatarUrl, 'https://pbs.twimg.com/profile_images/example.jpg');
  assert.equal(lookup.user.description, 'Mars and rockets');
  assert.equal(lookup.user.verified, true);

  const timeline = parseXreadUserTweetsResponse(
    {
      data: {
        user_result_by_rest_id: {
          rest_id: '44196397',
          result: {
            profile_timeline_v2: {
              timeline: {
                instructions: [
                  {
                    __typename: 'TimelineAddEntries',
                    entries: [
                      {
                        content: {
                          __typename: 'TimelineTimelineItem',
                          content: {
                            __typename: 'TimelineTweet',
                            tweet_results: {
                              rest_id: '2010705621524292007',
                              result: {
                                __typename: 'Tweet',
                                core: {
                                  user_results: {
                                    rest_id: '44196397',
                                    result: {
                                      core: {
                                        name: 'Elon Musk',
                                        screen_name: 'elonmusk',
                                      },
                                    },
                                  },
                                },
                                legacy: {
                                  full_text: '@another_user great point',
                                  created_at: 'Mon Jan 12 13:44:55 +0000 2026',
                                  retweet_count: 0,
                                  reply_count: 1,
                                  favorite_count: 4,
                                  conversation_id_str: '2010699000000000000',
                                  in_reply_to_status_id_str: '2010700000000000000',
                                  quoted_status_id_str: '2010600000000000000',
                                },
                              },
                            },
                          },
                        },
                      },
                      {
                        content: {
                          __typename: 'TimelineTimelineCursor',
                          cursor_type: 'Bottom',
                          value: 'next-1',
                        },
                      },
                      {
                        content: {
                          __typename: 'TimelineTimelineItem',
                          content: {
                            __typename: 'TimelineTweet',
                            tweet_results: {
                              rest_id: '2010705621524292008',
                              result: {
                                __typename: 'Tweet',
                                core: {
                                  user_results: {
                                    rest_id: '44196397',
                                    result: {
                                      core: {
                                        name: 'Elon Musk',
                                        screen_name: 'elonmusk',
                                      },
                                    },
                                  },
                                },
                                legacy: {
                                  full_text: 'Second tweet',
                                  created_at: '1768226755',
                                  retweet_count: 2,
                                  reply_count: 3,
                                  favorite_count: 40,
                                },
                              },
                            },
                          },
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    },
    { expectedHandle: 'elonmusk' }
  );

  assert.equal(timeline.provider, 'xread');
  assert.equal(timeline.userId, '44196397');
  assert.equal(timeline.hasMore, true);
  assert.equal(timeline.nextCursor, 'next-1');
  assert.equal(timeline.tweets.length, 2);
  assert.equal(timeline.tweets[0]?.replyToTweetId, '2010700000000000000');
  assert.equal(timeline.tweets[0]?.quoteTweetId, '2010600000000000000');
  assert.equal(timeline.tweets[1]?.createdAtMs, 1_768_226_755_000);
  assert.equal(timeline.tweets[1]?.likeCount, 40);

  const repliesTimeline = parseXreadUserTweetsResponse(
    {
      data: {
        user_result_by_rest_id: {
          rest_id: '44196397',
          result: {
            profile_with_replies_timeline_v2: {
              timeline: {
                instructions: [
                  {
                    __typename: 'TimelineAddEntries',
                    entries: [
                      {
                        content: {
                          __typename: 'TimelineTimelineModule',
                          items: [
                            {
                              item: {
                                content: {
                                  __typename: 'TimelineTweet',
                                  tweet_results: {
                                    rest_id: '2010705621524292009',
                                    result: {
                                      __typename: 'Tweet',
                                      core: {
                                        user_results: {
                                          rest_id: '44196397',
                                          result: {
                                            core: {
                                              name: 'Elon Musk',
                                              screen_name: 'elonmusk',
                                            },
                                          },
                                        },
                                      },
                                      legacy: {
                                        full_text: '@another_user reply from alternate timeline',
                                        created_at: 'Mon Jan 12 14:44:55 +0000 2026',
                                        in_reply_to_status_id_str: '2010700000000000000',
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          ],
                        },
                      },
                      {
                        content: {
                          __typename: 'TimelineTimelineCursor',
                          cursor_type: 'Bottom',
                          value: 'next-replies',
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    },
    { expectedHandle: 'elonmusk' }
  );

  assert.equal(repliesTimeline.nextCursor, 'next-replies');
  assert.equal(repliesTimeline.tweets.length, 1);
  assert.equal(repliesTimeline.tweets[0]?.tweetId, '2010705621524292009');
  assert.equal(repliesTimeline.tweets[0]?.replyToTweetId, '2010700000000000000');

  const noteTweet = parseXreadTweetDetailResponse({
    data: {
      tweet_result: {
        result: {
          __typename: 'Tweet',
          rest_id: '2010705621524292010',
          core: {
            user_result: {
              result: {
                rest_id: '44196397',
                legacy: {
                  name: 'Elon Musk',
                  screen_name: 'elonmusk',
                },
              },
            },
          },
          legacy: {
            full_text: '@tesla short text only',
            created_at: 'Mon Jan 12 15:44:55 +0000 2026',
            in_reply_to_status_id_str: '2010700000000000000',
          },
          note_tweet: {
            is_expandable: true,
            note_tweet_results: {
              result: {
                __typename: 'NoteTweet',
                text: 'long note tweet text\n\nwith the complete second paragraph',
              },
            },
          },
        },
      },
    },
  });

  assert.equal(noteTweet.tweet?.fullText, 'long note tweet text\n\nwith the complete second paragraph');

  const detail = parseXreadTweetDetailResponse({
    data: {
      tweet_result: {
        result: {
          __typename: 'Tweet',
          core: {
            user_result: {
              result: {
                rest_id: '44196397',
                legacy: {
                  name: 'Elon Musk',
                  screen_name: 'elonmusk',
                  profile_image_url_https: 'https://pbs.twimg.com/profile_images/example.jpg',
                },
              },
            },
          },
          legacy: {
            full_text: '@Gaurab Yes, it is extremely difficult',
            created_at: 'Thu Feb 05 04:18:34 +0000 2026',
            retweet_count: 136,
            reply_count: 396,
            favorite_count: 3676,
            conversation_id_str: '2019199325365227607',
            in_reply_to_status_id_str: '2019199325365227607',
          },
          rest_id: '2019264360682778716',
        },
      },
    },
  });

  assert.equal(detail.provider, 'xread');
  assert.equal(detail.tweet?.tweetId, '2019264360682778716');
  assert.equal(detail.tweet?.replyToTweetId, '2019199325365227607');
}

async function testXreadClient() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.includes('/UserResultByScreenName?')) {
      return new Response(
        JSON.stringify({
          data: {
            user_results: {
              rest_id: '44196397',
              result: {
                core: {
                  name: 'Elon Musk',
                  screen_name: 'elonmusk',
                },
              },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (url.includes('/UserTweetsReplies?')) {
      return new Response(
        JSON.stringify({
          data: {
            user_result_by_rest_id: {
              rest_id: '44196397',
              result: {
                profile_timeline_v2: {
                  timeline: {
                    instructions: [
                      {
                        __typename: 'TimelineAddEntries',
                        entries: [
                          {
                            content: {
                              __typename: 'TimelineTimelineItem',
                              content: {
                                __typename: 'TimelineTweet',
                                tweet_results: {
                                  rest_id: '2019264360682778716',
                                  result: {
                                    __typename: 'Tweet',
                                    core: {
                                      user_results: {
                                        rest_id: '44196397',
                                        result: {
                                          core: {
                                            name: 'Elon Musk',
                                            screen_name: 'elonmusk',
                                          },
                                        },
                                      },
                                    },
                                    legacy: {
                                      full_text: 'Timeline tweet',
                                      created_at: 'Thu Feb 05 04:18:34 +0000 2026',
                                    },
                                  },
                                },
                              },
                            },
                          },
                          {
                            content: {
                              __typename: 'TimelineTimelineCursor',
                              cursor_type: 'Bottom',
                              value: 'cursor-b',
                            },
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (url.includes('/TweetDetail?')) {
      return new Response(
        JSON.stringify({
          data: {
            tweet_result: {
              result: {
                rest_id: '2019264360682778716',
                core: {
                  user_result: {
                    result: {
                      rest_id: '44196397',
                      legacy: {
                        name: 'Elon Musk',
                        screen_name: 'elonmusk',
                      },
                    },
                  },
                },
                legacy: {
                  full_text: 'Detail tweet',
                  created_at: 'Thu Feb 05 04:18:34 +0000 2026',
                },
              },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 });
  };

  const client = createTwitterXreadClient(fetchImpl);

  const lookup = await client.lookupUser({
    apiKey: 'xread-key',
    username: '@ElonMusk',
  });
  assert.equal(lookup.user.handle, 'elonmusk');

  const timeline = await client.fetchUserTweets({
    apiKey: 'xread-key',
    username: 'elonmusk',
    userId: '44196397',
    lane: 'replies',
    cursor: 'cursor-a',
  });
  assert.equal(timeline.tweets.length, 1);

  const detail = await client.fetchTweetById({
    apiKey: 'xread-key',
    tweetId: '2019264360682778716',
  });
  assert.equal(detail.tweet?.tweetId, '2019264360682778716');

  assert.equal(calls.length, 3);
  assert.match(calls[0]?.url || '', /UserResultByScreenName/);
  assert.match(calls[0]?.url || '', /username=elonmusk/);
  assert.match(calls[0]?.url || '', /api_key=xread-key/);
  assert.match(calls[1]?.url || '', /UserTweetsReplies/);
  assert.match(calls[1]?.url || '', /user_id=44196397/);
  assert.match(calls[1]?.url || '', /cursor=cursor-a/);
  assert.equal((calls[0]?.init?.headers as Record<string, string> | undefined)?.Authorization, undefined);
}

async function main() {
  await test6551Parsers();
  await test6551Client();
  await testXreadParsers();
  await testXreadClient();

  console.log('twitter provider client tests: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
