/**
 * 对比: 飞书(newone sources)已启用且有推特的人物,在 pili 里是否被监控 / 推特是否对得上。
 *
 * 口径(比 feishuEnablementSync 更宽容,避免按名字误判):
 *   - newone sources kind='wallet' AND disabled=0,meta_json 里取 person_name + twitter
 *   - 按 person_name.toLowerCase() 分组成"人物"
 *   - pili 侧匹配键:先按推特,再按"钱包地址归属的 tracked_user"。只有两者都匹配不到才算"漏监控"
 *   - 推特对齐:该飞书人物的钱包在 pili 归属到的用户,其 twitter 必须与飞书一致(否则算"推特没回填")
 *
 * Usage: npx tsx scripts/check-feishu-twitter-coverage.ts
 * Read-only.
 */
import './server-only-shim.cjs';

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { getDb } from '../lib/server/sqlite';

const require = createRequire(import.meta.url);

type NewoneSqlite = {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
};

function isBunRuntime() {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

function openNewoneReadonly(newonePath: string): NewoneSqlite {
  if (isBunRuntime()) {
    const { Database } = require('bun:sqlite') as {
      Database: new (filename: string, opts?: { readonly?: boolean }) => NewoneSqlite;
    };
    return new Database(newonePath, { readonly: true });
  }
  const BetterSqlite3 = require('better-sqlite3') as new (
    filename: string,
    opts?: { readonly?: boolean }
  ) => NewoneSqlite;
  return new BetterSqlite3(newonePath, { readonly: true });
}

function resolveNewoneDbPath() {
  const fromEnv = (process.env.NEWONE_DB_PATH || process.env.PILI_NEWONE_DB_PATH || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), '..', 'newone', 'data', 'newone.sqlite');
}

function parseMetaJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}

type FeishuPerson = {
  name: string;
  twitter: string;
  walletCount: number;
  addressLowers: string[];
};

function readFeishuEnabledPeopleWithTwitter(): FeishuPerson[] {
  const newonePath = resolveNewoneDbPath();
  if (!existsSync(newonePath)) {
    throw new Error(`newone db not found: ${newonePath}`);
  }
  const db = openNewoneReadonly(newonePath);
  try {
    const rows = db
      .prepare(`SELECT external_id, label, meta_json FROM sources WHERE kind = 'wallet' AND disabled = 0`)
      .all() as Array<{ external_id: string; label: string | null; meta_json?: string | null }>;

    const byPersonKey = new Map<string, FeishuPerson>();
    for (const row of rows) {
      const address = String(row.external_id || '').trim();
      if (!address) continue;
      const meta = parseMetaJson(row.meta_json);
      const metaPerson = typeof meta.person_name === 'string' ? meta.person_name.trim() : '';
      const label = String(row.label || '').trim();
      const personName = metaPerson || label;
      if (!personName) continue;
      const twitter =
        typeof meta.twitter === 'string' && meta.twitter.trim() ? meta.twitter.trim() : '';
      if (!twitter) continue; // 只关心有推特的

      const key = personName.toLowerCase();
      let group = byPersonKey.get(key);
      if (!group) {
        group = { name: personName, twitter, walletCount: 0, addressLowers: [] };
        byPersonKey.set(key, group);
      }
      group.walletCount += 1;
      group.addressLowers.push(address.toLowerCase());
      if (!group.twitter && twitter) group.twitter = twitter;
    }
    return [...byPersonKey.values()];
  } finally {
    db.close();
  }
}

type PiliUser = {
  id: string;
  name: string;
  twitter: string | null;
  monitoringEnabled: boolean;
};

