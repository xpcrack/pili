import assert from 'node:assert/strict';
import path from 'node:path';

const dbPath = process.env.PILIPILI_DB_PATH || '';
const dataDir = process.env.PILIPILI_DATA_DIR || '';
assert.ok(dbPath, 'runner should provide an isolated PILIPILI_DB_PATH');
assert.ok(dataDir, 'runner should provide an isolated PILIPILI_DATA_DIR');
assert.equal(path.dirname(dbPath), dataDir);
assert.equal(path.basename(dbPath), 'test.sqlite');
assert.equal(dbPath.includes(`${path.sep}.data${path.sep}`), false, 'tests must not default to production .data');
console.log('db-isolation fixture: ok');
