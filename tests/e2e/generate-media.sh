#!/usr/bin/env bash
# Generate the synthetic test media used by the e2e suite (requires ffmpeg).
set -euo pipefail
cd "$(dirname "$0")/www"
ffmpeg -loglevel error -y -f lavfi -i testsrc2=size=640x360:rate=25 -f lavfi -i sine=frequency=440:sample_rate=44100 \
  -t 12 -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:v 1500k sample.mp4
ffmpeg -loglevel error -y -i sample.mp4 -an -c:v copy -movflags frag_keyframe+empty_moov+default_base_moof -frag_duration 2000000 v_frag.mp4
ffmpeg -loglevel error -y -i sample.mp4 -vn -c:a copy -movflags frag_keyframe+empty_moov+default_base_moof -frag_duration 2000000 a_frag.mp4
mkdir -p hls
ffmpeg -loglevel error -y -i sample.mp4 -c copy -f hls -hls_time 3 -hls_playlist_type vod -hls_segment_filename 'hls/seg%03d.ts' hls/media.m3u8
printf '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"\n/hls/media.m3u8\n' > hls/master.txt
echo "Test media generated in $(pwd)"
