# MoQ Live Encoder 実通信試験結果

試験日: 2026-11-17 22:43 JST。実装コミット:
`e949b77e21b4d539aff786021409430ea8eaf874`。

## 結果

**BitOVP 経由の Live 開始を試したが、アカウントの MoQ 機能制限で拒否された。**
実 Encoder の起動と Relay へのプロトコル交渉には到達していない。
従って「実際の最新版 Encoder が送る draft は16／18か、それ以外か」は未確認である。

```text
POST /encoding/encodings/{id}/live/start
HTTP 400 / provider code 2002
MoQ outputs are not enabled for this organization.
request: 87ee0b89-bb3d-4e7e-97d2-eab8ef3165bb
```

公開資料の draft 番号と汎用 QUIC クライアントの ALPN 試験だけでは、
実 Encoder の挙動を断定できない。今回は実装済みのアプリから開始要求を送った結果を
[機械可読の記録](research/live-moq-encoder-probe-20261117.json)に保存した。

## 試験経路

既存の稼働環境とは別の Web／Worker／Postgres／Redis を使用した。
通常のアプリ認証と tenant 認可を通し、暗号化した Relay 資格情報を登録。
`POST /api/live-channels` から plan → compiler → Worker → SDK の通常経路で実行した。
Bitmovin API を呼ぶ代替スクリプトで Encoding を作成・起動していない。

| 段階 | 確認結果 |
|---|---|
| 設定 | Encoder `BETA`、Custom Live、`DRAFT_18`、H.264 360p＋AAC、各1秒 FMP4、manifest なし |
| Relay 設定 | `moqt://sora-moq.sora-labo.shiguredo.app:443`。認証 token なしの接続試験用 |
| 入力設定 | Redundant RTMP。自作映像の送信を予定したが、起動前の拒否のため未送信 |
| 資格情報／MoQ output／Encoding／codec／stream／muxing | アプリから作成成功。step log の各 create は `DONE` |
| Live start | 上記の MoQ アカウント機能制限で `FAILED` |
| 実 version | Encoding GET は要求値 `BETA` のみを返し、`selectedEncoderVersion` は未返却。推測で補完していない |
| Live 統計 | 起動していないため summary diagnostics は404。Encoding の version 読み取りは別の audit に200として残る |
| 終了 | アプリの stop action を実行。アプリ `STOPPED`、provider `ERROR` と終端時刻を確認 |

作成した Encoding は `ae9ef409-57c1-4669-b610-ca9a72de75f0`。
provider 終端の観測時刻は `2026-11-17T13:43:35.301Z`。
HTTP request／response、step log、停止確認の生記録はローカルの非公開 evidence に保存した。
API token、session cookie、API key、RTMP stream key はこの報告・リポジトリに含めていない。

## 実装と検証

Relay に依存しない MoQ 出力として、資格情報管理、Live 専用 validation、
`CREATE_OUTPUT_MOQ` のコンパイルと Worker 実行、expert JSON の保持を追加した。
通常の Live、VOD、Player 8 の既存経路は維持する。MoQ 用の再生リンクは生成しない。
run diagnostics には、要求した Encoder version と provider が返す具体的な選択結果を
別々に扱う読み取りを追加した。

- Core: 8,134 passed（既存 skip 6）、typecheck 成功。
- Worker: 7,158 passed（既存 skip 60）、最終 preflight 回帰45 passed、typecheck 成功。
- Web: 13,060 passed（既存 skip 110）、typecheck／本番 build 成功。
- API census／contract／bounded audit checks 成功。変更範囲の Biome と diff check 成功。
- 実装コミットは Codex Rescue のフォアグラウンド実行と独立 agent review の両方で
  `APPROVE_STATIC C0R0`。この承認は Relay 接続・配信・再生の成功を意味しない。

## 再開条件

使用する Bitmovin organization で MoQ output を有効にするか、MoQ が有効な既存アカウントを
指定する。その後、同じ BitOVP 経路で最新 Encoder の選択結果と実接続を確認する。
`DRAFT_18` の開始要求が機能制限で拒否されたため、同じ条件の `DRAFT_16` を繰り返して
プロトコル互換性の結論を出すことはしていない。

接続が成立した場合は認可・catalog／media 中継を分けて確認し、必要な Player Web X
機能を BitOVP に追加したうえで再生試験へ進む。
