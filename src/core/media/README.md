# media: index, manifest, MediaMap, playhead, stream server

Plan §4.3, §5.3 (media API, timeline mapping), M4. Pure, renderer-safe parts are in `src/shared/media/`.
The host-only and viewer-only parts are in `src/core/media/`.

| File                            | What                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `shared/media/types.ts`         | `MediaIndex`, `Manifest`, `TrackInfo`, `KeyPoint = [ms, byte]`, `ByteRange = [start, end)`   |
| `shared/media/manifest.ts`      | Manifest v1 codec (compact-encoding + LEB128 deltas), `buildManifest`, host cache body codec |
| `shared/media/media-map.ts`     | `MediaMap`: time ↔ byte ↔ piece, `readyRange`, `bufferedAheadS`, `timelineSpans/Ranges`      |
| `shared/media/readiness.ts`     | Readiness policy: `readinessAheadS` (6/10/12 s) and `readiness()`                            |
| `shared/media/ranges.ts`        | `mergeRanges`, `thinKeyPoints`                                                               |
| `shared/media/remux.ts`         | The stream-copy remuxes the UI suggests: `remuxCommand`, `remuxFiles`, `FASTSTART_REMUX`, …  |
| `core/media/byte-source.ts`     | `FileSource` (positioned reads, 64 KiB read-ahead), `BufferSource`                           |
| `core/media/ebml.ts`            | Streaming EBML reader and the MKV/WebM index                                                 |
| `core/media/mp4.ts`             | MP4/MOV/M4V index (mp4box.js for moov; our own sidx/moof/tfdt parsing)                       |
| `core/media/fallback.ts`        | Generic containers: ffprobe keyframe scan, or a linear map; AVI RIFF layout                  |
| `core/media/margins.ts`         | How much media after the headers is open-critical                                            |
| `core/media/build-index.ts`     | `indexMediaFile` (in-thread), `buildMediaIndex` (worker + `media-v1.bin` cache)              |
| `core/media/index-worker.ts`    | `worker_threads` entry                                                                       |
| `core/media/playhead.ts`        | Playhead adapter: position → `{byte, windowBytes, hotBytes, seek, urgent}`                   |
| `core/media/stream-server.ts`   | Loopback HTTP range server, and the `StreamSource` contract transfer implements              |
| `core/media/mpv-stream-opts.ts` | `MPV_STREAM_OPTS`: the mpv cache/stream flags for the HTTP source                            |
| `core/media/testing/*`          | Test-only: EBML writer, `FakeSource`                                                         |

## API for the lead

### Host: index and manifest

```ts
import { buildMediaIndex } from './media/build-index.js'
import { buildManifest, encodeManifest } from '../shared/media/manifest.js'

const { index, cached } = await buildMediaIndex(videoPath, {
  signal,                     // abort → rejects with signal.reason; the worker is cancelled, then terminated after 2 s
  onProgress: (done, total) => …, // byte position, at most every 250 ms, always once at the end
  durationHintMs,             // linear map when nothing else gives a duration
  cacheDir,                   // <userData>/wt/host-cache/<key>; reads/writes media-v1.bin (ignored if the file size differs
                              // or an older indexer wrote it: the body's version also counts rule changes)
  workerUrl,                  // bundled worker entry (see "Bundling"); defaults to ./index-worker.js next to this module
  ffprobePath,                // undefined: look on PATH; null: never
})
const manifest = buildManifest(index, { infoHash, pieceLength, videoFileIndex: 0, externalSubs })
const bytes = encodeManifest(manifest)   // → blob store, hash in session.announce
```

- `buildManifest` adds the generic-container rule (head piece + last two pieces) because only it knows P.
- External subtitle files are open-critical as whole files. Those ranges are torrent ranges of other files,
  so the transfer module adds them itself. The manifest only lists them in `externalSubs` (fileIndex, name, lang, title).
- Critical ranges are video-file bytes, end exclusive. The engine rounds them out to pieces (video file offset is 0).

### Viewer and both sides: mapping, readiness, playhead

