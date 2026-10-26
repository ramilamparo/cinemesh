# ADR 0012: Catch-up priority for viewers who fall behind

- Date: 2026-10-26
- Status: **accepted; in.** The host feeds a viewer whose buffer runs short first, while other viewers have plenty,
  until it has caught up. Host only: no message changes, so viewers of any version benefit.
- Plan: §4.2 (striping, host upload), §4.5 (buffering barrier); ADR 0003 (Revealer), ADR 0006 (upload scheduler).
- Code:
  - `src/core/session/catch-up.ts` (who), `host-session.ts` (`updateCatchUp`, 1 Hz);
  - `src/core/transfer/engine.ts` (`setViewerCatchUp`), `revealer.ts` (`setCatchUp`), `upload-scheduler.ts`
    (`boosted`, `preempt(id, keep)`);
  - `src/core/session/peer-view.ts`, `src/renderer/src/screens/Room/PeerList.tsx` ("Catching up").
- Tests:
  - `test/integration/session/catch-up.test.ts`: a viewer joining mid-play into a room short of upload;
  - unit tests next to each module.

## 1. Context

When the room's upload is short, every viewer got the same share. A viewer with a few seconds of buffer got the same
share as one with minutes, stalled, and with "wait for everyone" the whole room paused for it. A late joiner, a
weaker link, or an exempt member catching up alone are all this case.

Two things worked against such a viewer:

- **The host ordered by piece, never by viewer.** In steady playback almost every request is class 2 (the hot window
  follows only seeks), and the upload scheduler shares a class round-robin between wires.
- **Striping keeps the host off pieces a linked viewer holds.** What a lagging viewer needs next is usually held by
  the others, so it came only through their uplinks. The host stepped in only after its reader blocked (the urgent
  report), and even then waited up to 3 s plus two pieces at one lane's share (`onItsWay`), as the stall began.
  Meanwhile the walk kept giving it new frontier pieces, which took its own downlink.

The host already had what it needs to see this: every viewer's `sync.status` carries `pos` and `bufferedAheadS`.

## 2. Decision

**Who** (`pickCatchUp`, once a second over the host's sync peers):

- Candidates have a status with a position, are not `joining` (position 0 until the room's state reaches them),
  `no-player`, `disk-full` or `ended`, and have no download limit of their own under 1.5 × their bitrate (lagging by
  choice; feeding them would only cost copies their gate turns away).
- A candidate starts catching up under 15 s of buffer (or while buffering) when another has at least 10 s more. When
  everyone is equally short there is nothing to rebalance, and reshuffling would only send more copies.
- It stops at 30 s, or once nobody is more than 5 s ahead of it.
- At most max(1, ⌊viewers / 3⌋) at once, the least buffered first; those already picked keep their place.
- A viewer with everything up to the end is never picked (its buffer is short only because the video is).

**What the host does for it** (`setViewerCatchUp(id, range)`, the range being its position to 30 s on, in pieces):

- **Revealer.** It shows the viewer the pieces of its range that it lacks, held by others or not, 4 at a time
  (`CATCH_UP_PIECES`): the host becomes one more source. The viewer's WebTorrent reserves each block once, so this
  alone does not send a block twice. The viewer gets no walk work and no rescue while it catches up, and its share of
  the frontier goes to the others. When it starts, what it was assigned and is not fetching is taken back (`retract`,
  from the plan's end) outside the group window and its range, and its exclusive set is cleared.
- **Upload scheduler.** The rank is `2 × class + (boosted ? 0 : 1)`. Class still comes first: a blocked reader
  anywhere goes before a boosted class 2. Within a class, the boosted wire goes first. The 2 s aging rule still gives
  every other wire a release, and the per-wire queue cap still applies. A boosted viewer whose own downlink is full is
  skipped, so the release stays work-conserving.
- **Preempt.** On the start, its held class-2 requests outside the range are rejected (BEP 6), so its WebTorrent
  refills those slots with the range.
- **Peer list.** The host's row for that viewer says "Catching up".

## 3. Measured

`test/integration/session/catch-up.test.ts`, fake players, testnet, isolated namespace:

- Media: a 240 s video at ~1.1 Mbit/s with 1 MiB pieces.
- Uplinks: the host sends at 400 KiB/s, each viewer at 96 KiB/s.
- Run: two viewers buffer for 15 s paused, then play for 20 s, and a third joins with nothing local.
- `WT_CATCH_UP_BASELINE=1` runs the same room with catch-up off (`HostSession.catchUpEnabled = false`).

| Run (late viewer's join → 45 s later) | Late viewer reaches 15 s ahead | Early viewers' lowest buffer | dupFactor (whole session) |
| ------------------------------------- | ------------------------------ | ---------------------------- | ------------------------- |
| Catch-up on (3 runs)                  | 18.4 / 19.1 / 20.2 s           | 11.4 / 12.4 / 14.4 s         | 1.47 / 1.49 / 1.45        |
| Catch-up off                          | never: 0 s for all 45 s        | 11.7 s                       | 1.16                      |

With catch-up off, the pieces at the late viewer's position came only through the two other viewers' uplinks, which
were already busy serving each other. With it on, it had 15 s after ~19 s and about 35 s after ~24 s, and was then
dropped from catch-up. The first ~7 s of each run are its join (`joining` is not a candidate).

**The price is copies.** What the late viewer is fed, the host had already sent once to the others: dupFactor
1.45-1.49 instead of 1.16. That is the intent: the host spends upload to keep a viewer from stalling. The cap (a
third of the viewers) and the 4-piece window bound the extra.

## 4. Not done

- **Viewer-to-viewer order.** A viewer serves its peers first come, first served, through WebTorrent's upload
  throttle. Serving a lagging peer first would need the hold mode and a scheduler on viewer wires, plus the host
  telling viewers who is catching up. Only the host's upload is prioritized.
- **A room short everywhere.** With viewer uplinks far under the bitrate (24 KiB/s each for a 1.1 Mbit/s video), the
  striped pieces spread between viewers so slowly (a 1 MiB piece in ~43 s) that no viewer's contiguous buffer grows.
  The first play's start gate then waits on everyone, for good: the host only sends a piece a linked viewer holds
  once a reader blocks on it (urgent, after `onItsWay`'s wait). Catch-up does not apply, because nobody is ahead. A
  rule that falls back to the host when a holder's uplink is too slow for the piece's deadline would cover it. That
  is a separate change to striping.
- **No setting.** The thresholds are constants. `catchUpEnabled` on the host session exists for the baseline test.
