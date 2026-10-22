#!/usr/bin/env bash
# S5 helper (plan §7): simulated NATs in network namespaces, for checking NAT classes, hole punching and the
# relay on one Linux machine. Nothing here is run by the test suite. Results: docs/adr/0005-s5-nat-matrix.md.
#
# Needs root, real or fake. Without sudo, run it inside a rootless session (user + mount + net + pid
# namespaces; everything vanishes when the session ends):
#   scripts/netns-rootless.sh                          a shell in which the commands below work as written
#   scripts/netns-rootless.sh node scripts/s5-matrix.mjs --out DIR     the whole S5 matrix (see that file)
# With real root, prefix the commands with sudo; `exec` then drops back to $SUDO_USER.
#
#   scripts/netns-nat.sh up [A-MODE] [B-MODE]   build the topology; MODE = plain | random (default plain)
#   scripts/netns-nat.sh mode a|b plain|random  switch one router's NAT mode in place
#   scripts/netns-nat.sh forward a|b PORT [static]  forward UDP PORT on the router to its client (udpPort test);
#                                               `static` also maps the client's outgoing UDP from PORT to the
#                                               same public port (a "static port" outbound rule)
#   scripts/netns-nat.sh unforward a|b
#   scripts/netns-nat.sh block-udp a|b          the router drops all UDP from its client ("UDP blocked?" test)
#   scripts/netns-nat.sh unblock-udp a|b
#   scripts/netns-nat.sh status                 addresses and NAT rules of every namespace
#   scripts/netns-nat.sh exec NS CMD...         run CMD in NS (pub, a, b, c, ra, rb)
#   scripts/netns-nat.sh netem NS DEV ARGS...   add a root netem qdisc on DEV in NS (as root, also under sudo)
#   scripts/netns-nat.sh down                   remove everything
#
# Topology. P = the "public" /24, WT_NETNS_PUB (default 192.88.99, the deprecated 6to4 relay prefix of RFC 7526).
# It must not be a bogon to hyperdht: when it dials an OPEN server it skips bogon addresses in the server's
# handshake (lib/connect.js:212-219), TEST-NET-2 (198.51.100.0/24) included, and then uses the address a DHT node
# saw, which is stale for a server that announced before its firewall check (see docs/adr/0005). It must not be
# private either, or path classification would say lan. The namespaces have no route out, so nothing leaks.
#
#   wt-pub  br-wt P.1/24 ── testnet + relay:  scripts/testnet.mjs --host P.1 --relay
#     ├── wt-ra  wan P.11 ── NAT ── lan 10.10.1.1/24 ── wt-a  10.10.1.2
#     ├── wt-rb  wan P.12 ── NAT ── lan 10.10.2.1/24 ── wt-b  10.10.2.2
#     └── wt-c   P.20  (no NAT: OPEN)
#
# NAT modes (both backends behave the same):
#   plain   masquerade: keeps the source port when it can (endpoint-independent mapping) → CONSISTENT
#   random  masquerade with fully random ports: a new port for every destination → RANDOM (dht.randomized)
# Like a home router, each router drops unsolicited packets addressed to itself on its WAN side; forwarded
# traffic is not filtered unless block-udp is set.
#
# Backends (WT_NETNS_BACKEND=auto|nft|iptables, default auto = iptables when rootless, else nft):
#   nft       nft masquerade/dnat/snat. Needs the nft_masq/nft_nat modules, which a user namespace cannot load.
#   iptables  iptables-nft (xt_MASQUERADE, xt_nat, xt_conntrack via nft_compat): works rootless.
#
# S5 matrix by hand (scripts/s5-matrix.mjs automates all of it and records the results):
#   1. up plain random. In wt-pub: node scripts/testnet.mjs --host P.1 --relay --size 20
#   2. In wt-a / wt-b / wt-c run members with WT_BOOTSTRAP=P.1:<port>, e.g.
#        scripts/netns-nat.sh exec a node --import tsx src/core/net/headless.ts host --name A
#        scripts/netns-nat.sh exec b node --import tsx src/core/net/headless.ts join <invite> --name B
#      Each prints its NAT class, peers with their path, and errors as JSON lines.
#   3. `mode a random` for RANDOM↔RANDOM; --relay KEY for the relay; c as an OPEN host or neighbour;
#      `forward b PORT` with --port PORT for the udpPort option; `headless.ts nat` for the Network test.
set -euo pipefail

