# MoQ の Live Encoder・Relay・Player Web X 実通信計画

2026-11-17。対象ブランチは `feat/live-moq-output`。ユーザー指定により Cloudflare MoQ を使う。
有料 Encoder 起動・合成映像送信は許可済み。必要な出力・再生機能を BitOVP に実装してから試験する。

## 目的と判定

BitOVP から Live を開始し、Cloudflare Relay を経て、同じ BitOVP の Live 画面に組み込む
Player Web X で自作映像・音声を再生する。Encoder の `RUNNING`、入力受信、catalog 取得、
動画の進行・復号フレームを分けて記録する。成功扱いには同一 run・専用 namespace の実映像が必要。
試験終了時には BitOVP の stop と fresh task 診断で provider の終端を確認する。
失敗時には ADMIN が明示的な `kind=task&download=task` で上限付きの task text を private attachment として
取得できるようにし、通常表示と監査には自由文を含めない。公開記録には token／入力情報を持ち込まない。

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
   native script／video／download の GET／HEAD は、固定 asset と正規 UUID の録画 path に限り
   document の `expectedOrganizationId` を URL に付ける。既存の組織照合を通し、tenant を選択する値には
   使わない。MoQ の URL では未知・重複 query を拒否し、汎用 proxy の制約は変更しない。
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

実際の専用 MoQ build は受信映像を Canvas 2D に描画するため、native video 要素の経路に加えて
Canvas の観測経路を用意する。実 canvas の native captureStream を、アプリが所有する muted video
で観測・録画・Analytics adapter に接続する。フレームレートを指定して映像を合成しない。
96×54に縮小した画素の変更を観測し、同じ画像の再描画・空画像・読取不能を新しい映像と扱わない。
Canvas の更新頻度は画素変化の観測下限として表示し、元の映像 FPS、復号・drop・総フレーム等の
公開されていない counter を補完しない。設定／保存データには任意の renderingSource を残す。
Canvas capture の録画は受信した映像のみで、別の WebAudio 出力は収録しない。
停止時は観測 callback を止め、録画・Analytics の finalization 後に所有する capture track と video を解放する。

基本表示は映像、実測の遅延・バッファ・解像度・Canvas 更新率に絞り、未取得の counter 行を並べない。
設定 namespace／draft／catalog／Relay と補助指標は折り畳む。終了後は録画と実測点のある遅延グラフ1つを
基本表示とし、観測点がなければ空グラフを作らない。Encoder 指標は既存の Push／Heartbeat 表示を利用し、
MoQ 領域へ重複して描画しない。選択した観測 session の run と UTC 時間帯を、既存 Heartbeat 欄への参照に付ける。
参照先は専用の heartbeatRunId／heartbeatFrom／heartbeatTo を検証し、認可済みの配信回一覧と
正規 UUID・UTC・最大10分の期間が一致した場合だけ、その配信回と時間帯を既存表示へ適用する。
過去の配信回が見つからない場合や参照が不正な場合に、現在の別配信回へ置き換えない。
AISA 用の runId query とは独立させ、参照なしの通常表示と手動の配信回選択を維持する。
時間帯の絞り込みは既存 Push／Poll の読み込み済み行へ適用し、未読のページや欠測を0件の証明と扱わない。

変更前に failing tests を置き、secret validation／redaction、tenant・run・account の照合、
publish token 非返却、asset hash 不一致、loader failure、teardown と run 変更を検証する。
関連 tests、typecheck、production build、必要な i18n／API contract checks を通す。
実通信では Cloudflare の専用 namespace に60秒程度の合成映像を送り、Player の currentTime、
decoded／presented frames、映像寸法と画面を記録する。停止後の provider task 終端まで確認する。
最後に同じ cmux workspace 内で Rescue の foreground review と独立 Codex review を並行して行う。
main への merge／release は行わず、ブランチと日本語の Obsidian 記録を残す。

## 終了後のデモ表示（2026-11-18 追加要件）

終了後も同じジョブページ・単独ページで、受信動画と統計の推移を振り返れるようにする。
終了時は保存動画・観測履歴を先に置き、空の Live preview は折り畳む。元の作成監査と一致した
設定 namespace／draft／catalog を、資格情報を復号せず履歴へ表示する。`#moq-preview` で直接開ける。
MoQ を受信した preview の `captureStream`／MediaRecorder により最大90秒・16MiBの WebM を保存する。
これは preview で実際に受信した範囲の録画であり、視聴していない時間までの連続収録とは表示しない。
未対応・失敗・録画なしを明示し、入力映像を受信録画の代用品にはしない。

