# Bombadilの適用と実測

2026-11-18。公式Bombadil **0.7.10の実binary**を使い、実Reactコンポーネントの操作生成・property検査・旧実装での違反検出・trace再生を実行した。対象を `RenditionAddControls` に限定して採用する。アプリ全体の探索やInstalled GUIの代替ではない。

## 対象と独立した検査条件

`tests/bombadil/rendition-fixture.tsx` は製品の `RenditionAddControls`、実LocaleProvider、実Select/Button等をそのままbundleする。合成renditionの選択・キー重複・並べ替え・追加・リセットだけを提供し、ログイン、DB、worker、実利用者データ、providerを使わない。

`rendition.spec.ts` の公式custom action generatorをBombadil自身が実行する。実selectにchangeを送信し、実DOMのbuttonをclickする。独自乱数ループやPlaywright操作列でBombadilを代用していない。最初の5操作は各操作種への到達を保証する短いprefixで、その後はBombadilが操作順を生成する。

| Property | 独立した期待値 |
|---|---|
| `defaultCopySourceIsLast` | 未選択時はfixture入力の最後のrow。旧実装でDOM自体が最初のrowへ変わる不具合も検出する |
| `explicitSelectionIsNotRedirected` | change captureで記録した利用者の選択。unique keyの並べ替えと、衝突解消後の並べ替えでも保持する |
| `copiedSourceMatchesVisibleChoice` | Add click直前の実DOM optionラベルと、実onAdd callback indexで選ばれた合成rowの対応 |
| `eachAddHasOneReceipt` | DOM Add click数と、実onAdd callback receipt数の一致 |

キーが重複している間はpositionだけをidentityとして扱う。重複中の件数変更では最後のrowへ戻す既存仕様を検査し、曖昧なキーにも永続row identityがあるという契約を発明しない。component内部stateやuseEffectをoracleから読み取らない。

## 実測結果

macOS arm64 / Bombadil0.7.10 / Playwright1.64.1のChromium（Google Chrome for Testing156.0.8078.4）で実行した。時間はbrowser起動・bundle後のCLI stageの実測で、CI全job時間ではない。

| Stage | CLI exit | 実測 | 実trace操作数 | 結果 |
|---|---:|---:|---:|---|
| 修正後component | 0 | 30.056秒 | 1734 | property違反0 |
| 旧8d34064a component | 2 | 0.453秒 | 1 | `defaultCopySourceIsLast` 違反 |
| 同じ旧bundleで `--reproduce` | 2 | 0.509秒 | 1 | 同じproperty違反を実再現。分岐エラーなし |

正の実行ではselect963、collision191、rotate183、Add200、reset197を観測した。traceのDOM snapshotから、unique keyの選択を保持した並べ替え55回、collision解消後の選択を保持した並べ替え4回、曖昧な選択から件数変更後にdefaultへ戻る遷移49回も確認した。ready、20以上の実trace操作、各操作種・各遷移の非ゼロ件数、実onAdd到達をrunnerが必須にする。未ロードや0操作のexit0は合格にならない。

負の対照はGitの実在する旧componentを一時bundleへ読み込む。ローカル実測のcommit `8d34064a343337090118f5196d81c8349318b0f8`、component SHA256 `5a4eaf947b6d789a5132a85a93afe6e5c8474ac6841fc3e4b41f10ee42b42d69` を検証し、製品sourceを変更しない。継続CIでは、squash後もmain履歴に残る `8c8642a0332585e934461302df4ac91a55f9bb9e` を参照する。両commitのcomponent bytesと上記SHA256が一致することを確認済みで、削除可能な作業branchへの依存を避ける。重複キーへ変える1操作で「最後のコピー元」を「最初のコピー元」にしてしまう既知不具合を検出した。これは既知不具合に対する追加検出力の証拠であり、Bombadilが未知の製品不具合を新発見したとは扱わない。縮小コマンドは実行していない。

初回のoracleは重複中のAdd後にも選択保持を要求し、既存のdefault復帰仕様を誤って違反にした。実callbackは正しいrowを選んでいた。初回traceを保存して契約を修正し、このoracle不具合を製品バグに数えなかった。その後の30秒試行でも1704操作・旧実装検出・実再生が成立し、最終版で上表の実測を得た。検出できるまで同じ試験を無制限に反復する運用ではない。

## 再実行と証跡

既存依存関係が入ったcheckoutで、公式releaseの0.7.10 binaryを取得して次を実行する。runnerは実行前にbinary SHA256を検証する。

```sh
node --test scripts/bombadil-component.test.mjs
node scripts/bombadil-component.mjs --binary=/absolute/path/to/bombadil --output=/absolute/path/to/new-evidence-directory
```

別checkoutの既存node_modulesを読み取り専用で使う場合だけ `--dependencies=/absolute/path/to/checkout` を付ける。package/lock更新は不要。runnerは既存Vitest→Vite/esbuildからbundleし、既存Playwrightが指定する専用Chromium binaryを使う。

