// Whiteboard client. The interesting behavior for the experiment:
// - Strokes you draw render dashed and faded ("waiting to save") until the
//   board acks them, then turn solid. During a failover you can watch ink wait.
// - On reconnect, unacked strokes are resent (the server dedupes by id).
// - Round-trip and save times are measured continuously and shown in the readout.
// - "Board instance" changes whenever the Durable Object is re-created
//   (wake from hibernation, restart, or failover to another node).

const WORLD_W = 2000, WORLD_H = 1250;
const INKS = ["#1d3f6e", "#c8452b", "#2e7d5b", "#b8780f", "#6b4c9a", "#3a3a3a"];
const NIBS = [3, 6, 12];

const params = new URLSearchParams(location.search);
const boardId = /^[a-zA-Z0-9_-]{1,64}$/.test(params.get("b") || "") ? params.get("b") : "lobby";
const clientId = sessionStorage.getItem("wb-client") || crypto.randomUUID();
sessionStorage.setItem("wb-client", clientId);
const myName = safeGet("wb-name") || `Guest ${Math.floor(Math.random() * 900 + 100)}`;
safeSet("wb-name", myName);
const myColor = INKS[Math.floor(Math.random() * INKS.length)];

// --- state -------------------------------------------------------------------
const saved = new Map();    // id -> stroke (acked / from server)
const pending = new Map();  // id -> { stroke, sentAt }
const drafts = new Map();   // id -> { stroke, at } (other people's in-progress strokes)
const peers = new Map();    // clientId -> { name, color, x, y, at }
const rtts = [], acks = [];
let ws, backoff = 250, reconnects = 0, lastActivation = null, everConnected = false;
let ink = INKS[0], nib = NIBS[1], current = null, dirty = true;

// --- dom -----------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const canvas = $("board"), ctx = canvas.getContext("2d");
const grid = document.createElement("canvas");
let view = { scale: 1, ox: 0, oy: 0, dpr: 1 };

$("boardInput").value = boardId;
$("boardForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("boardInput").value.trim();
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(v)) location.search = `?b=${encodeURIComponent(v)}`;
});
document.title = `${boardId} · Whiteboard lab`;

for (const c of INKS) {
  const b = document.createElement("button");
  b.type = "button"; b.style.setProperty("--c", c); b.setAttribute("aria-label", `Ink ${c}`);
  b.setAttribute("aria-pressed", String(c === ink));
  b.onclick = () => { ink = c; for (const x of $("swatches").children) x.setAttribute("aria-pressed", String(x === b)); };
  $("swatches").append(b);
}
for (const n of NIBS) {
  const b = document.createElement("button");
  b.type = "button"; b.setAttribute("aria-label", `Nib ${n}`); b.setAttribute("aria-pressed", String(n === nib));
  const i = document.createElement("i"); i.style.width = i.style.height = `${Math.max(3, n * 0.9)}px`; b.append(i);
  b.onclick = () => { nib = n; for (const x of $("nibs").children) x.setAttribute("aria-pressed", String(x === b)); };
  $("nibs").append(b);
}
$("clearBtn").onclick = () => {
  if (confirm(`Clear every stroke on “${boardId}” for everyone?`)) send({ t: "clear" });
};

// --- connection --------------------------------------------------------------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ client: clientId, name: myName, color: myColor });
  ws = new WebSocket(`${proto}://${location.host}/api/boards/${boardId}/ws?${q}`);
  setStatus("waiting", everConnected ? "Reconnecting" : "Connecting");

  const sock = ws;
  // A half-dead server can accept the connection but never finish the
  // handshake. Give up after 5s and retry instead of waiting forever.
  const guard = setTimeout(() => { if (sock.readyState !== WebSocket.OPEN) sock.close(); }, 5000);
  ws.onopen = () => clearTimeout(guard);
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    clearTimeout(guard);
    if (sock !== ws) return;
    setStatus("down", `Offline, retrying in ${(backoff / 1000).toFixed(1)}s`);
    log("Connection lost");
    setTimeout(() => { reconnects++; connect(); }, backoff);
    backoff = Math.min(backoff * 2, 5000);
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(obj)); return true; }
  return false;
}

