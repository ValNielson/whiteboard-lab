# Experiment runbook

The same code on Workers and on celld, then five experiments run against each. The README has the exact commands; this file explains what each experiment measures and what to expect. Record results in `docs/RESULTS.md`.

| Name | Where | What it represents |
|---|---|---|
| Workers | `whiteboard-lab.mantiswhiteboard.workers.dev` | The managed platform: global, Cloudflare runs everything |
| celld | `wb-celld.skelsemporium.com` (Cloudflare Tunnel), two nodes in an Arcane (Docker) project on your server | Self-hosted and distributed: your machines, your bucket |
| Local (baseline only) | `npm run dev` on your laptop | workerd as one process: what self-hosting looked like before celld |

Use a different board name prefix per run so results don't mix (e.g. `a-fail-1`, `b-fail-1`).

---

## Setup

Setup steps, with the exact commands, are in the [README](../README.md). Local is a baseline only; notes about it below are kept for reference.

---

## Experiment 1: Portability

**Question:** Does the same code run on all three without changes?

1. Deploy to Workers and celld from the same git commit.
2. Open each in a browser, draw, open a second tab, confirm cursors and strokes sync.
3. Record every change you had to make (code, config, flags) and every feature that behaved differently.

**Pass:** zero code changes. Config-only changes are worth noting but acceptable.

## Experiment 2: Latency

**Question:** How fast is each, from where?

```bash
node scripts/bots.mjs --url https://wb.<domain> --board a-lat --boards 10 --clients 5 --duration 120
```

Run against each deployment, ideally from two locations (your laptop, plus a cheap VM or a friend in another region). Note: for Workers, also run it from far away to see the global placement claim; the Board lives near whoever first created it.

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
- celld (2 nodes): another node takes over the board. celld advertises about 20s failover and zero acked writes lost.
- Local (workerd, one process): the board is down until you restart the process. Data should survive a restart because SQLite is on local disk, but there's no failover. Lose the disk and it's gone.
- Workers: you can't kill their servers. Instead, read Cloudflare's incident history for Durable Objects and note it as the equivalent data point.

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
- Workers: Cloudflare's dashboard usage for the period (requests, duration, storage).
- celld: your server's cost plus R2 storage and operations (R2 dashboard shows Class A/B operations).

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