```ts
const m = decodeManifest(bytes)            // throws on a newer version or malformed input
const map = new MediaMap(m)                // or new MediaMap({...index, pieceLength}, {fileOffset})
map.timeToByte(ms, 'keyframe' | 'interp' | 'nextKeyframe'); map.byteToTime(b)
map.bytesBetween(t0, t1); map.needBps(posMs?)
map.pieceOf(fileByte); map.piecesOf(range); map.pieceToTimeSpan(i)
map.readyRange(pMs, aheadMs)               // ByteRange[] (video range first, then audio of poorly interleaved files)
map.seekByte(pMs)                          // first byte mpv reads to start at p (readyRange's lo, the playhead's byte)
map.audioRanges(t0, t1)
map.bufferedAheadS(posS, pieceStates)
map.timelineSpans(pieceStates)             // [t0 s, t1 s, 0|1|2][] merged
map.timelineRanges(pieceStates, 512)       // {done, loading} second ranges for OSC `ranges` / renderer `timeline`

readinessAheadS({ avgBytesPerSec, nowMs, lastStallAtMs })   // host → waiting.aheadS
readiness(map, posS, 'seek' | 'join' | 'start' | 'buffering' | 'catchup', pieceStates,
          { aheadS, playbackRestarted, openCritical? })     // → {ready, missing[], ranges, waitingForRestart}

const playhead = new Playhead(map, scheduler)   // scheduler.setPlayhead(plan)
playhead.set(posS, 'seek' | 'play' | 'join' | 'catchup' | 'tick')
// plan = {byte, windowBytes, hotBytes, seek, urgent: ByteRange[], posS, reason}
```

- Build the map from the whole manifest (`new MediaMap(manifest)`): its `openCritical` anchors the read-on
  rule of `seekByte` (Invariants).
- `needsFullDownload(manifest)` is true when open-critical is the whole file: an fMP4 whose open walks every
  fragment (no `sidx`, or a `sidx` per fragment). Such a file plays only once complete; the UI says so and
  suggests `FASTSTART_REMUX` (`ffmpeg -i in.mp4 -map 0 -map -0:d -c copy -movflags +faststart out.mp4`). It takes
  a decoded `Manifest` as it is. A file of at most three pieces in a generic container (AVI, TS) is whole as
  well, because `buildManifest` adds the head piece and the last two; `FASTSTART_REMUX` fits MP4 only.
