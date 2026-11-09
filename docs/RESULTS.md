# Results

Fill this in as you run docs/EXPERIMENTS.md. Raw output from each bot run lives in `results/<run>/` (summary.json, timeline.json, acked-*.json).

## Environment

| | A: Cloudflare | B: celld | C: workerd |
|---|---|---|---|
| Version / commit | | | |
| Machines | Cloudflare network | | |
| Bucket / storage | DO SQLite | | local disk |
| Bot location(s) | | | |

## 1. Portability

| | A | B | C |
|---|---|---|---|
| Code changes needed | | | |
| Config changes needed | | | |
| Features that behaved differently | | | |

## 2. Latency (ms)

| | RTT p50 | RTT p99 | Save p50 | Save p99 |
|---|---|---|---|---|
| A, near | | | | |
| A, far | | | | |
| B, near | | | | |
| B, far | | | | |
| C, near | | | | |

## 3. Failover

| | Recovery time | Acked strokes lost | Reconnects | Instance changed? |
|---|---|---|---|---|
| B (kill -9 owning node) | | | | |
| C (kill -9 process) | | | | |
| A (incident history) | | n/a | n/a | n/a |

## 4. Hot board ceiling

| | Participants at ceiling (one board) | Same total spread over many boards |
|---|---|---|
| A | | |
| B | | |
| C | | |

## 5. Idle cost and wake-up

| | Wake-up first RTT | Hibernated? | Monthly cost estimate (200 boards) |
|---|---|---|---|
| A | | | |
| B | | | |

## Hours spent operating each

| | Setup | Debugging | Total |
|---|---|---|---|
| A | | | |
| B | | | |
| C | | | |

## Verdict

