#!/usr/bin/env bash
# Every S6-lite measurement of ADR 0007, ~75 min for 2 repetitions:
#   the end-to-end starts (member-e2e.ts, ~7 min) and the probes (~3 min);
#   then the matrix {local, stream} × {no load, 12 busy loops}, ~7.5 min per run, one mpv each;
#   then one run with IPC over a Unix socket (the Flatpak path, ~4 min).
#     S6_LOCK=<lock file> spikes/s6-lite/run-all.sh <out-dir> [reps=2]
# Runs go to <out-dir>/r<rep>-<source>-load<n>-<time>/ (run.json, mpv.log, log.txt), the starts to <out-dir>/e2e.md,
# the probes to <out-dir>/probe-*.md and the tables to <out-dir>/summary.md. With S6_LOCK set, every run holds that
# flock(1) lock, so it never overlaps other measurements that take the same lock (and waits for them).
# mpv is always --vo=null --ao=null: nothing is shown and no sound is produced.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
OUT=${1:?usage: run-all.sh <out-dir> [reps]}
REPS=${2:-2}
mkdir -p "$OUT"
locked() { if [ -n "${S6_LOCK:-}" ]; then flock "$S6_LOCK" "$@"; else "$@"; fi; }
stamp() { echo "$(date -Is) $1: $(cat /proc/loadavg)"; }
# probe <name> <probes.ts arguments...>: one probe, its output in <out-dir>/probe-<name>.md
probe() {
  local name=$1
  shift
  stamp "probe $name"
  locked timeout 300 npx tsx spikes/s6-lite/probes.ts "$@" --fixtures "$OUT/fixtures" > "$OUT/probe-$name.md" ||
    echo "probe $name failed"
}

stamp e2e
locked timeout 900 npx tsx spikes/s6-lite/member-e2e.ts --out "$OUT/e2e" --fixtures "$OUT/fixtures" --reps 8 \
  > "$OUT/e2e.md" || echo "e2e failed"
probe landing landing
probe paused paused
probe paused-buffer0.05 paused --mpv-arg=--ao-null-buffer=0.05
probe paused-buffer0.5 paused --mpv-arg=--ao-null-buffer=0.5
probe speed-step speed-step
probe reload-local reload --source local
probe reload-stream reload --source stream
for rep in $(seq 1 "$REPS"); do
  for load in 0 12; do
    for src in local stream; do
      stamp "rep $rep $src load$load"
      locked timeout 1200 npx tsx spikes/s6-lite/s6.ts --out "$OUT" --fixtures "$OUT/fixtures" --source "$src" \
        --load "$load" --seed "$rep" --tag "r$rep" || echo "run failed: rep $rep $src load$load"
    done
  done
done
stamp "socket"
locked timeout 1200 npx tsx spikes/s6-lite/s6.ts --out "$OUT/socket" --fixtures "$OUT/fixtures" --source local \
  --load 0 --ipc socket --protocols fit --tag r1 || echo "run failed: socket"
stamp end
npx tsx spikes/s6-lite/summarize.ts "$OUT" --json "$OUT/summary.json" > "$OUT/summary.md"
echo "done: $OUT/summary.md"
