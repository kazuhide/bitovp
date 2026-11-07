---
type: spec
project: bitovp
created: 2026-11-08
status: in-progress
tags: [qc, banding, playback]
---

# CAMBI検出区間の映像確認

## 目的と完了条件

CAMBIの影響区間から、測定した対象renditionの映像を確認できるようにする。区間を選ぶと開始位置へ移動し、再生後は終了位置で停止する。別の区間への切り替え、再再生、閉じる操作を提供する。banding-onlyとVMAF併用の両レポートを対象とする。

- banding-onlyでは参照動画、VMAFモデル、平均FPSを要求しない。
- 測定対象のstorage objectとversionに束縛した既存の認証付きpreviewを使う。VIEWER/組織境界とexpectedOrganizationIdを維持する。
- 実PTSから保存済みの区間秒数を使い、VFRや測定の空白を平均FPSで埋めない。ブラウザの最初の動画フレームのmediaTimeを時刻原点に使う。正確なフレーム一致は約束しない。
- 再生器は同時に1本。切り替え・閉じる・unmount・非同期playの遅延完了時も古い再生を止める。区間外へのseekを制限し、終了はexclusiveとして扱う。
- 読み込み中・読み取り不能・ブラウザが動画時刻を確認できない状態を明示する。動画がなくても既存のスコア・グラフ・区間表は保持する。

## 実装の境界

既存のVMAFフレーム比較は変更しない。BandingResultDataにbanding専用の安全なpreview descriptorを加え、既存preview endpointへmetric=bandingを明示する。共通の測定対象解決処理を再利用し、VMAF側のFPS条件は維持する。外部URLの任意proxy、credentialsの公開、provider write、DB schema変更、新しい依存は追加しない。

bandingの対象は保存済みparams.sourceに従い、ワーカーと同じenumerateBandingTargetsで列挙する。QC_MIRRORは参照解決を要求せず、OUTPUT_MP4は一意な暗号化されていないMP4出力を使う。ソースがない過去の自動測定はQC_MIRRORとして扱い、未知のソースは拒否する。主出力のMIMEはcanonicalなMP4構成から決め、filenameの拡張子に依存しない。出力、完全path、保存版とbyte数の照合は維持する。

UIは現在のButton・色・間隔・i18nを使い、区間表の操作はbuttonとしてキーボードから使えるようにする。320/768/1024/1440pxで操作と説明が読めることを確認する。

## 構成と実装順

1. server/vmaf-previewとpreview routeで時間ベースの対象解決を追加し、banding-only/併用のDTOに公開する。
2. banding専用の区間プレイヤーと区間表の選択操作を追加する。
3. 単体・境界・再生競合のテスト、実動画でのブラウザ確認、ガイドとCHANGELOG、API censusを更新する。

対象: apps/web/src/lib/server/vmaf-preview.ts、app/api/vmaf-jobs/[id]、app/qc/[id]、qc/vmaf-shared.ts、lib/i18n/messages。実装は既存のTypeScript strict型、named export、tabインデントに合わせる。例えば区間型は PublicBandingAssessment["ranges"][number] から導出し、型の複製を避ける。

## 検証

- 対象テスト: rtk proxy pnpm --filter @bitovp/web exec vitest run src/lib/server/vmaf-preview.test.ts 'src/app/api/vmaf-jobs/[id]/route.test.ts' 'src/app/api/vmaf-jobs/[id]/preview/route.test.ts' 'src/app/qc/[id]/banding-panel.test.tsx' 'src/app/qc/[id]/banding-interval-player.test.tsx' --maxWorkers=2
- 型: rtk proxy pnpm --filter @bitovp/web typecheck
- build: rtk proxy pnpm build
- 整形: rtk proxy pnpm check
- census/配布条件: rtk proxy pnpm test:api-coverage および rtk proxy pnpm test:release-gates
- 実ブラウザ: 所有するloopbackの検証serverと実動画fixtureで区間開始・末尾停止・再再生・切り替え・閉じる・各幅・consoleを確認する。既存の稼働サービスや顧客DBを使わない。

単体テストはno-FPS、exact object/version binding、query検証、legacy VMAF条件、VFRの非整数区間、遅延play、unmount、再生不能時の診断保持を扱う。実動画検証はlocal mediaとブラウザの証拠であり、provider処理や機器全般の検証とはしない。

未解決の要件はない。既存の優先順位提案の完了条件と利用者の「3/5を対応」に基づく実装範囲である。

## 時刻の根拠

[HTMLのmedia timeline](https://html.spec.whatwg.org/multipage/media.html#media-timeline)では、currentTimeは媒体の時間軸上の位置であり、原点が常にゼロとは限らない。[Video Frame Callback仕様](https://wicg.github.io/video-rvfc/)のmediaTimeはその時間軸上の提示フレームのPTSである。CAMBIは最初のdecoded video PTSから相対秒数を保存するため、プレイヤーはsource設定前にcallbackを登録し、初回の提示フレームでmediaTimeを確認してから区間へseekする。初回を取り逃がした場合、10秒以内に確認できない場合、未対応ブラウザでは原点を推測しない。

この対応付けは同じobject/versionの最初のvideo presentationを前提とする。callbackはUIのmain threadと同じ速度で完了する保証がなく、区間末尾のpauseやseekはブラウザの精度に従う。実動画による検証範囲を別途記録する。

ブラウザが最初に返すdurationは、ファイル末尾を読む際に増える場合がある。最初のdurationだけで区間末尾を拒否せず、seek後の実位置とduration更新を確認する。仮の長さでseekが短く制限された場合は、更新後に開始位置へのseekを再試行する。10秒以内に開始位置を確認できない場合や、区間末尾より前に実EOFへ到達した場合は再生不能として示し、区間の再生完了とは扱わない。
