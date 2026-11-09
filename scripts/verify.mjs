#!/usr/bin/env node
// Durability check. Compares every stroke id a bot saw acked against what the
// board actually has stored. Any acked id missing from the board is a lost
// acknowledged write, which the failover experiment is looking for.
//
// Usage: node scripts/verify.mjs --url https://wb.example.com --dir results/<run>

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
const base = (args.url || "http://localhost:8787").replace(/\/$/, "");
const dir = args.dir;
if (!dir) { console.error("Pass --dir results/<run>"); process.exit(2); }

let totalAcked = 0, totalMissing = 0;
for (const file of readdirSync(dir).filter((f) => f.startsWith("acked-"))) {
  const { board, ids } = JSON.parse(readFileSync(join(dir, file), "utf8"));
  let res;
  try {
    res = await fetch(`${base}/api/boards/${board}/strokes`, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    console.error(`${board}: unreachable (${e.name}). Is the server up?`); process.exitCode = 1; continue;
  }
  if (!res.ok) { console.error(`${board}: HTTP ${res.status}`); process.exitCode = 1; continue; }
  const stored = new Set((await res.json()).ids);
  const missing = ids.filter((id) => !stored.has(id));
  totalAcked += ids.length; totalMissing += missing.length;
  console.log(`${board}: acked=${ids.length} stored=${stored.size} missing=${missing.length}`);
  if (missing.length) console.log(`  first missing: ${missing.slice(0, 5).join(", ")}`);
}
console.log(`\nTOTAL acked=${totalAcked} lost=${totalMissing} ${totalMissing === 0 ? "PASS: no acknowledged writes lost" : "FAIL: acknowledged writes were lost"}`);
if (totalMissing) process.exitCode = 1;
