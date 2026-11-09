# whiteboard-lab

A shared whiteboard with live cursors, built to test the Cloudflare Workers + Durable Objects programming model, and the self-hosted versions of it (celld, workerd), for the Deno-joins-Cloudflare investigation.

It's an experiment rig, not a product: no auth, no undo, no zoom. What it does have is built-in measurement (round trip, save time, reconnects, which board instance is serving you) and scripts to load-test it, crash it, and verify nothing acknowledged was lost.

- **Design and protocol:** [docs/SPEC.md](docs/SPEC.md)
- **How to deploy it three ways and run the experiments:** [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md)
- **Where to write down what you find:** [docs/RESULTS.md](docs/RESULTS.md)

## Run it locally

Requires Node 22+.

```bash
npm install
npm run dev
```

Open http://localhost:8787 in two browser windows and draw. Add `?b=<name>` to switch boards.

Ink you draw is dashed and faded until the board confirms it's saved, then turns solid. The panel in the corner shows round-trip time, save time, and the board instance id (it changes when the board restarts, wakes from hibernation, or fails over).

## How it works in one paragraph

Every board is one Durable Object: a tiny single-threaded server with its own SQLite database. Cloudflare (or celld) routes every connection for board `lobby` to the same object, wherever it runs. The object relays cursors to everyone in the room without storing them, saves finished strokes to SQLite before confirming them, and can hibernate when idle while keeping WebSockets connected. The Worker in front is a 20-line router. There's no separate database, cache, or pub/sub service.

## Scripts

```bash
# 20 simulated users on one board for 60s; writes results/<run>/
node scripts/bots.mjs --url http://localhost:8787 --board load --clients 20 --duration 60

# check every acknowledged stroke from a run is actually stored
node scripts/verify.mjs --url http://localhost:8787 --dir results/<run>

# watch a board's instance id and stroke count once a second (useful during failover tests)
node scripts/stats.mjs --url http://localhost:8787 --board load
```

`bots.mjs` options: `--boards N` (spread over N boards), `--clients`, `--duration` (s), `--stroke-every` (s), `--cursor-hz`, `--ramp N --ramp-every S --max-clients M` (keep adding bots to find a ceiling), `--run <name>`.

## Layout

```
src/index.js        Worker router + Board Durable Object
public/             browser client (no build step)
scripts/            bots.mjs, verify.mjs, stats.mjs
wrangler.json       config read by wrangler and by celld
docs/               spec, experiment runbook, results template
```
