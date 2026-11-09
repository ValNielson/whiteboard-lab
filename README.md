# whiteboard-lab

A shared whiteboard with live cursors. It exists to test the Cloudflare Workers + Durable Objects programming model, and the self-hosted versions of it (celld and workerd), for the Deno-joins-Cloudflare investigation.

It's an experiment rig, not a product. There's no auth, no undo, and no zoom. What it does have is built-in measurement (round trip, save time, reconnects, and which board instance is serving you), plus scripts to load-test it, crash it, and check that nothing acknowledged was lost.

This README is the runbook. Follow it top to bottom.

| Doc | What's in it |
|---|---|
| This README | Setup for all three deployments, then the experiments in order |
| [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md) | Longer explanation of each experiment and what to expect |
| [docs/SPEC.md](docs/SPEC.md) | Design, protocol, durability contract, client fallback behavior |
| [docs/RESULTS.md](docs/RESULTS.md) | Blank tables to fill in as you go |

---

## Where things stand

The app is built and tested locally (on workerd, through `wrangler dev`):

- Drawing, live cursors, save acknowledgements, and reconnect all work in the browser.
- 15 bots on 3 boards for 15s: 431 strokes sent, 431 acked, 0 lost. Round trip p50 2ms.
- Crash test: `kill -9` of the runtime during load, restarted 5s later. The bots reconnected about 1s after the restart, the board instance id changed, and 553 of 553 acknowledged strokes were still stored.

Not done yet:

- Nothing is deployed to Cloudflare or to the Oracle server.
- celld has not been run at all. The celld steps below come from celld's docs (v0.6.2 beta), not from a test run, so expect some friction. Write it down; that friction is a result.

---

## How the four questions map to the experiments

