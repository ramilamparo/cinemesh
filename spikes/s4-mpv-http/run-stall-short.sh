#!/usr/bin/env bash
# Short stalls (hold 10 s) × 3 reps: watchdog reload, release-while-seek-blocked, plain release.
cd "$(dirname "$0")"
jobs=()
for f in mkv-cues.mkv mp4-faststart.mp4 fmp4-sidx.mp4 avi.avi; do
  for after in watchdog release-seek release; do
    for r in 1 2 3; do jobs+=("$f $after r$r"); done
  done
done
printf '%s\n' "${jobs[@]}" | xargs -P 6 -L 1 bash -c 'timeout 120 npx tsx run-stall.ts --fixture $0 --nt 0 --hold 10 --after $1 --tag $2'
