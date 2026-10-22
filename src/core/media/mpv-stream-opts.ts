// mpv options that concern reading a viewer's file from our loopback HTTP server (plan §4.4). The
// player module merges these into its version-aware argument list; everything here exists in mpv
// 0.39–0.41.
//
// - network-timeout=0: a missing piece blocks the HTTP body for as long as the swarm needs; mpv
//   must not give up on the stream (the server never times out either).
// - cache: a bounded RAM demuxer cache (R7) with back-buffer for small backward seeks.
// - cache-pause: mpv pauses itself while the cache underruns; sync treats that as buffering.
// - stream-buffer-size=1MiB: fewer, larger reads per request. mpv also reads on through a forward seek
//   up to this size, which MediaMap's STREAM_SKIP_BYTES must cover (mpv-stream-opts.test.ts).
// - demuxer-mkv-subtitle-preroll-secs-index=2 matches MediaMap's MKV readyRange preroll.
export const MPV_STREAM_OPTS = [
  '--cache=yes',
  '--cache-on-disk=no',
  '--demuxer-max-bytes=96MiB',
  '--demuxer-max-back-bytes=32MiB',
  '--cache-secs=60',
  '--demuxer-seekable-cache=yes',
  '--cache-pause=yes',
  '--cache-pause-initial=no',
  '--cache-pause-wait=1',
  '--network-timeout=0',
  '--stream-buffer-size=1MiB',
  '--demuxer-mkv-subtitle-preroll-secs-index=2',
] as const
