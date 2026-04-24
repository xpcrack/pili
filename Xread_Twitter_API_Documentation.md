# Twitter API 接口文档

> **地址**: `http://65.109.123.54/consumer`
> **API Key**: `YOUR_XREAD_API_KEY`
> **调用方式**: `GET {base}/{endpoint}?api_key={key}&参数...`

---

## 目录

- [Twitter API 接口文档](#twitter-api-接口文档)
  - [目录](#目录)
  - [Explore](#explore)
    - [1. FriendshipsShow](#1-friendshipsshow)
    - [2. Trends](#2-trends)
    - [3. Search](#3-search)
    - [4. AutoComplete](#4-autocomplete)
  - [User](#user)
    - [5. UsernameToUserId](#5-usernametouserid)
    - [6. UserResultByScreenName](#6-userresultbyscreenname)
    - [7. UserResultByRestId](#7-userresultbyrestid)
    - [8. UserResultsByRestIds](#8-userresultsbyrestids)
    - [9. UserTweets](#9-usertweets)
    - [10. UserTweetsReplies](#10-usertweetsreplies)
    - [11. UserMedia](#11-usermedia)
    - [12. UserLikes](#12-userlikes)
    - [13. UserFollowers](#13-userfollowers)
    - [14. FollowersLight](#14-followerslight)
    - [15. FollowersIds](#15-followersids)
    - [16. UserVerifiedFollowers](#16-userverifiedfollowers)
    - [17. UserSubscriptions](#17-usersubscriptions)
    - [18. TranslateProfile](#18-translateprofile)
    - [19. UserFollowing](#19-userfollowing)
    - [20. FollowingLight](#20-followinglight)
    - [21. FollowingIds](#21-followingids)
  - [Tweet](#tweet)
    - [22. TweetDetailConversation](#22-tweetdetailconversation)
    - [23. TweetDetail](#23-tweetdetail)
    - [24. TweetDetailv2](#24-tweetdetailv2)
    - [25. TweetDetailv3](#25-tweetdetailv3)
    - [26. TweetResultsByRestIds](#26-tweetresultsbyrestids)
    - [27. TweetFavoriters](#27-tweetfavoriters)
    - [28. TweetRetweeters](#28-tweetretweeters)
    - [29. TweetQuotes](#29-tweetquotes)
    - [30. TranslateTweet](#30-translatetweet)
    - [31. TweetArticle](#31-tweetarticle)
  - [List](#list)
    - [32. ListTweetsTimeline](#32-listtweetstimeline)
    - [33. ListSubscribersTimeline](#33-listsubscriberstimeline)
    - [34. ListMembersTimeline](#34-listmemberstimeline)
    - [35. ListSearch](#35-listsearch)
  - [Community](#community)
    - [36. CommunityMembers](#36-communitymembers)
    - [37. CommunityModerators](#37-communitymoderators)
    - [38. CommunitiesSearchSlice](#38-communitiessearchslice)
    - [39. CommunityResultsById](#39-communityresultsbyid)
    - [40. CommunityTimeline](#40-communitytimeline)
    - [41. CommunityMediaTimeline](#41-communitymediatimeline)
    - [42. CommunityMemberSearch](#42-communitymembersearch)
    - [43. CommunityAboutTimeline](#43-communityabouttimeline)
  - [通用说明](#通用说明)
    - [分页](#分页)
    - [通用返回结构](#通用返回结构)
    - [错误返回](#错误返回)

---

## Explore

### 1. FriendshipsShow

检查两个用户之间的关注关系。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `source_id` | 是* | 源用户 ID |
| `target_id` | 是* | 目标用户 ID |
| `source_screen_name` | 是* | 源用户名（与 source_id 二选一） |
| `target_screen_name` | 是* | 目标用户名（与 target_id 二选一） |

> *必须提供 `source_id` + `target_id` 或 `source_screen_name` + `target_screen_name` 其中一组

**请求示例**

```
GET /FriendshipsShow?api_key={key}&source_screen_name=elonmusk&target_screen_name=BillGates
```

**返回示例**

```json
{
  "relationship": {
    "source": {
      "id": 44196397,
      "screen_name": "elonmusk",
      "following": false,
      "followed_by": false,
      "blocking": false,
      "muting": false
    },
    "target": {
      "id": 50393960,
      "screen_name": "BillGates",
      "following": false,
      "followed_by": false
    }
  }
}
```

---

### 2. Trends

获取指定地区的热门趋势。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `woeid` | 是 | 地区 ID（1 = 全球, 23424977 = 美国, 23424856 = 日本 等） |

**请求示例**

```
GET /Trends?api_key={key}&woeid=1
```

**返回示例**

```json
{
  "metadata": {
    "timestamp": 1774403641687,
    "refresh_interval_millis": 300000,
    "woeid": {
      "name": "Worldwide",
      "id": 1
    }
  },
  "modules": [
    {
      "trend": {
        "name": "#Tresgracas",
        "target": { "query": "#Tresgracas" },
        "rank": 1
      }
    },
    {
      "trend": {
        "name": "Sora",
        "target": { "query": "Sora" },
        "rank": 2
      }
    }
  ]
}
```

---

### 3. Search

搜索推文或用户。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `q` | 是 | 搜索关键词 |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |
| `product` | 否 | 搜索类型：`Top`（默认）、`Latest`、`People`、`Photos`、`Videos` |

**请求示例**

```
GET /Search?api_key={key}&q=bitcoin&count=10&product=Latest
```

**返回示例**

```json
{
  "data": {
    "search_by_raw_query": {
      "id": "U2VhcmNoUXVlcnk6Yml0Y29pbg==",
      "rest_id": "bitcoin",
      "search_timeline": {
        "id": "...",
        "timeline": {
          "id": "TopTabSrpProduct-Timeline",
          "instructions": [
            {
              "__typename": "TimelineAddEntries",
              "entries": [
                {
                  "content": {
                    "__typename": "TimelineTimelineItem",
                    "content": {
                      "__typename": "TimelineTweet",
                      "tweet_results": {
                        "rest_id": "推文ID",
                        "result": { "...推文完整数据..." }
                      }
                    }
                  }
                }
              ]
            }
          ]
        }
      }
    }
  }
}
```

---

### 4. AutoComplete

搜索自动补全建议。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `q` | 是 | 搜索关键词 |

**请求示例**

```
GET /AutoComplete?api_key={key}&q=elon
```

**返回示例**

```json
{
  "num_results": 12,
  "users": [
    {
      "id": 44196397,
      "id_str": "44196397",
      "name": "Elon Musk",
      "screen_name": "elonmusk",
      "profile_image_url_https": "https://pbs.twimg.com/profile_images/.../photo_normal.jpg",
      "ext_is_blue_verified": true,
      "location": "",
      "is_protected": false,
      "social_context": {
        "following": false,
        "followed_by": false
      }
    }
  ]
}
```

---

## User

### 5. UsernameToUserId

将用户名转换为用户 ID。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `username` | 是 | 用户名（不带 @） |

**请求示例**

```
GET /UsernameToUserId?api_key={key}&username=elonmusk
```

**返回示例**

```json
{
  "id": 44196397,
  "id_str": "44196397"
}
```

---

### 6. UserResultByScreenName

通过用户名获取用户详细信息。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `username` | 是 | 用户名（不带 @） |

**请求示例**

```
GET /UserResultByScreenName?api_key={key}&username=elonmusk
```

**返回示例**

```json
{
  "data": {
    "user_results": {
      "rest_id": "44196397",
      "result": {
        "__typename": "User",
        "core": {
          "created_at": "Tue Jun 02 20:12:29 +0000 2009",
          "name": "Elon Musk",
          "screen_name": "elonmusk"
        },
        "avatar": {
          "image_url": "https://pbs.twimg.com/profile_images/.../photo_normal.jpg"
        },
        "banner": {
          "image_url": "https://pbs.twimg.com/profile_banners/44196397/..."
        },
        "profile_bio": {
          "description": "...",
          "entities": { "..." }
        },
        "action_counts": {
          "favorites_count": 219037
        },
        "privacy": {
          "protected": false,
          "suspended": false
        },
        "location": { "location": "" },
        "highlights_info": {
          "can_highlight_tweets": true,
          "highlighted_tweets": "950"
        },
        "creator_subscriptions_count": 238,
        "professional": {
          "professional_type": "Creator",
          "rest_id": "1679729435447275522"
        }
      }
    }
  }
}
```

---

### 7. UserResultByRestId

通过用户 Rest ID 获取用户信息。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `user_id` | 是 | 用户 ID |

**请求示例**

```
GET /UserResultByRestId?api_key={key}&user_id=44196397
```

**返回示例**

> 返回结构与 [UserResultByScreenName](#6-userresultbyscreenname) 一致

---

### 8. UserResultsByRestIds

批量通过 Rest ID 查询多个用户。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `user_ids` | 是 | 用户 ID 列表（逗号分隔） |

**请求示例**

```
GET /UserResultsByRestIds?api_key={key}&user_ids=44196397,50393960
```

**返回示例**

```json
{
  "data": {
    "users_by_rest_ids": {
      "users": [
        { "rest_id": "44196397", "result": { "...用户数据..." } },
        { "rest_id": "50393960", "result": { "...用户数据..." } }
      ]
    }
  }
}
```

---

### 9. UserTweets

获取用户的推文列表。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `user_id` | 是 | 用户 ID |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /UserTweets?api_key={key}&user_id=44196397&count=20
```

**返回示例**

```json
{
  "data": {
    "user_result_by_rest_id": {
      "rest_id": "44196397",
      "result": {
        "__typename": "User",
        "profile_timeline_v2": {
          "timeline": {
            "id": "ProfileBestProduct-Timeline",
            "instructions": [
              {
                "__typename": "TimelineAddEntries",
                "entries": [
                  {
                    "content": {
                      "__typename": "TimelineTimelineItem",
                      "content": {
                        "__typename": "TimelineTweet",
                        "tweet_results": {
                          "rest_id": "推文ID",
                          "result": {
                            "__typename": "Tweet",
                            "core": { "user_results": { "...用户信息..." } },
                            "legacy": {
                              "full_text": "推文内容...",
                              "created_at": "...",
                              "favorite_count": 12345,
                              "retweet_count": 678
                            }
                          }
                        }
                      }
                    }
                  }
                ]
              }
            ]
          }
        }
      }
    }
  }
}
```

---

### 10. UserTweetsReplies

获取用户的推文与回复。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `user_id` | 是 | 用户 ID |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /UserTweetsReplies?api_key={key}&user_id=44196397&count=20
```

**返回示例**

> 返回结构与 [UserTweets](#9-usertweets) 一致，但包含回复推文

---

### 11. UserMedia

获取用户的媒体内容（图片/视频）。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `user_id` | 是 | 用户 ID |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /UserMedia?api_key={key}&user_id=44196397&count=20
```

**返回示例**

```json
{
  "data": {
    "user_result_by_rest_id": {
      "rest_id": "44196397",
      "result": {
        "__typename": "User",
        "media_timeline_v2": {
          "timeline": {
            "id": "ProfileMediaProduct-Timeline",
            "instructions": [
              {
                "__typename": "TimelineAddEntries",
                "entries": [ "...包含媒体的推文列表..." ]
              }
            ]
          }
        }
      }
    }
  }
}
```

---

### 12. UserLikes

获取用户的点赞列表。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `user_id` | 是 | 用户 ID |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /UserLikes?api_key={key}&user_id=44196397&count=20
```

**返回示例**

```json
{
  "data": {
    "user_result_by_rest_id": {
      "rest_id": "44196397",
      "result": {
        "__typename": "User",
        "favorites_by_time_timeline_v2": {
          "id": "...",
          "timeline": {
            "instructions": [ "...点赞的推文列表..." ]
          }
        }
      }
    }
  }
}
```

---

### 13. UserFollowers

获取用户的粉丝列表（完整信息）。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `user_id` | 是 | 用户 ID |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /UserFollowers?api_key={key}&user_id=44196397&count=20
```

**返回示例**

```json
{
  "data": {
    "user_result_by_rest_id": {
      "rest_id": "44196397",
      "result": {
        "__typename": "User",
        "followers_timeline": {
          "timeline": {
            "id": "FollowersProduct-Timeline",
            "instructions": [
              {
                "__typename": "TimelineAddEntries",
                "entries": [
                  {
                    "content": {
                      "__typename": "TimelineTimelineItem",
                      "content": {
                        "__typename": "TimelineUser",
                        "user_results": {
                          "rest_id": "用户ID",
                          "result": { "...粉丝用户数据..." }
                        }
                      }
                    }
                  }
                ]
              }
            ]
          }
        }
      }
    }
  }
}
```

---

### 14. FollowersLight

获取用户粉丝列表（轻量版）。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `user_id` | 是* | 用户 ID |
| `username` | 是* | 用户名（与 user_id 二选一） |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /FollowersLight?api_key={key}&user_id=44196397&count=20
```

---

### 15. FollowersIds

获取用户粉丝 ID 列表。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `user_id` | 是* | 用户 ID |
| `username` | 是* | 用户名（与 user_id 二选一） |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /FollowersIds?api_key={key}&user_id=44196397&count=100
```

---

### 16. UserVerifiedFollowers

获取用户的认证粉丝列表。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `user_id` | 是 | 用户 ID |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /UserVerifiedFollowers?api_key={key}&user_id=44196397&count=20
```

---

### 17. UserSubscriptions

获取用户的订阅列表。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `user_id` | 是 | 用户 ID |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /UserSubscriptions?api_key={key}&user_id=44196397&count=20
```

---

### 18. TranslateProfile

翻译用户资料。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `user_id` | 是 | 用户 ID |

**请求示例**

```
GET /TranslateProfile?api_key={key}&user_id=44196397
```

---

### 19. UserFollowing

获取用户正在关注的列表（完整信息）。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `user_id` | 是 | 用户 ID |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /UserFollowing?api_key={key}&user_id=44196397&count=20
```

**返回示例**

> 返回结构与 [UserFollowers](#13-userfollowers) 类似，Timeline ID 为 `FollowingProduct-Timeline`

---

### 20. FollowingLight

获取用户关注列表（轻量版）。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `user_id` | 是* | 用户 ID |
| `username` | 是* | 用户名（与 user_id 二选一） |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /FollowingLight?api_key={key}&user_id=44196397&count=20
```

---

### 21. FollowingIds

获取用户关注者 ID 列表。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `user_id` | 是* | 用户 ID |
| `username` | 是* | 用户名（与 user_id 二选一） |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /FollowingIds?api_key={key}&user_id=44196397&count=100
```

---

## Tweet

### 22. TweetDetailConversation

获取推文详情及完整对话时间线。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `tweet_id` | 是 | 推文 ID |
| `cursor` | 否 | 分页游标（加载更多回复） |

**请求示例**

```
GET /TweetDetailConversation?api_key={key}&tweet_id=2035526376468394305
```

**返回示例**

```json
{
  "data": {
    "threaded_conversation_with_injections_v2": {
      "instructions": [
        {
          "__typename": "TimelineAddEntries",
          "entries": [
            {
              "content": {
                "__typename": "TimelineTimelineItem",
                "content": {
                  "__typename": "TimelineTweet",
                  "tweet_results": {
                    "rest_id": "2035526376468394305",
                    "result": {
                      "__typename": "Tweet",
                      "core": { "user_results": { "...用户信息..." } },
                      "legacy": {
                        "full_text": "推文内容...",
                        "created_at": "...",
                        "favorite_count": 12345,
                        "retweet_count": 678,
                        "reply_count": 90
                      }
                    }
                  }
                }
              }
            }
          ]
        }
      ]
    }
  }
}
```

---

### 23. TweetDetail

获取推文详情（轻量版，不含对话线程）。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `tweet_id` | 是 | 推文 ID |

**请求示例**

```
GET /TweetDetail?api_key={key}&tweet_id=2035526376468394305
```

**返回示例**

```json
{
  "data": {
    "tweet_result": {
      "result": {
        "__typename": "Tweet",
        "core": {
          "user_result": {
            "result": {
              "is_blue_verified": true,
              "legacy": {
                "name": "Elon Musk",
                "screen_name": "elonmusk",
                "followers_count": 237386850,
                "friends_count": 1301
              }
            }
          }
        },
        "legacy": {
          "full_text": "推文内容...",
          "created_at": "...",
          "favorite_count": 12345,
          "retweet_count": 678,
          "reply_count": 90,
          "bookmark_count": 45
        }
      }
    }
  }
}
```

---

### 24. TweetDetailv2

推文详情 Light V2（返回结构略有不同）。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `tweet_id` | 是 | 推文 ID |

**请求示例**

```
GET /TweetDetailv2?api_key={key}&tweet_id=2035526376468394305
```

---

### 25. TweetDetailv3

推文详情 Light V3（最新版本）。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `tweet_id` | 是 | 推文 ID |

**请求示例**

```
GET /TweetDetailv3?api_key={key}&tweet_id=2035526376468394305
```

---

### 26. TweetResultsByRestIds

批量通过推文 ID 查询多条推文。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `tweet_ids` | 是 | 推文 ID 列表（逗号分隔） |

**请求示例**

```
GET /TweetResultsByRestIds?api_key={key}&tweet_ids=2035526376468394305,2035000000000000000
```

---

### 27. TweetFavoriters

获取推文的点赞者列表。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `tweet_id` | 是 | 推文 ID |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /TweetFavoriters?api_key={key}&tweet_id=2035526376468394305&count=20
```

**返回示例**

```json
{
  "data": {
    "favoriters_timeline": {
      "timeline": {
        "id": "2035526376468394305",
        "instructions": [
          {
            "__typename": "TimelineAddEntries",
            "entries": [
              {
                "content": {
                  "__typename": "TimelineUser",
                  "user_results": { "...点赞用户数据..." }
                }
              }
            ]
          }
        ]
      }
    }
  }
}
```

---

### 28. TweetRetweeters

获取推文的转推者列表。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `tweet_id` | 是 | 推文 ID |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /TweetRetweeters?api_key={key}&tweet_id=2035526376468394305&count=20
```

**返回示例**

```json
{
  "data": {
    "retweeters_timeline": {
      "timeline": {
        "id": "Retweeters-2035526376468394305",
        "instructions": [
          {
            "__typename": "TimelineAddEntries",
            "entries": [ "...转推用户列表..." ]
          }
        ]
      }
    }
  }
}
```

---

### 29. TweetQuotes

获取推文的引用列表。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `tweet_id` | 是 | 推文 ID |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /TweetQuotes?api_key={key}&tweet_id=2035526376468394305&count=20
```

**返回示例**

```json
{
  "data": {
    "search_by_raw_query": {
      "rest_id": "quoted_tweet_id:2035526376468394305",
      "search_timeline": {
        "timeline": {
          "id": "LatestTabSrpProduct-Timeline",
          "instructions": [
            {
              "__typename": "TimelineAddEntries",
              "entries": [ "...引用推文列表..." ]
            }
          ]
        }
      }
    }
  }
}
```

---

### 30. TranslateTweet

翻译推文内容。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `tweet_id` | 是 | 推文 ID |

**请求示例**

```
GET /TranslateTweet?api_key={key}&tweet_id=2035526376468394305
```

---

### 31. TweetArticle

获取推文关联的文章内容。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `tweet_id` | 是 | 推文 ID |

**请求示例**

```
GET /TweetArticle?api_key={key}&tweet_id=2035526376468394305
```

---

## List

### 32. ListTweetsTimeline

获取列表的推文时间线。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `list_id` | 是 | 列表 ID |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /ListTweetsTimeline?api_key={key}&list_id=1580660522737561600&count=20
```

---

### 33. ListSubscribersTimeline

获取列表的订阅者。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `list_id` | 是 | 列表 ID |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /ListSubscribersTimeline?api_key={key}&list_id=1580660522737561600&count=20
```

---

### 34. ListMembersTimeline

获取列表的成员。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `list_id` | 是 | 列表 ID |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /ListMembersTimeline?api_key={key}&list_id=1580660522737561600&count=20
```

---

### 35. ListSearch

搜索列表。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `q` | 是 | 搜索关键词 |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /ListSearch?api_key={key}&q=crypto&count=20
```

---

## Community

### 36. CommunityMembers

获取社区成员列表。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `community_id` | 是 | 社区 ID |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /CommunityMembers?api_key={key}&community_id=1234567890&count=20
```

---

### 37. CommunityModerators

获取社区管理员列表。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `community_id` | 是 | 社区 ID |

**请求示例**

```
GET /CommunityModerators?api_key={key}&community_id=1234567890
```

---

### 38. CommunitiesSearchSlice

搜索社区。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `q` | 是 | 搜索关键词 |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /CommunitiesSearchSlice?api_key={key}&q=crypto&count=20
```

---

### 39. CommunityResultsById

通过 ID 获取社区信息。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `community_id` | 是 | 社区 ID |

**请求示例**

```
GET /CommunityResultsById?api_key={key}&community_id=1234567890
```

---

### 40. CommunityTimeline

获取社区时间线。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `community_id` | 是 | 社区 ID |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /CommunityTimeline?api_key={key}&community_id=1234567890&count=20
```

---

### 41. CommunityMediaTimeline

获取社区媒体时间线。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `community_id` | 是 | 社区 ID |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /CommunityMediaTimeline?api_key={key}&community_id=1234567890&count=20
```

---

### 42. CommunityMemberSearch

搜索社区内成员。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `community_id` | 是 | 社区 ID |
| `q` | 否 | 搜索关键词 |
| `count` | 否 | 返回数量 |
| `cursor` | 否 | 分页游标 |

**请求示例**

```
GET /CommunityMemberSearch?api_key={key}&community_id=1234567890&q=elon
```

---

### 43. CommunityAboutTimeline

获取社区关于页面时间线。

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `community_id` | 是 | 社区 ID |

**请求示例**

```
GET /CommunityAboutTimeline?api_key={key}&community_id=1234567890
```

---

## 通用说明

### 分页

大部分列表接口支持 `cursor` 分页。首次请求不传 cursor，返回数据中会包含 `cursor-bottom-*` 和 `cursor-top-*` 的 entry，取其中的 value 作为下次请求的 `cursor` 参数即可翻页。

### 通用返回结构

所有 Timeline 类接口遵循统一的返回结构：

```json
{
  "data": {
    "...": {
      "timeline": {
        "instructions": [
          {
            "__typename": "TimelineAddEntries",
            "entries": [ "...数据条目..." ]
          },
          {
            "__typename": "TimelineClearCache"
          }
        ]
      }
    }
  }
}
```

### 错误返回

```json
{
  "message": "错误描述"
}
```

常见错误：
- `"user_id is required"` — 缺少必填参数
- `"Method Not Allowed"` — 接口不存在或方法错误
- `"System error"` — 上游系统错误
