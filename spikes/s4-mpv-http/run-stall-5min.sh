#!/usr/bin/env bash
# The 5-minute withholding runs (concurrently): mkv-cues ×3 per network-timeout, mp4-faststart ×1 per timeout.
cd "$(dirname "$0")"
for nt in 0 60; do
  for r in 1 2 3; do timeout 420 npx tsx run-stall.ts --fixture mkv-cues.mkv --nt $nt --hold 300 --after watchdog --tag r$r & done
  timeout 420 npx tsx run-stall.ts --fixture mp4-faststart.mp4 --nt $nt --hold 300 --after watchdog --tag r1 &
done
wait
