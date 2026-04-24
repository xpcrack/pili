#!/usr/bin/env tsx

import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import { fetchOkxTransactionsByAddress } from '@/lib/okx';
import { buildActivityFeed } from '@/lib/activityFeed';
import { upsertFeedSnapshot, deleteFeedSnapshotWindowForUsers } from '@/lib/server/feedSnapshotRepo';
import { markAddressesSynced, updateAssetSnapshots } from '@/lib/server/trackedUsersRepo';

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

async function backfill14DaysTransactions() {
  console.log('开始补充所有地址近14天的交易动态...');

  // 获取所有被跟踪的用户和地址
  const users = listTrackedUsers();
  console.log(`找到 ${users.length} 个用户，共 ${users.reduce((sum, user) => sum + user.addresses.length, 0)} 个地址`);

  if (users.length === 0) {
    console.log('没有找到被跟踪的用户，退出');
    return;
  }

  const now = Date.now();
  const beginMs = now - FOURTEEN_DAYS_MS;
  const endMs = now;

  console.log(`时间范围: ${new Date(beginMs).toISOString()} 到 ${new Date(endMs).toISOString()}`);

  // 为每个用户的每个地址获取交易数据
  let totalAddresses = 0;
  let successfulAddresses = 0;
  let failedAddresses = 0;

  for (const user of users) {
    console.log(`\n处理用户: ${user.name} (${user.id})`);

    for (const address of user.addresses) {
      totalAddresses++;
      console.log(`  获取地址 ${address.address} (${address.chain}) 的交易数据...`);

      try {
        const result = await fetchOkxTransactionsByAddress(
          address.address,
          address.chain,
          { beginMs, endMs }
        );

        if (result.ok) {
          console.log(`    成功获取 ${result.transactions.length} 笔交易`);
          successfulAddresses++;
        } else {
          console.log(`    获取失败: ${result.error}`);
          failedAddresses++;
        }

        // 添加延迟避免API限制
        await new Promise(resolve => setTimeout(resolve, 300));

      } catch (error) {
        console.log(`    获取异常: ${error instanceof Error ? error.message : '未知错误'}`);
        failedAddresses++;
      }
    }
  }

  console.log(`\n开始构建活动feed...`);

  // 构建活动feed
  const feedResult = await buildActivityFeed(users, {
    beginMs,
    endMs,
    requireTrackedInitiator: true,
  });

  console.log(`构建完成，共 ${feedResult.feed.length} 条活动记录`);

  // 清理现有的14天窗口数据并插入新数据
  console.log('清理现有数据并插入新的feed数据...');
  deleteFeedSnapshotWindowForUsers(users, beginMs, endMs);
  upsertFeedSnapshot(feedResult.feed);

  // 更新资产快照
  console.log('更新资产快照...');
  updateAssetSnapshots(feedResult.addressAssets, feedResult.userAssets);

  // 标记地址已同步
  const syncedAt = Date.now();
  markAddressesSynced(
    feedResult.diagnostics
      .filter((item) => item.ok)
      .map((item) => ({
        chain: item.chain,
        address: item.address,
        syncedAt,
      }))
  );

  console.log('\n=== 补充完成 ===');
  console.log(`总地址数: ${totalAddresses}`);
  console.log(`成功: ${successfulAddresses}`);
  console.log(`失败: ${failedAddresses}`);
  console.log(`活动记录: ${feedResult.feed.length}`);
  console.log(`交易总数: ${feedResult.summary.transactionCount}`);
  console.log(`成功地址: ${feedResult.summary.successfulAddressCount}`);
  console.log(`失败地址: ${feedResult.summary.failedAddressCount}`);
}

// 执行脚本
if (require.main === module) {
  backfill14DaysTransactions()
    .then(() => {
      console.log('脚本执行完成');
      process.exit(0);
    })
    .catch((error) => {
      console.error('脚本执行失败:', error);
      process.exit(1);
    });
}

export { backfill14DaysTransactions };