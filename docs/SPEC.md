# Spec: whiteboard-lab

## Purpose

This is an experiment rig, not a product. It exists to answer four questions about the Workers + Durable Objects model (and the Deno/celld merger):

1. What do "a better way to build web applications" and the three claims behind it (cheap global deployment, bindings, Durable Objects) look like in real code?
2. How does the model differ from a traditional server + database + pub/sub stack?
3. What are the tradeoffs and failure modes?
4. Does the same app run unchanged on Cloudflare, on self-hosted celld, and on plain workerd, and how do they compare on latency, durability, failover, and cost?

Everything in the design is chosen to make those measurable. Anything that doesn't serve that (auth, undo, zoom, export) is deliberately left out.

## Why a whiteboard

A whiteboard mixes two kinds of traffic that stress the model differently:

- Ephemeral, high-frequency traffic: cursor positions (~30/s per user) and in-progress strokes. Losing these is harmless. This tests fan-out throughput through a single-threaded object.
- Durable, lower-frequency writes: finished strokes. Losing an acknowledged one is a bug. This tests durability and failover.

## Architecture

```
browser / bot ──HTTP/WS──▶ Worker (stateless router)
                               │  env.BOARDS.idFromName(boardId)
                               ▼
                       Board Durable Object  (one per board)
                         ├─ SQLite: strokes, meta
                         ├─ hibernatable WebSockets (one per participant)
                         └─ relays cursors/drafts, stores strokes, acks
```

- One Durable Object per board. Every connection to board `x`, from anywhere, lands on the same single-threaded object, so there are no locks, no Redis, and no ordering races within a board. Boards are independent, so the app scales by adding boards.
- The Worker is a ~20-line router. Static files in `public/` are served by the assets layer before the Worker runs.
- Plain JavaScript, no build step, no npm runtime dependencies. This removes bundler differences as a variable when comparing runtimes.

## Durability contract

A stroke is "saved" only when the sender receives `{t:"ack"}`. The Board inserts the stroke into SQLite, then sends the ack. On Cloudflare, output gates hold outgoing messages until the write is durable, so an ack implies the stroke survives a crash. celld advertises the same guarantee (zero acknowledged writes lost on kill). `scripts/verify.mjs` checks it.

Clients keep unacked strokes and resend them after reconnecting. The server dedupes by stroke id, so resends are safe.

## Protocol (JSON over WebSocket)

Client → Board

| type | fields | stored? |
|---|---|---|
| `ping` | `ts` | no; replies `pong` with node info |
| `cursor` | `x, y` | no; relayed |
| `draft` | `id, color, width, points` | no; relayed |
| `stroke` | `id, color, width, points` | yes; acked |
| `clear` | none | deletes all strokes |

Board → Client: `init` (history, peers, node), `ack`, `stroke`, `draft`, `cursor`, `join`, `leave`, `clear`, `pong`.

Coordinates are in a fixed 2000×1250 world space. Points per stroke are capped at 2000 and messages at 64 KB.

## Observability built in

- `activationId`: random id generated each time the Board object is constructed. It changes on first use, wake from hibernation, restart, and failover to another node. The UI shows it, logs changes, and the bots record them.
- `GET /api/boards/:id/stats`: stroke count, connections, total activations, database size, uptime.
- `GET /api/boards/:id/strokes`: all stored stroke ids (used by `verify.mjs`).
- The UI shows round-trip p50/p99, save time, saved and waiting counts, and reconnects. Unsaved ink renders dashed and faded until acked.

## Fallback behavior (what clients do when things break)

- Connection attempt not open within 5s → abandon and retry. (Found in testing: when the runtime process dies behind a still-listening proxy, connections hang forever without this.)
- Exponential backoff from 250ms to 5s.
- On reconnect: reload the board from `init`, resend unacked strokes, note any instance change.

## Deliberate limitations

- Every new browser connection downloads the full history. Fine for experiments; a real app would paginate or snapshot. Bots skip history so load tests measure steady state.
- No auth. Anyone with the URL can draw or clear. Don't leave a public deployment up longer than you need it.
- One Board is one thread. That's the point of the hot-board experiment, not a bug to fix here.

## Known unknowns to check on celld

- Whether `wrangler.json` deploys without edits (celld stops on unknown keys).
- Whether WebSocket hibernation, `ctx.storage.sql.databaseSize`, and output-gate semantics behave as on Cloudflare.
- ARM64 binary availability if your Oracle VM is Ampere (the Docker image is the fallback).
