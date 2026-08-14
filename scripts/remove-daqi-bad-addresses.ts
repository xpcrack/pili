/**
 * Remove two bad addresses from 大齐's tracked set (confirmed not his).
 * Deletes tracked_addresses rows + purges their events/feed data via the
 * repo's removeTrackedAddress, then clears leftover wallet_token_pnl rows
 * (purgeAddressRelatedData does not touch that table).
 */
import './server-only-shim.cjs';

import { getDb, withSqliteBusyRetry } from '../lib/server/sqlite';
import { removeTrackedAddress } from '../lib/server/trackedUsersRepo';

const DAQI_USER_ID = '96d450b5-7a52-4274-9f8c-2184dc29428a';
const ADDRESSES = [
  '8vtp7k9xybmfj4qid2nvgrp5jd6o3zvrcukprc8p2sye',
  'eao6b68vxdrvp5lfqx3jjjnchzm3kworsuubxcfnrjpz',
];

const db = getDb();

for (const addr of ADDRESSES) {
  const before = {
    tracked: db.prepare('SELECT COUNT(*) FROM tracked_addresses WHERE address_lower = ?').get(addr) as { 'COUNT(*)': number },
    events: db.prepare('SELECT COUNT(*) FROM events WHERE address = ?').get(addr) as { 'COUNT(*)': number },
    pnl: db.prepare('SELECT COUNT(*) FROM wallet_token_pnl WHERE wallet_address_lower = ?').get(addr) as { 'COUNT(*)': number },
  };
  console.log(`\n== ${addr} ==`);
  console.log(`  删除前: tracked=${before.tracked['COUNT(*)']} events=${before.events['COUNT(*)']} pnl=${before.pnl['COUNT(*)']}`);

  const removed = removeTrackedAddress(DAQI_USER_ID, addr);
  console.log(`  removeTrackedAddress → ${removed ? '已移除' : '未找到(可能已不在名单)'}`);

  const delPnl = withSqliteBusyRetry(() =>
    db.prepare('DELETE FROM wallet_token_pnl WHERE wallet_address_lower = ?').run(addr)
  );
  console.log(`  wallet_token_pnl 清理 ${delPnl.changes} 行`);

  const after = {
    tracked: db.prepare('SELECT COUNT(*) FROM tracked_addresses WHERE address_lower = ?').get(addr) as { 'COUNT(*)': number },
    events: db.prepare('SELECT COUNT(*) FROM events WHERE address = ?').get(addr) as { 'COUNT(*)': number },
    pnl: db.prepare('SELECT COUNT(*) FROM wallet_token_pnl WHERE wallet_address_lower = ?').get(addr) as { 'COUNT(*)': number },
  };
  console.log(`  删除后: tracked=${after.tracked['COUNT(*)']} events=${after.events['COUNT(*)']} pnl=${after.pnl['COUNT(*)']}`);
}

const left = db
  .prepare('SELECT COUNT(*) FROM tracked_addresses WHERE user_id = ?')
  .get(DAQI_USER_ID) as { 'COUNT(*)': number };
console.log(`\n大齐名下剩余地址数: ${left['COUNT(*)']}`);