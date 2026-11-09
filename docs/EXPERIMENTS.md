# Experiment runbook

Three deployments of the same code, then five experiments run against each. Record results in `docs/RESULTS.md`.

| Name | Where | What it represents |
|---|---|---|
| A: Cloudflare | `wb.<your-domain>` | The managed platform: global, Cloudflare runs everything |
| B: celld | `wb-celld.<your-domain>` on Oracle | Self-hosted and distributed: your machines, your bucket |
| C: workerd | `wb-workerd.<your-domain>` on Oracle | Self-hosted, single instance: what existed before celld |

Use a different board name prefix per run so results don't mix (e.g. `a-fail-1`, `b-fail-1`).

---

## Setup

### A: Cloudflare

```bash
npm install
npx wrangler login
npm run deploy:cf
```

Then in the dashboard: Workers & Pages → whiteboard-lab → Settings → Domains & Routes → add custom domain `wb.<your-domain>` (your domain must be on Cloudflare DNS).

### Oracle server prep (for B and C)

- Check the CPU: `uname -m`. `aarch64` means an Ampere ARM VM; confirm celld publishes an ARM64 build on its releases page, or use the Docker image.
- Oracle images block inbound ports twice: open the port in the VCN security list **and** in the VM's own firewall (`sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT`, then persist with `netfilter-persistent save`). This is the most common "why can't I reach it" problem on Oracle.
- Put TLS in front with Caddy (automatic certificates). Example `Caddyfile`:

```
wb-celld.<your-domain> {
  reverse_proxy localhost:<celld-port>
}
wb-workerd.<your-domain> {
  reverse_proxy localhost:8787
}
```

- DNS: add A records pointing at the Oracle VM. Set them to **DNS only (grey cloud)** so your latency numbers measure your server, not Cloudflare's proxy. Alternatively use a Cloudflare Tunnel if you can't open ports, but note it in your results since traffic then passes through Cloudflare's edge.

### B: celld

celld's commands and flags are moving quickly (it's beta), so follow its docs for exact syntax: https://celld.dev/docs. The shape of it:

