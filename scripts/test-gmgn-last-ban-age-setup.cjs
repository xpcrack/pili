// Bootstrap: gmgnRateLimit resolves GMGN_BAN_COOLDOWN_FILE at import time.
// This file must be imported BEFORE '@/lib/server/gmgnRateLimit' so the module
// under test reads the throwaway cooldown file, not the operator's real one.
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const dir = mkdtempSync(path.join(tmpdir(), 'gmgn-ban-'));
const file = path.join(dir, 'ban-cooldown.json');
writeFileSync(file, JSON.stringify({ untilMs: 0 }), 'utf8');
process.env.GMGN_BAN_COOLDOWN_FILE = file;
