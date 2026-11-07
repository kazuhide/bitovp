---
type: spec
project: bitovp
created: 2026-11-07
status: preview
tags: [aisa, live, preview]
---

# AISA Live Preview

通常の Live 作成画面 `/live/new` の設定に AISA 解析の有効化を追加する。作成、一覧 `/live`、チャンネル詳細 `/live/[id]`、実行履歴を共通にし、AISA 専用の作成フローや上部の3つの切り替えリンクは設けない。解析がある実行には key moments、日本語訳、サムネイルと区間再生を表示する。

## 通常 Live の追加機能としての表示

作成ウィザードは通常の9ステップを維持する。「1. 基本設定」でチャンネル名・アカウント・リージョン等を設定した後、「追加機能」の「キーモーメントを自動検出する」を選ぶ。対応スポーツと Preview の配信構成を開き、構成への同意はここで一度だけ取得する。「4. 出力」で既存 Output ID・録画保存先・解析結果保存先を指定する。後続のラダー・パッケージング・マニフェスト設定は対応構成の説明とし、同意チェックを繰り返さない。オフに戻した場合は既存の通常配信設定を保持する。

チャンネル詳細は通常と同じヘッダー、配信状態、開始・停止、配信履歴、セクションのナビゲーションを使う。解析が有効な場合だけ「キーモーメント」セクションを追加し、検出した場面・サムネイル・区間再生・日本語切り替えを配置する。AISA Live は解析機能の提供元として補助的に表記する。Analysis ID・モデル・sequence 等の技術情報は折りたたむ。専用の詳細画面には分岐しない。

Preview の capability にない通常 Live の監視・予約・graph 変更パネルは mount しない。取得していない監視値を正常・0件として表示しない。終了結果の取り込みは読み取り専用とする。選択した過去 run は解析と録画だけに適用し、配信の停止等は常に現在の run を対象とする。`?runId=...#sec-analysis`、VIEWER 投影、ingest とログの権限境界を維持する。320 / 768 / 1024 / 1440px の画面、通常配信との分岐、初回未検出・履歴選択を検証する。

現在確認できた Preview API は Analysis が backing Encoding を管理する契約で、任意の通常 Encoding へ関連付ける API は未確認。通常設定内で有効化する際はこの対応範囲を明示し、未対応の任意ラダー・DRM・ESAM 等を送信前とサーバー側で拒否する。通常の設定を受理して裏で捨てる実装はしない。

ユーザーから共有された現在の key moments 対象はサッカー（football）、テニス、アメリカンフットボール。画面の Preview 説明と結果ゼロ件の説明に明記する。対象でも必ず検出されるとは約束せず、未知の category を除外しない。将来の分類拡張を妨げる入力 enum としてスポーツ種別を API へ送らない。

## 実装方針

- 本流は公開 `@bitmovin/api-sdk@1.287.0` を維持する。
- Preview は `@bitmovin-internal/api-sdk@1.288.0-develop.02b690c6` の専用クライアントを使う。private registry 依存を通常 install に追加せず、管理者が別途インストールしたパッケージを server の `BITOVP_AISA_LIVE_SDK_PATH` で指定する。未指定時は通常の Node 解決を試す。版の不一致または未インストールは明示的な 503 とする。
- `BITOVP_AISA_LIVE_PREVIEW=true` のときだけ UI/API を公開する。既定は無効。API 側でも gate を評価する。
- AICA の organization-scoped Analysis resource と provider の Encoding 状態を読み、bitovp の LiveChannel/LiveChannelRun に実行単位の Analysis identity・最終状態・最後の有効 snapshot を関連付ける。再放送で結果を混ぜない。API key は server の account store からだけ取得する。
- GET は VIEWER、create/start/stop は OPERATOR 以上。stream key を含む ingest は専用 GET endpoint を OPERATOR 以上に限定する。list/detail/results は ingest と任意の upstream field を返さない。
- 録画と解析の両 Output に `PRIVATE` ACL を明示する。ACL 非対応 Output や bucket policy の設定まで非公開を保証するものではない。
- 新しい API は既存の proxy、tenant/expected-org 認証、監査方式を使う。signed HLS URL、stream key、API key、raw SDK error はログや監査に残さない。
- 通常の作成・開始・停止の操作と永続 lifecycle を利用する。内部では create 後の実 ID を記録してから start する。副作用を自動再試行せず、応答不明なら実リソースを再取得して照合する。Analysis の stop/finalize を経ずに通常 Encoding だけを停止しない。
- Encoding と Analysis の終了、final snapshot の有無を別々に表示する。RUNNING はメディア受信や key moments 検出の証拠としない。
- 解析の終了待ちは実行単位の `aisaFinalization` に記録して再確認する。`aisaSnapshot` は provider の結果だけを保持し、内部の失敗証明を混ぜない。両 provider が終了しても失敗した実行は ERROR と理由を保持する。新規 Preview の無効化後も、既存の同一 run の停止・回収は可能にする。
- 開始前のキャンセルは、CREATE 未送信の記録、または同じ run の Analysis と Encoding が両方 CREATED で START 未送信の独立した確認を、別の `NEVER_STARTED` 証明として保存する。証明と実行・ステップ記録が一致するときだけ再開始や削除を許可する。送信結果が不明な場合は許可しない。キャンセル要求の解除は、チャンネルと実行の終端状態・証明と同じ fenced transaction で確定する。
- 作成前に失敗したリソースなしの ERROR は、存在するチャンネル・実行のログが CREATE 未送信を証明する場合に削除できる。実行がまだない場合も、最新の実行が存在しないこと、チャンネルに provider ID と CREATE 送信の記録がないことを確認する。削除トランザクションではチャンネル、最新の実行の順でロック・再読し、その時点の状態と証明を確認してから依存データを削除する。古い実行の停止確認で、新しく開始された実行を削除しない。
- 停止の再試行は、読み取った claim の token・state・generation が同じ場合だけ所有者を更新する。競合で所有者が変わった場合は transaction を戻し、新しい所有者の処理とチャンネルの世代を保持する。
- 通常のチャンネル詳細 API も AISA の接続情報の権限を守る。VIEWER の返却値は allowlist の metadata・run binding・検証済み snapshot に限定し、plan/compiled payload/接続情報/未検証の raw container は返さない。

