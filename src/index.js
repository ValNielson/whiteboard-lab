// whiteboard-lab: one Durable Object per board.
//
// Design notes (see docs/SPEC.md for the full rationale):
// - Strokes are durable. Each stroke is INSERTed into the board's SQLite
//   database before the sender receives an "ack". On Cloudflare, output gates
//   hold the ack until the write is durable, so "acked" means "survives a crash".
//   The failover experiment checks whether that also holds on celld.
// - Cursors and in-progress strokes ("drafts") are ephemeral. They are relayed
//   to peers and never stored, so they cost nothing to lose.
// - Uses the WebSocket Hibernation API, so an idle board can be evicted from
//   memory while clients stay connected. Per-socket state lives in the socket
//   attachment, and nothing important lives only in instance fields.

import { DurableObject } from "cloudflare:workers";

const MAX_POINTS = 2000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const BOARD_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // A fresh id each time this object is constructed: first use, wake from
    // hibernation, or restart on another node after failover. Clients display
    // it, so you can see these events happen.
    this.activationId = crypto.randomUUID().slice(0, 8);
    this.activatedAt = Date.now();

    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS strokes (
        id         TEXT PRIMARY KEY,
        seq        INTEGER NOT NULL,
        client_id  TEXT NOT NULL,
        color      TEXT NOT NULL,
        width      REAL NOT NULL,
        points     TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    const row = this.sql.exec("SELECT COALESCE(MAX(seq), 0) AS s FROM strokes").one();
    this.seq = row.s;
    this.sql.exec(
      "INSERT INTO meta (k, v) VALUES ('activations', '1') " +
        "ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1",
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    if (action === "ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      return this.acceptClient(url);
    }
    if (action === "strokes") return Response.json(this.listStrokes(url.searchParams.get("full") === "1"));
    if (action === "stats") return Response.json(this.stats());
    return new Response("Unknown action", { status: 404 });
  }

  acceptClient(url) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const peer = {
      clientId: (url.searchParams.get("client") || crypto.randomUUID()).slice(0, 40),
      name: (url.searchParams.get("name") || "anon").slice(0, 24),
      color: /^#[0-9a-fA-F]{6}$/.test(url.searchParams.get("color") || "") ? url.searchParams.get("color") : "#1d3f6e",
      bot: url.searchParams.get("bot") === "1",
    };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(peer);

    // Bots skip the full stroke history so load tests measure steady-state
    // traffic, not repeated history downloads.
    const strokes = peer.bot ? [] : this.allStrokes();
    server.send(JSON.stringify({
      t: "init",
      you: peer.clientId,
      seq: this.seq,
      strokes,
      peers: this.peers().filter((p) => p.clientId !== peer.clientId),
      node: this.nodeInfo(),
    }));
    this.broadcast({ t: "join", peer }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const peer = ws.deserializeAttachment();

    switch (msg.t) {
      case "ping":
        // Round-trip probe. Includes node info so clients notice failovers.
        ws.send(JSON.stringify({ t: "pong", ts: msg.ts, node: this.nodeInfo() }));
        return;

      case "cursor":
        if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
        this.broadcast({ t: "cursor", from: peer.clientId, name: peer.name, color: peer.color, x: msg.x, y: msg.y }, ws);
        return;

      case "draft":
        // In-progress stroke, relayed only.
        if (!validStroke(msg)) return;
        this.broadcast({ t: "draft", from: peer.clientId, id: msg.id, color: msg.color, width: msg.width, points: msg.points }, ws);
        return;

      case "stroke": {
        if (!validStroke(msg)) return;
        // Idempotent: clients resend unacked strokes after reconnecting, so a
        // duplicate id is acked again rather than stored twice.
        const existing = this.sql.exec("SELECT seq FROM strokes WHERE id = ?", msg.id).toArray();
        if (existing.length) {
          ws.send(JSON.stringify({ t: "ack", id: msg.id, seq: existing[0].seq, dup: true }));
          return;
        }
        const seq = ++this.seq;
        const createdAt = Date.now();
        this.sql.exec(
          "INSERT INTO strokes (id, seq, client_id, color, width, points, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          msg.id, seq, peer.clientId, msg.color, msg.width, JSON.stringify(msg.points), createdAt,
        );
        ws.send(JSON.stringify({ t: "ack", id: msg.id, seq }));
        this.broadcast({ t: "stroke", stroke: { id: msg.id, seq, clientId: peer.clientId, color: msg.color, width: msg.width, points: msg.points } }, ws);
        return;
      }

      case "clear":
        this.sql.exec("DELETE FROM strokes");
        this.broadcast({ t: "clear", by: peer.name });
        return;
    }
  }

  async webSocketClose(ws) {
    const peer = ws.deserializeAttachment();
    this.broadcast({ t: "leave", clientId: peer?.clientId }, ws);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  // --- helpers -------------------------------------------------------------

  broadcast(obj, except) {
    const data = JSON.stringify(obj);
    for (const sock of this.ctx.getWebSockets()) {
      if (sock === except) continue;
      try { sock.send(data); } catch { /* socket is closing */ }
    }
  }

  peers() {
    const out = [];
    for (const sock of this.ctx.getWebSockets()) {
      const p = sock.deserializeAttachment();
      if (p && !p.bot) out.push(p);
    }
    return out;
  }

  allStrokes() {
    return this.sql
      .exec("SELECT id, seq, client_id, color, width, points FROM strokes ORDER BY seq")
      .toArray()
      .map((r) => ({ id: r.id, seq: r.seq, clientId: r.client_id, color: r.color, width: r.width, points: JSON.parse(r.points) }));
  }

  listStrokes(full) {
    if (full) { const strokes = this.allStrokes(); return { count: strokes.length, lastSeq: this.seq, strokes }; }
    const ids = this.sql.exec("SELECT id FROM strokes ORDER BY seq").toArray().map((r) => r.id);
    return { count: ids.length, lastSeq: this.seq, ids };
  }

  nodeInfo() {
    return { activationId: this.activationId, activatedAt: this.activatedAt };
  }

  stats() {
    const count = this.sql.exec("SELECT COUNT(*) AS c FROM strokes").one().c;
    const activations = Number(this.sql.exec("SELECT v FROM meta WHERE k = 'activations'").one().v);
    const sockets = this.ctx.getWebSockets();
    return {
      strokes: count,
      lastSeq: this.seq,
      connections: sockets.length,
      humans: this.peers().length,
      activations,
      // databaseSize isn't documented on celld; report null rather than failing
      // the whole stats endpoint (which the failover experiment depends on).
      databaseBytes: safe(() => this.ctx.storage.sql.databaseSize),
      node: this.nodeInfo(),
      uptimeMs: Date.now() - this.activatedAt,
    };
  }
}

function safe(fn) {
  try { const v = fn(); return Number.isFinite(v) ? v : null; } catch { return null; }
}

function validStroke(m) {
  return typeof m.id === "string" && m.id.length > 0 && m.id.length <= 64 &&
    typeof m.color === "string" && /^#[0-9a-fA-F]{6}$/.test(m.color) &&
    Number.isFinite(m.width) && m.width > 0 && m.width <= 64 &&
    Array.isArray(m.points) && m.points.length > 0 && m.points.length <= MAX_POINTS &&
    m.points.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

// --- Worker: stateless router ------------------------------------------------
// Static files in ./public are served by the assets layer before this runs.
// Anything that isn't a file (i.e. /api/*) lands here.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/boards\/([^/]+)\/(ws|strokes|stats)$/);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, at: new Date().toISOString() });
    }
    if (!match) return new Response("Not found", { status: 404 });

    const [, boardId, action] = match;
    if (!BOARD_ID_RE.test(boardId)) return new Response("Invalid board id", { status: 400 });

    // idFromName is the "distributed singleton" part: every request for this
    // board name, from anywhere, reaches the same object.
    const stub = env.BOARDS.get(env.BOARDS.idFromName(boardId));
    const inner = new URL(request.url);
    inner.searchParams.set("action", action);
    return stub.fetch(new Request(inner, request));
  },
};