| Question | Where the answer comes from |
|---|---|
| What does "a better way to build web applications" mean? | Read [src/index.js](src/index.js). The whole backend is one file with no database server, cache, or pub/sub. Note how much you didn't have to set up during Setup A. |
| How is the model different? | The Board Durable Object: one single-threaded object per board, with its own SQLite, that every user of that board is routed to. Compare it to how you'd build this with Express + Postgres + Redis pub/sub. |
| What are the tradeoffs? | Experiment 4 (one hot board hits a ceiling), Experiment 3 (failover cost when self-hosting), Experiment 1 (what didn't port). |
| What experiment, and how do you judge the hype? | All five experiments, scored with the table at the end of this README. |

---

## What you need

- Node 22 or later on your laptop (`node --version`).
- Your Cloudflare account, with your domain's DNS on Cloudflare.
- The Oracle VM, with SSH access and sudo.
- About half a day. Setup A takes 15 minutes. Setup C takes about 30. Setup B (celld) is the unknown; give it 2 hours.

Track how long each setup takes, including debugging. It goes in the "Hours spent operating each" table in [docs/RESULTS.md](docs/RESULTS.md) and is part of the answer.

Use your real domain wherever this README says `example.com`.

---

## Step 0: Run it locally (5 minutes)

On your laptop, from this folder:

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:8787 in two browser windows and draw in one. You should see:

- the other window's cursor moving,
- your stroke dashed and faded for a moment, then solid (that means the board saved it and sent back an "ack"),
- the panel in the bottom right showing round trip, save time, and a "Board instance" id.

Add `?b=<name>` to the URL to switch boards. Each board name is a separate Durable Object.

In a second terminal, run a short load test and check it:

```bash
node scripts/bots.mjs --board smoke --clients 10 --duration 15 --run smoke
```

```bash
node scripts/verify.mjs --dir results/smoke
```

The last line should say `PASS: no acknowledged writes lost`.

Leave `npm run dev` running if you want to try the crash test locally first (see Experiment 3).

---

## Setup A: Cloudflare (about 15 minutes)

1. Log in and deploy:

   ```bash
   npx wrangler login
   ```

   ```bash
   npm run deploy:cf
   ```

   It prints a `*.workers.dev` URL. Open it and draw to check it works.

2. Add your domain. In the Cloudflare dashboard, go to **Workers & Pages → whiteboard-lab → Settings → Domains & Routes → Add → Custom domain**, and enter `wb.example.com`.

   Don't put the domain in `wrangler.json`. celld rejects unknown config keys, and the portability test needs the same file to deploy everywhere.

3. Check it: `curl https://wb.example.com/api/health` should return `{"ok":true,...}`.

Write down the git commit (`git rev-parse --short HEAD`) in the Environment table in RESULTS.md. All three deployments should come from the same commit.

---

## Prepare the Oracle VM (for Setups B and C)

SSH in and do these once.

1. **Check the CPU.**

   ```bash
   uname -m
   ```

   `aarch64` means an Ampere ARM VM. That's fine: celld ships a Linux ARM64 build, and workerd supports it too.

2. **Install Node 22, git, esbuild, and Caddy.** For Oracle Linux or Ubuntu, Node is easiest through nvm:

   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && source ~/.bashrc && nvm install 22
   ```

   ```bash
   npm install -g esbuild
   ```

   celld's `deploy` command needs `esbuild` on your PATH.

   For Caddy, follow the instructions for your distro at https://caddyserver.com/docs/install.

3. **Get the code onto the VM.** Push this repo somewhere you can clone from, or copy it:

   ```bash
   rsync -av --exclude node_modules --exclude .wrangler --exclude results ./ <user>@<vm-ip>:~/whiteboard-lab/
   ```

   Then on the VM:

   ```bash
   cd ~/whiteboard-lab && npm install
   ```

4. **Open ports 80 and 443.** Oracle blocks inbound traffic in two places, and you need both:

   - In the Oracle Cloud console: **Networking → Virtual Cloud Networks → your VCN → Security Lists → Default → Add Ingress Rules**. Source `0.0.0.0/0`, TCP, destination ports `80,443`.
   - On the VM itself:

     ```bash
     sudo iptables -I INPUT 6 -p tcp -m multiport --dports 80,443 -j ACCEPT
     ```

     ```bash
     sudo netfilter-persistent save
     ```

   If you can't reach the server later, this is the first thing to check.

   **Don't open celld's internal ports (8081, 8091).** celld's peer traffic is unencrypted and unauthenticated at the network level. It must stay on `127.0.0.1` or a private network.

5. **Add DNS records.** In Cloudflare DNS, add two A records pointing at the VM's public IP:

   - `wb-celld` → VM IP
   - `wb-workerd` → VM IP

   Set both to **DNS only (grey cloud)**. If they're proxied (orange cloud), your latency numbers include Cloudflare's network, and long-lived WebSockets go through Cloudflare's proxy, which changes the failover test.

6. **Configure Caddy.** Put this in `/etc/caddy/Caddyfile`:

   ```
   wb-celld.example.com {
     encode gzip
     reverse_proxy 127.0.0.1:8080 127.0.0.1:8090 {
       lb_policy first
       fail_duration 10s
     }
   }

   wb-workerd.example.com {
     encode gzip
     reverse_proxy 127.0.0.1:8787
   }
   ```

   The celld block sends traffic to node 1 and skips it when it's down. `encode gzip` is there because celld doesn't compress static files itself.

   ```bash
   sudo systemctl reload caddy
   ```

   Caddy gets TLS certificates for both names automatically, as long as ports 80 and 443 are open and DNS points at the VM.

---

## Setup C: workerd, single instance (about 30 minutes)

This is "self-hosted Workers before celld": the open-source runtime running your app, with Durable Objects working on one machine only. `wrangler dev` runs your code on workerd and stores Durable Object data in `.wrangler/state` on local disk.

On the VM, inside `tmux` so it survives SSH disconnects:

```bash
tmux new -s workerd
```

```bash
cd ~/whiteboard-lab && npm run dev:lan
```

Detach with `Ctrl-b d`. Check it from your laptop:

```bash
curl https://wb-workerd.example.com/api/health
```

---

## Setup B: celld (about 2 hours, the unknown one)

celld is Deno's self-hosted implementation of the Workers + Durable Objects model. It runs a fleet of nodes that share one object storage bucket. The bucket holds all the data and decides which node owns each Durable Object, so when a node dies another one can take its objects over.

celld is beta and changes fast. If a command below fails, check https://celld.dev/docs and `celld --help`, and write down what you changed.

### B1. Make an R2 bucket for celld

On your laptop:

```bash
npx wrangler r2 bucket create whiteboard-lab-celld
```

Then in the Cloudflare dashboard, go to **R2 → Manage API tokens → Create API token**. Choose **Object Read & Write**, limited to the `whiteboard-lab-celld` bucket only. Copy the Access Key ID, the Secret Access Key, and your Account ID.

Scope it to this one bucket. Whoever has the bucket credentials controls the whole celld fleet.

### B2. Install celld and set the bucket variables

On the VM:

```bash
curl -fsSL https://celld.dev/install.sh | sh
```

If it says to, add `~/.local/bin` to your PATH. Then create `~/celld.env` (fill in your values):

```bash
export AWS_ACCESS_KEY_ID=<r2 access key id>
export AWS_SECRET_ACCESS_KEY=<r2 secret>
export AWS_REGION=auto
export S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
export CELLD_BUCKET=s3://whiteboard-lab-celld
```

```bash
chmod 600 ~/celld.env && source ~/celld.env
```

Record the version (`celld --version`) in RESULTS.md.

### B3. Deploy the app into the bucket

```bash
cd ~/whiteboard-lab && celld deploy . --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION"
```

This reads `wrangler.json`, the same file Cloudflare used. **This is Experiment 1's main data point.** Write down every error and every change you had to make.

### B4. Start two nodes

Two nodes is the minimum for a failover test. On a single VM, run two celld processes on different ports, both using the same bucket. Use two tmux windows:

```bash
tmux new -s celld1
```

```bash
source ~/celld.env && celld --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION" --listen 127.0.0.1:8080 --internal-listen 127.0.0.1:8081 --advertise 127.0.0.1:8081
```

Detach (`Ctrl-b d`), then:

```bash
tmux new -s celld2
```

```bash
source ~/celld.env && celld --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION" --listen 127.0.0.1:8090 --internal-listen 127.0.0.1:8091 --advertise 127.0.0.1:8091
```

If the two processes fight over a local data directory, look in `celld --help` for a data-directory flag and give each node its own.

Nodes find each other through the bucket. There's no join command.

Two processes on one VM can survive a process crash, but not a VM crash. If you want the stronger test, split Oracle's free ARM allowance into two VMs, connect them with Tailscale, and use the Tailscale IPs for `--internal-listen` and `--advertise`.

### B5. Check the fleet

```bash
celld diagnose --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION"
```

It should list both nodes as live. Then from your laptop:

```bash
curl https://wb-celld.example.com/api/health
```

Open `https://wb-celld.example.com` in a browser and draw.

---

## The experiments

Run these in order. Use a board name prefix for each deployment and run so results don't mix: `a-` for Cloudflare, `b-` for celld, `c-` for workerd. Each bot run writes `results/<run>/summary.json`, `timeline.json`, and the list of acked stroke ids.

Run the bots from your laptop, not from the VM, so you measure the network.

Shorthand used below:

```bash
A=https://wb.example.com
B=https://wb-celld.example.com
C=https://wb-workerd.example.com
```

### Experiment 1: Portability

Does the same code run on all three without changes?

For each of A, B, C: open it in two browser windows, draw, and check that cursors and strokes sync both ways. Then run a quick check, for example on B:

```bash
node scripts/bots.mjs --url $B --board b-port --clients 5 --duration 20 --run b-port
```

```bash
node scripts/verify.mjs --url $B --dir results/b-port
```

Things that might differ on celld, so check them on purpose:

- **Stats.** Open `$B/api/boards/b-port/stats`. If `databaseBytes` is `null`, celld doesn't support `ctx.storage.sql.databaseSize`. That's a portability gap; the app already handles it.
- **Hibernation.** Leave a board open in a browser for 10 minutes without drawing. Does the instance id change? Does the socket stay connected?

Fill in the Portability table in RESULTS.md. **Pass:** zero code changes.

### Experiment 2: Latency

How fast is each one, and from where?

```bash
node scripts/bots.mjs --url $A --board a-lat --boards 10 --clients 5 --duration 120 --run a-lat
```

Repeat with `$B` (`b-lat`) and `$C` (`c-lat`). Take round trip p50/p99 and save p50/p99 from each `summary.json`.

What to look for:

- **Save time** is where the platforms differ most. Cloudflare saves to local storage with replicas. celld with two nodes waits for a follower node to have the write; with one node, every write waits for the bucket (celld says about 90ms in the same region; R2 may be farther away from Oracle than that). workerd writes to local disk.
- **Distance.** If you can, run it again from a machine in another region (a cheap cloud VM, or a coworker). Cloudflare places each Durable Object near whoever first used it, so `a-lat` boards created from your laptop live near you. The Oracle VM is in one place for everyone.

### Experiment 3: Failover (the main one)

When a server dies during a session, do clients recover, and is any acknowledged stroke lost?

Open three terminals on your laptop and the board in a browser (`$B/?b=b-fail-1`).

Terminal 1, the load:

```bash
node scripts/bots.mjs --url $B --board b-fail-1 --clients 20 --duration 180 --stroke-every 0.5 --run b-fail-1
```

Terminal 2, the watcher (prints the instance id and stroke count every second, and how long the board was unreachable):

```bash
node scripts/stats.mjs --url $B --board b-fail-1
```

Terminal 3, SSH to the VM. At about 60 seconds, kill the node that owns the board. Start with node 1, since Caddy sends traffic there first:

```bash
pgrep -af "celld .*8080"
```

```bash
kill -9 <that pid>
```

If the board keeps working without any blip, node 2 owned it. Restart node 1 and kill node 2 instead on the next run (`b-fail-2`).

After the bots finish:

```bash
node scripts/verify.mjs --url $B --dir results/b-fail-1
```

Record: time from kill until the stats watcher prints `back after`, strokes lost (from verify), reconnects (from `summary.json`), and whether the instance id changed. celld claims about 20 seconds to fail over and zero acknowledged writes lost.

**Then do the same for C** with `$C` and board `c-fail-1`. Kill the runtime on the VM:

```bash
pkill -9 -f workerd; pkill -9 -f "wrangler-dist/cli.js dev"
```

Wait about 10 seconds, then restart it in the `workerd` tmux session (`npm run dev:lan`). Expected: the board is down until you restart it, nothing takes over, and the data survives because it's on local disk. Recovery time is however long it takes you to notice and restart it.

Kill both processes. If you only kill workerd, wrangler's proxy keeps the port open with nothing behind it, and clients hang. The client's 5-second connect timeout is there for exactly that case, so you can try it deliberately to see the client handle it.

**For A**, you can't kill Cloudflare's servers. Instead, look up Durable Objects incidents at https://www.cloudflarestatus.com/history and note them.

You can rehearse this on your laptop first against `npm run dev`. That's how the 553/553 baseline above was measured.

### Experiment 4: Hot board (the tradeoff)

Where does one board's single thread run out of capacity?

```bash
node scripts/bots.mjs --url $A --board a-hot-1 --clients 10 --ramp 10 --ramp-every 15 --max-clients 500 --duration 300 --cursor-hz 30 --run a-hot-1
```

This adds 10 bots every 15 seconds. Every cursor movement goes to everyone else on the board, so traffic grows with roughly the square of the number of people. Watch the report printed every 5 seconds. The ceiling is the bot count where round trip p99 goes above about 100ms, or where bots start reconnecting.

Then spread the same number of bots over many boards and compare:

```bash
node scripts/bots.mjs --url $A --board a-spread --boards 50 --clients 10 --duration 120 --cursor-hz 30 --run a-spread
```

Repeat both for B and C. Watch your laptop's CPU in Activity Monitor; if it's maxed out, the bots are the bottleneck, not the server. Stop around 200 bots per run if it is.

This is the concrete answer to "why would you not want this?": one board can't spread across machines. If one room gets huge, you have to split it yourself.

### Experiment 5: Idle cost and wake-up

What does an idle board cost, and how long does it take to wake up?

1. Create 200 boards with a little data each:

   ```bash
   node scripts/bots.mjs --url $A --board a-idle --boards 200 --clients 1 --duration 20 --run a-idle
   ```

2. Leave them alone for 30 minutes.
3. Open `$A/?b=a-idle-7` in a browser. Note whether the instance id is new (it was evicted from memory) and what the first round trip is.

Repeat on B. For cost, compare Cloudflare's Workers usage page for the time period against celld's VM cost plus R2 operations (**R2 → whiteboard-lab-celld → Metrics** shows Class A and B operation counts). celld claims idle boards cost close to nothing in bucket operations; check the operation count before and after the idle period.

---

## Clean up

There's no auth, so anyone with a URL can draw on or clear a board. Take things down when you're done:

- Cloudflare: `npx wrangler delete`
- Oracle: stop the tmux sessions (`tmux kill-server`) and remove the Caddy blocks.
- R2: delete the `whiteboard-lab-celld` bucket's contents and the API token.

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

### Scripts

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

### How it works in one paragraph

Every board is one Durable Object: a tiny single-threaded server with its own SQLite database. Cloudflare (or celld) routes every connection for board `lobby` to the same object, wherever it runs. The object relays cursors to everyone on the board without storing them, saves finished strokes to SQLite before confirming them, and can be evicted from memory when idle while WebSockets stay connected. The Worker in front is a 20-line router. There's no separate database, cache, or pub/sub service.

### Layout

```
src/index.js        Worker router + Board Durable Object
public/             browser client (no build step)
scripts/            bots.mjs, verify.mjs, stats.mjs
wrangler.json       config read by wrangler and by celld
docs/               spec, experiment details, results template
```
