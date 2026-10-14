// node scripts/backfill-usage-cost.test.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backfill } from './backfill-usage-cost.mjs';
const dir = mkdtempSync(join(tmpdir(), '9router-cost-test-'));
try {
  const path = join(dir, 'usage.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE usageHistory(id INTEGER PRIMARY KEY,timestamp TEXT,provider TEXT,model TEXT,tokens TEXT,cost REAL,connectionId TEXT,apiKey TEXT,endpoint TEXT);
    CREATE TABLE usageDaily(dateKey TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE kv(scope TEXT,key TEXT,value TEXT);`);
  const model = 'gpt-6.1-sol(high)', provider = 'codex';
  const tokenCounts = { prompt_tokens: 1000, cached_tokens: 500, completion_tokens: 100 };
  const insert = db.prepare('INSERT INTO usageHistory VALUES(?,?,?,?,?,?,?,?,?)');
  insert.run(1, '2026-10-01T12:00:00', provider, model, JSON.stringify(tokenCounts), 0, 'account', 'test-key', '/v1');
  insert.run(2, '2026-10-01T12:01:00', provider, model, JSON.stringify(tokenCounts), 0.123, 'account', 'test-key', '/v1');
  // Aggregate contains preexisting increments: only row 1 is inside cutoff.
  const counter = { requests: 2, promptTokens: 2000, completionTokens: 200, cachedTokens: 1000, cost: 0.123, rawModel: model, provider };
  const day = { ...counter, byProvider: { [provider]: counter }, byModel: { [`${model}|${provider}`]: counter }, byAccount: { account: counter },
    byApiKey: { [`test-key|${model}|${provider}`]: { ...counter, apiKey: 'test-key' } }, byEndpoint: { [`/v1|${model}|${provider}`]: counter } };
  db.prepare('INSERT INTO usageDaily VALUES(?,?)').run('2026-10-01', JSON.stringify(day));
  let result = backfill(path, { cutoff: 1 });
  assert.equal(result.rowsChanged, 1);
  assert.equal(db.prepare('SELECT cost FROM usageHistory WHERE id=1').get().cost, 0);
  result = backfill(path, { apply: true, cutoff: 1 });
  assert.equal(result.rowsChanged, 1);
  assert.equal(result.dailyDays, 1);
  assert.ok(Math.abs(result.newTotal - 0.00205) < 1e-12);
  assert.equal(db.prepare('SELECT cost FROM usageHistory WHERE id=2').get().cost, 0.123);
  const patched = JSON.parse(db.prepare('SELECT data FROM usageDaily').get().data);
  assert.ok(Math.abs(patched.cost - 0.12505) < 1e-12);
  for (const bucket of ['byProvider','byModel','byAccount','byApiKey','byEndpoint']) {
    const entry = Object.values(patched[bucket])[0];
    assert.ok(Math.abs(entry.cost - 0.12505) < 1e-12);
    assert.equal(entry.requests, 2);
  }
  assert.equal(backfill(path, { cutoff: 1 }).rowsChanged, 0);
  // Exact user override, including suffixed id, wins over constants.
  db.prepare('INSERT INTO kv VALUES(?,?,?)').run('pricing', provider, JSON.stringify({ [model]: { input: 1, output: 1, cached: 0.1 } }));
  assert.ok(Math.abs(backfill(path, { cutoff: 1 }).newTotal - 0.00065) < 1e-12);
  // Missing counter must roll back all writes.
  delete patched.byEndpoint;
  db.prepare('UPDATE usageDaily SET data=?').run(JSON.stringify(patched));
  assert.throws(() => backfill(path, { apply: true, cutoff: 1 }), /Missing byEndpoint counters/);
  assert.ok(Math.abs(db.prepare('SELECT cost FROM usageHistory WHERE id=1').get().cost - 0.00205) < 1e-12);
  db.close();
  console.log('cost backfill checks passed');
} finally {
  rmSync(dir, { recursive: true });
}
