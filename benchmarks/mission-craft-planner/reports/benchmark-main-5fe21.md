# Mission Craft Planner Benchmark

- Branch: `main`
- Commit: `5fe21`
- Generated at: `2026-02-26T01:05:51.369Z`
- Profile snapshot: `$REPO_ROOT/benchmarks/mission-craft-planner/profile-snapshot-benchmark.json`
- Snapshot captured at: `2026-02-26T00:44:00.269Z`
- Quantity per target: `1`
- Loot load overhead: excluded (prewarmed and subtracted in planner benchmark hook)

| Target | Solve mode | Priority | Solve wall clock | Plan mission time | Plan GE cost | Solve path |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Gilded book of Basan (Gilded) | Normal | 100% Time | 76,801 ms (76.80s) | 27d 11h 12m (659.20h) | 9,469,326 | primary |
| Gilded book of Basan (Gilded) | Normal | 50/50 | 179,486 ms (179.49s) | 27d 11h 12m (659.20h) | 9,387,796 | primary |
| Gilded book of Basan (Gilded) | Normal | 100% GE | 51,231 ms (51.23s) | 71d 4h 48m (1708.80h) | 1,264,771 | primary |
| Gilded book of Basan (Gilded) | Faster, less optimal solve | 100% Time | 49,714 ms (49.71s) | 30d 22h 24m (742.40h) | 8,865,593 | primary |
| Gilded book of Basan (Gilded) | Faster, less optimal solve | 50/50 | 112,405 ms (112.41s) | 30d 22h 24m (742.40h) | 8,074,569 | primary |
| Gilded book of Basan (Gilded) | Faster, less optimal solve | 100% GE | 34,858 ms (34.86s) | 48d (1152.00h) | 3,127,673 | primary |
| Reggference titanium actuator (Reggference) | Normal | 100% Time | 11,466 ms (11.47s) | 1d 23h 20m (47.33h) | 1,178,656 | primary |
| Reggference titanium actuator (Reggference) | Normal | 50/50 | 19,196 ms (19.20s) | 2d (48.00h) | 1,161,078 | primary |
| Reggference titanium actuator (Reggference) | Normal | 100% GE | 167 ms (0.17s) | 25d 14h 24m (614.40h) | 0 | primary |
| Reggference titanium actuator (Reggference) | Faster, less optimal solve | 100% Time | 9,043 ms (9.04s) | 1d 23h 20m (47.33h) | 1,178,656 | primary |
| Reggference titanium actuator (Reggference) | Faster, less optimal solve | 50/50 | 13,682 ms (13.68s) | 2d (48.00h) | 1,161,078 | primary |
| Reggference titanium actuator (Reggference) | Faster, less optimal solve | 100% GE | 75 ms (0.07s) | 25d 14h 24m (614.40h) | 0 | primary |
| Brilliant light of Eggendil (Brilliant) | Normal | 100% Time | 181,687 ms (181.69s) | 8d (192.00h) | 3,673,950 | primary |
| Brilliant light of Eggendil (Brilliant) | Normal | 50/50 | 222,829 ms (222.83s) | 8d (192.00h) | 3,573,778 | primary |
| Brilliant light of Eggendil (Brilliant) | Normal | 100% GE | 13,215 ms (13.21s) | 26d 3h 12m (627.20h) | 810,284 | primary |
| Brilliant light of Eggendil (Brilliant) | Faster, less optimal solve | 100% Time | 128,218 ms (128.22s) | 8d (192.00h) | 3,673,950 | primary |
| Brilliant light of Eggendil (Brilliant) | Faster, less optimal solve | 50/50 | 154,327 ms (154.33s) | 8d (192.00h) | 3,622,887 | primary |
| Brilliant light of Eggendil (Brilliant) | Faster, less optimal solve | 100% GE | 6,974 ms (6.97s) | 26d 3h 12m (627.20h) | 810,284 | primary |

## Aggregate Solve Time

| Solve mode | Total wall clock |
| --- | ---: |
| Normal | 756,078 ms (756.08s) |
| Faster, less optimal solve | 509,296 ms (509.30s) |

## Priority Presets

- 100% Time: 100% time / 0% GE
- 50/50: 50% time / 50% GE
- 100% GE: 0% time / 100% GE
