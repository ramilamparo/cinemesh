#!/bin/sh
# The S2b matrix (ADR 0006), one run at a time, each in its own rootless session (run.sh). Results go to OUT/<label>.json
# (metrics) and OUT/<label>/ (raw member reports); the source file and its torrent are cached in OUT/data/.
#   [S2B_LOCK=FILE [S2B_LOCK_SCOPE=repeat|chunk|run]] spikes/s2b-pacer/run-all.sh OUT [a|b|b20|b50|all] [REPEATS]
#   (default: all, 3 repeats; ~100 min of runs)
# A label that already has an ok result is skipped (FORCE=1 redoes it); a failed run is retried once. With S2B_LOCK,
# flock(FILE) is held for each repeat (22 runs, ~33 min; the default scope), each chunk (one part of a repeat, 6-8
# runs) or each run, so other timing-sensitive jobs that take the same lock never overlap a run. It is taken when a
# run is due and never held while nothing runs.
# Part A: the app's limit is the bottleneck (1000 KiB/s, as in ADR 0003 round 4); a reader blocks far past the frontier.
#   base | jit (just in time, FIFO) | jitu (+ urgent first) | jitup (+ preempt); a1-*: one viewer
# Part B: the host's real uplink is (netem rate 20/50 Mbit/s, 500 ms of buffer); group seeks every ~8 s. Every jit
# variant here is urgent first with preempt; "d" = the wire's queue reaches down into UDX (--jit-udx).
#   base | f85 (fixed limit, WebTorrent's throttle) | f85jd (fixed limit enforced by jit) | pacer (ctrl-delay pacer on
#   WebTorrent's throttle) | pjit / pjitd (pacer + jit) | pxjitd (pacer on UDX's srtt, 20 ms + jitd) | jitd (no rate)
# The fixed limits are 85 % of the 5 s peak the baseline reached in the calibration runs (2.40 / 6.20 MB/s).
# Within a repeat the variants the ADR needs most run first.
set -u
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: run-all.sh OUT [a|b|b20|b50|all] [REPEATS]}
what=${2:-all}
reps=${3:-3}
scope=${S2B_LOCK_SCOPE:-repeat}
mkdir -p "$out"
locked=0
lock() {
  [ -n "${S2B_LOCK:-}" ] && [ "$locked" = 0 ] || return 0
  exec 9>>"$S2B_LOCK"
  echo "--- waiting for the lock $(date +%T)"
  flock 9
  locked=1
  echo "--- locked $(date +%T) load $(cut -d' ' -f1-3 /proc/loadavg)"
}
unlock() {
  [ "$locked" = 1 ] || return 0
  flock -u 9
  exec 9>&-
  locked=0
  echo "--- unlocked $(date +%T) load $(cut -d' ' -f1-3 /proc/loadavg)"
}
ok() { [ -f "$out/$1.json" ] && grep -q '"ok": true' "$out/$1.json"; }
run() { # label, run.ts options...
  label=$1
  shift
  if ok "$label" && [ -z "${FORCE:-}" ]; then
    echo "skip $label"
    return
  fi
  lock
  for attempt in 1 2; do
    echo "=== $label $(date +%T) load $(cut -d' ' -f1-3 /proc/loadavg) (attempt $attempt)"
    "$here/run.sh" --out "$out" --label "$label" "$@" 9>&- 2>&1 | grep -E 'done:|FAILED' || true
    if ok "$label"; then break; fi
  done
  if [ "$scope" = run ]; then unlock; fi
}
A="--limit-kbps 1000 --size-mib 128 --piece-kib 256 --trials far --trial-every 2500 --warm 10000 --measure 60000"
J="--sched jit --urgent global --preempt"
i=1
while [ "$i" -le "$reps" ]; do
  if [ "$what" = a ] || [ "$what" = all ]; then
    run "a3-base-$i" $A
    run "a3-jitup-$i" $A $J
    run "a3-jitu-$i" $A --sched jit --urgent global
    run "a3-jit-$i" $A --sched jit --urgent off
    run "a1-base-$i" $A --viewers 1
    run "a1-jitup-$i" $A --viewers 1 $J
    if [ "$scope" = chunk ]; then unlock; fi
  fi
  for r in 20 50; do
    case "$what" in all | b | "b$r") ;; *) continue ;; esac
    B="--rate ${r}mbit --trials seek --trial-every 8000 --warm 12000 --measure 60000"
    if [ "$r" = 20 ]; then L=1995; else L=5147; fi
    run "b$r-base-$i" $B
    run "b$r-f85-$i" $B --limit-kbps $L
    run "b$r-pjitd-$i" $B --pacer 40 $J --jit-udx
    run "b$r-pxjitd-$i" $B --pacer 20 --pacer-signal udx $J --jit-udx
    run "b$r-jitd-$i" $B $J --jit-udx
    run "b$r-pacer-$i" $B --pacer 40
    run "b$r-pjit-$i" $B --pacer 40 $J
    run "b$r-f85jd-$i" $B --limit-kbps $L $J --jit-udx
    if [ "$scope" = chunk ]; then unlock; fi
  done
  unlock
  i=$((i + 1))
done
cd "$here/../.." && npx tsx spikes/s2b-pacer/summarize.ts "$out"
