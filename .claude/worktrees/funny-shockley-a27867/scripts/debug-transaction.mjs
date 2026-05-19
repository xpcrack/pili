import crypto from 'crypto';
import 'dotenv/config';

const OKX_API_BASE = 'https://web3.okx.com';
const TARGET_TX = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const USER_ADDRESS = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf03';
const CHAIN = 'bsc';

function createOkxHeaders(requestPathWithQuery) {
  const apiKey = process.env.OKX_API_KEY?.trim();
  const secretKey = process.env.OKX_SECRET_KEY?.trim();
  const passphrase = process.env.OKX_API_PASSPHRASE?.trim();

  if (!apiKey || !secretKey || !passphrase) {
    throw new Error('Missing OKX credentials in .env file');
  }

  const timestamp = new Date().toISOString();
  const prehash = `${timestamp}GET${requestPathWithQuery}`;
  const sign = crypto
    .createHmac('sha256', secretKey)
    .update(prehash)
    .digest('base64');

  return {
    'Content-Type': 'application/json',
    'OK-ACCESS-KEY': apiKey,
    'OK-ACCESS-SIGN': sign,
    'OK-ACCESS-PASSPHRASE': passphrase,
    'OK-ACCESS-TIMESTAMP': timestamp,
  };
}

async function fetchTransaction() {
  const chainIndex = CHAIN === 'bsc' ? '56' : '501';
  const now = Date.now();
  const seventyTwoHoursAgo = now - 72 * 60 * 60 * 1000;

  const params = new URLSearchParams({
    address: USER_ADDRESS,
    chains: chainIndex,
    begin: seventyTwoHoursAgo.toString(),
    end: now.toString(),
    limit: '100',
  });

  const requestPathWithQuery = `/api/v6/dex/post-transaction/transactions-by-address?${params}`;
  const headers = createOkxHeaders(requestPathWithQuery);

  console.log('🔍 Fetching transactions from OKX API...');
  console.log(`   Address: ${USER_ADDRESS}`);
  console.log(`   Chain: ${CHAIN} (index: ${chainIndex})`);
  console.log(`   Looking for tx: ${TARGET_TX}`);
  console.log('');

  const response = await fetch(`${OKX_API_BASE}${requestPathWithQuery}`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

function extractTransactions(payload) {
  if (Array.isArray(payload.data)) {
    const first = payload.data[0];
    if (Array.isArray(first?.transactionList)) {
      return first.transactionList;
    }
    if (Array.isArray(first?.transactions)) {
      return first.transactions;
    }
  }
  if (Array.isArray(payload.transactions)) {
    return payload.transactions;
  }
  return [];
}

async function main() {
  try {
    const result = await fetchTransaction();
    const transactions = extractTransactions(result);

    console.log(`✅ Fetched ${transactions.length} transactions\n`);

    const targetTx = transactions.find(tx =>
      tx.txHash?.toLowerCase() === TARGET_TX.toLowerCase()
    );

    if (!targetTx) {
      console.log('❌ Transaction not found in recent transactions (last 72 hours)');
      console.log('\nRecent transactions:');
      transactions.slice(0, 5).forEach((tx, i) => {
        console.log(`  ${i + 1}. ${tx.txHash} - ${tx.symbol} ${tx.amount}`);
      });
      return;
    }

    console.log('✅ Found target transaction!\n');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('                    TRANSACTION DETAILS');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log('📋 Basic Info:');
    console.log(`   TX Hash: ${targetTx.txHash}`);
    console.log(`   Symbol: ${targetTx.symbol}`);
    console.log(`   Amount: ${targetTx.amount}`);
    console.log(`   Status: ${targetTx.txStatus || 'N/A'}`);
    console.log('');

    console.log('🔧 Transaction Type:');
    console.log(`   itype/iType: ${targetTx.itype || targetTx.iType || 'N/A'}`);
    console.log(`   methodId: ${targetTx.methodId || 'N/A'}`);
    console.log(`   tag: ${targetTx.tag || 'N/A'}`);
    console.log(`   tokenAddress: ${targetTx.tokenAddress || targetTx.tokenContractAddress || 'N/A'}`);
    console.log('');

    console.log('📤 FROM addresses:');
    if (targetTx.from && targetTx.from.length > 0) {
      targetTx.from.forEach((item, i) => {
        const isUser = item.address?.toLowerCase() === USER_ADDRESS.toLowerCase();
        console.log(`   [${i}] ${item.address} ${isUser ? '👤 (USER)' : ''}`);
        console.log(`       Amount: ${item.amount || 'N/A'}`);
      });
    } else {
      console.log('   (empty)');
    }
    console.log('');

    console.log('📥 TO addresses:');
    if (targetTx.to && targetTx.to.length > 0) {
      targetTx.to.forEach((item, i) => {
        const isUser = item.address?.toLowerCase() === USER_ADDRESS.toLowerCase();
        console.log(`   [${i}] ${item.address} ${isUser ? '👤 (USER)' : ''}`);
        console.log(`       Amount: ${item.amount || 'N/A'}`);
      });
    } else {
      console.log('   (empty)');
    }
    console.log('');

    console.log('═══════════════════════════════════════════════════════════');
    console.log('                      ANALYSIS');
    console.log('═══════════════════════════════════════════════════════════\n');

    const userInFrom = (targetTx.from || []).some(item =>
      item?.address?.toLowerCase() === USER_ADDRESS.toLowerCase()
    );
    const userInTo = (targetTx.to || []).some(item =>
      item?.address?.toLowerCase() === USER_ADDRESS.toLowerCase()
    );

    console.log('🔍 User Position:');
    console.log(`   User address: ${USER_ADDRESS}`);
    console.log(`   User in FROM array: ${userInFrom ? '✅ YES' : '❌ NO'}`);
    console.log(`   User in TO array: ${userInTo ? '✅ YES' : '❌ NO'}`);
    console.log('');

    const rawType = targetTx.itype || targetTx.iType || '0';
    const isIncoming = userInTo && !userInFrom;
    const txAction = rawType === '1' ? (isIncoming ? 'buy' : 'sell') : (isIncoming ? 'receive' : 'send');

    console.log('💡 Current Logic Result:');
    console.log(`   rawType (itype): ${rawType}`);
    console.log(`   isIncoming: ${isIncoming} (userInTo && !userInFrom)`);
    console.log(`   txAction: ${txAction}`);
    console.log('');

    console.log('🎯 Expected Behavior:');
    if (rawType === '1') {
      console.log('   This is a contract interaction (DEX swap)');
      if (userInFrom && !userInTo) {
        console.log('   ✅ User is in FROM only → Token flows OUT → Should be SELL');
      } else if (userInTo && !userInFrom) {
        console.log('   ✅ User is in TO only → Token flows IN → Should be BUY');
      } else if (userInFrom && userInTo) {
        console.log('   ⚠️  User is in BOTH FROM and TO → Complex swap');
      } else {
        console.log('   ⚠️  User is in NEITHER → Uncertain transaction');
      }
    }
    console.log('');

    console.log('📄 Full Transaction JSON:');
    console.log(JSON.stringify(targetTx, null, 2));

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.message.includes('Missing OKX credentials')) {
      console.error('\n💡 Make sure your .env file contains:');
      console.error('   OKX_API_KEY=...');
      console.error('   OKX_SECRET_KEY=...');
      console.error('   OKX_API_PASSPHRASE=...');
    }
    process.exit(1);
  }
}

main();
