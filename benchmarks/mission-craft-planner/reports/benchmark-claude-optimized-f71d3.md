# Mission Craft Planner Benchmark

- Branch: `claude-optimized`
- Commit: `f71d3`
- Generated at: `2026-02-26T04:45:00.328Z`
- Profile snapshot: `$REPO_ROOT/benchmarks/mission-craft-planner/profile-snapshot-benchmark.json`
- Snapshot captured at: `2026-02-26T00:44:00.269Z`
- Quantity per target: `1`
- Loot load overhead: excluded (prewarmed and subtracted in planner benchmark hook)

| Target | Solve mode | Priority | Solve wall clock | Plan mission time | Plan GE cost | Solve path |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Gilded book of Basan (Gilded) | Normal | 100% Time | 7,210 ms (7.21s) | 27d 14h 24m (662.40h) | 9,408,806 | primary |
| Gilded book of Basan (Gilded) | Normal | 50/50 | 11,152 ms (11.15s) | 27d 14h 24m (662.40h) | 9,392,165 | primary |
| Gilded book of Basan (Gilded) | Normal | 100% GE | 4,181 ms (4.18s) | 59d 11h 12m (1427.20h) | 1,433,816 | primary |
| Gilded book of Basan (Gilded) | Faster, less optimal solve | 100% Time | 60 ms (0.06s) | 30d 9h 36m (729.60h) | 8,913,348 | primary |
| Gilded book of Basan (Gilded) | Faster, less optimal solve | 50/50 | 64 ms (0.06s) | 30d 9h 36m (729.60h) | 8,913,348 | primary |
| Gilded book of Basan (Gilded) | Faster, less optimal solve | 100% GE | 63 ms (0.06s) | 48d (1152.00h) | 3,127,673 | primary |
| Reggference titanium actuator (Reggference) | Normal | 100% Time | 1,313 ms (1.31s) | 2d 9h 36m (57.60h) | 1,169,268 | primary |
| Reggference titanium actuator (Reggference) | Normal | 50/50 | 1,815 ms (1.81s) | 2d 9h 36m (57.60h) | 1,167,236 | primary |
| Reggference titanium actuator (Reggference) | Normal | 100% GE | 201 ms (0.20s) | 25d 14h 24m (614.40h) | 0 | primary |
| Reggference titanium actuator (Reggference) | Faster, less optimal solve | 100% Time | 53 ms (0.05s) | 1d 14h 24m (38.40h) | 1,165,194 | primary |
| Reggference titanium actuator (Reggference) | Faster, less optimal solve | 50/50 | 53 ms (0.05s) | 1d 14h 24m (38.40h) | 1,165,194 | primary |
| Reggference titanium actuator (Reggference) | Faster, less optimal solve | 100% GE | 52 ms (0.05s) | 25d 14h 24m (614.40h) | 0 | primary |
| Brilliant light of Eggendil (Brilliant) | Normal | 100% Time | 7,917 ms (7.92s) | 8d (192.00h) | 3,695,869 | primary |
| Brilliant light of Eggendil (Brilliant) | Normal | 50/50 | 34,943 ms (34.94s) | 8d (192.00h) | 3,481,355 | primary |
| Brilliant light of Eggendil (Brilliant) | Normal | 100% GE | 3,340 ms (3.34s) | 27d 4h 48m (652.80h) | 810,284 | primary |
| Brilliant light of Eggendil (Brilliant) | Faster, less optimal solve | 100% Time | 83 ms (0.08s) | 6d 9h 36m (153.60h) | 4,016,541 | primary |
| Brilliant light of Eggendil (Brilliant) | Faster, less optimal solve | 50/50 | 87 ms (0.09s) | 6d 9h 36m (153.60h) | 4,016,541 | primary |
| Brilliant light of Eggendil (Brilliant) | Faster, less optimal solve | 100% GE | 80 ms (0.08s) | 25d 14h 24m (614.40h) | 810,284 | primary |

## Aggregate Solve Time

| Solve mode | Total wall clock |
| --- | ---: |
| Normal | 72,072 ms (72.07s) |
| Faster, less optimal solve | 595 ms (0.59s) |

## Priority Presets

- 100% Time: 100% time / 0% GE
- 50/50: 50% time / 50% GE
- 100% GE: 0% time / 100% GE
