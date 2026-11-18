# MoQ Live Encoder 実通信試験結果

試験期間: 2026-11-17〜18 JST。以下の実行時刻は UTC。
各試験の source commit は下表に記載した。
最終実試験と、停止後の読み取り専用再検証までを記録する。

## 確認できたこと

**BitOVP → Live Encoder → Cloudflare MoQ（設定 draft 16）→ Player Web X の映像表示を確認した。
最終実試験は実 Encoder `2.294.0`／Tokyo。Live ジョブと単独 Player の両ページで受信映像を観測し、
履歴保存、受信映像の保存・再生、同一 run の Heartbeat 参照、Analytics custom data の照合まで確認した。**
要求 version は `BETA`。過去の実試験で返った `2.293.0` と、最終実試験で返った
`selectedEncoderVersion: 2.294.0` は、要求値とは別に記録した。
MoQ output の設定値は `DRAFT_16`／`DRAFT_18`。実 Encoder が提示・選択した ALPN は取得できておらず、
最新版で wire protocol が更新されたかは未確定である。

## 試験ごとの結果

| 試験・ソース | Encoder／入力 | Relay／Player | 終了確認 |
|---|---|---|---|
| 初回 MoQ admission（`e949b77e`） | Live start が HTTP 400、provider code 2002。MoQ アカウント機能制限で起動前に拒否 | Relay 接続・映像送信には未到達 | provider `ERROR` を確認 |
| 機能制限解除後の Sora（`e949b77e`、設定 draft 18） | `2.293.0` が `RUNNING`。30秒の合成 A/V を送信し、入力 `CONNECTED` を確認 | token なしの接続試験。認可、SETUP、catalog／media object 中継は未確認。Player 再生試験なし | 初回90秒待ちでは不確定。アプリの再照合と task `FINISHED` で確認 |
| Cloudflare draft 18 初回（trial `0941830e`、`964fd0e7`） | `2.293.0` が起動したが、入力接続の確認前に provider `ERROR`。送信開始後の観測は約30秒 | 再生確認に進めず。この実行だけでは draft 18 の互換性を判定できない | provider 終端を確認 |
| Cloudflare draft 16 初回（trial `76decb2b`、`ee835cb3`） | Tokyo の `2.293.0` と入力接続を確認 | Player bundle の native script 読み込みが組織照合で HTTP 409。SDK 実行・WebTransport 接続前のアプリ不具合 | provider `FINISHED` を確認 |
| Cloudflare draft 16 再試験（trial `d453b290`、`1d7ce9fb`） | Tokyo の `2.293.0`、入力 `CONNECTED`。送信プロセスは終了コード0 | 修正後の bundle は200。ブラウザーの WebTransport 接続成立イベント後、約0.8秒で切断。映像フレームは未確認 | `2026-11-17T18:22:27Z` に task `FINISHED`、停止確認済み |
| Cloudflare draft 18 再試験（trial `46bb5afe`、`1d7ce9fb`） | Tokyo の `2.293.0` が `RUNNING` の後、入力接続を確認する前に汎用エラーで `ERROR` | Player 試験に進めず。draft 18 の互換性は判定できない | `2026-11-17T18:33:32Z` に task `ERROR`、終了確認済み |
| Cloudflare draft 16 映像確認（trial `46295f07`、`1d7ce9fb`） | Tokyo の `2.293.0`、入力 `CONNECTED` | ブラウザーは `moqt-16` を提示して WebTransport 接続成立。画面にカラーバーと UTC 時刻を確認。CDP は H.264 640×360／VideoToolbox と AAC を記録。ただし Canvas 非対応の観測処理が待機状態のままで、ハーネスは失敗。遅延・録画・Analytics の検証は未完了 | `2026-11-17T18:36:25Z` までに task `FINISHED`、停止確認済み |
| Cloudflare draft 16 Canvas 対応後（trial `cc055d8d`、`cfc23162`） | Tokyo の `2.293.0`、入力 `CONNECTED` | 640×360 の受信 Canvas で20.2秒間に336回の画像変化を観測。時刻コード由来の遅延表示は観測時点で1,915 ms。ただし履歴は2点保存後の PUT が409、録画は保存されず、統合ハーネスは失敗 | `2026-11-17T20:02:24Z` までに task `FINISHED`、停止確認済み |
| Cloudflare draft 16 最終実試験（trial `b903fd66`、`5f53e079`） | Tokyo の `2.294.0`、入力 `CONNECTED` | Live／単独 Player の両方で640×360の受信 Canvas の進行を約20秒確認。履歴と受信動画2本を保存。初回 post-live ハーネスは Analytics のサンプリング頻度を同一視した照合条件で失敗し、その記録を保持 | `2026-11-17T20:38:32Z` までに task `FINISHED`、停止確認済み |
| 同じ停止済み run の読み取り専用再検証 | 新たな Live 起動・映像送信なし。provider を再取得し `FINISHED` を確認 | 保存動画の Range／再生／seek、Heartbeat の元 run・UTC 範囲、29個の保存遅延値と Analytics の一意照合が成功。元の失敗 report のハッシュ不変を確認し、補足 report を分離 | `2026-11-17T20:44:30Z` に再検証成功。`20:44:43Z` の再照合も running 0／unverified 0 |

