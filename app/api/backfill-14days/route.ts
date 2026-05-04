import { NextResponse } from 'next/server';
import { listTrackedUsers, markAddressesSynced } from '@/lib/server/trackedUsersRepo';
import { buildActivityFeed } from '@/lib/activityFeed';
import { upsertFeedSnapshot, deleteFeedSnapshotWindowForUsers } from '@/lib/server/feedSnapshotRepo';
import { validateAndPersistPeakAssetSnapshots } from '@/lib/server/assetPeakValidation';

export const dynamic = 'force-dynamic';

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

export async function POST() {
  try {
    console.log('开始补充所有地址近14天的交易动态...');

    // 获取所有被跟踪的用户和地址
    const users = listTrackedUsers();
    const totalAddresses = users.reduce((sum, user) => sum + user.addresses.length, 0);

    console.log(`找到 ${users.length} 个用户，共 ${totalAddresses} 个地址`);

    if (users.length === 0) {
      return NextResponse.json({
        success: false,
        message: '没有找到被跟踪的用户',
        stats: { users: 0, addresses: 0, transactions: 0 }
      });
    }

    const now = Date.now();
    const beginMs = now - FOURTEEN_DAYS_MS;
    const endMs = now;

    console.log(`时间范围: ${new Date(beginMs).toISOString()} 到 ${new Date(endMs).toISOString()}`);

    // 构建活动feed
    console.log('开始构建活动feed...');
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
    const assetValidation = await validateAndPersistPeakAssetSnapshots({
      users,
      addressAssets: feedResult.addressAssets,
      userAssets: feedResult.userAssets,
    });
    if (assetValidation.blockedUsers.length > 0) {
      console.warn(`峰值资产校验拦截 ${assetValidation.blockedUsers.length} 个用户的可疑快照`);
    }

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

    const stats = {
      users: users.length,
      addresses: totalAddresses,
      transactions: feedResult.summary.transactionCount,
      successfulAddresses: feedResult.summary.successfulAddressCount,
      failedAddresses: feedResult.summary.failedAddressCount,
      feedRecords: feedResult.feed.length,
    };

    console.log('=== 补充完成 ===');
    console.log(`总地址数: ${totalAddresses}`);
    console.log(`成功: ${feedResult.summary.successfulAddressCount}`);
    console.log(`失败: ${feedResult.summary.failedAddressCount}`);
    console.log(`活动记录: ${feedResult.feed.length}`);
    console.log(`交易总数: ${feedResult.summary.transactionCount}`);

    return NextResponse.json({
      success: true,
      message: '14天交易数据补充完成',
      stats,
      summary: feedResult.summary,
      timeRange: {
        beginMs,
        endMs,
        begin: new Date(beginMs).toISOString(),
        end: new Date(endMs).toISOString(),
      }
    });

  } catch (error) {
    console.error('补充14天数据失败:', error);
    return NextResponse.json({
      success: false,
      message: '补充14天数据失败',
      error: error instanceof Error ? error.message : '未知错误'
    }, { status: 500 });
  }
}
