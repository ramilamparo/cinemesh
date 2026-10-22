#!/usr/bin/env bash
# Generates the S4 fixtures into spikes/s4-mpv-http/data/ (gitignored).
# Synthetic 10 min 854x480 25 fps H.264 (~2 Mbit/s, 2 s GOP) + two AAC tracks (eng 440 Hz, jpn 660 Hz).
set -euo pipefail
cd "$(dirname "$0")"
D=data
mkdir -p "$D"
DUR=${DUR:-600}
FONT=${FONT:-/usr/share/fonts/TTF/DejaVuSans-Bold.ttf}
FF="ffmpeg -hide_banner -loglevel error -y"

# 1. external subtitles (one cue every 10 s, 4 s long)
npx tsx make-subs.ts "$D" "$DUR"

# 2. master encode (all other fixtures are remuxes of it, so packets are identical)
if [ ! -f "$D/master.mkv" ]; then
  $FF -f lavfi -i "testsrc2=size=854x480:rate=25:duration=$DUR,noise=alls=12:allf=t" \
      -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=$DUR" \
      -f lavfi -i "sine=frequency=660:sample_rate=48000:duration=$DUR" \
      -map 0:v -map 1:a -map 2:a \
      -c:v libx264 -preset veryfast -b:v 2M -maxrate 2.5M -bufsize 4M -g 50 -keyint_min 50 -sc_threshold 0 -pix_fmt yuv420p \
      -c:a aac -b:a 128k \
      -metadata:s:a:0 language=eng -metadata:s:a:0 title='Sine 440' \
      -metadata:s:a:1 language=jpn -metadata:s:a:1 title='Sine 660' \
      "$D/master.mkv"
fi
IN="-i $D/master.mkv"
MAP="-map 0:v -map 0:a"

# 3. MKV with Cues (ffmpeg default: Cues written after the last Cluster, listed in SeekHead)
$FF $IN $MAP -c copy "$D/mkv-cues.mkv"

# 4. MKV without Cues: the matroska muxer writes no Cues when the output is not seekable
#    (matroskaenc only writes Cues/SeekHead/Duration in the trailer when pb is seekable).
#    -live 1 also skips Cues. We use a pipe, which is what a crashed/streamed recording looks like.
$FF $IN $MAP -c copy -f matroska pipe:1 > "$D/mkv-nocues.mkv"

# 5. MKV with an ASS track + attached font + chapters + tags, then Tags/Attachments/Chapters moved
#    after the last Cluster (ffmpeg always writes them in front; mkvmerge-style tail layout is
#    produced by our EBML rewriter, which also rebuilds the SeekHead).
cat > "$D/chapters.txt" <<CH
;FFMETADATA1
title=S4 tail fixture
comment=Tags written at the tail
[CHAPTER]
TIMEBASE=1/1000
START=0
END=300000
title=First half
[CHAPTER]
TIMEBASE=1/1000
START=300000
END=$((DUR * 1000))
title=Second half
CH
$FF $IN -i "$D/subs.ass" -i "$D/chapters.txt" -map 0:v -map 0:a -map 1:s -map_metadata 2 -map_chapters 2 \
    -c copy -metadata:s:s:0 language=eng -metadata:s:s:0 title='Embedded ASS' \
    -attach "$FONT" -metadata:s:t:0 mimetype=font/ttf -metadata:s:t:0 filename=S4Font.ttf \
    "$D/mkv-front.mkv"
npx tsx mkv-move-to-tail.ts "$D/mkv-front.mkv" "$D/mkv-tail.mkv"
rm -f "$D/mkv-front.mkv"

# 6. MP4 faststart / tail moov
$FF $IN $MAP -c copy -movflags +faststart "$D/mp4-faststart.mp4"
$FF $IN $MAP -c copy "$D/mp4-tailmoov.mp4"

# 7. fragmented MP4 (one fragment per 2 s GOP) with a global sidx, and without any index
$FF $IN $MAP -c copy -movflags +frag_keyframe+empty_moov+default_base_moof+global_sidx "$D/fmp4-sidx.mp4"
$FF $IN $MAP -c copy -movflags +frag_keyframe+empty_moov+default_base_moof+skip_trailer "$D/fmp4-nosidx.mp4"
# 7b. fragmented MP4 without sidx but with the mfra/tfra trailer (ffmpeg writes it unless skip_trailer)
$FF $IN $MAP -c copy -movflags +frag_keyframe+empty_moov+default_base_moof "$D/fmp4-mfra.mp4"

# 8. AVI (H.264 in Annex B, MP3 audio, idx1 at the tail). -r 25 matters: without it the muxer
#    keeps the 1/1000 Matroska time base and pads with ~600k empty 00dc chunks (a 10 MB idx1).
$FF $IN $MAP -c:v copy -bsf:v h264_mp4toannexb -r 25 -c:a libmp3lame -b:a 128k "$D/avi.avi"

ls -la "$D"
