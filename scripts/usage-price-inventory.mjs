import { DatabaseSync } from 'node:sqlite';
import { getPricingForModel, MODEL_PRICING, PROVIDER_PRICING, PATTERN_PRICING, matchPattern } from '../open-sse/providers/pricing.js';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const user = Object.fromEntries(db.prepare("SELECT key,value FROM kv WHERE scope='pricing'").all().map(r => [r.key, JSON.parse(r.value)]));
for (const row of db.prepare('SELECT provider,model,count(*) AS rows FROM usageHistory GROUP BY provider,model ORDER BY count(*) DESC').all()) {
  const stripped = row.model.replace(/\([^()]+\)\s*$/, '').trim(), base = stripped.split('/').pop();
  const pricing = user[row.provider]?.[row.model] ?? getPricingForModel(row.provider, row.model);
  const free = stripped.startsWith('cline-free/') || stripped.endsWith('-free') || stripped.endsWith(':free');
  const source = user[row.provider]?.[row.model] ? 'user override' : PROVIDER_PRICING[row.provider]?.[stripped] ? 'provider exact' : MODEL_PRICING[base] ? (stripped !== row.model ? 'suffix-stripped exact' : 'exact') : free ? 'free' :PATTERN_PRICING.find(x => matchPattern(x.pattern, base))?.pattern ?? 'null';
  console.log(JSON.stringify({ ...row, source, pricing }));
}
db.close();
