---
type: spec
project: bitovp
created: 2026-11-07
status: preview
tags: [aisa, live, preview]
---

# AISA Live Preview

既存の Live 作成画面 `/live/new` に Preview モードを追加し、デモが使う AISA Live 専用 API で作成・開始・停止・key moments 取得を行う。既存の通常 Live の plan/compiler/worker 経路は維持する。専用 API が backing Encoding を作成するため、このモードは通常 Live の任意ラダー・DRM・ESAM の設定を継承しない。

ユーザーから共有された現在の key moments 対象はサッカー（football）、テニス、アメリカンフットボール。画面の Preview 説明と結果ゼロ件の説明に明記する。対象でも必ず検出されるとは約束せず、未知の category を除外しない。将来の分類拡張を妨げる入力 enum としてスポーツ種別を API へ送らない。

## 実装方針

- 本流は公開 `@bitmovin/api-sdk@1.287.0` を維持する。
- Preview は `@bitmovin-internal/api-sdk@1.288.0-develop.02b690c6` の専用クライアントを使う。private registry 依存を通常 install に追加せず、管理者が別途インストールしたパッケージを server の `BITOVP_AISA_LIVE_SDK_PATH` で指定する。未指定時は通常の Node 解決を試す。版の不一致または未インストールは明示的な 503 とする。
- `BITOVP_AISA_LIVE_PREVIEW=true` のときだけ UI/API を公開する。既定は無効。API 側でも gate を評価する。
- AICA の organization-scoped Analysis resource を永続状態の正とし、既存の保存済み Bitmovin account を使って一覧・詳細を再取得する。DB migration は不要。API key は server の account store からだけ取得する。
- GET は VIEWER、create/start/stop は OPERATOR 以上。stream key を含む ingest は専用 GET endpoint を OPERATOR 以上に限定する。list/detail/results は ingest と任意の upstream field を返さない。
- 録画と解析の両 Output に `PRIVATE` ACL を明示する。ACL 非対応 Output や bucket policy の設定まで非公開を保証するものではない。
- 新しい API は既存の proxy、tenant/expected-org 認証、監査方式を使う。signed HLS URL、stream key、API key、raw SDK error はログや監査に残さない。
- create と start/stop は別操作。副作用を自動再試行せず、応答不明なら一覧/詳細の再取得で確認する。Start は CREATED、Stop は QUEUED/RUNNING から許可する。
- Encoding と Analysis の終了、final snapshot の有無を別々に表示する。RUNNING はメディア受信や key moments 検出の証拠としない。

## 機能と API

`/live` から Preview 一覧へ、`/live/new?mode=aisa-preview` から専用フォームへ移動できる。既存 deep link、複製、通常の作成動作を保持する。

| API | 内容 |
|---|---|
| GET `/api/live/analyses?bitmovinAccountId=...&offset=0&limit=25` | account 内の Analysis 一覧（最大100件/ページ） |
| POST `/api/live/analyses` | `{bitmovinAccountId, analysis}` を検証して作成 |
| GET `/api/live/analyses/[analysisId]?bitmovinAccountId=...` | ingest を含まない詳細 |
| POST `/api/live/analyses/[analysisId]/actions` | `{bitmovinAccountId, action: start/stop, esVersion?, aicaVersion?}`。override は start のみ |
| GET `/api/live/analyses/[analysisId]/ingest?bitmovinAccountId=...` | OPERATOR 向け RTMP/SRT 接続情報 |
| GET `/api/live/analyses/[analysisId]/results?bitmovinAccountId=...` | `{availability: available, snapshot}` または `{availability: pending}` |

作成の `analysis` は `name`、`input`（RTMP streamKey、HLS url、既存 Input の REFERENCE inputId と任意 streamKey）、任意 `cloudRegion`/`encoderVersion`、`recording.outputs`、`outputs`。Output は既存 Encoding Output の `outputId` と `outputPath` を指定し、inline credential resource は受け付けない。HLS は ongoing playlist と PDT mapping が必要。`encoderVersion` の空欄は省略、ES/AICA override は Start 時の header として分ける。

共通 client contract は `apps/web/src/lib/aisa-live/contracts.ts`。公開型は `AisaAnalysis`、`AisaAnalysisPage`、`AisaCreateBody`、`AisaActionBody`、`AisaResultSnapshot`、`AisaResultsResponse`、`AisaIngest`。schema は `aisaCreateBodySchema`、`aisaActionBodySchema`、`aisaAnalysisSchema`、`aisaResultSchema`、`aisaIngestSchema`。typed schema parse で upstream の余剰 field を削除する。

