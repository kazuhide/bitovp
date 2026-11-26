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

## CAMBI presentation-clock fixtures

The two offset files copy the generated video/audio above, preserving all 90
video frames while moving the first video presentation timestamp. They contain
no additional source material. The original `qc-comparison-synthetic.mp4` stays
unchanged.

| File | Bytes | First video PTS | SHA-256 |
| --- | ---: | ---: | --- |
| `qc-comparison-origin-0.5.mp4` | 36,317 | 0.5 s | `8950501ccf16de44afe92373523c1d5bc246eee18f5e770e374d13b465345ce5` |
| `qc-comparison-origin-1.mp4` | 36,317 | 1.0 s | `8400c570d35ca03e5da64ebbf410386bf4bec1846000231dcff35f202f309eea` |

Remuxed offline with Homebrew FFmpeg 9.0.2 (`libavformat 63.1.102`); this is the
host remuxer, not the pinned Worker build used to generate the original file:

```sh
ffmpeg -hide_banner -nostdin -y -i qc-comparison-synthetic.mp4 \
  -c copy -output_ts_offset 0.5 -movflags +faststart \
  qc-comparison-origin-0.5.mp4
ffmpeg -hide_banner -nostdin -y -i qc-comparison-synthetic.mp4 \
  -c copy -output_ts_offset 1.0 -movflags +faststart \
  qc-comparison-origin-1.mp4
```

The browser test observes actual `requestVideoFrameCallback` metadata, including
`presentedFrames === 1`, and checks these two different media-time origins.
A relative CAMBI time of 1.26 s must seek the native players to 1.76 s and 2.26 s.
The synthetic report's complete coverage is 3 s, although displayed score samples
end at 2 s. Seeking the 2.85 s tail must keep both captions unknown and reach
3.35 s / 3.85 s, including when native MP4 demuxing updates an initially shorter
duration. Native timing observations are saved with the browser-test artifacts.