最初の admission エラーは[初回記録](research/live-moq-encoder-probe-20261117.json)に残す。
後続の HTTP、step log、provider task、ブラウザー観測、停止確認は試験ごとの非公開 evidence に保持した。
Cloudflare の[過去6試験](research/moq-cloudflare-historical-trials-20261118.json)と、
[最終試験・停止後の再検証](research/moq-cloudflare-e2e-20261118.json)は、秘密情報を除いた JSON にまとめた。
アプリの `STOPPED` 表示や入力 `CONNECTED` だけを、Relay 配信・Player 再生・provider 停止の証拠にはしていない。
trial `46295f07` の画面証拠とデコード情報は映像表示の根拠だが、過去のハーネス結果を成功へ書き換えてはいない。
trial `cc055d8d` も映像進行・遅延を確認できた一方、保存の失敗を含む全体結果は失敗のまま保持する。
trial `b903fd66` の元 report も書き換えず、読み取り専用の再検証を別の補足記録として残した。

## 最終試験で確認した再生・保存・照合

trial `b903fd66`（source `5f53e07918ee5fd771b07b333fff404a00640801`）の受信映像は
640×360。Live ジョブでは20.19秒間に341回、単独 Player では20.30秒間に360回の
異なる Canvas 画像を観測した。これは画素変化の観測回数であり、元映像の FPS／復号フレーム数ではない。

| 保存した時刻コード遅延 | 有効点数 | 最小／中央値／最大 |
|---|---:|---|
| Live ジョブ | 12 | 1,641／1,642／1,650 ms |
| 単独 Player | 17 | 2,488／2,490／2,493 ms |

両セッションの合計29点では、最小1,641 ms、中央値2,489 ms、最大2,493 ms。
SDK が映像内の互換 barcode から得た推定値であり、RTT や独立した測定ではない。
異なる時間帯・ページの観測をまとめた値で、長時間の遅延分布を示すものではない。

実際に受信した映像の WebM を18.710秒と21.073秒の2本保存し、両方の Range GET が
206／64 bytes／WebM header で応答した。録画は映像のみで、別系統の Web Audio 音声は含まない。
Live ジョブと単独ページの両方で、選択中の保存動画
（21.073秒）のフレーム進行と中間時刻への seek を確認した。
両ページの Heartbeat リンクを実際に辿り、保存セッションの元 run と開始・終了 UTC 範囲が
既存パネルへ適用されたことも確認した。MoQ 履歴へ Encoder グラフは重複表示していない。

Analytics はセッションごとに別の impression とし、run／encoding／videoId／ライセンス識別値を照合した。
Live の保存有効値12点は Analytics 19点中の12点と、単独 Player の17点は21点中の17点と一意に一致した。
値の許容差は2 ms、時刻の許容差は10 ms。追加の7点と4点は、履歴側の1,000 ms以上という保存間隔のため
保存対象にならなかったサンプルとして区別し、保存値と一致した件数へ含めていない。

