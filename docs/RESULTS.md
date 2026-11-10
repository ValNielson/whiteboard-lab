# Results

Fill this in as you run the experiments in the README. Raw output from each bot run lives in `results/<run>/` (summary.json, timeline.json, acked-*.json).

The **Local** column is a baseline from `npm run dev` (workerd, one process on a laptop). It's already filled in where we have numbers. The comparison that matters is **Workers** vs **celld**.

## Environment

| | Workers | celld | Local (baseline) |
|---|---|---|---|
| URL | whiteboard-lab.mantiswhiteboard.workers.dev | wb-celld.skelsemporium.com | localhost:8787 |
| Version / commit | | celld 0.6.3, commit: | wrangler 4.158.0 |
| Machines | Cloudflare network | | MacBook (M-series) |
| How traffic arrives | Direct to Cloudflare | Cloudflare Tunnel → Arcane `lb` | localhost |
| Storage | Durable Object SQLite | R2 bucket + node disks | local disk |
| Bot location(s) | | | same machine |

## 1. Portability

| | Workers | celld |
|---|---|---|
| Code changes needed | none (reference) | |
| Config changes needed | none (reference) | |
| Features that behaved differently | | |
| WebSocket hibernation: socket stayed open? instance id changed? | | |

## 2. Latency (ms)

| | RTT p50 | RTT p99 | Save p50 | Save p99 |
|---|---|---|---|---|
| Workers, from laptop | | | | |
| Workers, from far away | | | | |
| celld, from laptop | | | | |
| celld, from far away | | | | |
| celld, node2 stopped (writes wait for R2) | | | | |
| Local (baseline) | 2 | 8.5 | 2.6 | 10.8 |

## 3. Failover

| | Recovery time | Acked strokes lost | Reconnects | Instance changed? |
|---|---|---|---|---|
| celld (kill -9 node1) | | | | |
| celld (graceful stop of node1) | | | | |
| Workers (incident history) | | n/a | n/a | n/a |
| Local (kill -9, manual restart after 5s) | until restarted, then ~1s | 0 of 553 | all 10 bots (64 attempts) | yes |

## 4. Hot board ceiling

| | Participants at ceiling (one board) | Same total spread over many boards |
|---|---|---|
| Workers | | |
| celld | | |

## 5. Idle cost and wake-up

| | Wake-up first RTT | Hibernated? | R2 operations while idle | Monthly cost estimate (200 boards) |
|---|---|---|---|---|
| Workers | | | n/a | |
| celld | | | | |

## Hours spent operating each

| | Setup | Debugging | Total |
|---|---|---|---|
| Workers | | | |
| celld | | | |

## Verdict

