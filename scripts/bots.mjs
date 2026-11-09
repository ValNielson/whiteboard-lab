#!/usr/bin/env node
// Simulated whiteboard users. Each bot holds a WebSocket, moves its cursor,
// draws strokes, and pings. It records:
//   - round-trip time (ping -> pong)
//   - save time (stroke sent -> ack received)
//   - every stroke id that was acked (written to results/<run>/acked-*.json)
//   - reconnects, and every change of board instance (activation id)
// Unacked strokes are resent after reconnecting, like the real client.
//
// Usage:
//   node scripts/bots.mjs --url https://wb.example.com --board load1 --clients 20 --duration 60
//   node scripts/bots.mjs --url ... --board hot --ramp 10 --ramp-every 15 --max-clients 400
//   node scripts/bots.mjs --url ... --boards 50 --clients 4      (spread over 50 boards)
// Requires Node 22+ (built-in WebSocket).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const URL_BASE = (args.url || "http://localhost:8787").replace(/\/$/, "");
const BOARD = args.board || "load";
const BOARDS = Number(args.boards || 1);            // >1 spreads bots across board-0..board-N
const CLIENTS = Number(args.clients || 10);         // bots per board (initial)
const DURATION = Number(args.duration || 60) * 1000;
const STROKE_EVERY = Number(args["stroke-every"] || 2) * 1000;
const CURSOR_HZ = Number(args["cursor-hz"] || 10);
const RAMP = Number(args.ramp || 0);                 // add this many bots per step (per board)
const RAMP_EVERY = Number(args["ramp-every"] || 15) * 1000;
const MAX_CLIENTS = Number(args["max-clients"] || 1000);
const RUN = args.run || new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join("results", RUN);
mkdirSync(OUT, { recursive: true });

const wsBase = URL_BASE.replace(/^http/, "ws");
const boards = BOARDS > 1 ? Array.from({ length: BOARDS }, (_, i) => `${BOARD}-${i}`) : [BOARD];

// Global measurement buckets. "window" resets every report; "all" is the run total.
const m = { rttWin: [], ackWin: [], rttAll: [], ackAll: [], sent: 0, acked: 0, dupAcks: 0, reconnects: 0, connectTimeouts: 0, errors: 0, activations: new Map() };
const ackedIds = new Map(boards.map((b) => [b, []]));
const bots = [];
const started = Date.now();
let stopping = false;

class Bot {
  constructor(board, n) {
    this.board = board; this.n = n;
    this.clientId = `bot-${RUN}-${board}-${n}`;
    this.pending = new Map(); // id -> sentAt
    this.angle = Math.random() * Math.PI * 2;
    this.x = 200 + Math.random() * 1600; this.y = 200 + Math.random() * 850;
    this.strokeNo = 0; this.timers = [];
    this.connect();
  }
  connect() {
    if (stopping) return;
    const q = new URLSearchParams({ client: this.clientId, name: `bot ${this.n}`, color: "#6b4c9a", bot: "1" });
    this.ws = new WebSocket(`${wsBase}/api/boards/${this.board}/ws?${q}`);
    // A half-dead server can accept TCP but never finish the handshake, so give
    // up on a connection attempt that isn't open within 5s and retry.
    const ws = this.ws;
    const guard = setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) { m.connectTimeouts++; try { ws.close(); } catch {} ws.onclose?.(); ws.onclose = null; } }, 5000);
    this.ws.onopen = () => { clearTimeout(guard); this.onOpen(); };
    this.ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    this.ws.onerror = () => { m.errors++; };
    this.ws.onclose = () => {
      clearTimeout(guard);
      ws.onclose = null; // fire once per attempt
      this.clearTimers();
      if (stopping) return;
      m.reconnects++;
      setTimeout(() => this.connect(), 500 + Math.random() * 1000);
    };
  }
  onOpen() {
    this.timers.push(setInterval(() => this.cursor(), 1000 / CURSOR_HZ));
    this.timers.push(setInterval(() => this.ping(), 1000));
    // Stagger strokes so bots don't all fire on the same tick.
    // Track the stagger timeout too, so a disconnect before it fires doesn't
    // leave an orphan stroke interval running (which would double the rate).
    this.stagger = setTimeout(() => this.timers.push(setInterval(() => this.stroke(), STROKE_EVERY)), Math.random() * STROKE_EVERY);
  }
  onMessage(msg) {
    if (msg.t === "init") {
      noteActivation(this.board, msg.node);
      for (const [id] of this.pending) this.sendStroke(id, true); // resend unacked
    } else if (msg.t === "pong") {
      const v = performance.now() - msg.ts; m.rttWin.push(v); m.rttAll.push(v);
      noteActivation(this.board, msg.node);
    } else if (msg.t === "ack") {
      const sentAt = this.pending.get(msg.id);
      if (sentAt === undefined) return;
      this.pending.delete(msg.id);
      const v = performance.now() - sentAt; m.ackWin.push(v); m.ackAll.push(v);
      m.acked++; if (msg.dup) m.dupAcks++;
      ackedIds.get(this.board).push(msg.id);
    }
  }
  send(o) { if (this.ws.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(o)); return true; } return false; }
  cursor() {
    this.angle += (Math.random() - 0.5) * 0.6;
    this.x = clamp(this.x + Math.cos(this.angle) * 12, 20, 1980);
    this.y = clamp(this.y + Math.sin(this.angle) * 12, 20, 1230);
    this.send({ t: "cursor", x: this.x, y: this.y });
  }
  ping() { this.send({ t: "ping", ts: performance.now() }); }
  stroke() {
    const id = `${this.clientId}-${++this.strokeNo}`;
    this.pending.set(id, performance.now());
    m.sent++;
    this.strokes ??= new Map();
    const pts = []; let a = Math.random() * Math.PI * 2, x = this.x, y = this.y;
    for (let i = 0; i < 20; i++) { a += (Math.random() - 0.5) * 0.8; x += Math.cos(a) * 8; y += Math.sin(a) * 8; pts.push([Math.round(x), Math.round(y)]); }
    this.strokes.set(id, { id, color: "#6b4c9a", width: 2, points: pts });
    this.sendStroke(id, false);
  }
  sendStroke(id, isResend) {
    const s = this.strokes?.get(id); if (!s) return;
    if (isResend) this.pending.set(id, performance.now());
    this.send({ t: "stroke", ...s });
  }
  clearTimers() { clearTimeout(this.stagger); for (const t of this.timers) clearInterval(t); this.timers = []; }
  close() { this.clearTimers(); try { this.ws.close(); } catch {} }
  unacked() { return this.pending.size; }
}

