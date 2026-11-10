# whiteboard-lab

A shared whiteboard with live cursors. It exists to test the Cloudflare Workers + Durable Objects programming model, and celld (Deno's self-hosted version of it), for the Deno-joins-Cloudflare investigation.

It's an experiment rig, not a product. There's no auth, no undo, and no zoom. What it does have is built-in measurement (round trip, save time, reconnects, and which board instance is serving you), plus scripts to load-test it, crash it, and check that nothing acknowledged was lost.

This README is the runbook. Follow it top to bottom.

| Doc | What's in it |
|---|---|
| This README | The three workflows (local, Workers, celld), then the experiments |
| [compose.yaml](compose.yaml) | The celld stack Arcane runs (and `npm run rehearse:up` runs locally) |
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

This is the one left to do. It follows your normal hosting workflow: **GitHub → Arcane → tunnel route.** Apart from the tunnel you already use, nothing runs on Cloudflare, and there are no secrets to look up.

### How it works

Everything runs in one Arcane project, defined by [compose.yaml](compose.yaml) at the repo root:

```
browser / bots ──▶ wb-celld.skelsemporium.com ──▶ your tunnel ──▶ lb (port 8088)
                                                                    │
                                          node1 (node2 takes over if node1 dies)
                                                                    │
                          s3: the storage bucket both nodes share (app code, board data)
```

| Service | What it does | Normal state in Arcane |
|---|---|---|
| `s3` | The storage celld needs: an S3-compatible bucket ([RustFS](https://rustfs.com)) running in the stack | Running |
| `bucket` | Creates the bucket the first time, then exits | Exited (0) |
| `deploy` | Downloads the app code from GitHub (`master`), builds it, and puts it in the bucket, then exits | Exited (0) |
| `node1`, `node2` | Two celld servers. The bucket decides which one owns each board; if one dies, the other takes its boards over. | Running |
| `lb` | The one address your tunnel points at. Sends traffic to node1, or node2 when node1 is down. | Running |

"Exited (0)" on `bucket` and `deploy` is correct. They're one-time jobs.

**What gets deployed:** whatever is pushed to `master` on GitHub, not changes sitting on your laptop. To ship a change: commit, push, then redeploy the project in Arcane (or wait for Auto Sync). The local rehearsal (`npm run rehearse:up`) also builds from GitHub.

**Secrets:** none to look up. The storage login is made up and only works inside the stack, because nothing but `lb` is reachable from outside. If you want your own values, set `S3_ACCESS_KEY` and `S3_SECRET_KEY` in the Arcane project's `.env`, and set them before the first start: the login is fixed when the storage is first created.

Results from running this exact file on a laptop:

| Test | Result |
|---|---|
| Deploy with the unchanged `wrangler.json` | Worked, no edits |
| `ctx.storage.sql.databaseSize` | Supported |
| 15 bots on 3 boards for 20s | 580 of 580 strokes saved. Round trip p50 1ms, save p50 5.6ms |
| `kill -9` of node1 under load | Board back in 10s on node2. 1,129 of 1,129 acknowledged strokes kept. |
| Restart the whole stack | All data still there |

celld saves more slowly than local (5.6ms vs 2.5ms) because each write is copied to the second node before it's acknowledged.

Two nodes on one server survive a process crash, not a server crash. That's enough to test celld's failover. A real deployment would also keep the bucket on a separate storage service.

### Step 1: Try it on your laptop (optional, 5 minutes)

The same file runs locally. Docker Desktop needs to be running.

```bash
npm run rehearse:up
```

The first run downloads images and takes a few minutes. Open http://localhost:8088 in two windows and draw. Stop and delete it with:

```bash
npm run rehearse:down
```

### Step 2: Put the repo on GitHub

1. On github.com, click **New repository**. Name it `whiteboard-lab`, make it **Public**, and leave "Add a README" and the other boxes unticked (the repo must start empty).
2. From this folder, connect it and push (use the URL GitHub shows you):

   ```bash
   git remote add origin https://github.com/<your-username>/whiteboard-lab.git
   ```

   ```bash
   git push -u origin master
   ```

### Step 3: Create the project in Arcane from Git

1. **Add the repository:** Customization → Git Repositories → Add Repository. Paste the GitHub URL. It's public, so no token should be needed.
2. **Create the project:** Projects → the dropdown next to **Create Project** → **From Git Repo**. Fill in:

   | Field | Value |
   |---|---|
   | Direction | Pull |
   | Sync Name | `whiteboard-lab` |
   | Target Type | Project, create a new project |
   | Git Repository / Branch | your repo, `master` (not `main`) |
   | Compose File Path | `compose.yaml` |
   | Sync Files | Doesn't matter. The stack gets the app code from GitHub itself. |
   | Redeploy After Sync | On, so pushing a change redeploys it |

3. Start the project. The first start builds the app and downloads images, so give it a few minutes. Then check the services match the table above.

If port 8088 is already taken on your server, add `WB_PORT=` with a free port to the project's `.env` and restart the project.

### Step 4: Add the tunnel route

Add a public hostname to your tunnel, the way you do for your other apps:

- Hostname: `wb-celld.skelsemporium.com`
- Service: `http://localhost:8088`. If `cloudflared` runs in a Docker container, use the server's LAN IP instead of `localhost`, for example `http://192.168.1.20:8088`.

If you still have the `wb-celld` and `wb-workerd` A records from the earlier plan, delete them first. The tunnel can't create its `wb-celld` record while an A record with that name exists.

Check it:

```bash
curl https://wb-celld.skelsemporium.com/api/health
```

Then open https://wb-celld.skelsemporium.com and draw. Done.

Note in RESULTS.md that celld traffic comes through your tunnel. Requests go through Cloudflare's network before reaching your server, so that's part of celld's latency numbers.

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

- **Save time.** On celld, the node acknowledges a write once the other node has it on disk, then copies it to the bucket in the background. If one node is down, every write waits for the bucket instead. Try a run with node2 stopped to see that cost.
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

At about 60 seconds, kill node1. The load balancer sends everything to node1 while it's healthy, so node1 owns the board. On the server (if the name doesn't match, find it with `docker ps`; it comes from the Arcane project name):

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

2. Leave everything alone for 30 minutes.
3. Open `$CELLD/?b=c-idle-7`. Note whether the instance id is new (it was evicted from memory) and the first round trip.

Repeat on Workers (`w-idle`), and look at Cloudflare's Workers usage page for the same period. celld's cost is your server's cost: note its CPU and memory use with 200 idle boards (Arcane's container stats).

---

## Clean up

There's no auth, so anyone with a URL can draw on or clear a board. Take things down when you're done:

- **Arcane:** stop and delete the `whiteboard-lab` project, including its volumes, and remove the tunnel route.
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
| `npm run rehearse:up` / `rehearse:down` | Start or delete the celld stack locally at http://localhost:8088 |

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
compose.yaml                     the celld stack: storage, deploy job, node1, node2, lb
docs/                            spec, experiment details, results template
```

### How it works in one paragraph

Every board is one Durable Object: a tiny single-threaded server with its own SQLite database. Cloudflare (or celld) routes every connection for board `lobby` to the same object, wherever it runs. The object relays cursors to everyone on the board without storing them, saves finished strokes to SQLite before confirming them, and can be evicted from memory when idle while WebSockets stay connected. The Worker in front is a 20-line router. There's no separate database, cache, or pub/sub service.
