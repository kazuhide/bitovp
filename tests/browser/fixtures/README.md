# QC comparison synthetic media

`qc-comparison-synthetic.mp4` contains only FFmpeg's generated `testsrc2` picture
and a generated 440 Hz sine tone. It contains no customer or provider media.
The QC report scores used with it are synthetic fixtures, not measurements.

- SHA-256: `8f6d6e262b56e40348b9a5ea6f9266bacdb95ed97fe2b5212422921d24dda13e`
- Size: 36,257 bytes
- Video: H.264, 160 × 90, 30 fps, 90 frames / 3.000 seconds
- Audio: AAC, mono, 48 kHz, 3.000 seconds

Generated offline with the Worker's pinned FFmpeg
`n8.1.3-34-ga35157abb9` (commit
`a35157abb96167fd7308edc92b55408d5bb084b0`, as pinned in `Dockerfile`):

```sh
ffmpeg -hide_banner -nostdin -y \
  -f lavfi -i testsrc2=size=160x90:rate=30 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -t 3 -map 0:v:0 -map 1:a:0 \
  -c:v libx264 -preset veryfast -crf 38 -threads 1 -pix_fmt yuv420p \
  -c:a aac -b:a 24k -ac 1 \
  -fflags +bitexact -flags:v +bitexact -flags:a +bitexact \
  -map_metadata -1 -movflags +faststart qc-comparison-synthetic.mp4
```

The checked-in checksum identifies these bytes. Different FFmpeg/x264 builds
may produce different bytes; replacement requires updating the checksum after
checking the decoded frame count and duration. Browser tests use native decoding
and range responses from this file; they do not start an encoding or QC job.
