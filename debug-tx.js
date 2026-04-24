import { config as loadEnv } from 'dotenv';
import crypto from 'node:crypto';

loadEnv({ path: '.env.local' });

const OKX_API_BASE = 'https://web3.okx.com';
const TARGET_TX = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function createOkxHeaders(requestPathWithQuery) {
  const apiKey = process.env.OKX_API_KEY?.trim();
  const secretKey = process.env.OKX_SECRET_KEY?.trim();
  const passphrase = process.env.OKX_API_PASSPHRASE?.trim();

  if (!apiKey || !secretKey || !passphrase) {
    throw new Error('Missing OKX credentials');
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

async function fetchTransaction(address, chain) {
  const chainIndex = chain === 'bsc' ? '56' : '501';
  const now = Date.now();
  const seventyTwoHoursAgo = now - 72 * 60 * 60 * 1000;

  const params = new URLSearchParams({
    address,
    chains: chainIndex,
    begin: seventyTwoHoursAgo.toString(),
    end: now.toString(),
    limit: '100',
  });

  const requestPathWithQuery = `/api/v6/dex/post-transaction/transactions-by-address?${params}`;
  const headers = createOkxHeaders(requestPathWithQuery);

  const response = await fetch(`${OKX_API_BASE}${requestPathWithQuery}`, {
    method: 'GET',
    headers,
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

async function main() {
  const address = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf03';
  const chain = 'bsc';

  console.log('Fetching transactions for address:', address);
  console.log('Looking for tx:', TARGET_TX);
  console.log('');

  const result = await fetchTransaction(address, chain);

  // 提取交易列表
  let transactions = [];
  if (Array.isArray(result.data)) {
    const first = result.data[0];
    if (Array.isArray(first?.transactionList)) {
      transactions = first.transactionList;
    } else if (Array.isArray(first?.transactions)) {
      transactions = first.transactions;
    }
  } else if (Array.isArray(result.transactions)) {
    transactions = result.transactions;
  }

  console.log(`Total transactions: ${transactions.length}`);
  console.log('');

  // 查找目标交易
  const targetTx = transactions.find(tx =>
    tx.txHash?.toLowerCase() === TARGET_TX.toLowerCase()
  );

  if (!targetTx) {
    console.log('❌ Transaction not found in recent transactions');
    console.log('Available transactions:');
    transactions.slice(0, 5).forEach(tx => {
      console.log(`  - ${tx.txHash} (${tx.symbol})`);
    });
    return;
  }

  console.log('✅ Found transaction!');
  console.log('');
  console.log('=== Transaction Details ===');
  console.log(JSON.stringify(targetTx, null, 2));
  console.log('');
  console.log('=== Key Fields ===');
  console.log('txHash:', targetTx.txHash);
  console.log('symbol:', targetTx.symbol);
  console.log('amount:', targetTx.amount);
  console.log('itype/iType:', targetTx.itype || targetTx.iType);
  console.log('methodId:', targetTx.methodId);
  console.log('tag:', targetTx.tag);
  console.log('');
  console.log('from addresses:');
  (targetTx.from || []).forEach((item, i) => {
    console.log(`  [${i}] ${item.address} (${item.amount})`);
  });
  console.log('');
  console.log('to addresses:');
  (targetTx.to || []).forEach((item, i) => {
    console.log(`  [${i}] ${item.address} (${item.amount})`);
  });
  console.log('');
  console.log('User address:', address.toLowerCase());
  console.log('User in from?', (targetTx.from || []).some(item =>
    item?.address?.toLowerCase() === address.toLowerCase()
  ));
  console.log('User in to?', (targetTx.to || []).some(item =>
    item?.address?.toLowerCase() === address.toLowerCase()
  ));
}

main().catch(console.error);