初回ハーネスは Analytics の全点が保存履歴にも存在することを要求し、正しい頻度差を失敗と判定した。
製品のサンプリングや認可条件は変更せず、保存した全有効点が同じ impression の Analytics に一度ずつ
対応することを確認する方式へ変更した。値変更・時刻変更・欠落・点の使い回し・空集合を拒否する
非公開ハーネスの10テストを通した後、同じ停止済み run の post-live 検証だけを再実行した。
**Analytics の `customData1` は同じ SDK barcode 値の転送であり、native `LATENCY` の対応や再測定ではない。**

## 表示の整理

MoQ 観測履歴は受信録画と実測 latency のグラフを中心にし、補助指標・イベント・Analytics・設定は
折りたたむ。未計測の空グラフを表示せず、元の録画なし run の履歴は高さ153pxで表示できることを確認した。
プレイヤーの常設表示は取得できた latency、buffer、解像度、描画更新数に絞り、取得できないカウンターの
行を並べない。Encoder の推移は既存の Push／Heartbeat を使い、元 run・観測期間を指定して開く。

## 実行経路と再生機能

既存環境から分離した Web／Worker／Postgres／Redis を使い、通常のアプリ認証と tenant 認可を通した。
暗号化資格情報の登録、`POST /api/live-channels`、plan compiler、Worker、SDK の経路で作成・開始・停止した。
後続の Cloudflare 試験は Docker 上の BitOVP を使用し、Encoder の地域は
`AWS_AP_NORTHEAST_1`（Tokyo）。H.264＋AAC、1秒 FMP4、MoQ 専用出力、専用 namespace とした。
publish token と subscribe-only token は分離している。

Player Web X の専用プレビューを Live ジョブと `/live/[id]/runs/[runId]/moq` に実装した。
公式 MoQ 専用 bundle `10.2.0-beta.14-464-gc431765b` を固定し、認証付きのローカル経路で読み込む。
bundle の SHA256 は `38c57dda461817fea186144468d70e9f1b9d2f642178cfece0cf8101bfc1a904`。
通常の Player 8 の manifest 再生とは分けている。

初期の観測処理は HTML video 要素を前提とし、SDK が Canvas へ描画した映像を検出できなかった。
trial `46295f07` はこれに該当し、画面に映像がある一方で UI は待機、録画は未開始、保存動画は0件だった。
その後の実装では受信 Canvas の異なる画素内容による描画更新を観測し、実 Canvas からの
native capture stream を録画に使用する。描画更新／秒は元映像の FPS やデコーダー統計ではなく、
元の復号・drop・総フレーム数が取得できない場合は未計測とする。
trial `cc055d8d` の336回／20.2秒は、この受信画像の変化を数えた値であり、元映像の FPS や復号フレーム数ではない。
`getLatency()` は映像内の互換 barcode に基づく秒単位の推定値であり、RTT ではない。
未取得・古い値・停止後の値は未計測として扱う。設定 draft や target buffer 2秒を実測遅延に置き換えない。

終了後のグラフと、実際に受信した preview 映像を最大90秒／16MiBで保存する機能も実装した。
受信フレームがない場合に入力映像を録画の代わりに使わず、保存動画があるとは表示しない。
trial `46295f07` では映像表示を確認したが、録画保存・保存動画の再生確認には至っていない。
trial `cc055d8d` も録画処理は開始したものの保存に至らず、保存動画の再生成功とはしていない。

Analytics は公開 HTMLVideoElementAdapter と custom data API を使用する。
barcode の値を `customData1` に ms で記録し、元の run／encoding／impression とライセンス識別値を照合して読む。
**native Analytics `LATENCY` の対応や独立した遅延測定を確認したものではない。**
Collector script の読み込み成功だけを impression／遅延データの受信成功にはしない。

## 履歴保存の小数精度修正

