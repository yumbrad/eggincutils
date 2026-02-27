# Mission Craft Planner Benchmark

- Branch: `claude-optimized`
- Commit: `002f4`
- Generated at: `2026-02-26T07:13:26.122Z`
- Profile snapshot: `$REPO_ROOT/benchmarks/mission-craft-planner/profile-snapshot-benchmark.json`
- Snapshot captured at: `2026-02-26T00:44:00.269Z`
- Quantity per target: `1`
- Loot load overhead: excluded (prewarmed and subtracted in planner benchmark hook)

| Target | Solve mode | Priority | Solve wall clock | Plan mission time | Plan GE cost | Solve path |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Gilded book of Basan (Gilded) | Normal | 100% Time | 5,919 ms (5.92s) | 27d 14h 24m (662.40h) | 9,408,806 | primary |
| Gilded book of Basan (Gilded) | Normal | 50/50 | 8,676 ms (8.68s) | 27d 14h 24m (662.40h) | 9,392,165 | primary |
| Gilded book of Basan (Gilded) | Normal | 100% GE | 3,064 ms (3.06s) | 59d 11h 12m (1427.20h) | 1,433,816 | primary |
| Gilded book of Basan (Gilded) | Faster, less optimal solve | 100% Time | 187 ms (0.19s) | 30d 9h 36m (729.60h) | 8,913,348 | primary |
| Gilded book of Basan (Gilded) | Faster, less optimal solve | 50/50 | 190 ms (0.19s) | 30d 9h 36m (729.60h) | 8,913,348 | primary |
| Gilded book of Basan (Gilded) | Faster, less optimal solve | 100% GE | 3,091 ms (3.09s) | 59d 11h 12m (1427.20h) | 1,433,816 | primary |
| Reggference titanium actuator (Reggference) | Normal | 100% Time | 1,003 ms (1.00s) | 2d 9h 36m (57.60h) | 1,169,268 | primary |
| Reggference titanium actuator (Reggference) | Normal | 50/50 | 1,340 ms (1.34s) | 2d 9h 36m (57.60h) | 1,167,236 | primary |
| Reggference titanium actuator (Reggference) | Normal | 100% GE | 174 ms (0.17s) | 25d 14h 24m (614.40h) | 0 | primary |
| Reggference titanium actuator (Reggference) | Faster, less optimal solve | 100% Time | 159 ms (0.16s) | 1d 14h 24m (38.40h) | 1,165,194 | primary |
| Reggference titanium actuator (Reggference) | Faster, less optimal solve | 50/50 | 153 ms (0.15s) | 1d 14h 24m (38.40h) | 1,165,194 | primary |
| Reggference titanium actuator (Reggference) | Faster, less optimal solve | 100% GE | 186 ms (0.19s) | 25d 14h 24m (614.40h) | 0 | primary |
| Brilliant light of Eggendil (Brilliant) | Normal | 100% Time | 5,550 ms (5.55s) | 8d (192.00h) | 3,695,869 | primary |
| Brilliant light of Eggendil (Brilliant) | Normal | 50/50 | 22,498 ms (22.50s) | 8d (192.00h) | 3,481,355 | primary |
| Brilliant light of Eggendil (Brilliant) | Normal | 100% GE | 2,385 ms (2.38s) | 27d 4h 48m (652.80h) | 810,284 | primary |
| Brilliant light of Eggendil (Brilliant) | Faster, less optimal solve | 100% Time | 185 ms (0.18s) | 6d 9h 36m (153.60h) | 4,016,541 | primary |
| Brilliant light of Eggendil (Brilliant) | Faster, less optimal solve | 50/50 | 195 ms (0.20s) | 6d 9h 36m (153.60h) | 4,016,541 | primary |
| Brilliant light of Eggendil (Brilliant) | Faster, less optimal solve | 100% GE | 2,311 ms (2.31s) | 27d 4h 48m (652.80h) | 810,284 | primary |

## Aggregate Solve Time

| Solve mode | Total wall clock |
| --- | ---: |
| Normal | 50,609 ms (50.61s) |
| Faster, less optimal solve | 6,657 ms (6.66s) |

## Priority Presets

- 100% Time: 100% time / 0% GE
- 50/50: 50% time / 50% GE
- 100% GE: 0% time / 100% GE
