/**
 * Mirror newone (Feishu) wallet enablement into pili monitoring_enabled flags.
 *
 *   npx tsx scripts/sync-feishu-enablement.ts
 *   NEWONE_DB_PATH=/path/to/newone.sqlite npx tsx scripts/sync-feishu-enablement.ts
 */
import './server-only-shim.cjs';

import { syncFeishuEnablementFromNewone } from '../lib/server/feishuEnablementSync';

const result = syncFeishuEnablementFromNewone();
if (!result.ok) {
  console.error('[sync-feishu-enablement] FAILED', result);
  process.exit(1);
}
console.log('[sync-feishu-enablement] OK', result);