trial `cc055d8d` では、JSON の保存時に小数値が丸められ、次の累積更新が既存履歴と一致しなくなって409になった。
保存済み prefix を変更できない制約は維持し、Prisma の model JSON 書き込みから
パラメーター化した JSON テキストの `TEXT::jsonb` 書き込みへ変更した。
run／organization の条件と更新件数1件を確認し、不一致なら安全な503を返す。

実 DB の rollback 専用 probe では、2,004個の小数入力のうち model 経路は946個が変化し、
JSON テキスト経路は変化0個だった。probe は rollback し、実 run の更新は0件、永続 probe 行も0件である。
この修正は `5f53e07918ee5fd771b07b333fff404a00640801` に含む。
関連118テストと typecheck は成功し、修正後の trial `b903fd66` では履歴・録画保存まで到達した。
続く読み取り専用の再検証で Analytics との対応も確認した。

## draft 互換性についての結論

Sora 公開 native QUIC 接続先に対する汎用クライアント試験では、`moqt-23` は TLS handshake が成功し、
`moqt-16`／`moqt-18` は `no_application_protocol` で拒否された。
これは[別の ALPN 試験](MOQ-SHIGUREDO-INTEROP.md)の結果であり、実 Encoder の送出 ALPN の観測ではない。

Sora の token なし試験、Cloudflare の短時間 ERROR、Player bootstrap の409、
WebTransport の短時間接続、Canvas 映像表示後の観測不備、観測後の履歴保存不具合はそれぞれ異なる段階の結果である。
いずれも「Encoder の draft が実際には23へ更新されている」や「draft 16／18 は必ず互換性がない」
という結論には使えない。Cloudflare draft 16 設定では保存・再生・観測値の照合まで到達したが、実 Encoder の
交渉済み ALPN、独立した MoQT SETUP／catalog／object の解析、長時間継続再生は未確認である。
ブラウザーの提示 protocol `moqt-16` と接続成立イベントを、Encoder 側の交渉済み ALPN と同一視しない。

## ソースと検証の同一性

trial `d453b290`／`46bb5afe`／`46295f07` の source commit は `1d7ce9fb`。
その Docker image の source label も同じ commit を示す。
以下は当時の source snapshot の検証記録であり、Canvas・UI の後続修正に対する最終検証件数ではない。

| 対象 | 検証結果 |
|---|---|
| Core | 8,142 passed、既存 skip 6 |
| Worker | 7,161 passed、既存 skip 60 |
| DB | 406 passed、既存 skip 70 |
| Web | 13,366 passed、既存 skip 110 |
| 型・build | 全対象 typecheck 成功、Web／Worker Docker build 成功 |

Web image: `sha256:e87a3dd07963a1c0156deddf006384691b4f2c7ad3b788804b5c6742865b39b2`。
Worker image: `sha256:0bb0bd073004cf8c54202694eab273d189bdb48a0fbf2f6fdca84c41621a9da8`。
小数精度修正後の source は `5f53e07918ee5fd771b07b333fff404a00640801`。
Linux の分割 build（compile／typecheck／generate／SDK assert）はすべて終了コード0。
その Web image は `sha256:cb9d7ec2152a233d417e69fa955c3d7e753a6fc1b88cec49217107ae86f61142`。
この image／source による trial `b903fd66` と、その停止後の再検証を上記の最終結果に用いた。
コード・単体テスト・build の成功は、実 Relay の配信成功とは別の証拠である。

後続の検証記録もソース・対象ごとに分ける。Web 全体13,385 passed／既存 skip 110 は
`26ad` 時点の記録であり、最終 HEAD の全体再実行とはしていない。
その後の相関・通常 Live 等の関連217テスト、小数精度修正の関連118テスト、非公開照合ハーネスの10テストは
それぞれ別の focused receipt として記録した。これらを合算して最新 HEAD の全体テスト件数とはしない。

成果は `feat/live-moq-output` ブランチに保持する。PR 作成・merge は行わない。
token、API key、cookie、RTMP stream key を本文・公開記録・画面へ含めない。
