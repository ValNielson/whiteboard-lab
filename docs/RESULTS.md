# Results

Runs on 2026-11-10 (UTC), from a MacBook on home Wi-Fi, against:

- **Workers:** https://whiteboard-lab.mantiswhiteboard.workers.dev
- **celld:** https://wb-celld.skelsemporium.com (Arcane on `brick`, through a Cloudflare Tunnel)

Raw output from each bot run is in `results/<run>/` (summary.json, timeline.json, acked-*.json). Run names start with `w-` for Workers and `c-` for celld.

## Summary of what we saw

1. **The same code ran on both, unchanged.** Same `src/index.js`, same `wrangler.json`. Every feature worked on celld, including WebSocket hibernation, SQLite, and `databaseSize`.
2. **Neither platform lost a single saved stroke**, across every run: under normal load, under overload, and through a crash of a celld node. That's the durability promise ("if you got an ack, it's stored") holding on both.
3. **Workers is faster, and the gap is the trip to your server.** In the best case, a round trip took 29ms on Workers and 55ms on celld. Both go through the same Cloudflare location (Chicago, `ORD`). celld then goes through the tunnel to your server and back, which adds about 25ms.
4. **celld slowed down more under load.** With 50 bots spread over 10 boards, median round trip was 115ms on Workers and 240ms on celld. Workers spreads boards over Cloudflare's machines. On celld, everything runs on one server behind one tunnel.
5. **celld failover works as advertised, and faster.** With 20 bots drawing, node1 was killed with `kill -9`. The board was back on node2 in about 9 seconds (celld advertises about 20), every client reconnected on its own, and all 9,183 acknowledged strokes were kept. In the browser: "Connection lost", four retries, then "Live" with a new board instance id. Workers can't be tested this way, because you can't kill Cloudflare's machines.
6. **Running on one node cost little.** During the failover run, celld's median save time was about 195ms with both nodes up and about 210ms on node2 alone. A single stroke drawn in the browser while on one node took 210ms to save on celld against 78ms on Workers, but one stroke is a small sample.
7. **When overloaded, they fail differently.** Workers dropped and reconnected the sockets. celld kept the sockets open but fell further and further behind, to 2–5 seconds of delay, with 1,128 strokes still waiting for an ack when the run ended. Neither lost acked data.
8. **Idle boards: Workers evicts them, celld keeps them in memory.** On Workers, boards idle for about 13 minutes had been evicted and restarted instantly on the next request. On celld, idle boards stayed in memory.
9. **We couldn't measure a real single-board ceiling from home.** Both platforms slowed at the same point (35–50 bots on one board) because the cursor fan-out needed about 30 Mbit/s of download, and this connection measured 34 Mbit/s. To find the platforms' real limits, run the bots from a cloud VM.

**Big caveat:** the home Wi-Fi was noisy. Ping to Cloudflare (1.1.1.1) ranged from 17ms to 200ms during the tests, averaging about 100ms. Medians are mostly that noise. The **minimum** and **p5** round trips are the cleaner signal, which is why they're reported below. Workers and celld were run at the same time wherever possible, so they shared the same network conditions.

## What to look at in the UI

Open the same board name on both sites (for example `?b=demo`) and draw. The panel in the bottom-right corner shows:

| Field | What it means | What we saw |
|---|---|---|
| Round trip | Time for a message to reach the board and come back (p50 = typical, p99 = worst 1%) | Workers 84ms, celld 135ms |
| Save time | Time from releasing the mouse until the board confirms the stroke is stored | Workers 78ms, celld 210ms (one stroke each) |
| Ink style | Dashed and faded = sent but not yet confirmed. Solid = stored. | The ink stays dashed visibly longer on celld |
| Waiting to save | Strokes sent but not yet confirmed. Should drop back to 0. | 0 on both |
| Board instance | Random id given each time the board's Durable Object starts. It changes on a crash, a failover, or a wake from hibernation. | Changes after a celld node is killed |
| Reconnects | How many times your browser lost the connection and reconnected | 0 on both in normal use |

The most interesting thing to watch is a failover. During the `c-fail-1` run, the open browser showed "Connection lost" four times and the status "Offline, retrying in 4.0s". About 10 seconds after the kill it went back to "Live", logged "Board instance changed ef7b4e5a → c21351c9", and reloaded all saved strokes. Any ink drawn during the gap stays dashed, then turns solid once it's resent and saved.

## Environment

| | Workers | celld | Local (baseline) |
|---|---|---|---|
| Version / commit | wrangler 4.158.0 | celld 0.6.3, commit 6298c3b | wrangler 4.158.0 |
| Machines | Cloudflare network (served from ORD) | one server (`brick`), 2 celld nodes in Docker | MacBook (M-series) |
| How traffic arrives | Direct to Cloudflare | Cloudflare edge (ORD) → Tunnel → Caddy `lb` | localhost |
| Storage | Durable Object SQLite | RustFS bucket in the stack + node disks | local disk |
| Bot location | MacBook, home Wi-Fi (34 Mbit/s down, 21 up) | same | same machine |

## 1. Portability

| | Workers | celld |
|---|---|---|
| Code changes needed | none (reference) | none |
| Config changes needed | none (reference) | none to `wrangler.json`. Hosting needed its own compose file (storage, 2 nodes, load balancer) |
| Features that behaved differently | | Saves are slower with one node down (writes wait for the bucket) |
| `databaseSize`, SQLite, hibernation API | work | work |