- macOS arm64 binary SHA256: `3d7866e2e8356390a0f2560853e3c775839f8c8ff648c9552c0105f7f78d1d72`
- Linux x86_64 binary SHA256: `6f2664ca7d4067017b4efb26db5c29d6dcfecdc78131f96989d336f12420cc1b`
- 修正後componentの実測SHA256: `a8d014e15b8d3817e014f9b3759fe847c966a2a66922bdf8f0d80be685d95f99`

出力先は新規directoryのみ。version、tool/browser/component/spec/fixture/lock/bundleのhash、実際のコマンド、終了理由、trace、callbackの観測値、再生結果を保存する。specとfixtureのsnapshotも保存し、3stageは同じspec、origin、viewport、browserで実行する。reproduceとtime-limit/exit-on-violationを同時指定せず、再生には独立した外側60秒timeoutを付ける。生成は各30秒、各CLI stageの外側上限は60秒。

各stageのChromiumは所有する一時profile・CDP・process groupで起動し、Bombadilは `browser test-external --create-target` で接続する。実利用者のbrowser/contextへ接続しない。子process環境はPATH/LANG/TMPDIR/NO_COLORだけを許可し、provider資格情報を引き継がない。serverはloopbackだけ、配信は合成HTML/bundleだけ、CSPで外部通信を許可しない。正常終了・失敗・signal中断とも所有process/server/tempだけをfinallyで終了・削除する。

## CIへの接続と限界

`.github/workflows/bombadil.yml` を独立した並列workflowとして追加した。既存CIやInstalled GUIを短縮・置換しない。既存quality jobには軽量なrunner契約テスト12件だけを追加する。

新workflowは固定Action、固定Linux CLI checksum、lockで固定されたPlaywright browserを使い、同じ3stageを実行する。アプリ全体のbuildは行わない。job上限8分、artifact保持7日。正の探索の大量screenshotsはCI artifactから除き、全trace・provenance・失敗/再生の合成screenshotsは残す。macOS最終試行の全証跡は約260MB規模で、主に毎stateのscreenshotsである。Linux workflowの所要時間・成功は、実CI完了をもって別途確認する。

30秒の有限探索は全入力や実アプリnavigationの正しさを証明しない。replayは公式にもbest effortとされるため、分岐・起動失敗・generic errorを指定propertyの検出成功に代用しない。このfixtureが検査するのはcomponentの選択とcallbackであり、VOD全体のconfig生成・submitやprovider処理ではない。3動画のmute排他は既存の確定的Installed GUI検査で確認する。

## 実インストールへの拡張

後続の[完了契約](./completion-contract.md)では、専用Chromiumに準備した1ページを `--create-target` なしで再利用し、認証済みcontextの通信制限を保つ。事前の合成実験では実Bombadil 0.7.10で231操作を実行し、同一originの禁止POSTと別originのPOSTを各231件遮断、各受信側への到達0件、対象page ID不変を確認した。これは接続方法の証拠であり、アプリ動作の合格ではない。

Installed GUIの必須ケースに、VODの編集、コピー元選択、コピー追加、削除、画面往復を生成する探索を追加した。意図した可視値と実画面・Plan JSONを照合し、操作の未到達を拒否する。意図的な操作先変更を同じ性質で検出して再生する対照は、過去の自然発生不具合を用いる部品検査とは別に記録する。実行時間・合否は確定したsourceのCI結果で判断する。

対照・再生の受理は生の違反名集合を比較する。未知名や、この対照で想定しない既知名の混在を捨てて合格にはしない。シンボリックリンク経由の起動でもCLI検証を必ず実行する。

## 一次資料

- [公式0.7.10 release](https://github.com/antithesishq/bombadil/releases/tag/v0.7.10)
- [Extractors](https://antithesishq.github.io/bombadil/browser/3.4.2-extractors.html) / [action generators](https://antithesishq.github.io/bombadil/browser/3.4.4-action-generators.html) / [custom actions](https://antithesishq.github.io/bombadil/browser/3.5-custom-actions.html)
- [外部browser接続](https://antithesishq.github.io/bombadil/browser/5.1.2-bombadil-browser-test-external.html) / [再生](https://antithesishq.github.io/bombadil/browser/4.1-reproducing-violations.html)
- [公式Chromium起動・cleanup実装](https://github.com/antithesishq/bombadil/blob/v0.7.10/lib/bombadil-browser/src/chromium.rs)

レビュー後のrunner補強では、readyを一度観測した後は、終端を含む全snapshotにreadyなstateがちょうど1個あることを必須にした。初期ロード前のprefixだけを許容し、途中で消失してから復帰したtraceも拒否する。十分な操作数を持つtraceで5種類の消失・重複条件を旧判定が見逃すREDを保存し、修正後のGREENと既存1734操作traceの再判定を確認した。これはrunnerの検出漏れ修正であり、製品の新規不具合とは数えない。

LinuxではUbuntu AppArmorによる起動失敗を避けるため、専用の合成loopback fixture browserだけに `--no-sandbox` を付ける。macOSには付けない。Linuxの実browser動作はCIで別途確認する。終了処理はleaderの終了状態に関係なく所有process groupへsignalを送り、leader終了後も残る子processを実際に起動した回帰テストで検査する。各stageのCLI終了時にもgroupを回収する。
