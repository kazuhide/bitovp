# Synthetic audio fixture

`tone-660hz.mp3` is a generated 660 Hz sine wave, one second, mono 48 kHz.
It contains no recorded or third-party material and is dedicated to CC0-1.0.
It is checked in so the CPU media gate only requires an MP3 decoder, not a
particular optional MP3 encoder in the deployment image.

Generation command (FFmpeg with libmp3lame):

```sh
ffmpeg -v error -nostdin -f lavfi \
  -i sine=frequency=660:sample_rate=48000:duration=1 \
  -map_metadata -1 -c:a libmp3lame -b:a 32k -ac 1 -threads 1 \
  -write_xing 0 -id3v2_version 0 -write_id3v1 0 tone-660hz.mp3
```
