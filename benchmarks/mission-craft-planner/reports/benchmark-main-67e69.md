# Mission Craft Planner Benchmark

- Branch: `main`
- Commit: `67e69`
- Generated at: `2026-02-26T06:42:23.396Z`
- Profile snapshot: `$REPO_ROOT/benchmarks/mission-craft-planner/profile-snapshot-benchmark.json`
- Snapshot captured at: `2026-02-26T00:44:00.269Z`
- Quantity per target: `1`
- Loot load overhead: excluded (prewarmed and subtracted in planner benchmark hook)

| Target | Solve mode | Priority | Solve wall clock | Plan mission time | Plan GE cost | Solve path |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Gilded book of Basan (Gilded) | Normal | 100% Time | 79,302 ms (79.30s) | 27d 14h 24m (662.40h) | 9,574,923 | primary |
| Gilded book of Basan (Gilded) | Normal | 50/50 | 207,839 ms (207.84s) | 27d 14h 24m (662.40h) | 9,387,796 | primary |
| Gilded book of Basan (Gilded) | Normal | 100% GE | 65,313 ms (65.31s) | 71d 4h 48m (1708.80h) | 1,264,771 | primary |
| Gilded book of Basan (Gilded) | Faster, less optimal solve | 100% Time | 46,118 ms (46.12s) | 32d (768.00h) | 8,922,958 | primary |
| Gilded book of Basan (Gilded) | Faster, less optimal solve | 50/50 | 129,102 ms (129.10s) | 32d (768.00h) | 8,074,569 | primary |
| Gilded book of Basan (Gilded) | Faster, less optimal solve | 100% GE | 42,205 ms (42.20s) | 48d (1152.00h) | 3,127,673 | primary |
| Reggference titanium actuator (Reggference) | Normal | 100% Time | 10,836 ms (10.84s) | 2d 9h 36m (57.60h) | 1,169,268 | primary |
| Reggference titanium actuator (Reggference) | Normal | 50/50 | 23,721 ms (23.72s) | 2d 9h 36m (57.60h) | 1,161,078 | primary |
| Reggference titanium actuator (Reggference) | Normal | 100% GE | 191 ms (0.19s) | 25d 14h 24m (614.40h) | 0 | primary |
| Reggference titanium actuator (Reggference) | Faster, less optimal solve | 100% Time | 11,203 ms (11.20s) | 2d 9h 36m (57.60h) | 1,169,268 | primary |
| Reggference titanium actuator (Reggference) | Faster, less optimal solve | 50/50 | 17,875 ms (17.88s) | 2d 9h 36m (57.60h) | 1,161,078 | primary |
| Reggference titanium actuator (Reggference) | Faster, less optimal solve | 100% GE | 119 ms (0.12s) | 25d 14h 24m (614.40h) | 0 | primary |
| Brilliant light of Eggendil (Brilliant) | Normal | 100% Time | 259,913 ms (259.91s) | 8d (192.00h) | 3,574,302 | primary |
| Brilliant light of Eggendil (Brilliant) | Normal | 50/50 | 290,226 ms (290.23s) | 8d (192.00h) | 3,501,438 | primary |
| Brilliant light of Eggendil (Brilliant) | Normal | 100% GE | 17,325 ms (17.32s) | 27d 4h 48m (652.80h) | 810,284 | primary |
| Brilliant light of Eggendil (Brilliant) | Faster, less optimal solve | 100% Time | 152,775 ms (152.78s) | 8d (192.00h) | 3,574,302 | primary |
| Brilliant light of Eggendil (Brilliant) | Faster, less optimal solve | 50/50 | 172,365 ms (172.37s) | 8d (192.00h) | 3,501,438 | primary |
| Brilliant light of Eggendil (Brilliant) | Faster, less optimal solve | 100% GE | 7,834 ms (7.83s) | 27d 4h 48m (652.80h) | 810,284 | primary |

## Aggregate Solve Time

| Solve mode | Total wall clock |
| --- | ---: |
| Normal | 954,666 ms (954.67s) |
| Faster, less optimal solve | 579,596 ms (579.60s) |

## Priority Presets

- 100% Time: 100% time / 0% GE
- 50/50: 50% time / 50% GE
- 100% GE: 0% time / 100% GE
