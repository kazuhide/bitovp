# Bombadilの適用判断

2026-11-17。公式Manual 0.7.10、公式GitHub Action、BitOVPの既存browser fixtureを静的に確認した。今回は適用設計まで。Bombadilによる実アプリ探索・再生・縮小は未実行で、常時必須CIへ導入済みとは扱わない。

## 採用候補と検査対象

Bombadilは実DOMの状態を取り出し、操作を生成しながらpropertyを検査する。固定手順のPlaywrightが既知の不具合を再現する役割に加え、操作順序で現れる不具合の探索に使う。

初期候補は3本の出力比較プレーヤー。`tests/browser/output-comparison-fixture.ts` は既に3本の合成HLSと実プレーヤーを使い、private/user dataを含まない。音声の素材自体は無音なので、可聴音ではなくmute選択状態の検査である。

| Property | 操作候補 | 合否の境界 |
|---|---|---|
| 同時に非mutedとなる比較videoは最大1つ | 音声選択、再生/停止、品質切替、同一画面の再読込 | `video.muted`を実DOMから取得。ボタン選択表示だけで推測しない |
| 試験対象の比較画面と3本のvideoが観測される | 準備完了後の比較操作 | 未ロード/未ログイン/0 actionsを合格にしない。ready確認・実action数・到達状態を別のcoverage条件にする |
| 比較条件の異なるHDR/SDRを同一品質順位と誤表示しない | レポート選択・表示切替 | 既存measurement contextと表示を照合。AV1が必ずH.264より高得点というpropertyは設定しない |

中止/再試行のUIも候補だが、画面にERRORが見えただけではworker停止を証明できない。attempt identityを固定してAPI/workerの証跡と組み合わせる必要がある。lease更新、停止後の容量再割当などは既存の制御可能なworker/Redisテストを主に使う。

## 既存ハーネスとの接続

現fixtureはPlaywrightのroute interceptionで合成API/mediaを提供するため、別の新規ブラウザーでURLを開くだけでは同じfixtureにならない。

PoCは既存fixtureが所有する専用ChromiumのCDPへ `browser test-external --remote-debugger` で接続する案を優先する。同じpage/contextを指定でき、interceptionとログイン状態が維持されることを最初に実証する。この間の操作主体はBombadil一つにし、Playwrightは準備と検証・後片付けを担当する。もし同じtargetへの接続を保証できなければ、その時点でPoCをblockedとして記録する。

origin/allow-urlは専用loopbackの対象画面だけ。既定の全ページ探索をそのまま輸入せず、比較操作だけを生成する。ネットワークは既存の非課金fixture境界で制限する。`allow-url`はnavigation境界であり、外部通信や課金防止そのものの保証として使わない。

## 小さなPoCの合格条件

1. 固定バージョンと専用ブラウザーで、対象画面のready、実action数、property評価、trace保存を確認する。観測が0件なら不合格。
2. 一時fixtureで2本を非mutedにする違反を注入し、意図したproperty名で違反を検出する。起動失敗や汎用console errorで代用しない。元のfixtureへ戻したrunも確認する。
3. 同じアプリrevision、初期データ、spec、viewport、tool/browser版でtraceを再生する。再現が分岐したらinconclusive/errorとして残す。
4. 所有するbrowser/server/fixtureを終了し、trace/必要な合成画面だけを保存する。実ユーザーのcookie、画面、署名URLをartifactへ入れない。

PoCの探索は30〜60秒の固定予算から始め、別の外側timeoutとcleanup予算を持つ。これは性能保証ではなく実験上限。再現・縮小は別予算にし、同じ失敗を無制限に繰り返さない。導入判断は実測の時間、再現率、偽陽性、追加の検出例を見て行う。

## バージョン・CI・再現性

- Manual確認版は0.7.10。Action v3は0.7.x向けだがdefaultは0.7.3と記載されている。採用時はCLIのversionとAction commitを固定する。Manualの導入例にあるv2をそのままコピーしない。
- CLIは時間上限付きtestと `--reproduce` を同時指定できない。reproduceには外側のtimeoutを使う。
- exit 0は探索範囲で違反を観測しなかったという意味。exit 2はproperty違反、その他は実行エラー。未観測の性質や全入力の正しさを証明しない。
- reproduceはbest effortで、分岐するとエラーになる。shrinkもexperimentalであり最小反例を常に得られるとは限らない。
- 発見した不具合は可能な限り小さい固定Playwright/worker回帰テストへ移す。ランダム探索をPRの唯一の合否基準にしない。
- 初期PoCは現在の必須CIを置き換えない。安定した時間・証跡・再現経路が成立してから対象を限定したCIへ接続する。
- heap増加の閾値はGCで揺れるため、根拠なく5MB等をコピーしない。リーク検査は必要な場合にDOM/listenerのbaselineを計測してから追加する。

## 一次資料

- [公式リポジトリ](https://github.com/antithesishq/bombadil)
- [仕組み](https://antithesishq.github.io/bombadil/browser/1.2-how-it-works.html)
- [Extractors](https://antithesishq.github.io/bombadil/browser/3.4.2-extractors.html)
- [Action generators](https://antithesishq.github.io/bombadil/browser/3.4.4-action-generators.html)
- [外部ブラウザー接続](https://antithesishq.github.io/bombadil/browser/5.1.2-bombadil-browser-test-external.html)
- [再現](https://antithesishq.github.io/bombadil/browser/4.1-reproducing-violations.html)・[縮小](https://antithesishq.github.io/bombadil/browser/4.2-shrinking-violations.html)
- [公式Action](https://github.com/antithesishq/bombadil-action)
