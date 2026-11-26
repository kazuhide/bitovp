# 擬似ライブの単発再生

`POST /api/feeder-sessions` の `playbackMode` を `ONCE` にすると、指定素材を先頭から末尾まで一度だけ送る。省略時は従来の `LOOP`。通常の認証、tenant、source seal、provider run、owner lease、publisher claim の制御を使用する。

画面から作るフィーダーは `LOOP` で動作する。単発再生は API から即時送出する場合に利用できる。

`ONCE` には `Idempotency-Key` ヘッダーが必要。応答を受け取れなかったら同じキーと本文で再試行する。初回は `201`、再試行は同じセッション ID と `replayed: true` を含む `200` を返す。本文が変わった場合は `409`、セッションを削除済みの場合は `410` を返す。キュー投入の応答を確認できず `503 FEEDER_ENQUEUE_UNCONFIRMED` が返った場合も、同じキーで再試行する。セッションが開始待ちなら、元のキュー ID で投入を試みる。

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
- 元素材の映像と音声をそのまま送る。MP4 edit list の除外フレームや AAC の部分トリムを送出先で再現できない素材は、送出前に拒否する。字幕とデータストリームは送出しない。
- `-stream_loop 0` で送出し、正常終了・異常終了・bind timeout のいずれでも先頭から再送しない。単発再生は段階切り替えを対象とせず、`switchFromActive: true` を拒否する。
- actual spawn 直前に、所有者と publisher claim を条件に `playbackDispatchedAt: null` を一度だけ取得する。応答喪失後も marker を戻さない。クラッシュ時は一回の再生を断念しうるが、既に送った先頭を再送しない。
- worker takeover も同じ marker を尊重する。marker のある session は ERROR とし、既存の process の停止・回収を行う。process が消えた証拠がない限り、pid や publisher claim を解放しない。
- 自然 EOF は正常終了と最後の `progress=end` に加え、選択した映像・音声それぞれでパケット数が一致したときに記録する。入力は edit list を適用した ffprobe の実測値、出力は FFmpeg が muxer に渡した数を使う。報告された送出時刻は参考値。クラウド側の受信結果は別途確認する。
- 終了 receipt は terminal の fenced write と一緒に保存する。手動停止には自然 EOF receipt を付けない。通常の list/detail API で mode、dispatch 日時、receipt を参照でき、クライアントから receipt を設定することはできない。

## Live 全体の停止

Feeder の EOF と課金 Live の終了は別の状態である。AISA 検証 controller は exact channel/run/analysis/encoding と EOF receipt を確認し、末尾の録画 coverage を照合したうえで通常の channel STOP を要求する。独立した上限 STOP 予約も設ける。

最終確認は Analysis/Encoding の終端、同じ pair の final snapshot、DB の終端状態、Feeder process と publisher claim の解放を個別に行う。`isFinal` だけで正常終了としない。

## 導入と検証

追加マイグレーションでは既存行を `LOOP` とする。ONCE を受け付ける前に Web と Worker を同じ対応版へ更新する。旧版へ戻す場合は、全 ONCE session の停止と process/claim の回収を先に確認する。

契約・API・supervisor・processor の Vitest に加え、[FFmpeg の実メディア試験](../apps/worker/src/feeder/single-pass.media.ts)と[PostgreSQL の試験](../packages/db/src/feeder-single-pass.integration.test.ts)がある。

```sh
rtk proxy pnpm test:postgres
rtk proxy pnpm --filter @bitovp/worker exec tsx --test src/feeder/single-pass.media.ts
```