`AisaAnalysis` は `{analysisId, encodingId, status, name?, createdAt?, inputId?}`。
`AisaIngest` は `{rtmpIngest?: {encoderIp, streamKey, application?}, srtIngest?: {mode: LISTENER, encoderIp, port}}`。
`AisaResultSnapshot` は pinned SDK の累積結果と同じ公開 field を持つ。省略の observations/keyMoments/sourceGaps は空配列へ正規化する。

`apps/web/src/lib/aisa-live/snapshots.ts` の `applyAisaSnapshot(previous, snapshot)` は新旧 snapshot を比較し、採用可能な snapshot を返す。古い/同一 sequence は前回値を保持し、identity、media origin、coverage、finality、観測の不変性と moment revision の違反は拒否する。withdrawal の ID 再利用を見落とさないため必要な履歴は reducer state に保持する（具体型は実装で定義）。UI は不正な更新や poll 失敗時も最後の正しい結果を保持する。

SDK adapter は `apps/web/src/lib/server/aisa-live-sdk.ts`。`aisaLivePreviewEnabled()` と `aisaLiveClientForAccount(ctx, accountId, versions?)` を公開し、account 不在は null、それ以外は `list/create/get/start/stop/latest` を備えるクライアントを返す。methods の返値は unknown とし、route 境界で schema parse する。SDK error を public-safe な専用 error に変換し、raw error を caller に渡さない。結果未生成は専用 code `LIVE_ANALYSIS_RESULT_NOT_AVAILABLE` だけを pending とする。

## 検証

- Vitest: 入力検証、未知 field 削除、sports 制限の説明、snapshot 撤回/改訂/identity/finality、gate、tenant account、ingest role、action state と audit の秘密除外。
- 実 dev SDK と fake transport で create/start/stop/latest の request/response を確認する。外部ネットワークには接続しない。
- UI の作成・一覧・詳細・pending/empty/error・read-only を component tests とブラウザで確認する。
- 既存 Live 作成、権限/route coverage、i18n、SDK externalization、typecheck/build を実行する。
- `rtk proxy pnpm --filter @bitovp/web exec vitest run <変更に対応するtest>`。
- `rtk proxy pnpm --filter @bitovp/web typecheck`。
- `rtk proxy pnpm --filter @bitovp/web build`。
- `rtk proxy pnpm exec biome check --error-on-warnings <変更ファイル>`。

デモリポジトリは read-only。実クラウドの開始・停止・費用発生を伴う試験はこの実装検証に含めない。ローカル検証結果を実サービスの対応・検出精度の証明にしない。ブランチで実装・レビュー・PR を作成し、Preview を本流へ公開する判断は残す。

## ローカルでの起動

管理者の認証済み npm 設定を使い、dev SDK を bitovp 本体とは別の場所へインストールする。例えば次のように専用 prefix を指定する。private registry の認証はデモと同じ `JFROG_NPM_TOKEN` の環境変数参照を持つ npm 設定で行い、token 値をコマンドやリポジトリへ保存しない。

```sh
npm install --prefix /path/to/aisa-preview --ignore-scripts \
  --registry=https://bitmovin.jfrog.io/artifactory/api/npm/npm-local/ \
  @bitmovin-internal/api-sdk@1.288.0-develop.02b690c6
```

bitovp の server 環境（または repo root のローカル `.env`）で指定する:

```dotenv
BITOVP_AISA_LIVE_PREVIEW=true
BITOVP_AISA_LIVE_SDK_PATH=/path/to/aisa-preview/node_modules/@bitmovin-internal/api-sdk
```

既存の Bitmovin account を設定して `pnpm dev` で起動後、`/live/new?mode=aisa-preview` を開く。SDK のパスは browser からは指定できない。container で使う場合は、その container から読み込める場所へ SDK と依存を配置する。通常の install/build には private SDK は不要。

実 SDK の送受信形式だけを確認する場合:

```sh
BITOVP_AISA_LIVE_SDK_PATH=/path/to/aisa-preview/node_modules/@bitmovin-internal/api-sdk \
  node scripts/aisa-live-sdk-contract.mjs
```

このスクリプトは合成応答の fake transport を使い、cloud Analysis を開始しない。SDK 共存、3 input 形式、非公開 ACL、bodyless start/stop、override の分離、最新結果と pending code を確認する。

本番 build 後は、同じ SDK の環境変数を指定して `node scripts/aisa-live-built-sdk-check.mjs` を実行できる。実際の生成 route を Turbopack runtime と依存で実行し、account store と HTTP だけを合成置換して native SDK の読み込みと SDK 不在時の 503 を確認する。通常の source 単体テストだけでは検出できない bundler の読み込み変更を検出する。
