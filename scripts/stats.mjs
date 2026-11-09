#!/usr/bin/env node
// Polls a board's stats once a second. Handy in a second terminal during a
// failover test: watch "instance" change and how long the gap lasts.
// Usage: node scripts/stats.mjs --url https://wb.example.com --board load

const a = process.argv.slice(2);
const get = (k, d) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
const base = get("url", "http://localhost:8787").replace(/\/$/, "");
const board = get("board", "lobby");
let lastOk = Date.now(), down = false;

setInterval(async () => {
  const t0 = performance.now();
  try {
    const r = await fetch(`${base}/api/boards/${board}/stats`, { signal: AbortSignal.timeout(3000) });
    const s = await r.json();
    if (down) { console.log(`  back after ${((Date.now() - lastOk) / 1000).toFixed(1)}s`); down = false; }
    lastOk = Date.now();
    console.log(`${new Date().toISOString().slice(11, 19)} ${Math.round(performance.now() - t0)}ms instance=${s.node.activationId} strokes=${s.strokes} conns=${s.connections} activations=${s.activations} db=${s.databaseBytes == null ? "n/a" : `${Math.round(s.databaseBytes / 1024)}KB`}`);
  } catch (e) {
    if (!down) { down = true; console.log(`${new Date().toISOString().slice(11, 19)} UNREACHABLE (${e.name})`); }
  }
}, 1000);