同一 run に最大5件の観測 session を保存し、各 session は最大600点、1秒以上間隔、10分以内。
ブラウザーで測定した時刻・latency・FPS・buffer・frame counters、接続／初回フレーム／停止／失敗イベントを
上限付き schema で受け付ける。未知値は null を保持する。5秒ごとと停止時に保存する。
session は server が認証済み actor と run に結び、別の actor による上書きを拒否する。
保存済み prefix の小数値を Prisma の Json model input で丸めないため、履歴と録画メタデータは
検証済み store を JSON 文字列のパラメーターとして jsonb へ保存する。既存の行ロック、
run／organization の照合、更新1行の確認、updatedAt の更新を維持し、追記比較の許容誤差は追加しない。
6件目の session 作成は拒否し、保存済み5件を自動で消さない。UUID は小文字の正規形に統一し、
大文字・小文字の別 session が同じファイルへ写像されることを防ぐ。
最大5件は退避・上書きせず、新規 session の作成だけを拒否する。Live 再生は継続できる。
開始は稼働中の同じ run に限り、終了後の flush は既存 session だけ短時間許可する。
GET は OPERATOR に限定し、tenant／channel／run の照合を行う。応答は private/no-store。
購読 URL・token・Player key・自由文 SDK エラーは保存しない。
固定 Player asset と UUID で一意に決まる archive の GET／HEAD だけを、既存の
`expectedOrganizationId` passive request binding に登録する。native script／video／download は
現在の document organization を URL に付け、proxy の same-origin・認証・role・tenant 一致の
検査を維持する。追加 query・重複・不正な binding は拒否する。
終了済み画面の設定表示は、保存済み output payload と元の CREATE 監査が一致した場合だけ、
optional `configuration` に namespace tuple、設定 draft、catalog を返す。資格情報は復号しない。

API 契約は `GET /api/live-channels/[id]/runs/[runId]/moq-observations` と
`PUT /api/live-channels/[id]/runs/[runId]/moq-observations/[sessionId]`。
session 更新 DTO は `{startedAt, endedAt, samples, events}`。sample は
`{elapsedMs, latencyMs, fps, bufferSeconds, droppedFrames, decodedFrames, presentedFrames, totalFrames, resolution}`。
event は `{elapsedMs,type}`、type は `started|first-frame|stopped|failed|ended`。
sample の optional `bufferSource` は `player|video|null` の固定値で、出所がない過去データは不明と扱う。
optional `analyticsImpressionId` は UUID のみ受け付け、video ID はサーバーが元の encoding／run から
`bitovp-moq:<encodingId>:<runId>` に固定する。保存済み impression の差し替えは拒否する。
Analytics license は最初の impression 保存時に SHA256 だけを固定し、readback 時に現在の設定と
一致する場合だけ照会する。生の key は観測データに保存しない。
descriptor の Analytics key と同じ snapshot から `analytics.licenseKeySha256` を返し、client は
その指紋を impression と組にして送る。初回保存時に設定が変わっていれば409で拒否し、
別 license に誤って固定しない。保存済みの指紋・impression は以後の設定変更でも差し替えない。
archive は同じ session 配下の `/archive` に `PUT video/webm`、`GET` は Range 対応で配信する。
固定ローカル artifact root の UUID 導出 path に保存し、サイズ制限、署名チェック、hash、原子的置換、
権限、同一 session 所有者を検査する。任意 path や外部 URL を受け取らない。
Web tier に含める FFprobe／FFmpeg で長さ・映像を上限付きで検査し、stream copy で Duration／Cues を
付けて seek 可能な WebM にする。保存済み動画を別の入力で上書きしない。アップロードは body を読む前に
process 全体で最大2件・同一 session で1件へ制限し、読取にも期限を置く。
channel 削除／reset の DB commit が成功した後だけ、対応する保存動画を確認して削除する。
provider 停止が不確かな場合や DB rollback 時には動画を保持する。
生 WebM は `X-BitOVP-Moq-Duration-Ms` でブラウザーの記録時間も伝えるが、保存可否は
上限付き ffprobe による動画 track と実 packet 時刻で判定する。ffmpeg の copy-remux 後に
再検査し、Duration／Cues を持つ seek 可能な WebM を原子的に確定する。
upload はプロセスごと最大2件、同一 tenant／run／session は同時1件に制限し、body 読み込み前に
判定する。body は全体で10秒の deadline を持ち、cancel の未完了で slot を占有し続けない。
filesystem の UUID path と JSON の所有者判定を一致させるため、この API の route ID は
小文字の canonical UUID だけを受け付ける。大文字 alias は検索・保存前に拒否する。
channel 削除と全体／選択 reset は、同じ transaction の channel／run lock 下で保存先 UUID と
メタデータを取得し、provider の終了が不確かな場合は拒否する。DB commit 成功後だけ、
専用 root 内で検証できた該当 archive とアプリ作成の UUID 一時ファイルを削除する。
DB の拒否・rollback では録画を残し、未知の隣接ファイルや共有 artifact は削除しない。

