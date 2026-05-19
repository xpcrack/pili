# 社交内容翻译 + CA/Ticker 高亮 + 评价识别设计

## 目标

1. 英文社交媒体内容（Twitter + Telegram）自动翻译为中文
2. 推文/Telegram 正文中 CA 地址和 $Ticker 实时高亮
3. 识别交易员对提及资产的正面/负面/中性评价

## 现有基础

| 能力 | 状态 | 位置 |
|---|---|---|
| CA/Ticker 规则提取 | ✅ | `lib/twitter/extractTweetTokenMentions.ts` |
| 评价数据结构 | ✅ | `types/index.ts` `tokenSentiments` 字段 |
| 评价 UI chips | ✅ | `components/ActivityCard.tsx` 绿/红/灰 chip |
| 翻译 DB 字段 | ✅ | `twitter_tweet_enrichments.translation_zh` |
| 翻译 UI 展示 | ✅ | ActivityCard 翻译为主、原文为次 |
| Enrichment repo/service | ✅ | `lib/server/twitterEnrichmentRepo.ts` + `twitterEnrichmentService.ts` |
| Enrichment model 接口 | ✅ | `lib/server/twitterEnrichmentModel.ts` `TweetEnrichmentModel` |
| **翻译模型实现** | ❌ 返回 null | `getDefaultTweetEnrichmentModel()` |
| **Enrichment 生产触发** | ❌ 从未调用 | `runTweetEnrichmentForTweetIds()` |
| **Telegram 翻译** | ❌ 无字段无逻辑 | |
| **Telegram token 提取** | ❌ | |
| **正文内高亮** | ❌ 纯文本渲染 | ActivityCard 显示 `twitterPrimaryText` |

## 1. NVIDIA Qwen2.5-7B 翻译+评价模型

### 新文件: `lib/server/nvidiaEnrichmentModel.ts`

实现 `TweetEnrichmentModel` 接口，一次 LLM 调用同时产出翻译和评价：

- 环境变量: `NVIDIA_API_KEY`
- Base URL: `https://integrate.api.nvidia.com/v1`
- Model: `qwen/qwen2.5-7b-instruct`
- OpenAI 兼容格式（只换 base_url 和 api_key）

### Prompt 设计

```
你是一个加密货币社交媒体分析助手。对以下推文执行两个任务：

1. 将英文内容翻译为简洁自然的中文（保留 $TICKER 和 CA 地址原样，不翻译项目名和代币符号）
2. 判断作者对每个提及代币的情感倾向

推文内容：
{fullText}

提及的代币：
{mentions 列表，含 tokenSymbol 和 tokenAddress}

请严格以如下 JSON 格式回复，不要输出任何其他内容：
{"translation_zh":"中文翻译","sentiments":[{"token_symbol":"BTC","token_address":"0x...","sentiment":"positive"}]}

sentiment 只能是 positive / negative / neutral 之一。
```

### 评价判断规则（prompt 引导）

- 明确看多/买入/持有 → `positive`
- 明确看空/卖出/警告 → `negative`
- 仅提及/分享信息无倾向 → `neutral`
- 不确定 → `neutral`

### 英文检测

在调用 LLM 前先检测文本是否包含英文：
- 包含拉丁字母且非纯中文 → 调用翻译
- 纯中文/纯数字/纯符号 → 跳过翻译，`translationZh = null`

## 2. Enrichment 生产触发

### Twitter: 在推文入库后触发

在 `projectTwitterTweetsToFeed()` 末尾，对刚入库的 tweet IDs 调用 enrichment：

```
projectTwitterTweetsToFeed() {
  // ... 现有入库逻辑 ...

  // 新增：入库后异步触发 enrichment（翻译 + 评价）
  const pendingTweetIds = tweetCandidates
    .filter(tweet => {
      const enrich = enrichmentByTweetId.get(tweet.tweetId);
      return !enrich || enrich.translationStatus === 'pending' || enrich.translationStatus === 'failed';
    })
    .map(t => t.tweetId);

  if (pendingTweetIds.length > 0) {
    void runTweetEnrichmentForTweetIds({ tweetIds: pendingTweetIds })
      .then(result => {
        console.log(`[enrichment] ${result.succeeded} succeeded, ${result.failed} failed`);
        // 重新 project 以更新 translationZh 和 sentiments
        projectTwitterTweetsToFeed({ sinceMs: 0, tweetIds: pendingTweetIds });
      })
      .catch(err => console.warn('[enrichment] background enrichment failed:', err));
  }
}
```

注意：enrichment 异步执行，不阻塞主流程。完成后重新 project 把翻译和评价写入 feed。

### Telegram: 在 Telegram 帖子映射为 Activity 时触发

在 Telegram 帖子映射为 Activity 的代码中：
1. 用 `extractTweetTokenMentions()` 提取 CA/Ticker
2. 调用翻译服务翻译英文内容
3. 将 `translationZh`、`mentionedTickers`、`tokenSentiments` 写入 activity metadata

需要找到 Telegram 帖子映射为 Activity 的代码位置。

## 3. 推文/Telegram 正文 CA 和 Ticker 高亮

### 新文件: `lib/socialContentHighlight.ts`

提供函数 `highlightSocialContent(text, mentions)` 将纯文本转为带高亮标记的 React 节点数组。

规则：
- `$TICKER` → `<span class="text-yellow-400 font-semibold">$TICKER</span>`
- CA 地址 (0x... / Solana base58) → `<span class="text-cyan-400 font-mono text-[11px]">0xabc4...</span>`（截断显示，hover 显示完整，点击复制）
- 其他文本保持不变

### ActivityCard 改动

Twitter 正文区域：
- 当前：`<p>{twitterPrimaryText}</p>` 纯文本
- 改为：用 `highlightSocialContent()` 渲染翻译后的中文内容
- 原文（twitterSecondaryText）不高亮，保持原样

Telegram 正文区域：
- 同理：用 `highlightSocialContent()` 渲染翻译后的内容

## 4. Telegram 帖子翻译 + 评价展示

### 翻译展示

ActivityCard 的 Telegram 区域加上与 Twitter 相同的翻译展示逻辑：
- 翻译为主文本（primaryText）
- 原文为次要文本（secondaryText，小字灰色）

### 评价 chips

复用 Twitter 的 `tweetSentimentChips` 渲染逻辑，对 Telegram 帖子也展示 `tokenSentiments` chips。

## 5. 实现顺序

1. `lib/server/nvidiaEnrichmentModel.ts` — Qwen2.5 模型实现
2. `lib/server/twitterEnrichmentModel.ts` — 修改 `getDefaultTweetEnrichmentModel()` 使用 NVIDIA 模型
3. `lib/server/twitterFeedMapper.ts` — 在 projectTwitterTweetsToFeed 末尾触发 enrichment
4. `lib/socialContentHighlight.ts` — CA/Ticker 高亮渲染
5. `components/ActivityCard.tsx` — 应用高亮 + Telegram 翻译/评价展示
6. Telegram ingestion 集成 — 找到映射代码，加上 token 提取和翻译
7. `.env.local` 加 `NVIDIA_API_KEY`

## 6. 环境变量

```
NVIDIA_API_KEY=nvapi-xxx
```

已有的 `NVIDIA_API_KEY` 格式 key，无需新变量名。