## 機能と API

`/live` は AISA の有無を含む同じチャンネル履歴、`/live/new` は同じ作成画面、`/live/[id]` は同じチャンネル詳細を使う。既存 deep link、複製、通常の作成動作を保持し、以前の AISA ページへのリンクも対応する通常画面へ導く。

## 機能の分割と実装順

| 機能 | 責務 | 依存 |
|---|---|---|
| live-integration | 通常設定の AISA 有効化、実行単位の永続関連付け、共通履歴・詳細、既存3ランの取り込み | 既存 Live lifecycle |
| moment-preview | 認証付き録画 proxy、PDT と解析時刻の変換、サムネイル、区間再生 | 実行の Analysis/Encoding identity |
| local-translation | 原文を保持したローカルモデルの日本語訳、原文 hash と provenance に基づく保存 | 実行の Analysis/Encoding identity |

実装順は関連付けと契約の確定、録画・翻訳の並列実装、通常 UI への接続、実データでの検証とする。新規作成で用いる限定設定は `start.aiSceneAnalysisLive` に明示し、同じフォームの account/name/input/region/encoderVersion を使う。既存 Output ID、録画と解析の出力 path は既存の出力設定内で指定する。独自の encoding graph は未対応として明示的に拒否する。

## 区間プレビュー

サムネイルは実録画の `anchorInSeconds` のフレームを表示する。クリックすると同じ出力を読み、`startInSeconds`〜`endInSeconds` の間を再生する。派生のクリップ動画は生成しない。

`mediaTimeOriginUnixMs` と HLS の PROGRAM-DATE-TIME を使って解析時刻をプレイヤーの時刻に変換する。対象区間の連続した coverage が確認できない場合は再生可能と見せない。seek は区間内へ制限し、終了位置で pause する。サムネイルの同時デコーダー数・cache 数・待ち時間を制限する。

録画 manifest は固定の Bitmovin endpoint から認証付きで取得する。署名 URL を server 内で隠し、tenant/account/analysis/encoding に束縛した短命の opaque token へ書き換える。子リソースも expected-org を検証する。ユーザー入力の URL proxy、外部 storage への Bitmovin API key 転送、redirect 追従は行わない。

## 日本語訳

確認した Preview SDK の Live Create/Start/Result には出力言語の指定がない。今回の実結果8件は英語であり、VOD の追加言語 API を Live の対応根拠にしない。

ユーザーの希望により導入済みローカルモデルを優先する。Bitmovin 原文は変更せず、日本語訳を別データとして保存し、表示言語を切り替えられるようにする。tenant/account/analysis/encoding/observation ID・原文 hash・target locale・model・prompt version を保存し、原文の更新や撤回で古い訳を表示しない。翻訳は bitovp のローカルモデルによるものと分かるようにし、失敗時も原文を保持する。ID・時刻・重要度・category は翻訳しない。

既存の OpenAI 互換ローカル推論エンドポイントを `BITOVP_AISA_TRANSLATION_BASE_URL=http://127.0.0.1:<port>/v1`、導入済みモデルを `BITOVP_AISA_TRANSLATION_MODEL`、必要に応じ認証を `BITOVP_AISA_TRANSLATION_TOKEN` で指定する。接続先はサーバー設定のみで loopback に限定し、ユーザーから URL・モデル・provenance を受け取らない。未設定時は原文と保存済み訳の閲覧を維持する。今回のローカル検証では導入済み Qwen を既存の推論ロック・解放確認を守る loopback bridge 経由で利用した。モデルのダウンロードは行わない。