Bitmovin Analytics の対応を一次資料とこの専用ビルドで確認し、取得可能な latency を併記する。
SDK が返した値・映像内時刻からの値・設定値を混同しない。Analytics が未設定／未対応なら明示する。
公開 Collector 2.62.0 の HTMLVideoElementAdapter と setCustomDataOnce を用い、
この専用 MoQ build の barcode latency を customData1 の ms 値として収集する。
これは native LATENCY 項目の対応確認でも独立した時計の測定でもない。
videoId、runId、encodingId、impressionId と license key の SHA256 を元の run に結び、
同じ条件の Analytics Count query から時刻と遅延だけ読み戻す。key 自体は履歴に保存しない。
Collector の unload lifetime は専用の same-origin iframe が所有し、private な SDK cleanup は呼ばない。
同一 run の保存済み Live Encoder heartbeat の観測時刻・入力／出力の利用可能な指標を時間軸で照合する。
欠落や異なる時計・計測区間を成功値や0に置き換えない。
Player、Analytics、heartbeat の時刻は UTC で照合し、各 source と計測区間を残す。
Player グラフはブラウザーの開始 UTC 時刻＋単調時計の経過時間で表示し、tooltip に経過秒も残す。
初回 session 作成の応答前に停止しても、応答後に終了時刻を flush し、周期保存の timer を残さない。
最終成果はブランチのまま Docker で起動し、終了済みでも動画と統計が残る MoQ Live ジョブページを提示する。

## 映像内時刻と履歴の連続表示（2026-11-18 追記）

ジョブと専用 Player の再生映像に、当時の映像内時刻を UTC の日付・時分秒・ミリ秒で表示する。
受信映像へ埋め込まれた48-bitの時刻コードを読み取り、録画開始時刻に再生秒数を足した推測値は使わない。
対象は既存デモの白黒ヘッダー・48 bit・黒い末尾を持つ形式で、2000年から2100年未満の epoch ms を検査する。
任意の焼き込み文字を OCR する機能ではなく、時刻コードの真正性を保証するものでもない。
既存の保存動画にも適用し、再生、一時停止、seek、速度変更、末尾、セッション切替に追従する。
時刻コードがない・読み取れない映像は未取得とし、現在時刻への置換や時計だけの自走をしない。
Live Canvas と保存 video の同じ小さな時刻表示を使い、元のプレイヤーや録画 stream の所有権は変えない。
読み取りは最大10Hz・小さな画素領域に制限し、切替・終了・unmount 時に自分の callback と listener を解放する。

履歴の保存間隔は少なくとも1秒であり、1秒周期 callback の微小なずれで約2秒間隔になる場合がある。
グラフだけが1.5秒超を欠損と判定していたため、通常の間引きも線の切断になっていた。
人工的な区切りは2.5秒超へ合わせ、既存の実測点をそのまま結ぶ。明示的な未計測値と長い欠測は区切ったままにする。
保存データ、API の最小間隔、欠測値、測定時刻を補完・書換えしない。

検証は時刻コードの既知値、壊れた／未対応の画像、旧履歴の約2秒間隔と実欠測の回帰を先に追加する。
保存済みの実受信動画を Docker の両ページで再生し、映像の時刻と UI、一時停止、seek、再生速度、末尾、
セッション切替、320px表示を実ブラウザーで確認する。既存動画を使い、有料 Encoder の再起動は必要としない。

## 一次資料

- https://developers.cloudflare.com/moq/ と use-the-api／demo-streams
- https://developer.bitmovin.com/encoding/docs/media-over-quic-moq-output
- https://demo.bitmovin.com/public/pwx-moq/
- https://developer.bitmovin.com/playback/docs/player-web-x-getting-started
- [動画フレームの callback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)
- [video／canvas の画素読み取り](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage)

確認した専用 bundle: `playerx-moq.js?v=20260912120554`、1,051,867 bytes、
SHA256 `38c57dda461817fea186144468d70e9f1b9d2f642178cfece0cf8101bfc1a904`。