function handle(m) {
  switch (m.t) {
    case "init": {
      everConnected = true; backoff = 250;
      setStatus("live", "Live");
      saved.clear();
      for (const s of m.strokes) saved.set(s.id, s);
      peers.clear();
      for (const p of m.peers) peers.set(p.clientId, { ...p, x: null, y: null, at: Date.now() });
      noteActivation(m.node);
      // Resend anything the previous connection never confirmed.
      let resent = 0;
      for (const [id, p] of pending) {
        if (saved.has(id)) { pending.delete(id); continue; }
        p.sentAt = performance.now(); send({ t: "stroke", ...p.stroke }); resent++;
      }
      if (resent) log(`Resent ${resent} unsaved stroke${resent > 1 ? "s" : ""}`);
      renderPeers(); dirty = true; break;
    }
    case "ack": {
      const p = pending.get(m.id);
      if (p) {
        acks.push(performance.now() - p.sentAt); trim(acks);
        saved.set(m.id, { ...p.stroke, seq: m.seq });
        pending.delete(m.id); dirty = true;
      }
      break;
    }
    case "stroke": saved.set(m.stroke.id, m.stroke); drafts.delete(m.stroke.id); dirty = true; break;
    case "draft": drafts.set(m.id, { stroke: m, at: Date.now() }); dirty = true; break;
    case "clear": saved.clear(); pending.clear(); drafts.clear(); log(`${m.by} cleared the board`); dirty = true; break;
    case "cursor": {
      const p = peers.get(m.from) || { name: m.name, color: m.color };
      Object.assign(p, { x: m.x, y: m.y, at: Date.now() }); peers.set(m.from, p); moveCursor(m.from, p);
      break;
    }
    case "join": peers.set(m.peer.clientId, { ...m.peer, x: null, y: null, at: Date.now() }); renderPeers(); break;
    case "leave": peers.delete(m.clientId); $("cursors").querySelector(`[data-id="${CSS.escape(m.clientId || "")}"]`)?.remove(); renderPeers(); break;
    case "pong": rtts.push(performance.now() - m.ts); trim(rtts); noteActivation(m.node); break;
  }
}

function noteActivation(node) {
  if (!node) return;
  if (lastActivation && lastActivation !== node.activationId) {
    log(`Board instance changed ${lastActivation} → ${node.activationId}`);
  }
  lastActivation = node.activationId;
  $("activation").textContent = node.activationId;
}

setInterval(() => send({ t: "ping", ts: performance.now() }), 1000);

// --- drawing input -------------------------------------------------------------
let lastCursorSend = 0, lastDraftSend = 0;
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  current = { id: crypto.randomUUID(), color: ink, width: nib, points: [toWorld(e)] };
  dirty = true;
});
canvas.addEventListener("pointermove", (e) => {
  const pt = toWorld(e);
  const now = performance.now();
  if (now - lastCursorSend > 33) { send({ t: "cursor", x: pt[0], y: pt[1] }); lastCursorSend = now; }
  if (!current) return;
  const last = current.points[current.points.length - 1];
  if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 1.5 || current.points.length >= 2000) return;
  current.points.push(pt); dirty = true;
  if (now - lastDraftSend > 50) { send({ t: "draft", ...current }); lastDraftSend = now; }
});
const finish = () => {
  if (!current) return;
  const stroke = current; current = null;
  pending.set(stroke.id, { stroke, sentAt: performance.now() });
  send({ t: "stroke", ...stroke }); // if offline, it stays pending and is resent on reconnect
  dirty = true;
};
canvas.addEventListener("pointerup", finish);
canvas.addEventListener("pointercancel", finish);

function toWorld(e) {
  const r = canvas.getBoundingClientRect();
  return [round((e.clientX - r.left - view.ox) / view.scale), round((e.clientY - r.top - view.oy) / view.scale)];
}
const round = (n) => Math.round(n * 10) / 10;

