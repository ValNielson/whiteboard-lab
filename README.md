# whiteboard-lab

A shared whiteboard with live cursors. It exists to test the Cloudflare Workers + Durable Objects programming model, and celld (Deno's self-hosted version of it), for the Deno-joins-Cloudflare investigation.

It's an experiment rig, not a product. There's no auth, no undo, and no zoom. What it does have is built-in measurement (round trip, save time, reconnects, and which board instance is serving you), plus scripts to load-test it, crash it, and check that nothing acknowledged was lost.

This README is the runbook. Follow it top to bottom.

| Doc | What's in it |
|---|---|
| This README | The three workflows (local, Workers, celld), then the experiments |
| [deploy/celld/](deploy/celld/) | The Docker Compose stack for Arcane, and the local rehearsal version |
| [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md) | Longer explanation of each experiment and what to expect |
| [docs/SPEC.md](docs/SPEC.md) | Design, protocol, durability contract, client fallback behavior |
| [docs/RESULTS.md](docs/RESULTS.md) | Blank tables to fill in as you go |

---

## How the four questions map to the experiments

| Question | Where the answer comes from |
|---|---|
| What does "a better way to build web applications" mean? | Read [src/index.js](src/index.js). The whole backend is one file with no database server, cache, or pub/sub. The same file runs on Cloudflare and on celld. |
| How is the model different? | The Board Durable Object: one single-threaded object per board, with its own SQLite, that every user of that board is routed to. Compare it to how you'd build this with Express + Postgres + Redis pub/sub. |
| What are the tradeoffs? | Experiment 4 (one hot board hits a ceiling), Experiment 3 (what self-hosting costs you during failures), Experiment 1 (what didn't port). |
| What experiment, and how do you judge the hype? | All five experiments, scored with the table at the end of this README. |

---

## The three workflows

The same code ([src/index.js](src/index.js) + [public/](public/)) runs three ways:

| Workflow | Where it runs | URL | Status |
|---|---|---|---|
| **Local** | Your laptop, via `npm run dev` | http://localhost:8787 | ✅ Done |
| **Workers** | Cloudflare's hosted platform | https://whiteboard-lab.mantiswhiteboard.workers.dev | ✅ Done |
| **celld** | Your server, as an Arcane project | https://wb-celld.skelsemporium.com | ⬜ To do |

The experiments compare **Workers** and **celld**. The local workflow is for development and quick checks, and it gave you a baseline for free.

---

## Local workflow ✅

You've done this. For reference:

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:8787 in two windows and draw. Under the hood, wrangler runs the app on workerd, Cloudflare's open-source runtime, as a single process.

Results from local runs, worth citing in your write-up:

| Test | Result |
|---|---|
| 15 bots on 3 boards for 15s | 431 of 431 strokes saved. Round trip p50 2ms, save p50 2.5ms |
| `kill -9` of the runtime under load, restarted 5s later | Bots reconnected about 1s after the restart. 553 of 553 acknowledged strokes kept. |

The second row is the "before celld" picture: the board stayed down until someone restarted the process, and nothing took over.

---

## Workers workflow ✅

You've done this too. To redeploy after a code change:

```bash
npm run deploy:cf
```

Check it's up:

```bash
curl https://whiteboard-lab.mantiswhiteboard.workers.dev/api/health
```

---

## celld workflow ⬜

This is what's left to set up: celld running on your server through Arcane, reached through your Cloudflare Tunnel.

Results from rehearsing it on a laptop (2 nodes, RustFS as the bucket). Use these as a baseline, not as real numbers:

| Test | Result |
|---|---|
| Deploy with the unchanged `wrangler.json` | Worked, no edits |
| `ctx.storage.sql.databaseSize` | Supported |
| 15 bots on 3 boards for 20s | 580 of 580 strokes saved. Round trip p50 1ms, save p50 5.6ms |
| `kill -9` of node1 under load (20 bots, 4 boards) | Board back in 10s on node2. 2,755 of 2,755 acknowledged strokes kept. |

celld saves more slowly than local (5.6ms vs 2.5ms) because each write is copied to the second node before it's acknowledged.

### How the celld setup works

```
your laptop                                  your server (Arcane project)
───────────                                  ────────────────────────────
npm run deploy:celld ──writes app──▶ R2 bucket ◀──reads app, stores data── node1, node2
                                                                              ▲
browser / bots ──▶ your domain ──▶ lb (Caddy, port WB_PORT) ──────────────────┘
                                   sends to node1; to node2 when node1 is down
```

- **The bucket is the source of truth.** It holds the deployed app, every board's data, and the leases that decide which node owns which board. When a node dies, its lease runs out and the other node takes over its boards.
- **Nothing is built on the server.** The Arcane stack uses only published images (`ghcr.io/denoland/celld` and `caddy`). You deploy the app from your laptop into the bucket, and running nodes pick up the new version within seconds, without restarting.
- **Two nodes plus a load balancer.** Two nodes is the minimum for failover. The load balancer gives clients one address that keeps working when a node dies.
- **The nodes talk to each other on a private Docker network** (port 8081). That port isn't published and must never be. celld's peer traffic has no encryption or authentication.

Two nodes on one server survive a process crash, not a server crash. That's enough to test celld's failover. It isn't a production setup.

### What you need

- Docker on your laptop (Node you already have).
- Your Cloudflare account (for the R2 bucket).
- Arcane on your server, and your Cloudflare Tunnel.
- About 1.5 hours.

Track how long setup takes, including debugging. It goes in the "Hours spent operating each" table in [docs/RESULTS.md](docs/RESULTS.md) and is part of the answer.

### celld step 1: Rehearse on your laptop (10 minutes)

This runs the same stack as the server, but with RustFS (a local S3-compatible store) in place of R2. Do it first, so any problems on the server are server problems, not celld problems.

```bash
npm run rehearse:up
```

The first run downloads images and takes a few minutes. Then open http://localhost:8088 in two browser windows and draw.

Try a failover by hand. In one terminal:

```bash
node scripts/stats.mjs --url http://localhost:8088 --board lobby
```

In another:

```bash
docker kill -s KILL wb-rehearsal-node1-1
```

The stats watcher prints `UNREACHABLE`, then `back after 10.0s` or so, with a new instance id. A browser open on the board shows ink waiting to save during the gap, then saving. Start node1 again with `docker start wb-rehearsal-node1-1`.

When you're done:

```bash
npm run rehearse:down
```

### celld step 2: Make the R2 bucket (5 minutes)

```bash
npx wrangler r2 bucket create whiteboard-lab-celld
```

Then in the Cloudflare dashboard, go to **R2 → Manage API tokens → Create API token**. Choose **Object Read & Write**, limited to the `whiteboard-lab-celld` bucket only. Copy the Access Key ID, the Secret Access Key, and your Account ID (it's in the S3 endpoint URL the page shows).

Scope it to this one bucket. Whoever has these credentials controls the whole celld fleet.

Create the env file and fill it in:

```bash
cp deploy/celld/.env.example deploy/celld/.env
```

Don't put quotes around the values; `docker run --env-file` keeps them literally. The file is gitignored.

Optional check that R2 supports what celld needs (it should):

```bash
docker run --rm --env-file deploy/celld/.env ghcr.io/denoland/celld:0.6.3 diagnose
```

Look for `ok bucket conditional write: create, reject-create, update, reject-stale`.

### celld step 3: Deploy the app into the bucket (2 minutes)

From your laptop:

```bash
npm run deploy:celld
```

This builds a small image with celld and esbuild, then runs `celld deploy`, which bundles `src/index.js` and `public/` and uploads them to the bucket. It reads the same `wrangler.json` Cloudflare used. Write down any errors or changes you needed; that's the main Experiment 1 result.

Run it again whenever you change the app. Running nodes switch to the new version on their own.

### celld step 4: Start the fleet in Arcane (15 minutes)

1. In Arcane, go to **Projects → Create Project**. Name it `whiteboard-lab`.
2. Paste the contents of [deploy/celld/compose.yaml](deploy/celld/compose.yaml) into the Compose editor.
3. Paste the contents of your `deploy/celld/.env` into the **Environment Configuration (.env)** editor.
4. Click **Create Project**. Arcane pulls the images and starts `node1`, `node2`, and `lb`.
5. Make it reachable through your Cloudflare Tunnel.

   First, in **Cloudflare DNS for skelsemporium.com**, delete any A records left from the earlier plan (`wb-celld` and `wb-workerd`). The tunnel creates its own record for `wb-celld`, and it can't while an A record with that name exists. `wb-workerd` isn't needed any more.

   Then in **Zero Trust → Networks → Tunnels → your tunnel → Public Hostname → Add a public hostname**:

   - Subdomain `wb-celld`, domain `skelsemporium.com`
   - Service type `HTTP`, URL: the load balancer as your `cloudflared` sees it.
     - If `cloudflared` runs directly on the server: `localhost:8088` (the `WB_PORT` value).
     - If `cloudflared` runs as a Docker container: use the server's LAN IP and port, such as `192.168.1.20:8088`. Inside a container, `localhost` is the container itself.

   WebSockets work through tunnels without extra settings.

   Only the `lb` service should be reachable. Never publish or route to node ports 8080 or 8081.

   Write in RESULTS.md that celld is reached through a Cloudflare Tunnel. Every request then goes laptop → Cloudflare's edge → tunnel → your server, so celld's latency includes Cloudflare's network, and a tunnel hiccup looks the same as a node failure to the bots. That's fine for this experiment, as long as you say so in the results.

6. Check it:

   ```bash
   curl https://wb-celld.skelsemporium.com/api/health
   ```

   Then open `https://wb-celld.skelsemporium.com` and draw.

7. Check both nodes see each other. In Arcane, open a terminal on the `node1` container (or on the server, `docker exec -it whiteboard-lab-node1-1 sh`) and run:

   ```bash
   celld diagnose
   ```

   It should list two node leases. The node logs print a line every second; that's normal for this beta.

   Container names come from the Arcane project name. This README assumes `whiteboard-lab`, so `whiteboard-lab-node1-1`. If yours differ, check with `docker ps`.

---

## The experiments

Run the bots from your laptop so you measure the network. Each bot run writes `results/<run>/summary.json`, `timeline.json`, and the list of acked stroke ids. Use a board name prefix per workflow so results don't mix: `w-` for Workers, `c-` for celld.

Set these in each terminal you use:

```bash
WORKERS=https://whiteboard-lab.mantiswhiteboard.workers.dev
CELLD=https://wb-celld.skelsemporium.com
```

### Experiment 1: Portability

Does the same code run on both without changes?

For both Workers and celld: open the site in two browser windows, draw, and check that cursors and strokes sync both ways. Then:

```bash
node scripts/bots.mjs --url $CELLD --board c-port --clients 5 --duration 20 --run c-port
```

```bash
node scripts/verify.mjs --url $CELLD --dir results/c-port
```

Also check hibernation: leave a board open in a browser for 10 minutes without drawing. Does the socket stay connected? Does the "Board instance" id change?

Fill in the Portability table in RESULTS.md. Things already known from the rehearsal: `wrangler.json` deployed unchanged, and `databaseSize` works. If you ever add a custom domain to the Cloudflare deployment, set it in the dashboard, not in `wrangler.json`: celld rejects `routes`.

### Experiment 2: Latency

```bash
node scripts/bots.mjs --url $WORKERS --board w-lat --boards 10 --clients 5 --duration 120 --run w-lat
```

```bash
node scripts/bots.mjs --url $CELLD --board c-lat --boards 10 --clients 5 --duration 120 --run c-lat
```

Take round trip p50/p99 and save p50/p99 from each `summary.json`.

What to look for:

- **Save time.** On celld, the node acknowledges a write once the other node has it on disk, then uploads to R2 in the background. If one node is down, every write waits for R2 instead. Try a run with node2 stopped to see that cost.
- **Distance.** If you can, run it again from a machine in another region. Cloudflare places each board near whoever first used it. Your server is in one place for everyone.

### Experiment 3: Failover (the main one)

When a node dies during a session, do clients recover, and is any acknowledged stroke lost?

Open the board in a browser (`$CELLD/?b=c-fail-1`) and two terminals on your laptop.

Terminal 1, the load:

```bash
node scripts/bots.mjs --url $CELLD --board c-fail-1 --clients 20 --duration 180 --stroke-every 0.5 --run c-fail-1
```

Terminal 2, the watcher. It prints the instance id every second, and how long the board was unreachable:

```bash
node scripts/stats.mjs --url $CELLD --board c-fail-1
```

At about 60 seconds, kill node1. The load balancer sends everything to node1 while it's healthy, so node1 owns the board. On the server:

```bash
docker kill -s KILL whiteboard-lab-node1-1
```

Use `docker kill -s KILL`, not Arcane's Stop button. Stop shuts the node down gracefully so it can hand its boards over. That's worth testing too as a separate run, but it's not a crash.

After the bots finish:

```bash
node scripts/verify.mjs --url $CELLD --dir results/c-fail-1
```

Record: the `back after` time from the watcher, strokes lost (from verify), reconnects (from `summary.json`), and whether the instance id changed. celld claims about 20 seconds to fail over and zero acknowledged writes lost. The rehearsal got 10 seconds and zero lost.

Start node1 again afterwards (Arcane's Start button, or `docker start whiteboard-lab-node1-1`).

For Workers you can't kill Cloudflare's servers. Look up Durable Objects incidents at https://www.cloudflarestatus.com/history and note them instead.

### Experiment 4: Hot board (the tradeoff)

Where does one board's single thread run out of capacity?

```bash
node scripts/bots.mjs --url $WORKERS --board w-hot-1 --clients 10 --ramp 10 --ramp-every 15 --max-clients 500 --duration 300 --cursor-hz 30 --run w-hot-1
```

This adds 10 bots every 15 seconds. Every cursor movement goes to everyone else on the board, so traffic grows with roughly the square of the number of people. The ceiling is the bot count where round trip p99 goes above about 100ms, or where bots start reconnecting.

Then spread bots over many boards and compare:

```bash
node scripts/bots.mjs --url $WORKERS --board w-spread --boards 50 --clients 10 --duration 120 --cursor-hz 30 --run w-spread
```

Repeat both with `$CELLD` (`c-hot-1`, `c-spread`). On celld, all boards go to node1 first (that's how the load balancer is set up), so "many boards" on celld mostly measures one node. Watch your laptop's CPU; if it's maxed out, the bots are the bottleneck. Stop around 200 bots per run if it is.

This is the concrete answer to "why would you not want this?": one board can't spread across machines. If one room gets huge, you have to split it yourself.

### Experiment 5: Idle cost and wake-up

1. Create 200 boards with a little data each:

   ```bash
   node scripts/bots.mjs --url $CELLD --board c-idle --boards 200 --clients 1 --duration 20 --run c-idle
   ```

2. Note the R2 operation counts: **R2 → whiteboard-lab-celld → Metrics** (Class A and Class B operations).
3. Leave everything alone for 30 minutes.
4. Check the operation counts again. celld claims idle boards cost almost nothing in bucket operations.
5. Open `$CELLD/?b=c-idle-7`. Note whether the instance id is new (it was evicted from memory) and the first round trip.

Repeat steps 1, 3, and 5 on Workers (`w-idle`), and compare Cloudflare's Workers usage page for the same period. For celld's cost, add your server's monthly cost to R2's storage and operation charges.

---

## Clean up

There's no auth, so anyone with a URL can draw on or clear a board. Take things down when you're done:

- **Arcane:** stop and delete the `whiteboard-lab` project, including its volumes.
- **R2:** empty and delete the `whiteboard-lab-celld` bucket, and delete the API token.
- **Cloudflare Worker:** `npx wrangler delete`.

---

## Scoring the hype

Fill this in at the end, using what's in RESULTS.md.

| Claim | Supports it | Undercuts it |
|---|---|---|
| Simple to build stateful, real-time apps | Lines of code in `src/index.js`; no Redis, no locks, no DB server | Anything you had to work around |
| Runs anywhere, no lock-in | Experiment 1 | Features that didn't port, config you had to change |
| Self-hosting is production-ready | Experiment 3 on celld | Failover time, lost writes, hours of ops work |
| Scales | Experiment 4, many boards | Experiment 4, one hot board |
| Cheap | Experiment 5 | Your setup and debugging hours |

---

## Reference

### npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Run locally on workerd (wrangler) at http://localhost:8787 |
| `npm run deploy:cf` | Deploy to Cloudflare |
| `npm run deploy:celld` | Deploy to the celld bucket in `deploy/celld/.env` (uses Docker) |
| `npm run rehearse:up` / `rehearse:down` | Start or delete the local celld stack at http://localhost:8088 |

### Test scripts

| Command | What it does |
|---|---|
| `node scripts/bots.mjs --url <url> --board <name> ...` | Simulated users. Writes `results/<run>/`. |
| `node scripts/verify.mjs --url <url> --dir results/<run>` | Checks every acked stroke from a run is stored. |
| `node scripts/stats.mjs --url <url> --board <name>` | Prints a board's instance id and stroke count every second. |

`bots.mjs` options:

| Option | Default | Meaning |
|---|---|---|
| `--url` | `http://localhost:8787` | Deployment to hit |
| `--board` | `load` | Board name, or prefix when `--boards` > 1 |
| `--boards` | 1 | Spread bots over this many boards |
| `--clients` | 10 | Bots per board at start |
| `--duration` | 60 | Seconds |
| `--stroke-every` | 2 | Seconds between strokes per bot |
| `--cursor-hz` | 10 | Cursor updates per second per bot |
| `--ramp`, `--ramp-every`, `--max-clients` | off, 15, 1000 | Add bots over time to find a ceiling |
| `--run` | timestamp | Name of the results folder |

### HTTP endpoints

| Path | Returns |
|---|---|
| `/api/health` | `{ok: true}` from the Worker, without touching a Durable Object |
| `/api/boards/<id>/stats` | Stroke count, connections, activations, database size, instance id |
| `/api/boards/<id>/strokes` | All stored stroke ids (add `?full=1` for the strokes) |
| `/api/boards/<id>/ws` | The WebSocket the client and bots use |

### Files

```
src/index.js                     Worker router + Board Durable Object
public/                          browser client (no build step)
scripts/                         bots.mjs, verify.mjs, stats.mjs
wrangler.json                    config read by wrangler and by celld
deploy/celld/compose.yaml        the Arcane stack: node1, node2, lb
deploy/celld/.env.example        settings for the stack and for deploy:celld
deploy/celld/Dockerfile.deploy   celld + esbuild, used by deploy:celld
deploy/celld/compose.local.yaml  rehearsal additions: RustFS bucket + auto-deploy
deploy/celld/local.env           throwaway settings for the rehearsal
docs/                            spec, experiment details, results template
```

### How it works in one paragraph

Every board is one Durable Object: a tiny single-threaded server with its own SQLite database. Cloudflare (or celld) routes every connection for board `lobby` to the same object, wherever it runs. The object relays cursors to everyone on the board without storing them, saves finished strokes to SQLite before confirming them, and can be evicted from memory when idle while WebSockets stay connected. The Worker in front is a 20-line router. There's no separate database, cache, or pub/sub service.