1. **Bucket.** Use an R2 bucket from your Cloudflare account via its S3 API (endpoint `https://<account-id>.r2.cloudflarestorage.com`, region `auto`, with an R2 API token). celld requires conditional writes (compare-and-swap) on the bucket. Some S3-compatible providers don't support them; Oracle Object Storage's S3 layer is unverified, so start with R2.
2. **Install:** `curl -fsSL celld.dev/install.sh | sh` (or `docker run ghcr.io/denoland/celld`).
3. **Check the bucket:** run `celld diagnose` with your bucket env vars set. It should report all conditional-write checks passing. Don't proceed if it doesn't.
4. **Start nodes.** For a real failover test you want two nodes. Either two VMs (Oracle's free ARM allowance can be split in two) or, at minimum, two celld processes on one VM on different ports, both pointing at the same bucket.
5. **Deploy:** `celld deploy .` from this repo. It reads `wrangler.json`. Note any errors or edits you needed; that's your portability result.
6. Point Caddy at the nodes (with two nodes, use `reverse_proxy node1:port node2:port` so a dead node is skipped).

### C: workerd (single instance)

`wrangler dev` runs your app on workerd locally, with Durable Objects in single-instance mode. That's an honest stand-in for "self-hosted workerd before celld":

```bash
npm install
npm run dev:lan   # listens on 0.0.0.0:8787; state persists in .wrangler/state
```

Run it under `systemd` or `tmux` so it survives your SSH session.

---

## Experiment 1: Portability

**Question:** Does the same code run on all three without changes?

1. Deploy to A, B, and C from the same git commit.
2. Open each in a browser, draw, open a second tab, confirm cursors and strokes sync.
3. Record every change you had to make (code, config, flags) and every feature that behaved differently.

**Pass:** zero code changes. Config-only changes are worth noting but acceptable.

## Experiment 2: Latency

**Question:** How fast is each, from where?

```bash
node scripts/bots.mjs --url https://wb.<domain> --board a-lat --boards 10 --clients 5 --duration 120
```

Run against each deployment, ideally from two locations (your laptop, plus a cheap VM or a friend in another region). Note: for A, also run it from far away to see the global placement claim; the Board lives near whoever first created it.

**Record:** round-trip and save p50/p99 from `summary.json`.

## Experiment 3: Failover (the headline)

**Question:** When a server dies mid-session, do clients recover, and is any acknowledged stroke lost?

Terminal 1 (load):
```bash
node scripts/bots.mjs --url https://wb-celld.<domain> --board b-fail-1 --clients 20 --duration 180 --stroke-every 0.5
```
Terminal 2 (watch):
```bash
node scripts/stats.mjs --url https://wb-celld.<domain> --board b-fail-1
```
Also keep the board open in a browser.

At about 60s, on the node currently hosting the board: `sudo kill -9 <celld pid>`. (Find which node owns it from celld's logs or by killing nodes one at a time.)

After the run:
```bash
node scripts/verify.mjs --url https://wb-celld.<domain> --dir results/<run>
```

**Record:** time from kill to recovery (from `stats.mjs` and the bot timeline), strokes lost (verify), reconnects, and whether the instance id changed.

**Expected:**
- B (celld, 2 nodes): another node takes over the board. celld advertises about 20s failover and zero acked writes lost.
- C (workerd): the board is down until you restart the process. Data should survive a restart because SQLite is on local disk, but there's no failover. Kill the VM's disk and it's gone.
- A (Cloudflare): you can't kill their servers. Instead, read Cloudflare's incident history for Durable Objects and note it as the equivalent data point.

A baseline from the sandbox while building this (workerd via `wrangler dev`, `kill -9` of the runtime, 15 bots): clients reconnected about 1–2s after the process came back, and 817 of 817 acknowledged strokes were present afterward.

## Experiment 4: Hot board (the tradeoff)

**Question:** Where does one board's single thread hit its ceiling?

```bash
node scripts/bots.mjs --url <url> --board hot-1 --clients 10 --ramp 10 --ramp-every 15 --max-clients 500 --duration 300 --cursor-hz 30
```

Cursor traffic fans out to every other participant, so total messages per second grows roughly with participants squared. Watch the 5-second reports: the point where round-trip p99 climbs past ~100ms or bots start disconnecting is the ceiling.

Then run the same total number of bots spread over many boards (`--boards 50 --clients 10`) and compare. Many boards should scale; one board shouldn't.

**Record:** participant count at the ceiling for each deployment, from `timeline.json`. This is your concrete answer to "why would you not want this": a single hot object can't scale out, so you have to design around it (e.g. shard a huge board into regions, or sample cursors).

The bots run on one machine, so make sure the bot machine isn't the bottleneck (watch its CPU).

## Experiment 5: Idle cost and wake-up

**Question:** What does an idle board cost, and how long does it take to wake?

1. Create 200 boards with a little data each:
   ```bash
   node scripts/bots.mjs --url <url> --board idle --boards 200 --clients 1 --duration 20
   ```
2. Leave them idle for 30 minutes.
3. Open one in a browser and watch whether the instance id changes (it hibernated) and how long the first round trip takes.

For cost, compare:
- A: Cloudflare's dashboard usage for the period (requests, duration, storage).
- B: your VM cost plus R2 storage and operations (R2 dashboard shows Class A/B operations).

celld claims inactive cells cost roughly nothing in bucket operations; check that against R2's operation counts.

---

## Evaluating "does it live up to the hype"

Score each claim against your evidence:

| Claim | Evidence that supports it | Evidence that undercuts it |
|---|---|---|
| Simple to build stateful real-time apps | Lines of code; no Redis, no locks | Anything you had to work around |
| Runs anywhere (no lock-in) | Experiment 1 result | Features that didn't port |
| Self-hosted is production-viable | Experiment 3 on celld | Failover time, lost writes, ops effort |
| Scales | Experiment 4, many boards | Experiment 4, one hot board |
| Cheap | Experiment 5 | Ops hours you spent (count them) |
