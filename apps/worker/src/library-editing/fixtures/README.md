# Real tracking regression frames

`caminandes2-head-30-34.gray.gz` is a test derivative of **Caminandes 2: Gran Dillama**, Blender Foundation / [caminandes.org](https://www.caminandes.org/), released under [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/). [Film page](https://studio.blender.org/films/caminandes-2/). The original film's credits at 144 seconds carry the Blender Foundation and CC BY 3.0 notice. No endorsement is implied.

Changes: the public original was normalized to 640×360 CFR30 for evaluation, then 12 actual frames at 30s + n/3s were downscaled to 320×180 and converted to grayscale with FFmpeg area sampling. The resulting 691200 raw bytes are gzip compressed with mtime 0. This fixture contains no generated video or inferred coordinates. The eye-region seed is an explicitly authored evaluation annotation; it is not provider AISA evidence.

Original SHA-256: `7c0f22495d7e6d33576068af668aa887e4dfbe38690c8f6b75ae953c9df80aea`.

Prepared video SHA-256: `562a20a7b99b8117d1cc408e3029f0d2a807093d9c5615ede49c96fac82623aa`.

Raw grayscale SHA-256: `82e46d0d4aeb84c4da18ca50b712aeaba67b58354c89f5c73f1adb4244f23d1b`.

Compressed SHA-256: `264addd35bc92ad8ce7f9fcb113549b8dbb7cf6f32c9ca8c2e0a0ea42adc02c1`.

Extraction from the prepared video:

```sh
rtk proxy ffmpeg -ss 30 -i prepared.mp4 -t 4 -an \
  -vf 'scale=320:180:flags=area,format=gray,select=not(mod(n\,10))' \
  -fps_mode vfr -frames:v 12 -f rawvideo -pix_fmt gray frames.gray
```

The regression checks actual measured location and scale changes followed by a conservative loss before the later shot cut. Its second case explicitly masks the subject region to test controlled occlusion; that mask is not presented as original film content.