function readPiliUsers(): { byTwitter: Map<string, PiliUser[]>; byId: Map<string, PiliUser> } {
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, name, twitter, monitoring_enabled FROM tracked_users`)
    .all() as Array<{ id: string; name: string; twitter: string | null; monitoring_enabled: number | null }>;
  const byTwitter = new Map<string, PiliUser[]>();
  const byId = new Map<string, PiliUser>();
  for (const row of rows) {
    const u: PiliUser = {
      id: row.id,
      name: String(row.name || '').trim(),
      twitter: row.twitter ? String(row.twitter).trim() : null,
      monitoringEnabled: row.monitoring_enabled == null ? true : row.monitoring_enabled !== 0,
    };
    byId.set(u.id, u);
    if (u.twitter) {
      const key = u.twitter.toLowerCase();
      const list = byTwitter.get(key) || [];
      list.push(u);
      byTwitter.set(key, list);
    }
  }
  return { byTwitter, byId };
}

/** 钱包地址 → 归属的 pili user_id。 */
function readPiliAddressOwners(): Map<string, string> {
  const db = getDb();
  const rows = db
    .prepare(`SELECT address_lower, user_id FROM tracked_addresses`)
    .all() as Array<{ address_lower: string; user_id: string }>;
  const m = new Map<string, string>();
  for (const row of rows) {
    const lower = String(row.address_lower || '').trim().toLowerCase();
    if (lower && !m.has(lower)) m.set(lower, row.user_id);
  }
  return m;
}

function main() {
  const feishuPeople = readFeishuEnabledPeopleWithTwitter();
  const { byTwitter, byId } = readPiliUsers();
  const addrOwner = readPiliAddressOwners();

  const missing: FeishuPerson[] = []; // 钱包在 pili 没有任何归属 + 推特也匹配不到
  const twitterMismatch: Array<{ feishu: FeishuPerson; pili: PiliUser }> = [];
  let aligned = 0;

  for (const fp of feishuPeople) {
    // 1) 先按推特匹配 pili 用户
    let piliUsers = byTwitter.get(fp.twitter.toLowerCase()) || [];
    // 2) 推特没匹配上,按钱包地址归属找 pili 用户
    if (piliUsers.length === 0) {
      const ownerIds = new Set<string>();
      for (const lower of fp.addressLowers) {
        const oid = addrOwner.get(lower);
        if (oid) ownerIds.add(oid);
      }
      piliUsers = [...ownerIds].map((id) => byId.get(id)).filter((u): u is PiliUser => Boolean(u));
    }

    if (piliUsers.length === 0) {
      missing.push(fp);
      continue;
    }

    // 推特对齐判定:这些 pili 用户里,有没有人的 twitter 正好等于飞书的
    const matched = piliUsers.find((u) => (u.twitter || '').toLowerCase() === fp.twitter.toLowerCase());
    if (matched) {
      aligned += 1;
    } else {
      // 钱包归属到了 pili 用户,但该用户的推特不是飞书的值(空或旧值)
      const rep = piliUsers[0];
      twitterMismatch.push({ feishu: fp, pili: rep });
    }
  }

  console.log(`飞书已启用且有推特的人物: ${feishuPeople.length}`);
  console.log(`  ├─ pili 推特已对齐: ${aligned}`);
  console.log(`  ├─ pili 有钱包但推特没回填/不一致: ${twitterMismatch.length}`);
  console.log(`  └─ pili 完全无监控(钱包没归属、推特没匹配): ${missing.length}`);
  console.log('');

  if (twitterMismatch.length) {
    console.log('=== 钱包在 pili 监控,但推特没跟上飞书 ===');
    for (const { feishu, pili } of twitterMismatch) {
      console.log(
        `  飞书: ${feishu.name} @${feishu.twitter}  →  pili: ${pili.name} @${pili.twitter || '(空)'}  monitored=${pili.monitoringEnabled}`,
      );
    }
    console.log('');
  }
  if (missing.length) {
    console.log('=== 完全没在 pili 监控 (钱包没归属 + 推特没匹配) ===');
    for (const fp of missing) {
      console.log(`  ${fp.name}  @${fp.twitter}  (${fp.walletCount}个钱包)`);
    }
    console.log('');
  }

  if (missing.length === 0 && twitterMismatch.length === 0) {
    console.log('✓ 飞书已启用且有推特的人物,pili 全部已监控且推特与飞书一致。');
  }
}

main();
