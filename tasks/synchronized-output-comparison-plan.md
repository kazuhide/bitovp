---
type: spec
project: bitovp
created: 2026-11-16
status: implemented
tags: [bitovp, interbee, playback, qc]
---
# InterBEE 出力同期再生と QC 比較

## 目的・前提
同じ作品を処理した二つの出力を、再利用できる URL で左右再生する。計画時点の QC 比較は測定済みプレビューに限定され、HDR/SDR 混在時も統計・曲線を重ねていた。親担当は以下の範囲を承認済み。

## 構成と順序
1. playback-control: 既存 PlaybackSurface の再生エンジンと寿命管理を再利用する小さな制御口。
2. output-compare: /vod/compare?jobs=ID1,ID2。依存は playback-control と既存の認証付きエンコード詳細 API。
3. metric-scope: HDR/SDR 測定条件が混在した QC をレポート別の統計・曲線に分ける。独立した SDR 同士の比較は維持する。

## 受け入れ条件
- [x] 二つのローカル EncodingJob ID を URL に保持し、既存 apiFetch で読む。取得失敗・未完了・出力なしを表示する。
- [x] 共通の再生・停止・シーク。再生時刻の差が 150ms を超えたら追従側を補正する。フレーム精度や作品の開始点一致は保証しない。
- [x] 片側がバッファ中・シーク中なら両側を待機させる。エラー・終端・出力変更・破棄時は両側を停止し、遅い play 完了を無効化する。
- [x] 音声は左・右・消音から一つを選ぶ。選べる画質が公開された場合は 2160p を優先して固定し、未対応時は自動画質と明示する。
- [x] HDR/DV の表示は出力設定の表示である。端末の HDR 表示や Dolby Vision 動的メタデータ適用を成功扱いしない。
- [x] HDR/SDR が混在する QC には共通の平均表・分布・フレーム曲線・ビットレート品質曲線を作らない。

## 画面方針
既存の zinc 背景・境界・本文と emerald 操作色、amber 注意色、既存のサンセリフを使う。左右動画を主役にし、操作は一列。狭い画面では縦積み。説明は短い一行に抑える。新しい装飾・テーマ・依存を追加しない。

## 実装と検証
- [x] 制御口と同期協調の失敗テストを書き、再生待ち・競合・破棄を確認してから実装する。
- [x] URL・出力選択・片側音声・エラー表示、混在 QC の分離と SDR 維持をテストする。
- [x] rtk proxy pnpm --filter @bitovp/web test --maxWorkers=2
- [x] rtk proxy pnpm --filter @bitovp/web typecheck
- [x] rtk proxy pnpm --filter @bitovp/web build
- [x] Biome とソース識別情報を保存し、親担当の二系統レビューへ渡す。

## 統合結果

[PR #144](https://github.com/kazuhide/bitovp/pull/144) で2出力の同期再生と測定条件別の QC 比較を実装した。[Installed GUI](https://github.com/kazuhide/bitovp/actions/runs/43829369516/job/133170822700) では合成 HLS を再生して操作を確認した。実機での Dolby Vision 表示はこの検証の範囲外。[PR #145](https://github.com/kazuhide/bitovp/pull/145) で3出力にも対応した。

## 境界
新しいサーバー API、認証・テナント境界、測定方式、課金・プロバイダー操作を変更しない。元 main・HDR worktree・前の修正 worktree を保持する。デプロイ・merge・実ブラウザー認証操作は親担当が行う。

## 根拠
- https://github.com/Netflix/vmaf/blob/master/resource/doc/models_v1.md
- https://mailarchive.ietf.org/arch/msg/hls-interest/HG12eKhPSp4vlZy5Mqu_5d40ldw/
HDR モデルは HDR 同士の測定条件を持つ。Apple の 2026-10-13 説明では、macOS の DV 10.1 動的メタデータ適用は dormant とされる。形式のシグナリングから実表示を推定しない。
