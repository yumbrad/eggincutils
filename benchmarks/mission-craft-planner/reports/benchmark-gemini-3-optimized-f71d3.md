# Mission Craft Planner Benchmark

- Branch: `gemini-3-optimized`
- Commit: `f71d3`
- Generated at: `2026-02-26T06:46:20.153Z`
- Profile snapshot: `$REPO_ROOT/benchmarks/mission-craft-planner/profile-snapshot-benchmark.json`
- Snapshot captured at: `2026-02-26T00:44:00.269Z`
- Quantity per target: `1`
- Loot load overhead: excluded (prewarmed and subtracted in planner benchmark hook)

| Target | Solve mode | Priority | Solve wall clock | Plan mission time | Plan GE cost | Solve path |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Gilded book of Basan (Gilded) | Normal | 100% Time | 25,633 ms (25.63s) | 27d 14h 24m (662.40h) | 9,400,461 | primary |
| Gilded book of Basan (Gilded) | Normal | 50/50 | 38,603 ms (38.60s) | 27d 14h 24m (662.40h) | 9,387,796 | primary |
| Gilded book of Basan (Gilded) | Normal | 100% GE | 12,264 ms (12.26s) | 71d 4h 48m (1708.80h) | 1,264,771 | primary |
| Gilded book of Basan (Gilded) | Faster, less optimal solve | 100% Time | 1,444 ms (1.44s) | 32d (768.00h) | 8,872,093 | primary |
| Gilded book of Basan (Gilded) | Faster, less optimal solve | 50/50 | 2,553 ms (2.55s) | 32d (768.00h) | 8,074,569 | primary |
| Gilded book of Basan (Gilded) | Faster, less optimal solve | 100% GE | 1,034 ms (1.03s) | 48d (1152.00h) | 3,127,673 | primary |
| Reggference titanium actuator (Reggference) | Normal | 100% Time | 3,319 ms (3.32s) | 2d 9h 36m (57.60h) | 1,265,729 | primary |
| Reggference titanium actuator (Reggference) | Normal | 50/50 | 6,857 ms (6.86s) | 2d 9h 36m (57.60h) | 1,167,236 | primary |
| Reggference titanium actuator (Reggference) | Normal | 100% GE | 105 ms (0.10s) | 25d 14h 24m (614.40h) | 0 | primary |
| Reggference titanium actuator (Reggference) | Faster, less optimal solve | 100% Time | 298 ms (0.30s) | 2d 9h 36m (57.60h) | 1,265,729 | primary |
| Reggference titanium actuator (Reggference) | Faster, less optimal solve | 50/50 | 515 ms (0.52s) | 2d 9h 36m (57.60h) | 1,167,236 | primary |
| Reggference titanium actuator (Reggference) | Faster, less optimal solve | 100% GE | 53 ms (0.05s) | 25d 14h 24m (614.40h) | 0 | primary |
| Brilliant light of Eggendil (Brilliant) | Normal | 100% Time | 58,401 ms (58.40s) | 8d (192.00h) | 3,706,917 | primary |
| Brilliant light of Eggendil (Brilliant) | Normal | 50/50 | 66,690 ms (66.69s) | 8d (192.00h) | 3,481,355 | primary |
| Brilliant light of Eggendil (Brilliant) | Normal | 100% GE | 8,867 ms (8.87s) | 27d 4h 48m (652.80h) | 810,284 | primary |
| Brilliant light of Eggendil (Brilliant) | Faster, less optimal solve | 100% Time | 1,613 ms (1.61s) | 8d (192.00h) | 3,706,917 | primary |
| Brilliant light of Eggendil (Brilliant) | Faster, less optimal solve | 50/50 | 2,220 ms (2.22s) | 8d (192.00h) | 3,481,355 | primary |
| Brilliant light of Eggendil (Brilliant) | Faster, less optimal solve | 100% GE | 208 ms (0.21s) | 27d 4h 48m (652.80h) | 810,284 | primary |

## Aggregate Solve Time

| Solve mode | Total wall clock |
| --- | ---: |
| Normal | 220,739 ms (220.74s) |
| Faster, less optimal solve | 9,938 ms (9.94s) |

## Priority Presets

- 100% Time: 100% time / 0% GE
- 50/50: 50% time / 50% GE
- 100% GE: 0% time / 100% GE
