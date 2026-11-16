#!/usr/bin/env bash
# 生成 test/media.test.ts 使用的素材。需要 ImageMagick 7、ffmpeg，以及装有 pillow-heif 的 Python（用于 HEIC）。
set -euo pipefail
cd "$(dirname "$0")"

magick -size 640x360 gradient:'#1e3a5f'-'#f2c14e' image-640x360.png
magick image-640x360.png -quality 80 image-640x360.jpg
magick image-640x360.png -quality 80 image-640x360.webp
magick image-640x360.png -colors 32 image-640x360.gif
magick -size 320x320 gradient:'#1e3a5f'-'#f2c14e' -colors 16 -type palette BMP3:image-320x320.bmp
magick -size 320x320 gradient:'#1e3a5f'-'#f2c14e' -compress zip image-320x320.tiff
"${PYTHON:-python3}" make_heic.py image-640x360.png image-640x360.heic
magick -size 200x720 gradient:'#1e3a5f'-'#f2c14e' image-200x720.png
magick -size 1600x600 gradient:'#1e3a5f'-'#f2c14e' -colors 16 image-1600x600.png
printf 'this is not a media file\n' > not-media.txt

video() {
  local output=$1 size=$2 rate=$3 seconds=$4
  shift 4
  ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=${size}:rate=${rate}" -t "$seconds" \
    -c:v libx264 -pix_fmt yuv420p "$@" "$output"
}
video video-854x480-24fps.mp4 854x480 24 3 -b:v 100k -movflags +faststart
video video-854x480-120fps.mp4 854x480 120 2 -b:v 100k -movflags +faststart
# moov 放在文件末尾，并且 mdat 大于 SDK 单次读取的 256 KB，用来覆盖分段读取
video video-854x480-23.976fps-moov-end.mp4 854x480 24000/1001 3 -b:v 1500k
# fragmented MP4：moov 里没有样本，帧数和时长在各个 moof 里
video video-854x480-30fps-fragmented.mp4 854x480 30 4 -b:v 100k -g 30 -movflags frag_keyframe+empty_moov
video video-640x360.mov 640x360 30 3 -b:v 100k
video video-854x480-1s.mp4 854x480 24 1 -b:v 100k -movflags +faststart
video video-854x480-20s.mp4 854x480 24 20 -b:v 60k -movflags +faststart

ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=5" -ar 8000 -ac 1 audio-5s.wav
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=1" -ar 8000 -ac 1 audio-1s.wav
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=10" -ac 1 -b:a 32k audio-10s.mp3
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=20" -ac 1 -b:a 32k audio-20s.mp3
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=5" -ac 1 -b:a 32k audio-5s.m4a