初期表示の DB snapshot と API snapshot の比較では、JSONB の小数往復による最下位桁の差を吸収するため秒値をマイクロ秒精度で比較する。保存された元の時刻・再生対象時刻は書き換えない。identity・原文・改訂・finality の不変性を維持し、実質的に異なる時刻の更新は拒否する。

| API | 内容 |
|---|---|
| GET `/api/live/analyses?bitmovinAccountId=...&offset=0&limit=25` | account 内の Analysis 一覧（最大100件/ページ） |
| POST `/api/live/analyses` | `{bitmovinAccountId, analysis}` を検証して作成 |
| GET `/api/live/analyses/[analysisId]?bitmovinAccountId=...` | ingest を含まない詳細 |
| POST `/api/live/analyses/[analysisId]/actions` | `{bitmovinAccountId, action: start/stop, esVersion?, aicaVersion?}`。override は start のみ |
| GET `/api/live/analyses/[analysisId]/ingest?bitmovinAccountId=...` | OPERATOR 向け RTMP/SRT 接続情報 |
| GET `/api/live/analyses/[analysisId]/results?bitmovinAccountId=...` | `{availability: available, snapshot}` または `{availability: pending}` |
| POST `/api/live-channels` | 通常と同じ作成。明示した `start.aiSceneAnalysisLive` の場合は専用 lifecycle を永続化して enqueue |
| POST `/api/live-channels/[id]/actions` | AISA の場合は新しい実行の開始・停止・起動キャンセル。その他の標準 graph 変更は拒否 |
| POST `/api/live-channels/import-analysis` | `{bitmovinAccountId, analysisId}`。独立した最終状態検証後に既存 run を共通履歴へ取り込む。provider write なし |
| GET/HEAD `/api/live/analyses/[analysisId]/recording` と `/recording/media` | tenant/account/analysis/encoding に束縛した認証付き HLS 読み取り |
| GET/POST `/api/live/analyses/[analysisId]/translations` | 保存済み日本語訳の閲覧 / OPERATOR によるローカル翻訳。原文は保持 |

旧 `/live/analyses` は通常履歴へ、関連付け済みの旧解析詳細リンクは `?runId=<exact run ID>` を保持して同じチャンネル詳細へ移動する。通常ページで所属 channel と AISA binding を検証し、不明・別 channel の run は 404 とする。再放送後も古いリンクを最新 run へ置き換えない。旧 Analysis actions API から関連付け済み run を変更することは拒否し、共通 lifecycle の操作を使用する。取り込み済みの終了 run は読み取り専用とする。

作成の `analysis` は `name`、`input`（RTMP streamKey、HLS url、既存 Input の REFERENCE inputId と任意 streamKey）、任意 `cloudRegion`/`encoderVersion`、`recording.outputs`、`outputs`。Output は既存 Encoding Output の `outputId` と `outputPath` を指定し、inline credential resource は受け付けない。HLS は ongoing playlist と PDT mapping が必要。`encoderVersion` の空欄は省略、ES/AICA override は Start 時の header として分ける。

共通 client contract は `apps/web/src/lib/aisa-live/contracts.ts`。公開型は `AisaAnalysis`、`AisaAnalysisPage`、`AisaCreateBody`、`AisaActionBody`、`AisaResultSnapshot`、`AisaResultsResponse`、`AisaIngest`。schema は `aisaCreateBodySchema`、`aisaActionBodySchema`、`aisaAnalysisSchema`、`aisaResultSchema`、`aisaIngestSchema`。typed schema parse で upstream の余剰 field を削除する。

`AisaAnalysis` は `{analysisId, encodingId, status, name?, createdAt?, inputId?}`。
`AisaIngest` は `{rtmpIngest?: {encoderIp, streamKey, application?}, srtIngest?: {mode: LISTENER, encoderIp, port}}`。
`AisaResultSnapshot` は pinned SDK の累積結果と同じ公開 field を持つ。省略の observations/keyMoments/sourceGaps は空配列へ正規化する。

`apps/web/src/lib/aisa-live/snapshots.ts` の `applyAisaSnapshot(previous, snapshot)` は新旧 snapshot を比較し、採用可能な snapshot を返す。古い/同一 sequence は前回値を保持し、identity、media origin、coverage、finality、観測の不変性と moment revision の違反は拒否する。withdrawal の ID 再利用を見落とさないため必要な履歴は reducer state に保持する（具体型は実装で定義）。UI は不正な更新や poll 失敗時も最後の正しい結果を保持する。

