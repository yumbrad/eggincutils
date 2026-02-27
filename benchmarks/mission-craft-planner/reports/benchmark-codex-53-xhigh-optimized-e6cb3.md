# Mission Craft Planner Benchmark

- Branch: `codex-53-xhigh-optimized`
- Commit: `e6cb3`
- Generated at: `2026-02-26T06:53:48.237Z`
- Profile snapshot: `$REPO_ROOT/benchmarks/mission-craft-planner/profile-snapshot-benchmark.json`
- Snapshot captured at: `2026-02-26T00:44:00.269Z`
- Quantity per target: `1`
- Loot load overhead: excluded (prewarmed and subtracted in planner benchmark hook)

| Target | Solve mode | Priority | Solve wall clock | Plan mission time | Plan GE cost | Solve path |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Gilded book of Basan (Gilded) | Normal | 100% Time | 4,150 ms (4.15s) | 27d 14h 24m (662.40h) | 9,476,469 | primary |
| Gilded book of Basan (Gilded) | Normal | 50/50 | 18,162 ms (18.16s) | 27d 14h 24m (662.40h) | 9,387,796 | primary |
| Gilded book of Basan (Gilded) | Normal | 100% GE | 70,699 ms (70.70s) | 71d 4h 48m (1708.80h) | 1,264,771 | primary |
| Gilded book of Basan (Gilded) | Faster, less optimal solve | 100% Time | 7,202 ms (7.20s) | 32d (768.00h) | 8,945,011 | primary |
| Gilded book of Basan (Gilded) | Faster, less optimal solve | 50/50 | 40,343 ms (40.34s) | 32d (768.00h) | 8,886,294 | primary |
| Gilded book of Basan (Gilded) | Faster, less optimal solve | 100% GE | 18,265 ms (18.27s) | 48d (1152.00h) | 3,127,673 | primary |
| Reggference titanium actuator (Reggference) | Normal | 100% Time | 542 ms (0.54s) | 2d 9h 36m (57.60h) | 1,169,268 | primary |
| Reggference titanium actuator (Reggference) | Normal | 50/50 | 3,005 ms (3.00s) | 2d 9h 36m (57.60h) | 1,161,078 | primary |
| Reggference titanium actuator (Reggference) | Normal | 100% GE | 1,261 ms (1.26s) | 16d 9h 36m (393.60h) | 0 | primary |
| Reggference titanium actuator (Reggference) | Faster, less optimal solve | 100% Time | 395 ms (0.40s) | 2d 9h 36m (57.60h) | 1,169,268 | primary |
| Reggference titanium actuator (Reggference) | Faster, less optimal solve | 50/50 | 488 ms (0.49s) | 2d 9h 36m (57.60h) | 1,161,078 | primary |
| Reggference titanium actuator (Reggference) | Faster, less optimal solve | 100% GE | 571 ms (0.57s) | 25d 14h 24m (614.40h) | 0 | primary |
| Brilliant light of Eggendil (Brilliant) | Normal | 100% Time | 16,764 ms (16.76s) | 8d (192.00h) | 3,695,869 | primary |
| Brilliant light of Eggendil (Brilliant) | Normal | 50/50 | 132,582 ms (132.58s) | 8d (192.00h) | 3,501,438 | primary |
| Brilliant light of Eggendil (Brilliant) | Normal | 100% GE | 13,754 ms (13.75s) | 27d 4h 48m (652.80h) | 810,284 | primary |
| Brilliant light of Eggendil (Brilliant) | Faster, less optimal solve | 100% Time | 11,651 ms (11.65s) | 8d (192.00h) | 3,695,869 | primary |
| Brilliant light of Eggendil (Brilliant) | Faster, less optimal solve | 50/50 | 43,016 ms (43.02s) | 8d (192.00h) | 3,504,385 | primary |
| Brilliant light of Eggendil (Brilliant) | Faster, less optimal solve | 100% GE | 2,539 ms (2.54s) | 27d 4h 48m (652.80h) | 810,284 | primary |

## Aggregate Solve Time

| Solve mode | Total wall clock |
| --- | ---: |
| Normal | 260,919 ms (260.92s) |
| Faster, less optimal solve | 124,470 ms (124.47s) |

## Priority Presets

- 100% Time: 100% time / 0% GE
- 50/50: 50% time / 50% GE
- 100% GE: 0% time / 100% GE