// --- rendering ------------------------------------------------------------------
function resize() {
  const r = canvas.getBoundingClientRect();
  view.dpr = window.devicePixelRatio || 1;
  canvas.width = r.width * view.dpr; canvas.height = r.height * view.dpr;
  view.scale = Math.min(r.width / WORLD_W, r.height / WORLD_H);
  view.ox = (r.width - WORLD_W * view.scale) / 2; view.oy = (r.height - WORLD_H * view.scale) / 2;
  drawGrid(); dirty = true;
  for (const [id, p] of peers) moveCursor(id, p);
}
function drawGrid() {
  grid.width = canvas.width; grid.height = canvas.height;
  const g = grid.getContext("2d"), css = getComputedStyle(document.documentElement);
  g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  g.fillStyle = css.getPropertyValue("--surface");
  g.fillRect(view.ox, view.oy, WORLD_W * view.scale, WORLD_H * view.scale);
  g.fillStyle = css.getPropertyValue("--grid");
  for (let x = 50; x < WORLD_W; x += 50) for (let y = 50; y < WORLD_H; y += 50) {
    g.beginPath(); g.arc(view.ox + x * view.scale, view.oy + y * view.scale, 1.2, 0, Math.PI * 2); g.fill();
  }
}
function drawStroke(s, opts = {}) {
  if (!s.points.length) return;
  ctx.save();
  ctx.globalAlpha = opts.alpha ?? 1;
  ctx.setLineDash(opts.dash ? [6 * view.scale + 2, 6 * view.scale + 2] : []);
  ctx.strokeStyle = s.color; ctx.lineWidth = s.width * view.scale; ctx.lineCap = ctx.lineJoin = "round";
  ctx.beginPath();
  const [x0, y0] = s.points[0];
  ctx.moveTo(view.ox + x0 * view.scale, view.oy + y0 * view.scale);
  if (s.points.length === 1) ctx.lineTo(view.ox + x0 * view.scale + 0.01, view.oy + y0 * view.scale);
  for (const [x, y] of s.points) ctx.lineTo(view.ox + x * view.scale, view.oy + y * view.scale);
  ctx.stroke(); ctx.restore();
}
function frame() {
  // Drop drafts whose author vanished mid-stroke.
  const now = Date.now();
  for (const [id, d] of drafts) if (now - d.at > 4000) { drafts.delete(id); dirty = true; }
  if (dirty) {
    dirty = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(grid, 0, 0);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    const ordered = [...saved.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    for (const s of ordered) drawStroke(s);
    for (const d of drafts.values()) drawStroke(d.stroke, { alpha: 0.6 });
    for (const p of pending.values()) drawStroke(p.stroke, { alpha: 0.45, dash: true });
    if (current) drawStroke(current, { alpha: 0.45, dash: true });
  }
  requestAnimationFrame(frame);
}

function moveCursor(id, p) {
  if (p.x == null) return;
  let el = $("cursors").querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!el) {
    el = document.createElement("div"); el.className = "cursor"; el.dataset.id = id;
    el.style.setProperty("--c", p.color); el.innerHTML = "<span></span>";
    el.firstChild.textContent = p.name; $("cursors").append(el);
  }
  el.style.transform = `translate(${view.ox + p.x * view.scale}px, ${view.oy + p.y * view.scale}px)`;
}
setInterval(() => {
  const now = Date.now();
  for (const el of $("cursors").children) {
    const p = peers.get(el.dataset.id);
    if (!p || now - p.at > 5000) el.remove();
  }
}, 1000);

function renderPeers() {
  const ul = $("peers"); ul.replaceChildren();
  const me = document.createElement("li"); me.style.setProperty("--c", myColor); me.textContent = `${myName} (you)`; ul.append(me);
  for (const p of peers.values()) {
    const li = document.createElement("li"); li.style.setProperty("--c", p.color); li.textContent = p.name; ul.append(li);
  }
}

// --- readout -------------------------------------------------------------------
function pct(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
const ms = (v) => (v == null ? "–" : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);
function trim(arr) { if (arr.length > 120) arr.shift(); }
setInterval(() => {
  $("rttP50").textContent = ms(pct(rtts, 0.5));
  $("rttP99").textContent = ms(pct(rtts, 0.99));
  $("ackP50").textContent = ms(pct(acks, 0.5));
  $("savedCount").textContent = saved.size;
  $("pendingCount").textContent = pending.size;
  $("pendingCount").dataset.nonzero = String(pending.size > 0);
  $("reconnects").textContent = reconnects;
}, 500);

function setStatus(state, text) { $("status").dataset.state = state; $("statusText").textContent = text; }
function log(text) {
  const li = document.createElement("li");
  const t = document.createElement("time"); t.textContent = new Date().toLocaleTimeString();
  li.append(t, text); $("log").prepend(li);
  while ($("log").children.length > 4) $("log").lastChild.remove();
}
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } }

window.addEventListener("resize", resize);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", resize);
resize(); renderPeers(); connect(); requestAnimationFrame(frame);
