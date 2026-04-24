// 在浏览器控制台运行这段代码来获取交易详情
(async function() {
  const TARGET_TX = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const USER_ADDRESS = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf03';

  // 从 localStorage 获取缓存的活动数据
  const cacheKey = 'activity-feed-cache';
  const cached = localStorage.getItem(cacheKey);

  if (!cached) {
    console.log('❌ No cached activity feed found');
    return;
  }

  const data = JSON.parse(cached);
  const allActivities = data.state?.feed || [];

  console.log(`📊 Total activities in cache: ${allActivities.length}`);

  // 查找目标交易
  const targetActivity = allActivities.find(item =>
    item.activity?.metadata?.txHash?.toLowerCase() === TARGET_TX.toLowerCase()
  );

  if (!targetActivity) {
    console.log('❌ Transaction not found in cached activities');
    console.log('Recent transactions:');
    allActivities.slice(0, 5).forEach((item, i) => {
      console.log(`  ${i + 1}. ${item.activity?.metadata?.txHash} - ${item.activity?.metadata?.token}`);
    });
    return;
  }

  console.log('✅ Found transaction in cache!\n');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                    CACHED ACTIVITY DATA');
  console.log('═══════════════════════════════════════════════════════════\n');

  const activity = targetActivity.activity;
  const metadata = activity.metadata;

  console.log('📋 Activity Info:');
  console.log('   Title:', activity.title);
  console.log('   Content:', activity.content);
  console.log('   Type:', activity.type);
  console.log('   Source:', activity.source);
  console.log('');

  console.log('💰 Transaction Details:');
  console.log('   TX Hash:', metadata.txHash);
  console.log('   Token:', metadata.token);
  console.log('   Amount:', metadata.value);
  console.log('   Chain:', metadata.chain);
  console.log('   Status:', metadata.txStatus);
  console.log('');

  console.log('🔧 Transaction Type:');
  console.log('   txAction:', metadata.txAction, metadata.txAction === 'buy' ? '❌ (WRONG - should be sell)' : '✅');
  console.log('   uncertainFrom:', metadata.uncertainFrom);
  console.log('');

  console.log('📍 Addresses:');
  console.log('   From:', metadata.fromAddress);
  console.log('   To:', metadata.toAddress);
  console.log('   User:', USER_ADDRESS.toLowerCase());
  console.log('');

  console.log('⚠️  PROBLEM: This only shows the FIRST address from from/to arrays!');
  console.log('    OKX returns arrays, but we only see [0] here.');
  console.log('');
  console.log('Full activity object:');
  console.log(JSON.stringify(targetActivity, null, 2));

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Please copy the full JSON output above and share it.');
  console.log('═══════════════════════════════════════════════════════════');
})();
