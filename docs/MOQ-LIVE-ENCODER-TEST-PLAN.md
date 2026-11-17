# MoQ Live Encoder 実通信検証 — 実装計画

作成日: 2026-11-17。対象: BitOVP の検証ブランチ。

## 目的

公開文書の draft 16／18 と実際の最新版 Live Encoder の挙動が一致するか、
BitOVP 自身の Live 作成・Worker・停止経路を使って検証する。
Python の ALPN 試験を実 Encoder の接続試験の代わりにはしない。

ユーザーは有料 Live 起動と映像送信を許可済み。必要機能は先に BitOVP に実装する。
ブランチでの検証に留め、main へのマージ・リリースは今回の対象に含めない。

## 実装契約

- 資格情報 provider `MOQ` を追加。暗号化する secret は `relayUrl`、任意の
  `authToken` と `authTokenType`。token type は token がある場合のみ許可する。
- URL は `moqt://`、userinfo・query・fragment を禁止する。秘密は plan／audit／エラーに出さない。
- plan output は `kind: MOQ`、既存の `credentialId`、`trackNamespace`（1〜32要素）、
  `draftVersion: DRAFT_16 | DRAFT_18`、name を持つ。SDK 型外の draft を型偽装して送らない。
- MoQ は Live 専用、専用出力、H.264／AAC、rendition ごとの FMP4 のみ。
  storage mirror、DRM、SCTE-35、通常の manifest は受け付けない。
- 既存の compile → operation → Worker SDK → audit の経路に
  `CREATE_OUTPUT_MOQ` を追加する。再開・停止・診断・tenant 認可を迂回しない。
- 通常の Live API／expert JSON から作成できるようにする。
  接続が成立した場合の Player Web X 再生は次の段階とし、既存 Player 8 に MoQ URL を渡さない。

## 実装順序

1. 資格情報 schema／migration と Live plan schema／validation／compiler のテストを先に追加。
2. Worker SDK の実 wire body、秘密の除外、credential provider 確認、操作 dispatch をテストして実装。
3. Web の既存資格情報管理・Live import／API／表示を対応させ、typecheck と build を確認。
4. 分割パネルで Codex Rescue と agent team の独立レビューを実行し、指摘を修正。
5. ブランチの Web／Worker を既存稼働状態と区別して起動し、アプリ経由で実試験。

## 試験と合格条件

- 実行する最新版の release／BETA の解決結果と実 Encoder version を API readback で記録。
- 原則1映像＋1音声、短時間、自作テスト映像、専用 namespace と owned channel を使用。
- 時雨堂公開先に対し、まず文書上の `DRAFT_18` 設定で開始し、必要なら16と比較する。
- 実際の Encoder 接続結果、MoQT SETUP／認可／配信を区別して記録する。
  Beta 未有効化や起動前の API 拒否は「接続互換なし」の根拠にしない。
- 必要であれば owned Relay で TLS ALPN を記録するが、アプリの Encoder 出力先として設定する。
- アカウント・token 不足が判明した場合は、完了していない段階と実エラーを明記する。
- 全ての owned Live は finally 相当で停止し、provider 停止 readback を確認する。
  他の channel／Worker／ユーザーの画面は変更しない。

## 検証コマンド

既存の pnpm workspace／Vitest／TypeScript を使う。新規外部依存は追加しない。

```sh
rtk proxy pnpm --filter @bitovp/core exec vitest run src/live/moq-output.test.ts
rtk proxy pnpm --filter @bitovp/worker exec vitest run src/orchestrator/sdk-ops.moq-output.test.ts
rtk proxy pnpm --filter @bitovp/core typecheck
rtk proxy pnpm --filter @bitovp/worker typecheck
rtk proxy pnpm --filter @bitovp/web typecheck
rtk proxy pnpm --filter @bitovp/web build
```

変更した schema／資格情報／Live compiler の既存回帰試験も実行する。
プロトコルの実測結果は研究ノートと Obsidian に日本語で追記する。
