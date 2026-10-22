#!/usr/bin/env bash
# Every S4 measurement, in order. Each step is bounded by `timeout`; results go to data/results/.
set -uo pipefail
cd "$(dirname "$0")"
R=data/results
mkdir -p "$R" data/mpvdocs

[ -f data/avi.avi ] || bash make-fixtures.sh
for v in 0.39.0 0.40.0 0.41.0; do
  f=data/mpvdocs/options-$v.rst
  [ -f "$f" ] || curl -fsSLo "$f" "https://raw.githubusercontent.com/mpv-player/mpv/v$v/DOCS/man/options.rst"
done
timeout 300 npx tsx ranges.ts > "$R/ranges.txt"

# open / seek / aid: 3 reps × 5 modes, two fixtures per run (< 2 min each)
for pair in "mkv-cues.mkv mkv-nocues.mkv" "mkv-tail.mkv mp4-faststart.mp4" "mp4-tailmoov.mp4 avi.avi" "fmp4-sidx.mp4 fmp4-nosidx.mp4" "fmp4-mfra.mp4"; do
  timeout 180 npx tsx run-open-seek.ts --reps 3 --par 3 $pair | tee -a "$R/open-seek.txt"
done
# the same gated at 16 KiB instead of 1 MiB pieces (exact ranges)
timeout 180 npx tsx run-open-seek.ts --reps 3 --par 4 --modes fixed,fixed-join --piece 16384 --tag -p16k \
  mkv-cues.mkv mkv-tail.mkv mp4-faststart.mp4 mp4-tailmoov.mp4 | tee -a "$R/open-seek-p16k.txt"
timeout 180 npx tsx run-open-seek.ts --reps 3 --par 4 --modes fixed,fixed-join --piece 16384 --tag -p16k \
  fmp4-sidx.mp4 avi.avi mkv-nocues.mkv | tee -a "$R/open-seek-p16k.txt"
timeout 180 npx tsx run-open-seek.ts --reps 3 --par 4 --modes gated,gated-join --piece 16384 --tag -p16k \
  mkv-cues.mkv mkv-tail.mkv mp4-tailmoov.mp4 avi.avi | tee -a "$R/open-seek-p16k.txt"
npx tsx summarize.ts > "$R/summary.md"
npx tsx summarize.ts fixed-p16k fixed-join-p16k gated-p16k gated-join-p16k > "$R/summary-p16k.md"

timeout 150 npx tsx probe-seek-target.ts mp4-faststart.mp4 avi.avi mkv-cues.mkv fmp4-sidx.mp4 > "$R/seek-target.txt"
for f in mkv-cues.mkv mkv-tail.mkv mp4-faststart.mp4 mp4-tailmoov.mp4 fmp4-sidx.mp4 avi.avi mkv-nocues.mkv fmp4-nosidx.mp4; do
  for m in free fixed; do echo "$f $m"; done
done | xargs -P 4 -L 1 bash -c 'timeout 60 npx tsx probe-aid.ts $0 $1' > "$R/aid.txt"
for i in 1 2 3; do
  timeout 90 npx tsx probe-blocked-ops.ts mkv-cues.mkv mp4-faststart.mp4 avi.avi
  SKIP_SET=1 timeout 60 npx tsx probe-blocked-ops.ts mkv-cues.mkv mp4-faststart.mp4
  RELOAD_OPT=aid=2,alang=jpn timeout 60 npx tsx probe-blocked-ops.ts mkv-cues.mkv mp4-faststart.mp4
done > "$R/blocked-ops.txt"

bash run-stall-short.sh > "$R/stall-short.txt"
for st in 404 416 503; do timeout 60 npx tsx run-stall.ts --fixture mkv-cues.mkv --nt 0 --hold 10 --after destroy-$st --tag r1; done > "$R/stall-destroy.txt"
for r in 1 2 3; do timeout 60 npx tsx run-stall.ts --fixture mkv-cues.mkv --nt 0 --hold 10 --after destroy-seek --tag r$r; done >> "$R/stall-destroy.txt"
for r in 1 2 3; do timeout 60 npx tsx run-stall.ts --fixture mkv-cues.mkv --nt 0 --hold 5 --after cache-seek --tag r$r; done > "$R/stall-cache-seek.txt"
bash run-stall-5min.sh > "$R/stall-5min.txt"

timeout 100 npx tsx run-subs.ts > "$R/subs.json.txt"
timeout 90 npx tsx argv-check.ts > "$R/argv-check.txt"
timeout 60 npx tsx ipc-fd3.ts > "$R/ipc-fd3.txt"
npx tsx options-diff.ts > "$R/options-diff.txt"
echo "done: $R"
