# MoQ の再生画面と観測履歴

再生画面は、映像と取得元別の時系列を並べます。狭い画面では映像を先に表示します。再生ページを開くだけのときと、再生ボタンを押した後の状態を区別します。

| 表示 | 出所と時刻 |
| --- | --- |
| 映像遅延 | Player Web X が読めた時刻コード。ミリ秒で表示 |
| バッファ | Player Web X の報告値またはブラウザーが読んだ video の先読み秒数。系列を分ける |
| 描画 | video の描画 FPS または Canvas 画像変化の毎秒観測数。旧データは別系列で扱う |
| エンコーダー | 同じ配信実行の Heartbeat の入力ビットレート、入力 FPS、累計パケット数など。BitOVP の観測時刻を使う |

再生中は直近60件のプレイヤー観測を表示します。履歴のプレイヤー側は保存したセッションごとに表示し、録画の推定再生時刻が観測範囲に入ると線とその位置までの値を示します。Heartbeat はサーバーの観測時刻を使うため、録画の位置は重ねません。未取得値は線の欠損として残します。

## 検証

画像の比較では「再生を始める」「計測元を判別する」「録画を選んでシークする」を確認します。Lean モデルは `verification/lean/MoqMetricSource.lean` にあります。欠測とゼロ、プレイヤーの取得元、エンコーダーの区別を検査します。

```sh
lean --run verification/lean/MoqMetricSource.lean
pnpm --filter @bitovp/web exec vitest run 'src/app/live/[id]/moq-' src/lib/moq-player
```

`tests/bombadil/moq-observations.spec.ts` は合成データを入れたローカルの停止済み配信で使います。2つの短い録画と時刻コード遅延、同じ配信の Heartbeat の入力ビットレートと FPS を用意し、履歴のロードを待ってから、ブラウザーに次の試験用モデルを設定します。

- `window.__bitovpMoqArchiveModel.runId` は配信実行ID。
- `sessions` は録画選択に出るID、同じオリジンの録画 API の `archivePath`、録画の観測開始 UTC をミリ秒化した `originMs`、観測期間内でシークする位置の配列 `seeks` を持つ。位置は秒で指定し、各録画に少なくとも2か所用意する。

準備した Chromium へ `bombadil browser test-external` で接続します。実 DOM のセッション変更とメディアのシークを繰り返し、録画とグラフの出所が一致し続けることを検査します。既知の対照は修正前の #171 で、API に入力測定があっても画面にグラフが出ません。