function noteActivation(board, node) {
  if (!node) return;
  const prev = m.activations.get(board);
  if (prev && prev !== node.activationId) log(`board ${board}: instance changed ${prev} -> ${node.activationId}`);
  m.activations.set(board, node.activationId);
}

function spawn(n) {
  for (const b of boards) {
    const onBoard = bots.filter((x) => x.board === b).length;
    for (let i = 0; i < n && onBoard + i < MAX_CLIENTS; i++) bots.push(new Bot(b, onBoard + i));
  }
}

function report() {
  const t = ((Date.now() - started) / 1000).toFixed(0).padStart(4);
  const open = bots.filter((b) => b.ws.readyState === WebSocket.OPEN).length;
  const unacked = bots.reduce((s, b) => s + b.unacked(), 0);
  log(`t=${t}s bots=${open}/${bots.length} rtt p50=${f(p(m.rttWin, .5))} p99=${f(p(m.rttWin, .99))} | save p50=${f(p(m.ackWin, .5))} p99=${f(p(m.ackWin, .99))} | sent=${m.sent} acked=${m.acked} unacked=${unacked} reconnects=${m.reconnects}`);
  timeline.push({ t: Number(t), bots: open, rttP50: p(m.rttWin, .5), rttP99: p(m.rttWin, .99), saveP50: p(m.ackWin, .5), saveP99: p(m.ackWin, .99), unacked, reconnects: m.reconnects });
  m.rttWin = []; m.ackWin = [];
}
const timeline = [];

function finish() {
  stopping = true;
  for (const b of bots) b.close();
  const unacked = bots.reduce((s, b) => s + b.unacked(), 0);
  const summary = {
    url: URL_BASE, boards, botsPerBoardFinal: Math.max(...boards.map((b) => bots.filter((x) => x.board === b).length)),
    durationS: Math.round((Date.now() - started) / 1000),
    strokesSent: m.sent, strokesAcked: m.acked, stillUnacked: unacked, duplicateAcks: m.dupAcks,
    reconnects: m.reconnects, connectTimeouts: m.connectTimeouts, errors: m.errors,
    rttMs: { p50: p(m.rttAll, .5), p95: p(m.rttAll, .95), p99: p(m.rttAll, .99), max: p(m.rttAll, 1) },
    saveMs: { p50: p(m.ackAll, .5), p95: p(m.ackAll, .95), p99: p(m.ackAll, .99), max: p(m.ackAll, 1) },
  };
  for (const [b, ids] of ackedIds) writeFileSync(join(OUT, `acked-${b}.json`), JSON.stringify({ board: b, ids }));
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(OUT, "timeline.json"), JSON.stringify(timeline, null, 2));
  console.log("\n" + JSON.stringify(summary, null, 2));
  console.log(`\nResults in ${OUT}/. Check durability with:\n  node scripts/verify.mjs --url ${URL_BASE} --dir ${OUT}`);
  setTimeout(() => process.exit(0), 200);
}

// --- run -------------------------------------------------------------------------
log(`target=${URL_BASE} boards=${boards.length} clients/board=${CLIENTS} duration=${DURATION / 1000}s${RAMP ? ` ramp=+${RAMP}/${RAMP_EVERY / 1000}s` : ""}`);
spawn(CLIENTS);
setInterval(report, 5000);
if (RAMP) setInterval(() => spawn(RAMP), RAMP_EVERY);
setTimeout(finish, DURATION);
process.on("SIGINT", finish);

// --- utils -------------------------------------------------------------------------
function p(arr, q) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return round1(s[Math.min(s.length - 1, Math.floor(q * s.length))]); }
function f(v) { return v == null ? "–" : `${v}ms`; }
function round1(v) { return Math.round(v * 10) / 10; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function log(s) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`); }
function parseArgs(a) { const o = {}; for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) { const k = a[i].slice(2); o[k] = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : "1"; } return o; }
