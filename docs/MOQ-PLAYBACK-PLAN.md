# MoQ の Live Encoder・Relay・Player Web X 実通信計画

2026-11-17〜18 の実装・検証計画の記録。対象は当時の `feat/live-moq-output`。
Live 出力と Player Web X の初期機能は 1.3.2 に入った。現行の設定は
[Live ガイド](user-guide/LIVE.md#experimental-moq-delivery)、API は
[API リファレンス](API-USAGE.md)、画面と指標の見方は
[観測画面の検証手順](verification/moq-observation-ui.md)を参照。

## 当時の試験条件

- BitOVP から Live を開始し、Cloudflare Relay 経由で送った合成映像を
  チャンネル詳細と専用 Player で観測した。試験の初期設定は AWS 東京
  (`AWS_AP_NORTHEAST_1`)、BETA、draft 18、H.264 360p と AAC、
  1秒の FMP4、専用 namespace 1要素。別の配信回で draft 16 を試した。
- publish 用と subscribe 専用の token を使い分けた。ドメインと Player ライセンスの
  組み合わせは実再生で確認した。実際に使った Encoder バージョンや試験ごとの
  到達段階は[実通信試験結果](MOQ-LIVE-ENCODER-TEST-RESULTS.md)に残した。
- Encoder の起動、入力受信、catalog、同じ配信回の受信映像、保存・再生、停止の確認を
  別々に記録した。受信映像には実際に観測した時間だけが含まれる。
  [時雨堂の ALPN 試験](MOQ-SHIGUREDO-INTEROP.md)には対象と測定範囲を別途記録した。

## 設計上の判断

- 購読は、保存済み `CREATE_OUTPUT_MOQ` の実行記録から同じ配信回の namespace、
  draft、資格情報参照を得る。プレビュー用の1要素 namespace には配信回の識別子を付け、
  作成時に実際の値を保存する。Relay の権限はこの値に対して必要。
  [実行記録の照合](../apps/web/src/lib/server/moq-playback-run.ts)と
  [資格情報の照合](../apps/web/src/lib/server/moq-playback.ts)を参照。
- 資格情報のバージョンと購読用の値は同じ読み取りで取得する。配信開始後に資格情報が
  変更された場合は再生を拒否する。ブラウザーのネイティブな script・動画取得は
  固定の経路に限定し、ページの組織と認証セッションを照合する。代理閲覧時の境界は
  [API リファレンス](API-USAGE.md)を参照。
- 受信 Canvas はブラウザーが画像の変化を観測する。取得元の区別や明示的な欠測は
  保存とグラフに残す。
  [プレイヤー測定](../apps/web/src/lib/moq-player/video-statistics.ts)、
  [時系列への変換](../apps/web/src/lib/moq-player/metric-series.ts)、
  [録画時刻の推定](../apps/web/src/lib/moq-player/client-playback-time.ts)を参照。
- 履歴は配信回と所有者に結び付ける。上限に達した場合は観測の追加を止め、
  プレイヤーは動作を続ける。追記時の小数精度を保つため、検証した JSON を
  パラメーター化したテキストとして JSONB に書き込む。
  [小数精度の試験記録](MOQ-LIVE-ENCODER-TEST-RESULTS.md#履歴保存の小数精度修正)を参照。
- 録画は FFprobe／FFmpeg で上限、動画トラック、実パケット時刻を確認し、
  Duration と Cues を持つ再生可能な WebM に確定する。削除は配信回の停止と
  データベースへの反映を確認してから行う。
  [読み書きの上限](../apps/web/config/moq-policy.ts)と
  [アーカイブ API](../apps/web/src/lib/server/moq-archive.ts)を参照。
- Analytics は元の run、encoding、impression とライセンスの指紋に結び付ける。
  紐付けに失敗しても、ブラウザーで取得できた観測値と録画を保存できる。
  [保存契約](../apps/web/src/lib/server/moq-observations.ts)と
  [Analytics の照会](../apps/web/src/lib/server/moq-analytics.ts)を参照。

## 一次資料

- [Cloudflare MoQ](https://developers.cloudflare.com/moq/)
- [Bitmovin MoQ Output](https://developer.bitmovin.com/encoding/docs/media-over-quic-moq-output)
- [Player Web X MoQ デモ](https://demo.bitmovin.com/public/pwx-moq/)
- [Player Web X の導入](https://developer.bitmovin.com/playback/docs/player-web-x-getting-started)
- [動画の再生位置](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime)

試験で使用した専用 bundle は `playerx-moq.js?v=20260912120554`（1,051,867 bytes）。
SHA256 は `38c57dda461817fea186144468d70e9f1b9d2f642178cfece0cf8101bfc1a904`。