表示と polling、翻訳対象の基準は親コンポーネントが受理した同じ snapshot とする。再入場時に fresh な古い query cache があっても、既知の DB final result を隠さない。DB snapshot の更新も同じ reducer を通し、拒否した更新の警告は維持する。

SDK adapter は `apps/web/src/lib/server/aisa-live-sdk.ts`。`aisaLivePreviewEnabled()` と `aisaLiveClientForAccount(ctx, accountId, versions?)` を公開し、account 不在は null、それ以外は `list/create/get/start/stop/latest` を備えるクライアントを返す。methods の返値は unknown とし、route 境界で schema parse する。SDK error を public-safe な専用 error に変換し、raw error を caller に渡さない。結果未生成は専用 code `LIVE_ANALYSIS_RESULT_NOT_AVAILABLE` だけを pending とする。

## 検証

- Vitest: 入力検証、未知 field 削除、sports 制限の説明、snapshot 撤回/改訂/identity/finality、gate、tenant account、ingest role、action state と audit の秘密除外。
- 実 dev SDK と fake transport で create/start/stop/latest の request/response を確認する。外部ネットワークには接続しない。
- UI の作成・一覧・詳細・pending/empty/error・read-only を component tests とブラウザで確認する。
- 通常 Live の作成と履歴に統合され、AISA がない実行には解析問い合わせが発生しないことを確認する。未対応設定は provider write 前に拒否する。
- 既存3つの実ラン（サッカー4件、テニス0件、アメフト4件）は実 ID・日時・最終結果を保って取り込み、provider write や新規 queue を発生させない。
- 実録画からサムネイルを表示し、クリック後の開始位置・区間外 seek・終了停止をブラウザで確認する。PDT 不在、欠落、期限切れ、tenant 切り替えは fail closed。
- 導入済みのローカルモデルで実観測文を日本語へ翻訳し、原文保持、hash 不一致時の無効化、失敗表示、VIEWER/OPERATOR の境界を確認する。
- 既存 Live 作成、権限/route coverage、i18n、SDK externalization、typecheck/build を実行する。
- `rtk proxy pnpm --filter @bitovp/web exec vitest run <変更に対応するtest>`。
- `rtk proxy pnpm --filter @bitovp/web typecheck`。
- `rtk proxy pnpm --filter @bitovp/web build`。
- `rtk proxy pnpm exec biome check --error-on-warnings <変更ファイル>`。

デモリポジトリは read-only。既存の有料3ランと実録画を使って履歴・区間再生を確認する。新規作成の lifecycle 検証が必要な場合だけ、既に承認された短時間の課金試験の範囲で実行し、Analysis と Encoding の終了を独立に照合する。ローカル検証結果を検出精度の証明にしない。ブランチで実装・レビュー・PR を更新し、main への公開判断は残す。

## ローカルでの起動

管理者の認証済み npm 設定を使い、dev SDK を bitovp 本体とは別の場所へインストールする。`@bitmovin-internal:registry=https://bitmovin.jfrog.io/artifactory/api/npm/npm-local/` を scope 設定に使い、公開の依存パッケージは通常の registry から取得する。private registry の認証は `JFROG_NPM_TOKEN` の環境変数参照を持つ npm 設定で行い、token 値をコマンドやリポジトリへ保存しない。例えば次のように専用 prefix を指定する。

```sh
npm install --prefix /path/to/aisa-preview --ignore-scripts \
  @bitmovin-internal/api-sdk@1.288.0-develop.02b690c6
```

bitovp の server 環境（または repo root のローカル `.env`）で指定する:

```dotenv
BITOVP_AISA_LIVE_PREVIEW=true
BITOVP_AISA_LIVE_SDK_PATH=/path/to/aisa-preview/node_modules/@bitmovin-internal/api-sdk
```

既存の Bitmovin account を設定して `pnpm dev` で起動後、`/live/new` の通常設定から AISA を有効にする。SDK のパスは browser からは指定できない。container で使う場合は、その container から読み込める場所へ SDK と依存を配置する。通常の install/build には private SDK は不要。

実 SDK の送受信形式だけを確認する場合:

```sh
BITOVP_AISA_LIVE_SDK_PATH=/path/to/aisa-preview/node_modules/@bitmovin-internal/api-sdk \
  node scripts/aisa-live-sdk-contract.mjs
```

このスクリプトは合成応答の fake transport を使い、cloud Analysis を開始しない。SDK 共存、3 input 形式、非公開 ACL、bodyless start/stop、override の分離、最新結果と pending code を確認する。

本番 build 後は、同じ SDK の環境変数を指定して `node scripts/aisa-live-built-sdk-check.mjs` を実行できる。実際の生成 route を Turbopack runtime と依存で実行し、account store と HTTP だけを合成置換して native SDK の読み込みと SDK 不在時の 503 を確認する。通常の source 単体テストだけでは検出できない bundler の読み込み変更を検出する。