PREFIX=wt
PUB=$PREFIX-pub
BRIDGE=br-wt
PUB_NET=${WT_NETNS_PUB:-192.88.99}
[[ $PUB_NET =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "netns-nat: WT_NETNS_PUB must look like 192.88.99" >&2; exit 1; }
declare -A ROUTER=([a]=$PREFIX-ra [b]=$PREFIX-rb)
declare -A CLIENT=([a]=$PREFIX-a [b]=$PREFIX-b)
declare -A WAN_IP=([a]=$PUB_NET.11 [b]=$PUB_NET.12)
declare -A LAN_NET=([a]=10.10.1 [b]=10.10.2)
OPEN_CLIENT=$PREFIX-c
OPEN_IP=$PUB_NET.20
STATE_DIR=/run/wt-netns

die() {
  echo "netns-nat: $*" >&2
  exit 1
}
in_ns() {
  local ns=$1
  shift
  ip netns exec "$ns" "$@"
}

# Fake root inside a user namespace (scripts/netns-rootless.sh) rather than real root.
rootless() {
  [[ ${WT_NETNS_ROOTLESS:-} == 1 ]] || ! grep -qE '^[[:space:]]*0[[:space:]]+0[[:space:]]+4294967295' /proc/self/uid_map
}
need_root() {
  [[ $EUID -eq 0 ]] || die "needs root: run 'sudo $0 $*', or inside 'scripts/netns-rootless.sh'"
}

backend() {
  local b=${WT_NETNS_BACKEND:-auto}
  if [[ $b == auto ]]; then
    if rootless; then b=iptables; else b=nft; fi
  fi
  [[ $b == nft || $b == iptables ]] || die "WT_NETNS_BACKEND must be auto, nft or iptables, not '$b'"
  echo "$b"
}

check_mode() { [[ $1 == plain || $1 == random ]] || die "mode must be plain or random, not '$1'"; }
check_side() { [[ $1 == a || $1 == b ]] || die "side must be a or b, not '$1'"; }

# Router state: one small file per setting, so every command can rebuild the rules from scratch.
state_get() { cat "$STATE_DIR/$1.$2" 2>/dev/null || echo "${3:-}"; }
state_set() {
  mkdir -p "$STATE_DIR"
  if [[ -n $3 ]]; then echo "$3" >"$STATE_DIR/$1.$2"; else rm -f "$STATE_DIR/$1.$2"; fi
}

# The router's rules, rebuilt from its state: masquerade on the WAN side (plain or random), an optional UDP
# forward to its client (plus a static outbound mapping for that port), an optional UDP block, and the WAN
# input drop every home router has.
apply_nat() {
  local side=$1
  local mode fwd static block
  mode=$(state_get "$side" mode plain)
  fwd=$(state_get "$side" fwd)
  static=$(state_get "$side" static)
  block=$(state_get "$side" block)
  local r=${ROUTER[$side]} client="${LAN_NET[$side]}.2" wan=${WAN_IP[$side]}
  if [[ $(backend) == nft ]]; then
    local flags='' extra_post='' extra_pre='' extra_fwd=''
    if [[ $mode == random ]]; then flags=' random,fully-random'; fi
    if [[ -n $fwd ]]; then
      extra_pre="iifname \"wan\" udp dport $fwd dnat to $client:$fwd;"
      if [[ -n $static ]]; then
        extra_post="oifname \"wan\" ip saddr $client udp sport $fwd snat to $wan:$fwd;"
      fi
    fi
    if [[ -n $block ]]; then extra_fwd='iifname "lan" meta l4proto udp drop;'; fi
    in_ns "$r" nft delete table ip wtnat 2>/dev/null || true
    in_ns "$r" nft -f - <<EOF
table ip wtnat {
  chain post { type nat hook postrouting priority srcnat; policy accept; $extra_post oifname "wan" masquerade$flags; }
  chain pre { type nat hook prerouting priority dstnat; policy accept; $extra_pre }
  chain input { type filter hook input priority filter; policy accept; iifname "wan" ct state new drop; }
  chain forward { type filter hook forward priority filter; policy accept; $extra_fwd }
}
EOF
  else
    local ipt=(in_ns "$r" iptables)
    "${ipt[@]}" -t nat -F
    "${ipt[@]}" -F INPUT
    "${ipt[@]}" -F FORWARD
    if [[ -n $fwd ]]; then
      "${ipt[@]}" -t nat -A PREROUTING -i wan -p udp --dport "$fwd" -j DNAT --to-destination "$client:$fwd"
      if [[ -n $static ]]; then
        "${ipt[@]}" -t nat -A POSTROUTING -o wan -s "$client" -p udp --sport "$fwd" -j SNAT --to-source "$wan:$fwd"
      fi
    fi
    if [[ $mode == random ]]; then
      "${ipt[@]}" -t nat -A POSTROUTING -o wan -j MASQUERADE --random --random-fully
    else
      "${ipt[@]}" -t nat -A POSTROUTING -o wan -j MASQUERADE
    fi
    "${ipt[@]}" -A INPUT -i wan -m conntrack --ctstate NEW -j DROP
    if [[ -n $block ]]; then "${ipt[@]}" -A FORWARD -i lan -p udp -j DROP; fi
  fi
  echo "$r: $mode${fwd:+, UDP $fwd forwarded}${static:+ (static)}${block:+, UDP blocked} [$(backend)]"
}

cmd_up() {
  local mode_a=${1:-plain} mode_b=${2:-plain}
  check_mode "$mode_a"
  check_mode "$mode_b"
  ip netns list | grep -q "^$PUB\b" && die "already up; run '$0 down' first"
  rm -rf "$STATE_DIR"
  mkdir -p "$STATE_DIR"

  ip netns add "$PUB"
  in_ns "$PUB" ip link set lo up
  in_ns "$PUB" ip link add "$BRIDGE" type bridge
  in_ns "$PUB" ip addr add "$PUB_NET.1/24" dev "$BRIDGE"
  in_ns "$PUB" ip link set "$BRIDGE" up

  for side in a b; do
    local r=${ROUTER[$side]} c=${CLIENT[$side]} lan=${LAN_NET[$side]}
    ip netns add "$r"
    ip netns add "$c"
    in_ns "$r" ip link set lo up
    in_ns "$c" ip link set lo up
    # router WAN ↔ public bridge
    ip link add "$r-w" netns "$PUB" type veth peer name wan netns "$r"
    in_ns "$PUB" ip link set "$r-w" master "$BRIDGE" up
    in_ns "$r" ip addr add "${WAN_IP[$side]}/24" dev wan
    in_ns "$r" ip link set wan up
    # router LAN ↔ client
    ip link add lan netns "$r" type veth peer name eth0 netns "$c"
    in_ns "$r" ip addr add "$lan.1/24" dev lan
    in_ns "$r" ip link set lan up
    in_ns "$r" sysctl -qw net.ipv4.ip_forward=1
    in_ns "$c" ip addr add "$lan.2/24" dev eth0
    in_ns "$c" ip link set eth0 up
    in_ns "$c" ip route add default via "$lan.1"
  done
  state_set a mode "$mode_a"
  state_set b mode "$mode_b"
  apply_nat a
  apply_nat b

  ip netns add "$OPEN_CLIENT"
  in_ns "$OPEN_CLIENT" ip link set lo up
  ip link add "$OPEN_CLIENT-w" netns "$PUB" type veth peer name eth0 netns "$OPEN_CLIENT"
  in_ns "$PUB" ip link set "$OPEN_CLIENT-w" master "$BRIDGE" up
  in_ns "$OPEN_CLIENT" ip addr add "$OPEN_IP/24" dev eth0
  in_ns "$OPEN_CLIENT" ip link set eth0 up

  echo "up. Next: $0 exec pub node scripts/testnet.mjs --host $PUB_NET.1 --relay --size 20"
}

cmd_down() {
  for ns in "$OPEN_CLIENT" "${CLIENT[a]}" "${CLIENT[b]}" "${ROUTER[a]}" "${ROUTER[b]}" "$PUB"; do
    ip netns pids "$ns" 2>/dev/null | xargs -r kill 2>/dev/null || true
    ip netns delete "$ns" 2>/dev/null || true
  done
  rm -rf "$STATE_DIR"
  echo down
}

cmd_status() {
  for ns in "$PUB" "${ROUTER[a]}" "${ROUTER[b]}" "${CLIENT[a]}" "${CLIENT[b]}" "$OPEN_CLIENT"; do
    echo "== $ns"
    in_ns "$ns" ip -brief addr 2>/dev/null | grep -v '^lo' || echo '(missing)'
  done
  for side in a b; do
    local fwd static block
    fwd=$(state_get "$side" fwd)
    static=$(state_get "$side" static)
    block=$(state_get "$side" block)
    echo "== ${ROUTER[$side]}: $(state_get "$side" mode plain)${fwd:+, UDP $fwd forwarded}${static:+ (static)}${block:+, UDP blocked} [$(backend)]"
    if [[ $(backend) == nft ]]; then
      in_ns "${ROUTER[$side]}" nft list table ip wtnat 2>/dev/null | grep -E 'masquerade|dnat|snat|drop' || true
    else
      in_ns "${ROUTER[$side]}" iptables-save 2>/dev/null | grep -E '^-A' || true
    fi
  done
}

ns_for() {
  case $1 in
    pub) echo "$PUB" ;;
    a | b) echo "${CLIENT[$1]}" ;;
    c) echo "$OPEN_CLIENT" ;;
    ra) echo "${ROUTER[a]}" ;;
    rb) echo "${ROUTER[b]}" ;;
    *) die "unknown namespace '$1' (pub, a, b, c, ra, rb)" ;;
  esac
}