## 2. Latency (ms)

Same time, same network. "1 bot" = one connection on its own. "50 bots" = 10 boards with 5 bots each.

| Run | RTT min | RTT p5 | RTT p50 | RTT p99 | Save min | Save p50 | Save p99 |
|---|---|---|---|---|---|---|---|
| Workers, 1 bot (`w-lat1`) | 29 | 33 | 105 | 252 | 45 | 117 | 253 |
| celld, 1 bot (`c-lat1`) | 55 | 59 | 113 | 268 | 58 | 130 | 259 |
| Workers, 50 bots (`w-lat`) | 25 | 41 | 115 | 373 | 41 | 138 | 400 |
| celld, 50 bots (`c-lat`) | 53 | 130 | 240 | 596 | 73 | 305 | 687 |
| Local baseline | | | 2 | 8.5 | | 2.6 | 10.8 |

Both runs had both celld nodes up. Plain HTTPS requests (new connection each time) took a median of 384ms to Workers and 410ms to celld, mostly the TLS handshake over the noisy Wi-Fi.

How to read it:

- **Network path:** compare RTT min. 29ms vs 55ms, so celld's path is about 25ms longer.
- **Cost of a save:** compare save min against RTT min. Workers 45 − 29 = 16ms; celld 58 − 55 = 3ms. On Workers the save waits for Cloudflare to copy the write to other machines. On celld it waits for the second node, which is on the same server.
- **Under load:** celld's p5 jumped from 59 to 130 with 50 bots, so even its best case got slower. Workers' best case didn't move.

## 3. Failover

| | Recovery time | Acked strokes lost | Reconnects | Instance changed? |
|---|---|---|---|---|
| celld (kill -9 node1, between runs) | serving again on the next request | 0 of 1,707 | n/a (no clients connected) | yes (`c-lat-0`: activations 1 → 2) |
| celld (kill -9 node1, during load: `c-fail-1`, 20 bots, 4 min) | **~9s** (watcher: unreachable at 03:27:53, back 8.9s later) | **0 of 9,183** | 113 attempts across 20 bots, all during the gap | yes (`ef7b4e5a` → `c21351c9` on node2) |
| Workers (incident history) | see cloudflarestatus.com | n/a | n/a | n/a |
| Local (kill -9, manual restart after 5s) | until restarted, then ~1s | 0 of 553 | all 10 bots (64 attempts) | yes |

## 4. Hot board (one board, 5 → 60 bots, cursors at 10/s)

Median round trip (ms) as bots were added:

| Bots on the board | 10 | 20 | 30 | 40 | 50 | 60 |
|---|---|---|---|---|---|---|
| Workers (`w-hot-1`) | 108–116 | 97–124 | 101–164 | 138–176 | 197–226 | 386–571, then sockets dropped |
| celld (`c-hot-1`) | 135–145 | 182–184 | 247 | 174–195 | 247–269 | 797 → 1,780 → 2,760, 30 bots disconnected |

| | Acked | Lost | Never acked by the end | Reconnects |
|---|---|---|---|---|
| Workers | 2,078 | 0 | 13 | 156 (all in the last 5s) |
| celld | 976 | 0 | 1,128 | 30 |

Caveats:

- **Bandwidth, not the platforms.** At 60 bots, the board sends about 35,000 cursor messages per second to the bots, roughly 30 Mbit/s, and this connection's download was 34 Mbit/s. Both platforms degrading from about 35 bots is mostly this. The bot process itself stayed under 20% CPU, so the laptop's CPU wasn't the limit.
- **celld was on one node** for this run (node1 had been killed a minute earlier), so its saves waited for the bucket.
- What still holds: under overload, Workers sheds connections and clients reconnect, while celld queues work and latency keeps growing.

## 5. Idle and wake-up

50 boards on each were seeded at 03:12 UTC (reduced from 200 to stay well inside Cloudflare's free allowance).

Checked boards 7, 23 and 41 on each at 03:25 UTC, timing the first request (which may have to wake the board) against a second one right after it.

| | Idle time | First request / second request | Was the board evicted? |
|---|---|---|---|
| Workers | ~13 min (no connections) | 0.43–0.53s / 0.29–0.61s | **Yes.** `uptimeMs: 0`: Cloudflare had dropped all three from memory and started them fresh on the request |
| celld | ~5.5 min since last touched | 0.20–0.41s / 0.26–0.50s | **No.** Still resident (`uptimeMs` about 330,000) |

- **Workers evicts idle boards and wakes them on demand.** The wake-up cost didn't show above the Wi-Fi noise, so it's well under 100ms. Idle boards cost nothing but storage.
- **celld keeps idle boards in memory.** It doesn't evict boards without connections by default (its docs mention idle eviction as something you configure). On your own server, idle boards cost RAM rather than money. That's fine at 50 boards, but it's a capacity-planning question at thousands.
- celld's boards had last been activated at about 03:20, when the verify step touched them after node1 was killed, which is why the idle time is shorter.

## Not measured yet

- Latency from a second location far away.
- A true single-board ceiling (needs bots on a fast connection, such as a cloud VM).
- Cost: Cloudflare's usage page for the test window, against the server's monthly cost.

## Hours spent operating each

| | Setup | Debugging | Total |
|---|---|---|---|
| Workers | | | |
| celld | | | |

## Verdict

