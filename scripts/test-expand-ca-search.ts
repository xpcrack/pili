import './server-only-shim.cjs';
import { readEventsFeed } from '../lib/server/eventsRepo';

const CA = 'wdysfTqUsJ8qAVB1796BXgGisThoBzu1keQmdgswdyt';

function summarize(label: string, feed: Array<{ user: { name: string }; activity: { content: string; id?: string; timestamp?: number; source?: string; metadata?: { tweetId?: string } } }>) {
  const lines = feed.map((item) => {
    const meta = item.activity.metadata || {};
    return `${item.user.name}|tweet=${meta.tweetId || '-'}|${(item.activity.content || '').slice(0, 40).replace(/\n/g, ' ')}`;
  });
  console.log(`\n[${label}] ${feed.length} 条`);
  for (const line of lines) console.log(' ', line);
}

// 1. 基线：无扩展
summarize('baseline', readEventsFeed({ limit: 100, q: CA }).feed);
// 2. expandTicker
summarize('expandTicker', readEventsFeed({ limit: 100, q: CA, expandTicker: true }).feed);
// 3. expandOfficial
summarize('expandOfficial', readEventsFeed({ limit: 100, q: CA, expandOfficialTweets: true }).feed);
// 4. 全开
summarize('both', readEventsFeed({ limit: 100, q: CA, expandTicker: true, expandOfficialTweets: true }).feed);
// 5. 开关开着但 q 不是 CA（普通词）→ 应等于 baseline 行为
summarize('nonCA-word', readEventsFeed({ limit: 20, q: 'solana', expandTicker: true, expandOfficialTweets: true }).feed);
summarize('nonCA-word-noexpand', readEventsFeed({ limit: 20, q: 'solana' }).feed);
