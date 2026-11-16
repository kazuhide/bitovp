# 同期再生 UI 用の合成 HLS fixture

既存の `../qc-comparison-synthetic.mp4` を三回つなぎ、FFmpeg 9.0.2 で映像を再エンコードせず fMP4 HLS に組み直した。H.264、160×90、30 fps、270 フレーム、9 秒。音声は含まない。ブラウザーでの復号・同期・シークと、左右音声選択時の mute 状態を確認するための素材であり、プロバイダーのエンコード、画質測定、4K/HDR/Dolby Vision 表示の証拠には使わない。

元 MP4 の SHA-256: `8f6d6e262b56e40348b9a5ea6f9266bacdb95ed97fe2b5212422921d24dda13e`

リポジトリのルートから生成する。

```sh
rtk proxy ffmpeg -hide_banner -loglevel error -stream_loop 2 \
  -i tests/browser/fixtures/qc-comparison-synthetic.mp4 \
  -map 0:v:0 -c:v copy -an -map_metadata -1 -map_chapters -1 -bitexact \
  -hls_time 30 -hls_list_size 0 -hls_segment_type fmp4 \
  -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename tests/browser/fixtures/output-comparison/segment-%03d.m4s \
  -f hls tests/browser/fixtures/output-comparison/index.m3u8
```

| ファイル | バイト数 | SHA-256 |
|---|---:|---|
| index.m3u8 | 148 | fe0d1507b7af8d2f3509e0bc05c502fe3676e743ab845d4c913a18a2bfec88fc |
| init.mp4 | 809 | f7cf88238eecfbc2ad051fc3b0cd38a19ebbae40d9d8d906eb2cdd3c2e3a2bbd |
| segment-000.m4s | 71167 | 997a6cf8c515b54e8e8f1dee5cadb4ba720c32be1c161b63ad50975bf1550d99 |

ローカルの `ffmpeg -i index.m3u8 -f null -` は終了コード 0。`ffprobe -count_frames` で 270 フレームを確認した。実ブラウザーでの確認は既存の必須 Installed GUI ケース内で行う。