cmd_exec() {
  [[ $# -ge 2 ]] || die "usage: $0 exec NS CMD..."
  local ns
  ns=$(ns_for "$1")
  shift
  local user=${SUDO_USER:-root}
  # Rootless: we already are the invoking user outside the namespace. With sudo, drop back to that user so
  # node_modules, caches and created files keep their owner.
  if rootless || [[ $user == root ]]; then
    exec ip netns exec "$ns" "$@"
  fi
  exec ip netns exec "$ns" sudo -u "$user" --preserve-env=WT_BOOTSTRAP,PATH "$@"
}

main() {
  local cmd=${1:-}
  [[ -n $cmd ]] || {
    sed -n '2,22p' "$0"
    exit 1
  }
  shift
  need_root "$cmd"
  case $cmd in
    up) cmd_up "$@" ;;
    down) cmd_down ;;
    mode)
      check_side "${1:-}"
      check_mode "${2:-}"
      state_set "$1" mode "$2"
      apply_nat "$1"
      ;;
    forward)
      check_side "${1:-}"
      [[ ${2:-} =~ ^[0-9]+$ ]] || die "PORT required"
      [[ -z ${3:-} || ${3:-} == static ]] || die "the only option after PORT is 'static'"
      state_set "$1" fwd "$2"
      state_set "$1" static "${3:-}"
      apply_nat "$1"
      ;;
    unforward)
      check_side "${1:-}"
      state_set "$1" fwd ''
      state_set "$1" static ''
      apply_nat "$1"
      ;;
    block-udp | unblock-udp)
      check_side "${1:-}"
      state_set "$1" block "$([[ $cmd == block-udp ]] && echo 1 || true)"
      apply_nat "$1"
      ;;
    status) cmd_status ;;
    exec) cmd_exec "$@" ;;
    netem)
      # tc needs CAP_NET_ADMIN: unlike exec, never drop back to $SUDO_USER
      [[ $# -ge 3 ]] || die "usage: $0 netem NS DEV ARGS..."
      local ns
      ns=$(ns_for "$1")
      ip netns exec "$ns" tc qdisc add dev "$2" root netem "${@:3}"
      ;;
    *) die "unknown command '$cmd'" ;;
  esac
}

main "$@"