- `remuxCommand(container, seekMode, interleave)` (`shared/media/remux.ts`, also re-exported from `media-map.ts`)
  gives the stream copy that fixes a `'linear'` or `'poor'` file, or null when it needs none or none is known:

  | Index says                               | Remux (constant)                                                                                |
  | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
  | `fmp4` linear, `mp4` poor                | `FASTSTART_REMUX`: `-map 0 -map -0:d -c copy -movflags +faststart` into `out.mp4`               |
  | `mov` poor                               | `MOV_REMUX`: the same into `out.mov`                                                            |
  | `mkv` / `webm` linear or poor            | `MKV_REMUX` / `WEBM_REMUX`: `-map 0 -map -0:d -c copy -max_interleave_delta 60000000`, same ext |
  | `mpegts` (always linear)                 | `TS_REMUX`: the same into `out.mkv`                                                             |
  | `avi`, `generic`; `index` and not `poor` | none                                                                                            |

  Each was run with FFmpeg 9 on generated files: the copy indexes `'index'` and `'good'` with every video, audio
  and subtitle track (`remux.test.ts`). `-map 0` keeps every track (without it FFmpeg keeps one audio and one
  subtitle track), `-map -0:d` drops data tracks MP4 and Matroska cannot hold (timecode, SCTE-35). The mov demuxer
  reads samples in time order, so an MP4 copy is interleaved however far apart audio and video lay. The matroska
  demuxer reads in file order: with FFmpeg's default `max_interleave_delta` (10 s), a copy of audio stored 20 s
  late still had it 10 s late. 60 s fixes lags up to that and holds at most 60 s of media in memory (0 would wait
  for a packet of every stream, a sparse subtitle track's too). None for AVI: it stores no pts, so a copy of
  B-frames stops at "Can't write packet with unknown timestamp", and `-fflags +genpts` puts H.264 B-pyramid frames
  out of order. `remuxFiles(command)` names a command's input and output (`in.ts` → `out.mkv`).

- `pieceStates` is the transfer module's `Uint8Array`: 0 missing, 1 partial/requested, 2 verified.
- `plan.urgent` holds the audio intervals of poorly interleaved files over the hot window. Treat them like
  group 3 (urgent, critical). `scheduler.setPlayhead` in §5.3 only names `{byte, windowBytes, hotBytes, seek}`,
  so the extra field can be ignored until the scheduler supports it.
- Pass `openCritical: manifest.openCritical` to `readiness()` until mpv has opened the file.

### Viewer: stream server

```ts
const server = await StreamServer.listen(pieceSource) // 127.0.0.1:0, random 24-byte token
server.url(0) // http://127.0.0.1:<port>/<token>/f/0/<name> → loadfile / sub-add
server.activeRequests
server.isBlocked(0) // a response for file 0 waits on a piece → PlayerController hooks.readerBlocked
await server.close() // aborts every body loop (their waits are released), closes all sockets
```

The transfer module's PieceSource implements `StreamSource` (defined in `stream-server.ts`):

```ts
interface StreamSource {
  readonly pieceLength: number
  readonly files: readonly { index: number; name: string; offset: number; length: number }[]
  has(piece: number): boolean
  waitVerified(piece: number, signal: AbortSignal): Promise<void> // must reject when signal aborts; no timeout
  read(piece: number, offset: number, length: number): Promise<Uint8Array> // offset is inside the piece
  openReader(fileIndex: number, byte: number): { update(byte): void; blockedOn(piece): void; close(): void }
}
```

### Player

`MPV_STREAM_OPTS` (from `mpv-stream-opts.ts`): `network-timeout=0`, the demuxer cache caps, `cache-pause`,
`stream-buffer-size=1MiB` and the MKV subtitle preroll. The player module merges them into its argument list.

## Events

None. Everything here is a call. Progress reporting goes through the `onProgress` callback (the session maps it
to the `prepare` event with `stage: 'indexing'`).

## Invariants

- Times are ms on the player timeline (mpv's `time-pos`, start time rebased to 0). `startMs` keeps the container's
  start time for information only.
- Keyframes are strictly increasing in time, non-decreasing in byte, and at least 250 ms apart. This holds for
  the index, the manifest and the cache.
  - MKV seek points are Cluster starts.
  - fMP4 seek points are moof starts.
  - MP4 seek points are the sync samples' offsets.
- `MediaMap` interpolates linearly between keyframes, anchored at `(duration, fileSize)`. Without keyframes it is
  `byte = size × t / D`. Header bytes before the first keyframe map to the first keyframe's time.
- `readyRange` starts at `seekByte(p)` (ADR 0004 §5), which is:
  - the keyframe (Cluster) at or before `p − 2 s` for MKV/WebM;
  - for other containers, the keyframe at or before `p − 250 ms` (lavf takes the previous GOP when `p` is on
    a keyframe), less 64 KiB for the audio interleaved in front of it; fMP4 starts one fragment earlier;
  - `0` in linear mode;
  - the end of the open-critical head when the above lies at most 2 MiB past it (`STREAM_SKIP_BYTES`): mpv
    and FFmpeg reach such a start by reading on from where the open stopped, through every byte between.

  It ends at the next keyframe after `p + ahead`, plus 64 KiB for non-MKV containers.

- The stream server:
  - serves only GET and HEAD, and only a single range;
  - sends the headers at once, before the first body byte (`flushHeaders`);
  - reads in slices of ≤ 256 KiB that never cross a piece;
  - never times out, and never answers an in-range request with 4xx/5xx (mpv takes that as EOF);
  - counts the responses waiting on a piece per file (`isBlocked`), on abort too;
  - aborts a request on socket close and releases its wait through the `AbortSignal`;
  - closes its reader in every case;
  - does not open a reader for HEAD, 416 or other error responses.
- The manifest decoder rejects a version above 1 and ignores trailing bytes (new fields go behind new flag bits).
  - flag 1: multiSegment.
  - flag 2: audioIndexes present.

## Deviations from the plan (and why)

1. **Open-critical margin: about 5 s of media, between 1 and 8 MiB, instead of 256 KiB** (`margins.ts`).
   - With mpv 0.41 and `MPV_STREAM_OPTS`, starting at 10 s needed far more than 256 KiB:
     - MP4 faststart, tail moov, fMP4 and AVI stalled at open until about 1 MiB after the first media byte was present
       (600 kbit/s fixtures, so about 13 s of media). lavf probes the stream before applying `start=`.
     - MKV with tail elements needed about 280 KiB after the first Cluster.
     - MKV with Cues was fine.
   - Tail-moov MP4 therefore also gets `[mdatStart, mdatStart + margin)`.
   - S4 owns the final numbers. Its documented fallback is "+8 MiB head", which is our cap.
2. **ffprobe keyframe scan also asks for `dts_time`.** AVI packets have no pts, so `pts_time` alone yields no keyframes.
3. **AVI is parsed for its RIFF layout.** `idx1` can be larger than two pieces (500 KB for a 30 s fixture).
   - The header list and `idx1` are open-critical.
   - The seek mode is `index` when `idx1` exists.
   - Other generic files (MPEG-TS and the rest) are `linear`.
   - `buildManifest` still adds piece 0 and the last two pieces.
4. **fMP4 open-critical follows S4** (ADR 0004 §5, §8.2), modelled on FFmpeg 9's open (`openScanEnd`): it reads
   the top-level boxes in order until it has seen moov and an mdat and its fragment index is complete, which
   only a `sidx` with first_offset 0 whose references reach the `mfra` (or EOF) does (`completesFragmentIndex`).
   - A `sidx` in front of the first mdat completes it (`global_sidx`, DASH on-demand): every box in front of the
     first mdat (ftyp, moov, the `sidx` boxes, the moof), the first moof + mdat, `[size − 16, size)` (FFmpeg reads
     the `mfra` size at open) and the `mfra`. A `sidx` further on, such as one per fragment behind that index, is
     neither open- nor seek-critical: a seek reads it as the start of its fragment's reference, which
     `readyRange` covers. Keyframes come from the video `sidx` in front.
   - Otherwise the open walks every fragment: without `sidx` (even with an `mfra`) to EOF, and with a `sidx` per
     fragment (`-movflags dash`) to the last one. It reads each `sidx` and moof, and reads on through every mdat
     that is not too long to skip, i.e. the whole file for 1 s fragments. The whole file is open-critical and
     `seekMode = 'linear'` (`needsFullDownload`); keyframes come from the moof scan.
5. **Poor-interleave rule.** The ">4× its own bytes" rule also needs a span over 2 MiB. Without that floor,
   low-bitrate files whose spans are far below one piece are flagged.
   - MKV is only sampled at 25/50/75 %. A poorly interleaved MKV is flagged `poor`, but gets no `audioIndexes`:
     building them would need a full block scan.
6. **Playhead windows are measured from `byte`, not from `pos`.** `windowBytes = clamp(timeToByte(pos+25 s) − byte, 2P, 256 MiB)`,
   and `hotBytes` is measured the same way. With the MKV preroll or a long GOP, a window measured from `pos` would
   stop short of `pos + 25 s` once the scheduler places it at `byte`.
7. **Wrapper split.** The main-thread wrapper is in `build-index.ts`, and `index-worker.ts` is only the worker entry.
   In one file, bundling into core would make the worker load all of core. The option is `durationHintMs`,
   not `durationHint`.
8. **The readiness policy is in `shared/media/readiness.ts`**, not `core/media/readiness.ts`. It is pure and the renderer may use it.
   - `readiness()` takes `aheadS` explicitly; `reason` is recorded for the caller.
   - It accepts `openCritical`, because mpv cannot open the file without it.
9. **The stream server answers several ranges with 416**, not 200 with the whole file. A 200 would move this
   reader's playhead to byte 0. A Host mismatch gets 403. Both `127.0.0.1:<port>` and `localhost:<port>` are accepted.

## Bundling note for the lead

`buildMediaIndex` starts `new Worker(workerUrl)`.

- By default the worker file is `./index-worker.js`, next to the importing module.
- Under tsx/vitest it uses `./index-worker.ts` with `--import tsx`.
- In the electron-vite build, add `src/core/media/index-worker.ts` as its own entry. Then either emit it next to the
  core bundle as `index-worker.js`, or pass `workerUrl` (for example from `import url from './index-worker?modulePath'`).

## How to test

```sh
npx vitest run --project unit src/shared/media src/core/media          # pure + synthetic EBML/MP4 + HTTP server
npx vitest run --project integration test/integration/media            # needs ffmpeg/ffprobe (and mpv for the playback test)
```

- **Fixtures.** `test/integration/media/fixtures.ts` generates them on first use into `$TMPDIR/wt-media-fixtures-v1/`.
  - The source is 30 s of testsrc2 + sine (x264 with B-frames, 1 s GOP), remuxed to 11 layouts:
    - MKV with Cues;
    - MKV without Cues (written through a pipe);
    - MKV with tail Tags + font attachment + ASS track (rewritten by our EBML writer);
    - MP4 faststart;
    - MP4 with tail moov;
    - fMP4 with sidx;
    - fMP4 without sidx, without and with an `mfra` trailer;
    - fMP4 with a sidx per fragment (`-movflags dash`), and the same behind a `sidx` index per track that
      `fixtures.ts` splices in (`fmp4-dash-global`);
    - AVI (without `-r 25`: a 1 ms time base, so `idx1` has about 1000 entries per second).
  - A second set, `LONG` (60 s at 2 Mbit/s, 640×360, in `long-60s-2M/`), puts 40 s about 10 MB into the file,
    far past the open-critical head (about 1.3 MB). `fixture(name, LONG)`; `SHORT` is the default.
  - Remux inputs, outside `FIXTURES` (so the suites above do not run them): WebM without Cues (VP9 + Opus through
    a pipe), MPEG-TS, an fMP4 without `sidx` with two audio tracks, a mov_text subtitle and a timecode track, and,
    on `LONG`, MP4, MOV and MKV with the audio stored `POOR_LAG_S` (20 s) after its video. Those are muxed with
    `-itsoffset 20` on the audio, then the MP4/MOV audio track's edit list is renamed `free` and the MKV audio
    blocks' times are moved back in place: the audio plays at its own time again but lies 20 s later.
  - Delete the directory to regenerate.
  - Tests skip when ffmpeg or mpv are missing.
- **Golden data:** `ffprobe -show_packets` keyframes, read at test time.
  - MP4 and AVI offsets must match exactly.
  - For MKV and fMP4, each keyframe packet must lie between our seek point and the next one.
- **mpv test:** mpv 0.41 plays 50 frames of five fixtures through `StreamServer`. A `FakeSource` verifies one
  64 KiB piece every 15 ms, and a piece a reader is blocked on goes first.
- **S4 rules:**
  - `index.test.ts` checks open-critical and `readyRange` against rules derived from ffprobe's packets and
    plain box/chunk walks (`s4-rules.ts`).
  - `gated-mpv.test.ts` serves only open-critical ∪ seek-critical ∪ `readyRange(p, 6 s)` in 16 KiB pieces,
    and mpv must still start:
    - at 0, 10 and 13.5 s on all eleven 30 s fixtures. There `readyRange` mostly starts inside the head plus the
      read-on distance, so these cases check hi and the read-on rule (13.5 s on AVI), not lo;
    - at 40 s (a keyframe) and 45.5 s (inside a GOP) on the `LONG` set, for the seven layouts with a seek index.
      Each case first asserts that lo lies past `headEnd + STREAM_SKIP_BYTES`, so it checks the keyframe rule.
      `fmp4-dash-global` starts there without its later `sidx` boxes;
    - as a control, `fmp4-dash` with every box but the later mdat bodies released does not open: FFmpeg reads
      on through each mdat to the next `sidx`;
    - and, as a control, the plan's lo (keyframe at or before p: no preroll, slack or earlier fragment) must
      leave mp4-faststart at 40 s waiting on a byte only S4's lo releases. With that lo in `media-map.ts` the
      `LONG` cases fail on mp4-faststart and mp4-tailmoov at 40 s and on fmp4-sidx at both positions.
  - `s4-golden.test.ts` feeds S4's golden data (`spikes/s4-mpv-http/golden/`) to `MediaMap` where S4's
    keyframes are our seek points (MP4, AVI). The golden fixtures cannot be regenerated byte for byte.
- **Remux commands** (`remux.test.ts`): each command `remuxCommand` gives for the remux inputs and `mkv-nocues`
  and `fmp4-nosidx` is run as the UI shows it. The input must index `'linear'` or `'poor'`, the copy `'index'`,
  `'good'`, not a full download, as long, with the same video, audio and subtitle tracks. A control runs
  `MKV_REMUX` without `-max_interleave_delta` on the 20 s lag and expects it still `'poor'`.
