#!/bin/sh
# Runs every S3 measurement sequentially (each run < 2 min, hard timeouts); JSON lands in data/results/.
#   sh spikes/s3-scheduler/run-all.sh [a|patched|b|extra|r2|all]   (from the repository root)
set -u
cd "$(dirname "$0")/../.." || exit 1
R=spikes/s3-scheduler/data/results
mkdir -p "$R"
run() { # name, script, args...
  name=$1; shift; script=$1; shift
  echo "== $name ($(date +%T), load $(cut -d' ' -f1 /proc/loadavg))"
  timeout 160 npx tsx "spikes/s3-scheduler/$script" "$@" > "$R/$name.json" 2> "$R/$name.err" || echo "   FAILED: see $R/$name.err"
}
what=${1:-all}
if [ "$what" = a ] || [ "$what" = all ]; then
  run bench bench.ts
  run hook wire-hook.ts
  run bounds part-a-bounds.ts
  run bounds-sentinel part-a-bounds.ts --sentinel
  for i in 1 2 3; do run a-default-$i part-a.ts --out a-default-$i; done
  for i in 1 2 3; do run a-churn-$i part-a.ts --churn --out a-churn-$i; done
  run a-delay25 part-a.ts --delay 25 --out a-delay25
  run a-sentinel part-a.ts --sentinel --out a-sentinel
  run a-batched-churn part-a.ts --batched --churn --out a-batched-churn
  run a-independent part-a.ts --peer-plan independent --out a-independent
fi
if [ "$what" = patched ] || [ "$what" = a ] || [ "$what" = all ]; then
  # patched/webtorrent: validateWire() walks the plan forwards (the strict-order patch proposed in the report)
  export S3_PATCHED_WT=1
  run bounds-patched part-a-bounds.ts
  for i in 1 2 3; do run a-patched-$i part-a.ts --out a-patched-$i; done
  run a-patched-churn part-a.ts --churn --out a-patched-churn
  unset S3_PATCHED_WT
fi
if [ "$what" = b ] || [ "$what" = all ]; then
  for i in 1 2 3; do run b-baseline-$i part-b.ts --mode baseline; done
  for i in 1 2 3; do run b-stripe-$i part-b.ts --mode stripe; done
  for i in 1 2 3; do run b-stripe-plan8s-$i part-b.ts --mode stripe --deadline-mode everyone; done
  for i in 1 2 3; do run b-stripe-drop-$i part-b.ts --mode stripe --drop v3-v4; done
  run b-stripe-drop-connected part-b.ts --mode stripe --drop v3-v4 --eligibility connected
  run b-stripe-nodeadline part-b.ts --mode stripe --deadline-mode none
  run b-stripe-delay25 part-b.ts --mode stripe --delay 25
  run b-baseline-delay25 part-b.ts --mode baseline --delay 25
  run b-stripe-vup4 part-b.ts --mode stripe --viewer-up 4
  run b-stripe-drop-vup4 part-b.ts --mode stripe --drop v3-v4 --viewer-up 4
  run b-stripe-drop-connected-vup4 part-b.ts --mode stripe --drop v3-v4 --eligibility connected --viewer-up 4
  run b-stripe-R2 part-b.ts --mode stripe --R 2
  run b-stripe-R8 part-b.ts --mode stripe --R 8
fi
if [ "$what" = extra ] || [ "$what" = all ]; then
  # plan §9 load case: 7 viewers at 10 Mbit/s (1.25 MB/s) on a 50 Mbit/s (6.25 MB/s) host uplink
  run b-load7-baseline part-b.ts --mode baseline --viewers 7 --bitrate 1.25 --host-rate 6.25
  for i in 1 2 3; do run b-load7-stripe-$i part-b.ts --mode stripe --viewers 7 --bitrate 1.25 --host-rate 6.25; done
  # tight uplink: host 5 MB/s, bitrate 4 MB/s (1.25x one stream)
  run b-tight-baseline part-b.ts --mode baseline --bitrate 4
  run b-tight-stripe part-b.ts --mode stripe --bitrate 4
  for i in 2 3; do run b-stripe-nodeadline-$i part-b.ts --mode stripe --deadline-mode none; done
fi
if [ "$what" = r2 ] || [ "$what" = all ]; then
  # R = 2 (Finding 11): repeats, the 7-viewer load case, and the tight uplink with and without the rescue rule
  for i in 2 3; do run b-stripe-R2-$i part-b.ts --mode stripe --R 2; done
  run b-load7-stripe-R2 part-b.ts --mode stripe --viewers 7 --bitrate 1.25 --host-rate 6.25 --R 2
  run b-tight-stripe-R2 part-b.ts --mode stripe --bitrate 4 --R 2
  run b-tight-stripe-R2-nodeadline part-b.ts --mode stripe --bitrate 4 --R 2 --deadline-mode none
fi
echo "== done $(date +%T)"
