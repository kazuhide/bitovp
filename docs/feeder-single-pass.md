# 擬似ライブの単発再生

`POST /api/feeder-sessions` の `playbackMode` を `ONCE` にすると、指定素材を先頭から末尾まで一度だけ送る。省略時は従来の `LOOP`。通常の認証、tenant、source seal、provider run、owner lease、publisher claim の制御を使用する。

```json
{
  "liveChannelId": "<channel UUID>",
  "playbackMode": "ONCE",
  "source": {
    "credentialId": "<storage credential UUID>",
    "bucket": "<bucket>",
    "key": "<full source MP4 key>"
  },
  "protocol": "RTMP",
  "target": {
    "url": "rtmp://<ingest host>/<application>",
    "streamKey": "<current run stream key>"
  }
}
```

## 再生と終了の契約

- 初期対応はコピー可能な H.264/AAC 素材。再生尺が不明な素材、先頭の video stream がカバー画像の素材、入力属性が現在の run と一致しない素材は送出しない。
- 元素材を使用し、ループ専用の CFR 正規化・末尾トリムを適用しない。MP4 edit list を尊重し、映像と音声を送る。字幕・データ stream は送らない。
- `-stream_loop 0` で送出し、正常終了・異常終了・bind timeout のいずれでも先頭から再送しない。単発再生は段階切り替えを対象とせず、`switchFromActive: true` を拒否する。
- actual spawn 直前に、所有者と publisher claim を条件に `playbackDispatchedAt: null` を一度だけ取得する。応答喪失後も marker を戻さない。クラッシュ時は一回の再生を断念しうるが、既に送った先頭を再送しない。
- worker takeover も同じ marker を尊重する。marker のある session は ERROR とし、既存の process の停止・回収を行う。process が消えた証拠がない限り、pid や publisher claim を解放しない。
- 自然 EOF は exit 0、signal なし、最後の `progress=end`、既知の素材尺までの進行、既知の video frame 数の一致で判定する。FFmpeg/FLV の timestamp 差には最大 0.5 秒の許容を置く。これはクラウド側で全パケットを受信した証明ではない。
- 終了 receipt は terminal の fenced write と一緒に保存する。手動停止には自然 EOF receipt を付けない。通常の list/detail API で mode、dispatch 日時、receipt を参照でき、クライアントから receipt を設定することはできない。

## Live 全体の停止

Feeder の EOF と課金 Live の終了は別の状態である。AISA 検証 controller は exact channel/run/analysis/encoding と EOF receipt を確認し、末尾の録画 coverage を照合したうえで通常の channel STOP を要求する。独立した上限 STOP 予約も設ける。

最終確認は Analysis/Encoding の終端、同じ pair の final snapshot、DB の終端状態、Feeder process と publisher claim の解放を個別に行う。`isFinal` だけで正常終了としない。

## 導入と検証

migration 109 は既存行を `LOOP` とする追加変更。ONCE を受け付ける前に Web と Worker を同じ対応版へ更新する。旧 Worker は新しい mode を解釈できず無限ループを送るため、混在状態で ONCE を受け付けない。旧版へ戻す場合も、全 ONCE session の停止と process/claim の回収を先に確認する。

契約・API・supervisor・processor の Vitest、実 FFmpeg の `src/feeder/single-pass.media.ts`、実 PostgreSQL の `src/feeder-single-pass.integration.test.ts` で検証する。PostgreSQL の検証は `rtk proxy pnpm test:postgres`、実メディアは `rtk proxy pnpm --filter @bitovp/worker exec tsx --test src/feeder/single-pass.media.ts`。
