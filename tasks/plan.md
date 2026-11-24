---
type: plan
project: BitOVP
created: 2026-11-17
status: implemented
tags: [bitovp, harness, verification, astro-review]
---

# 検証ハーネスとQC実行制御の改善

QC 実行制御は [PR #152](https://github.com/kazuhide/bitovp/pull/152)、検証ハーネスと CI は [PR #153](https://github.com/kazuhide/bitovp/pull/153) で main に統合した。[実測と照合結果](./todo.md)を参照。

## 目的と根拠

Lauren Tan の講演と pstack の設計を参考に、既存検査を毎回探索し直す時間を減らし、検査不足や実行未完了を成功と誤認しない仕組みを実装する。今回の失敗は検査ツールの不在だけではなく、準備中の業務queue停止、実行経路を踏まえない並列化、未計測の完了予告、LOCAL QCの中止経路不足による。Lintだけではこれら全体を解決できない。

設計基準は main `da31b866166763fda126dcc1cd6ec858d3ab42ce`。Astroの独立レビュー2系統で、既存のBiome/型検査/Vitest/Playwright、skip監査、実FFmpeg/Redis/PostgreSQL検査、lease/supervisor、verifyのresource intentを確認した。これらを再利用する。PR151で修正済みのdecoder割当は再実装しない。

ユーザーは2026-11-17に設計、実装、検証、mainへのマージを承認。本番反映、課金計測、停止済みMeridianの再開はこの変更に含まない。

## 決定

1. **短い検証経路**：固定feature registryと薄いCLIを追加する。任意shell、動的に選んだテスト集合、合格数の自動追認は受け付けない。既存runnerの起動・中断・report検査を再利用する。
2. **正しいreadiness**：doctorは選んだfeatureの前提を読み取り専用で確認する。既存 `verify preflight` は報告コマンドでありexit 0でもcapability不足があり得る。終了コードをそのまま実行可能と解釈しない。
3. **実行と証跡**：runは有限の予算を持ち、期待したsuite/件数と実結果を照合する。欠落、skip、todo、blocked、timeout、中断、cleanup未確認は成功にしない。子がexit 0だけでも成功にしない。
4. **LOCAL中止**：既存VOD cancel API、ERROR状態、WorkerのAbortSignalを接続する。中止受理と停止確認を混同しない。完了更新はRUNNINGを条件とし、中止との競合でFINISHEDへ上書きしない。
5. **任意期限**：LOCAL実行に `execution.deadlineAt` を追加する。timezone付きの有限なISO日時。省略時は従来どおり。queue待ち・再試行で期限を延長しない。期限超過はERROR/未完了であり完了時刻の保証ではない。
6. **速度の証拠**：割当threads・並列許容量は速度の証明にしない。ハーネスは実行時間を記録する。実測していない全尺QCのETAやAV1の優位性を生成しない。比較条件・全フレームcoverageの既存検査を維持する。

## A: Feature検証入口（独立PR）

### 構成

- `scripts/feature-verification-registry.mjs`：固定ID、検証範囲、workspace、suite、期待件数、最大実行時間、前提。
- `scripts/feature-verification.mjs`：list / doctor / run。既存 `media-smoke.command` とreport検証を利用。
- `scripts/feature-verification.test.mjs`：負例、実CLI、実小規模childのtimeout/中断、所有物保持。
- `docs/verification/features.md`：利用者の機能と検査範囲の対応。実行仕様の正本はregistry。
- package scripts、Biome対象、常時実行CIに接続する。

初期の安価な検査は `qc-resource-allocation`（resource-plan / banding-resources）、`qc-measurement-validity`（HDR / alignment）、`qc-runtime-safety`（admission abort / supervisor lifetime）の3つ。scopeは `unit-contract` と明記する。これらの合格をUI、実GPU、provider、本番の証拠として表示しない。実画面の証拠は既存installed GUI CIが担い、feature mapにその利用経路と必要環境を明記する。

### CLIと証跡

- `list` は検査範囲、suite、前提、環境、副作用を表示する。
- `doctor <id>` は前提不足を非ゼロにする。install、アプリ起動、課金、復旧、cleanを暗黙実行しない。
- `run <id> --output <new-directory>` は新規出力先を排他的に確保し、一つの固定featureだけを実行する。任意のargvを受け付けない。
- provider credentialを引き継がない既存の環境allowlistを利用し、CI/allowOnlyを明示する。
- 最初はincomplete receiptを置く。source SHAと作業差分identity、feature/registry identity、実行範囲、期待/実行件数、時刻・所要時間、結果と理由、report digest、cleanup結果を残す。秘密を含むraw logは公開しない。
- SIGINT/TERM、timeoutは所有する子だけを止め、終了確認後に結果を確定する。証跡はcleanupで削除しない。未確認の所有物が残れば成功にしない。
- source/registryが実行中に変わった場合はその証拠を合格として再利用しない。

### 合否条件

1. 正常なfeatureで固定対象が全件実行・合格し、cleanup後にも結果が残る。
2. 未知ID、空選択、前提不足、欠落/重複/skip/todoを含むreport、古いreport、timeout、中断は非成功。失敗理由を固定IDで確認する。
3. 意図的に壊した検証対象を検知する負例を持つ。構文エラーや起動失敗だけを「検査が効いた」証拠にしない。既存required CIを弱めず、新runnerの検査も常時実行される。

## B: LOCAL QC中止と期限（独立PR）

### 中止

- tenant/RBACとfeature flagは既存経路を使う。VODのLOCAL（旧データのexecution省略を含む）とCLOUDを対象とする。LIVEは既存の専用lifecycleを維持する。
- PENDING/RUNNINGからERRORへの条件付き更新で中止要求を永続化する。params全体の上書きによる中止flag保存は行わない。
- terminalに対する要求はidempotentで、既存FINISHEDやERRORを上書きしない。
- Workerが中止を観測した後は新たなmedia処理を起動せず、進行中の処理へabortを伝える。HTTP受理直後から物理的spawnを完全禁止するACKプロトコルは導入しない。
- 結果保存とterminal更新を中止・所有権と整合させる。測定済みpartial resultsは保持する。停止時もBLOCK_MANIFESTSの待機を取り残さない。
- retryは既存queue active/lock確認を守り、停止前の旧attemptと重ねない。supervisor未使用経路に親死亡・全process tree保証があると表示しない。

### 期限

- `vmafExecutionSchema` のLOCAL側に任意 `deadlineAt`。CLOUDは既存profileのtimeout/budgetを維持する。
- claim時に絶対期限を確認し、期限切れならmedia起動0。admission待ちから実行・結果保存まで同じ期限に基づくsignalを伝える。
- Node timerの上限を超える日時を誤って即時timeoutにしない。timer/listenerはfinallyで解除する。
- worker停止中にqueue上のrowが期限ちょうどに更新される保証はない。worker再開時に期限切れを拒否する。expired retryは409とし、暗黙の期限延長はしない。
- 期限超過でも子の終了前にleaseを解放しない。強制停止やcleanupが未確認ならその事実を残し、clean/successへ変換しない。

### 合否条件

1. admission待ち、spawn境界、結果保存直前の中止をfixtureで再現し、中止観測後の起動、FINISHEDの上書き、blocking gateの取り残しを検出する。
2. 期限切れqueue、admission中の期限、実行中の期限、期限省略、invalid日時、expired retryを検査する。停止とlease解放の順序を確認する。
3. API権限、terminal idempotency、既存cloud/LIVEの挙動を保ち、実小規模childの停止検査と既存GUI検査で操作経路を確認する。

## 実装順とレビュー

### 追加の受入条件：品質を保った高速な開発サイクル

ユーザーの追加指定により、局所検査とPR全体の両方を改善対象とする。ツールの設置だけでは完了にしない。

- 局所検査は同じsource/環境/suite/件数/2workersで直接実行とハーネスを各3回交互に測る。依存導入済み開発Macで各feature中央値10秒以下、追加overhead中央値1秒以下を初期基準とする。件数・assertionを削って達成しない。実際のdecoder割当を誤動作へ戻すsemantic negativeを既存2回帰で検出する。
- main `da31b866` のWeb CIは907秒、Installed GUIは1292秒。後者の1085秒はDockerビルドで、実ブラウザー12ケースは約63秒だった。並列jobの時間は加算しない。CIの待ち時間も今回改善し、残課題として繰り延べない。
- Web全件の分割実行は、全shardの成功だけでなく全ファイルの重複・欠落のない合流と既存skip監査を必須にする。必須context名は維持し、shard欠落・失敗・cancelを合格にしない。
- HDR用FFmpegはsource-buildの重複とキャッシュ対象漏れを修正する。source/model/patchの対応、キャッシュ内容の完全性、毎回の実行検証を守り、古い検証receiptを成功証拠として使わない。cold/warmを区別して測り、既存の完全source-build検査を維持する。
- 具体的なCI変更は内訳計測と独立Astro設計レビューを経て実装する。変更前後の実GitHub CI時間・件数を照合し、改善を確認したものだけをmainへマージする。

AとBは別worktree/branchで並列実装し、各々テスト→PR→foreground codex-rescueと独立Codex agent review→修正→CI green→squash merge。二つのPRを合流後、final mainのtreeと対象checksを読み戻す。既存PR148/149のrestackや本番deployを暗黙に追加しない。

局所の変更では対象テストを使い、PRでは既存必須CIを満たす。毎編集で全release gateや高負荷media suiteを繰り返さない。作業Macで全尺QCやエンコードは行わない。

## 適用範囲と今後の条件

初期実装では新scheduler、別resource台帳、pause service、汎用デプロイツールを作らない。準備作業のため業務queueを止める必要はない。将来pauseを自動化する変更が必要ならowner/期限/build整合性のある切替だけを独立設計し、期限経過だけで不明なbuildを再開させない。

Bombadilは操作順依存のUI不具合、TLA+はlease/retryの小さい並行状態、Leanは実装に対応づけられる計算性質に具体的な未解決対象がある場合に選ぶ。初期実装の成立を待たせる必須依存にはしない。モデル/driver/assertionが誤っていれば検査は誤るため、負例・独立レビュー・実際の利用経路を併用する。

ユーザーの追加依頼に基づき、[Bombadilの適用判断](../docs/verification/bombadil-evaluation.md)を作成した。3本比較の実DOMと操作順を優先対象とし、既存fixtureへのCDP接続、違反canary、replay、探索/cleanup予算を導入条件とする。この依頼は検討であり、評価未実施のPoCやランダム探索を必須CIへ自動追加したものではない。

## 一次資料

- [講演の公式字幕](https://ai.engineer/api/data/transcript?format=json&slug=youtube-87dd31e7fa6155e8455b)
- [pstack create-verification-skill](https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/skills/create-verification-skill/SKILL.md)
- [pstack create-formal-verification-skill](https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/skills/create-formal-verification-skill/SKILL.md)

公開pstackには手順書と実行コードが混在する。導入しただけで上記契約が強制されるという前提は置かない。
