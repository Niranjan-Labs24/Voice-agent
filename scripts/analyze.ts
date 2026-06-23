// @ts-nocheck
import { readFileSync } from 'node:fs';

const GATES = { p50: 900, p95: 1400 };
const path = process.argv[2] ?? 'metrics/runs.jsonl';

let rows: any[];
try {
  rows = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l: string) => JSON.parse(l));
} catch (e) {
  console.error(`Could not read or parse ${path}. Ensure you have completed at least one conversation turn first.`);
  process.exit(1);
}

if (rows.length === 0) {
  console.error('No metrics found in the file.');
  process.exit(1);
}

const byLang = new Map<string, any[]>();
for (const r of rows) byLang.set(r.lang, [...(byLang.get(r.lang) ?? []), r]);

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};

console.log(`\n${rows.length} turns across ${byLang.size} languages\n`);
console.log('| lang | turns | eou p50 | ttft p50 | ttfb p50 | TOTAL p50 | TOTAL p95 | G1 | G2 |');
console.log('|---|---|---|---|---|---|---|---|---|');

for (const [lang, rs] of [...byLang.entries()].sort()) {
  const ms = (k: string, q: number) =>
    Math.round(pct(rs.map(r => r[k]), q) * (k === 'total_ms' ? 1 : 1000));
  
  const p50 = ms('total_ms', 0.5), p95 = ms('total_ms', 0.95);
  
  console.log(`| ${lang} | ${rs.length} | ${ms('eou_delay', 0.5)} | ${ms('llm_ttft', 0.5)} | ` +
    `${ms('tts_ttfb', 0.5)} | **${p50}** | ${p95} | ` +
    `${p50 <= GATES.p50 ? 'PASS' : 'FAIL'} | ${p95 <= GATES.p95 ? 'PASS' : 'FAIL'} |`);
}
