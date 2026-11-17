# MoQ の Live Encoder・Relay・Player Web X 実通信計画

2026-11-17。対象ブランチは `feat/live-moq-output`。ユーザー指定により Cloudflare MoQ を使う。
有料 Encoder 起動・合成映像送信は許可済み。必要な出力・再生機能を BitOVP に実装してから試験する。

## 目的と判定

BitOVP から Live を開始し、Cloudflare Relay を経て、同じ BitOVP の Live 画面に組み込む
Player Web X で自作映像・音声を再生する。Encoder の `RUNNING`、入力受信、catalog 取得、
動画の進行・復号フレームを分けて記録する。成功扱いには同一 run・専用 namespace の実映像が必要。
試験終了時には BitOVP の stop と fresh task 診断で provider の終端を確認する。

## 構成

- Relay: Cloudflare の beta 期間無料サービス。既存の個人プロファイルでログイン済みの account に
  評価専用 Relay を用意する。publish+subscribe token と subscribe-only token を用途別に扱う。
- Encoder: BitOVP の既存 MoQ plan／compiler／Worker 経路。以後の起動はユーザー指定の
  AWS 東京 `AWS_AP_NORTHEAST_1` に固定し、選択結果も確認する。最初は BETA、draft18、
  H.264 360p＋AAC、1秒 FMP4、1要素の専用 namespace。必要な場合は別 run の draft16 と比較する。
- Player: 公開 npm 10.3.1 に MoQ module がないため、公式 MoQ デモの専用ビルドを検証用に使用。
  元 URL と SHA256 を証拠に記録し、proprietary bundle をリポジトリへ取り込まない。
  サーバー運用者が指定するローカル bundle と digest を検証して配信する。
  既存 tenant の Player license key を使い、domain の可否を実再生で確認する。

## 実装の分担と境界

1. MOQ secret に optional `playbackUrl` を追加。HTTPS の subscribe URL を publish 用
   `relayUrl`／`authToken` と分離する。資格情報フォーム・redaction・型・回帰テストを更新する。
2. OPERATOR の `GET /api/live-channels/[id]/runs/[runId]/moq-playback`。
   run と channel、元の Encoding／MOQ output 作成記録に照合し、保存済み step から namespace／draft／
   credential reference を得る。最新 channel plan や query の任意 URL は使わない。
   credential が出力作成後に変更されていれば保守的に拒否する。publish secret は返さない。
   その判定は `CredentialStore.revealVersioned` の1回の scoped read で取得した version と secret を用い、
   別々の metadata／secret read による更新競合を避ける。
   応答は subscribe URL、1要素 namespace、draft16／18、catalog `catalog`、既存の Player key のみ。
   private/no-store。監査は URL／token／key を含めない。欠落・複数 namespace は明示的な未対応状態にする。
   Cloudflare の既知の draft16／18 HTTPS origin の場合だけ、同じ資格情報内の購読 JWT を
   上限付きでデコードし、optional `relay` に設定上の Relay ID（32桁 hex）、endpoint origin、
   token 有効期限、`subscribe` 操作を返す。署名はローカル検証せず、
   `metadataSource: unverified-token-claims` を明示する。接続先 edge・接続成立・実際の draft の
   証明には使わない。既知の Cloudflare URL の token が不正、または操作が厳密に
   `[subscribe]` でなければ、publish 権限の誤返却を防ぐため409で拒否する。
   JWT 全体・署名・jti・kid・issuer・account ID は追加メタデータに含めない。
   Relay の公開管理 API は設定と optional 接続状態を返すが、接続数・bytes・RTT 等の
   公開 counter API は確認できていないため、新しい管理用 API token や外部リクエストは追加しない。
3. OPERATOR の固定 player asset route。`BITOVP_MOQ_PLAYER_BUNDLE_PATH` と
   `BITOVP_MOQ_PLAYER_BUNDLE_SHA256` を使用し、ファイル種別・サイズ・digest を検査する。
   任意のリクエスト URL／path を fetch・read しない。未設定や不一致時に既存 Player へ fallback しない。
4. Live の既存 playback slot に専用 MoQ preview を追加。Player 8／manifest preview は維持する。
   明示 Play、muted 開始、Stop、状態表示。HLS output confirmation を MoQ の再生条件に使わない。
   source を追加し target buffer を2秒に設定、unmount／run 変更時には source を除去し player を dispose。
   非同期の途中中断も処理する。SDK の自由文エラーや token URL を画面・console・storage に出さない。

## 表示の方針

既存 Live のタイポグラフィ・余白・コンポーネントを使う。新しい hero や装飾は作らない。
既存 zinc の背景／文字、emerald の操作色、red の失敗表示を継承する。基準 palette は
既存テーマにある `#101828`、`#192436`、`#2b3c52`、`#f1f5f9`、`#1d4ed8`。
新しい色定数を追加せず theme token を参照する。左揃えの操作行、その下に16:9の映像領域を置く。
320px 幅では操作を折り返す。loading／未設定／失敗／再生／停止を区別し、ボタンと状態をキーボード・
screen reader から利用可能にする。短い文言で、資格情報や実装内部の値は表示しない。

## 検証

追加範囲: 実 Live job の preview と同じ MoQ Player を専用ページ
`/live/[id]/runs/[runId]/moq` にも配置し、OPERATOR に限定する。
両方に MoQ／Web X 表示と、実 video から測った FPS・解像度・drop・buffer ahead・
クリックから最初の描画フレームまでの時間を最大1秒ごとに表示する。
取得できない値と停止後の値は不明として示し、設定 draft／target buffer 2秒と実測値を区別する。
公式デモで確認した `getLatency()`（秒）は映像内の互換 barcode による video latency と表示し、
互換 barcode がない場合・非有限値・直近1秒に実フレームがない場合は未計測に戻す。
`getBufferLevel()`（秒）を優先し、未対応時は video buffered の計測と出所を区別する。
通常の合成映像の時刻表示から latency を推測しない。

変更前に failing tests を置き、secret validation／redaction、tenant・run・account の照合、
publish token 非返却、asset hash 不一致、loader failure、teardown と run 変更を検証する。
関連 tests、typecheck、production build、必要な i18n／API contract checks を通す。
実通信では Cloudflare の専用 namespace に60秒程度の合成映像を送り、Player の currentTime、
decoded／presented frames、映像寸法と画面を記録する。停止後の provider task 終端まで確認する。
最後に同じ cmux workspace 内で Rescue の foreground review と独立 Codex review を並行して行う。
main への merge／release は行わず、ブランチと日本語の Obsidian 記録を残す。

## 一次資料

- https://developers.cloudflare.com/moq/ と use-the-api／demo-streams
- https://developer.bitmovin.com/encoding/docs/media-over-quic-moq-output
- https://demo.bitmovin.com/public/pwx-moq/
- https://developer.bitmovin.com/playback/docs/player-web-x-getting-started

確認した専用 bundle: `playerx-moq.js?v=20260912120554`、1,051,867 bytes、
SHA256 `38c57dda461817fea186144468d70e9f1b9d2f642178cfece0cf8101bfc1a904`。
