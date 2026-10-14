// node scripts/backfill-usage-cost.mjs <backup.sqlite> [--dry-run|--apply] [--cutoff=<id>]
// Dry-run against a .backup copy; apply against the live DB after taking a backup.
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { getPricingForModel, calculateCostFromTokens } from '../open-sse/providers/pricing.js';

export function backfill(dbPath, { apply = false, cutoff } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: !apply });
  db.exec('PRAGMA busy_timeout = 10000');
  let transaction = false;
  try {
    // Compute from a read snapshot without blocking the live gateway's writes.
    db.exec('BEGIN');
    transaction = true;
    const maxId = db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM usageHistory').get().id;
    cutoff ??= maxId;
    if (!Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff > maxId) throw new Error('Invalid cutoff');
    const user = Object.fromEntries(db.prepare("SELECT key,value FROM kv WHERE scope='pricing'").all().map(r => [r.key, JSON.parse(r.value)]));
    const groups = new Map();
    const prices = new Map();
    const skipped = new Map();
    let rowsChanged = 0, rows = 0, oldTotal = 0, newTotal = 0;
    if (apply) db.exec('CREATE TEMP TABLE costDelta (id INTEGER PRIMARY KEY, newCost REAL NOT NULL, delta REAL NOT NULL, dateKey TEXT NOT NULL)');
    const insert = apply ? db.prepare('INSERT INTO costDelta VALUES (?,?,?,?)') : null;
    // No apiKey, prompts, request bodies, or credential fields leave SQLite.
    const history = db.prepare('SELECT id,timestamp,provider,model,tokens,cost FROM usageHistory WHERE id <= ? ORDER BY id');
    for (const row of history.iterate(cutoff)) {
      const key = JSON.stringify([row.provider, row.model]);
      if (!prices.has(key)) prices.set(key, user[row.provider]?.[row.model] || getPricingForModel(row.provider, row.model));
      const pricing = prices.get(key);
      const oldCost = row.cost ?? 0;
      if (!Number.isFinite(oldCost)) throw new Error(`Invalid stored cost at row ${row.id}`);
      // Unknown public price: preserve existing cost, don't invent a replacement.
      const tokens = JSON.parse(row.tokens || '{}');
      if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) throw new Error(`Invalid usage at row ${row.id}`);
      for (const field of ['prompt_tokens','input_tokens','completion_tokens','output_tokens','cached_tokens','cache_read_input_tokens','cache_creation_input_tokens','reasoning_tokens']) {
        if (tokens[field] != null && (typeof tokens[field] !== 'number' || !Number.isFinite(tokens[field]) || tokens[field] < 0)) throw new Error(`Invalid usage count at row ${row.id}`);
      }
      const newCost = pricing ? calculateCostFromTokens(tokens, pricing) : oldCost;
      if (!Number.isFinite(newCost) || newCost < 0) throw new Error(`Invalid calculated cost at row ${row.id}`);
      if (!pricing) skipped.set(key, (skipped.get(key) || 0) + 1);
      let group = groups.get(key);
      if (!group) groups.set(key, group = { provider: row.provider, model: row.model, rows: 0, changed: 0, oldTotal: 0, newTotal: 0 });
      group.rows++; group.oldTotal += oldCost; group.newTotal += newCost;
      rows++; oldTotal += oldCost; newTotal += newCost;
      if (Math.abs(newCost - oldCost) <= 1e-12) continue;
      group.changed++; rowsChanged++;
      if (apply) {
        const date = new Date(row.timestamp);
        if (!Number.isFinite(date.getTime())) throw new Error(`Invalid timestamp at row ${row.id}`);
        // Same local calendar day as usageRepo.getLocalDateKey (run in gateway TZ).
        const dateKey = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
        insert.run(row.id, newCost, newCost - oldCost, dateKey);
      }
    }
    db.exec('COMMIT'); transaction = false;
    let dailyDays = 0, lockMs = 0, maxLockMs = 0;
    const changedDays = new Set();
    if (apply && rowsChanged) {
      // ponytail: 10K rows per atomic history+daily patch to keep live writer waits
      // below the gateway's 5s timeout; rerun after interruption repairs remaining rows.
      db.exec('ALTER TABLE costDelta RENAME TO candidates');
      rowsChanged = 0;
      let after = 0;
      while (true) {
        db.exec('DROP TABLE IF EXISTS temp.costDelta; DROP TABLE IF EXISTS temp.dailyCostDelta');
        db.prepare('CREATE TEMP TABLE costDelta AS SELECT * FROM candidates WHERE id > ? ORDER BY id LIMIT 10000').run(after);
        db.exec('CREATE UNIQUE INDEX temp.costDeltaId ON costDelta(id)');
        const last = db.prepare('SELECT MAX(id) AS id FROM costDelta').get().id;
        if (last == null) break;
        after = last;
        const started = performance.now();
        db.exec('BEGIN IMMEDIATE'); transaction = true;
        // Re-read stored costs under the lock; retries never apply stale deltas.
        db.exec(`UPDATE costDelta SET delta=newCost-(SELECT COALESCE(cost,0) FROM usageHistory WHERE id=costDelta.id);
          DELETE FROM costDelta WHERE ABS(delta) <= 1e-12;`);
        const chunkRows = db.prepare('SELECT count(*) AS n FROM costDelta').get().n;
        for (const row of db.prepare('SELECT DISTINCT dateKey FROM costDelta').all()) changedDays.add(row.dateKey);
        const missing = db.prepare('SELECT count(*) AS n FROM costDelta d LEFT JOIN usageDaily u ON u.dateKey=d.dateKey WHERE u.dateKey IS NULL').get().n;
        if (missing) throw new Error('Missing daily aggregates; check gateway timezone');
        db.exec(`CREATE TEMP TABLE dailyCostDelta (dateKey TEXT, bucket TEXT, key TEXT, delta REAL, PRIMARY KEY(dateKey,bucket,key));
          INSERT INTO dailyCostDelta
          SELECT d.dateKey,'byProvider',h.provider,SUM(d.delta) FROM costDelta d JOIN usageHistory h ON h.id=d.id WHERE COALESCE(h.provider,'') != '' GROUP BY d.dateKey,h.provider;
          INSERT INTO dailyCostDelta
          SELECT d.dateKey,'byModel',CASE WHEN COALESCE(h.provider,'') != '' THEN h.model || '|' || h.provider ELSE h.model END,SUM(d.delta) FROM costDelta d JOIN usageHistory h ON h.id=d.id GROUP BY 1,3;
          INSERT INTO dailyCostDelta
          SELECT d.dateKey,'byAccount',h.connectionId,SUM(d.delta) FROM costDelta d JOIN usageHistory h ON h.id=d.id WHERE COALESCE(h.connectionId,'') != '' GROUP BY 1,3;
          INSERT INTO dailyCostDelta
          SELECT d.dateKey,'byApiKey',COALESCE(NULLIF(h.apiKey,''),'local-no-key') || '|' || h.model || '|' || COALESCE(NULLIF(h.provider,''),'unknown'),SUM(d.delta) FROM costDelta d JOIN usageHistory h ON h.id=d.id GROUP BY 1,3;
          INSERT INTO dailyCostDelta
          SELECT d.dateKey,'byEndpoint',COALESCE(NULLIF(h.endpoint,''),'Unknown') || '|' || h.model || '|' || COALESCE(NULLIF(h.provider,''),'unknown'),SUM(d.delta) FROM costDelta d JOIN usageHistory h ON h.id=d.id GROUP BY 1,3;`);
        // Validate every changed counter exists before writing, without returning its key.
        for (const bucket of ['byProvider','byModel','byAccount','byApiKey','byEndpoint']) {
          const missingKeys = db.prepare(`SELECT count(*) AS n FROM dailyCostDelta d JOIN usageDaily u USING(dateKey)
            WHERE d.bucket=? AND NOT EXISTS (SELECT 1 FROM json_each(u.data,?) e WHERE e.key=d.key)`).get(bucket, `$.${bucket}`).n;
          if (missingKeys) throw new Error(`Missing ${bucket} counters; refusing partial backfill`);
          db.prepare(`UPDATE usageDaily SET data=json_set(data,?,json((
            SELECT json_group_object(e.key,json(json_set(e.value,'$.cost',COALESCE(json_extract(e.value,'$.cost'),0)+COALESCE(d.delta,0))))
            FROM json_each(usageDaily.data,?) e LEFT JOIN dailyCostDelta d ON d.dateKey=usageDaily.dateKey AND d.bucket=? AND d.key=e.key
          ))) WHERE dateKey IN (SELECT DISTINCT dateKey FROM costDelta)`).run(`$.${bucket}`, `$.${bucket}`, bucket);
        }
        db.prepare(`UPDATE usageDaily SET data=json_set(data,'$.cost',COALESCE(json_extract(data,'$.cost'),0)+
          (SELECT SUM(delta) FROM costDelta WHERE dateKey=usageDaily.dateKey)) WHERE dateKey IN (SELECT DISTINCT dateKey FROM costDelta)`).run().changes;
        const updated = db.prepare('UPDATE usageHistory SET cost=(SELECT newCost FROM costDelta WHERE id=usageHistory.id) WHERE id IN (SELECT id FROM costDelta)').run().changes;
        if (updated !== chunkRows) throw new Error('History update count mismatch');
        db.exec('COMMIT'); transaction = false;
        rowsChanged += updated;
        const elapsed = performance.now() - started;
        lockMs += elapsed; maxLockMs = Math.max(maxLockMs, elapsed);
        // Give queued gateway writers a turn before taking the next lock.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      dailyDays = changedDays.size;
    }
    return { mode: apply ? 'apply' : 'dry-run', cutoff, rows, rowsChanged, oldTotal, newTotal, dailyDays, lockMs, maxLockMs,
      groups: [...groups.values()].sort((a,b) => b.newTotal-a.newTotal),
      unpriced: [...skipped].map(([key, rows]) => ({ provider: JSON.parse(key)[0], model: JSON.parse(key)[1], rows })) };
  } finally {
    if (transaction) db.exec('ROLLBACK');
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dbPath, ...args] = process.argv.slice(2);
  if (!dbPath || args.some(arg => !['--dry-run','--apply'].includes(arg) && !/^--cutoff=\d+$/.test(arg)) || (args.includes('--dry-run') && args.includes('--apply'))) {
    console.error('Usage: node scripts/backfill-usage-cost.mjs <database.sqlite> [--dry-run|--apply] [--cutoff=<id>]');
    process.exitCode = 1;
  } else {
    const cutoffArg = args.find(arg => arg.startsWith('--cutoff='));
    console.log(JSON.stringify(backfill(dbPath, { apply: args.includes('--apply'), cutoff: cutoffArg ? Number(cutoffArg.slice(9)) : undefined }), null, 2));
  }
}
