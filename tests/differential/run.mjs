#!/usr/bin/env node
// Differential integration-test runner: nightfrost REST (/api/v0) versus the
// Blockfrost-hosted Midnight preview indexer (GraphQL).
//
//   MIDNIGHT_BLOCKFROST_TOKEN=... node tests/differential/run.mjs
//
// Discovers and runs every module in ./checks (sorted by filename — use a
// numeric prefix to order; earlier checks populate shared discovery state in
// ctx for later ones). Exits 0 only if every category passes; writes a
// machine-readable report to tests/differential/report.json.

import { readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { config, makeContext, makeRecorder } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = config();
const ctx = makeContext(cfg);
const startedAt = new Date().toISOString();
const t0 = Date.now();

const files = (await readdir(join(here, 'checks'))).filter((f) => f.endsWith('.mjs')).sort();
const results = [];

for (const file of files) {
  const mod = await import(pathToFileURL(join(here, 'checks', file)).href);
  const name = mod.name ?? file.replace(/^\d+-/, '').replace(/\.mjs$/, '');
  const t = makeRecorder(name);
  process.stderr.write(`\n--- check: ${name} (${file}) ---\n`);
  try {
    await mod.run(ctx, t);
  } catch (e) {
    t.rec.error = String(e?.stack ?? e);
    t.mismatch('(check aborted)', 'error', String(e?.message ?? e), null);
  }
  results.push(t.rec);
}

const finishedAt = new Date().toISOString();
const report = {
  started_at: startedAt,
  finished_at: finishedAt,
  duration_seconds: Math.round((Date.now() - t0) / 1000),
  seed: cfg.seed,
  nightfrost_url: cfg.nightfrost,
  oracle_url: cfg.oracle,
  nightfrost_calls: ctx.stats.nfCalls,
  oracle_calls: ctx.stats.oracleCalls,
  pass: results.every((r) => r.mismatches.length === 0),
  categories: Object.fromEntries(
    results.map((r) => [
      r.name,
      {
        status: r.mismatches.length ? 'FAIL' : 'PASS',
        comparisons: r.comparisons,
        mismatches: r.mismatches,
        notes: r.notes,
        ...(r.error ? { error: r.error } : {}),
      },
    ]),
  ),
};
await writeFile(join(here, 'report.json'), JSON.stringify(report, null, 2) + '\n');

console.log(
  `\n=== differential report (seed ${cfg.seed}, ${report.duration_seconds}s, ` +
    `${ctx.stats.nfCalls} nightfrost calls, ${ctx.stats.oracleCalls} oracle calls) ===`,
);
console.log(`oracle:     ${cfg.oracle}`);
console.log(`nightfrost: ${cfg.nightfrost}`);
for (const r of results) {
  const status = r.mismatches.length ? 'FAIL' : 'PASS';
  console.log(`\n[${status}] ${r.name}: ${r.mismatches.length} mismatches across ${r.comparisons} comparisons`);
  for (const n of r.notes) console.log(`  note: ${n}`);
  for (const m of r.mismatches.slice(0, 50))
    console.log(
      `  MISMATCH ${m.id} :: ${m.field}\n` +
        `    nightfrost: ${JSON.stringify(m.nightfrost)?.slice(0, 300)}\n` +
        `    oracle:     ${JSON.stringify(m.oracle)?.slice(0, 300)}`,
    );
  if (r.mismatches.length > 50) console.log(`  ... and ${r.mismatches.length - 50} more`);
}
console.log(`\nreport written to tests/differential/report.json`);
process.exit(report.pass ? 0 : 1);
