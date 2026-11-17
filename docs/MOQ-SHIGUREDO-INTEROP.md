# Bitmovin Live → 時雨堂 MoQ Relay → Player Web X 接続調査

調査日: 2026-11-17。公開仕様・公開ソース・SDK 型の確認と、公開接続先への TLS/ALPN 試験。
BitOVP 調査基点: `da31b866166763fda126dcc1cd6ec858d3ab42ce`。

## 判断

**試験した時雨堂の公開 native QUIC 接続先とは、Bitmovin の公開対応 draft では接続できなかった。**
最初に解消する条件は MoQT draft の一致である。Bitmovin Encoder の公開対応は
16／18、Player Web X の公開 MoQ デモの選択肢は14／16／18。
時雨堂の DevTools は23、Sora MoQ の公開説明は22で、共通対応は確認できない。
実通信でも `sora-moq.sora-labo.shiguredo.app:443/UDP` は `moqt-23` を選択する一方、
`moqt-16`／`moqt-18` を `no_application_protocol` で拒否した。
別の接続先で旧 draft を併設できるかは未確認。

時雨堂に **draft 18 または16の評価用接続先** があるか確認するのが、最も変更量の
少ない進め方である。最新 draft のみ提供される場合は、Encoder と Player の両方に
その draft の対応が必要になる。draft 番号や URL の書き換えはプロトコル変換にならない。

## 構成と互換条件

```text
OBS等 → RTMP/SRT → Bitmovin Live Encoder
                        │ native QUIC / MoQT
                        ▼
                  時雨堂 MoQ Relay
                        │ WebTransport / MoQT
                        ▼
                  Player Web X
```

[MOQT DevTools](https://moqt-devtools.shiguredo.app/) はブラウザ用クライアントで、
Relay の公開先そのものではない。Encoder の出力先には別途 Relay の接続情報が必要。

### 公開接続先の実通信結果

接続先は Sora MoQ の公開資料 [S3] にある上記ホスト。標準の443/UDPへ、ALPN を
1つずつ提示して4回の QUIC TLS ハンドシェイクを実施した。クライアントは
`aioquic 1.8.0`、サーバー名と証明書を検証し、検証の無効化はしていない。
MoQT SETUP、認証 token、PUBLISH、media object は送信していない。

| 提示した ALPN | 結果 |
|---|---|
| `moqt-23` | TLS handshake 成功、選択された ALPN も `moqt-23` |
| `moqt-18` | 接続拒否: `no_application_protocol`（QUIC error 376 = `0x178`） |
| `moqt-16` | 接続拒否: `no_application_protocol`（同上） |
| `h3` | TLS handshake 成功（WebTransport の HTTP/3 transport に対する確認のみ） |

[生の試験記録](research/moq-shiguredo-alpn-20261117.json)に UTC 時刻と結果を保存した。
16／18ではパケット形式や認証の互換性を試す前に、TLS のアプリケーションプロトコル
交渉で拒否されている。draft ごとに `moqt-<番号>` を使う規則は
[draft 16 §3.1](https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-16#section-3.1)／
[draft 18 §3.1](https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-18#section-3.1)にある。
23の成功は MoQT SETUP や配信成功を意味せず、`h3` の成功も WebTransport CONNECT の
成功ではない。この試験は実際の Bitmovin Encoder／Player での接続試験ではない。

ユーザーから有料 Live 起動・映像送信も許可されたが、draft の不一致を先に確認したため
現構成での有料試験には進めていない。将来の Encoder／映像試験は、必要な MoQ 機能を
BitOVP に実装したうえで BitOVP 経由で行う。

| 確認点 | Bitmovin | 時雨堂 | 判断・必要な確認 |
|---|---|---|---|
| MoQT draft | Encoder: `DRAFT_16`／`DRAFT_18`。公開 Player デモ: 14／16／18 [B1][B2][B3] | 現行クライアント:23。Relay 公開説明:22 [S1][S2][S3] | 公開情報に共通 draft がない。専用評価環境または両 Bitmovin 製品の対応が必要 |
| Transport | Encoder: `moqt://host:port`。Player デモ: HTTPS の WebTransport URL [B1][B3] | JS は WebTransport。Sora 資料の Rust／Python SDK は QUIC／WebTransport [S1][S3] | Encoder 用の native QUIC 接続先・UDP port と、Player 用の HTTPS 接続先・path・証明書を別々に確認 |
| 認証 | `authToken: string`、任意の `authTokenType: number`。URL 中の資格情報は使われない [B1][B2] | C4M。現行 JS は Base64 の CAT を復号し、CBOR/CWT のバイト列を type 1 の SETUP token として送る [S4] | Encoder の文字列→wire byte 変換と SETUP／PUBLISH の token 提示を確認。`authTokenType: 1` だけでは互換性を保証できない |
| Namespace／track | Namespace は1〜32要素のタプル。rendition ごとの media track と `catalog` [B1][B2] | Sora Labo は `[GitHub ID, channel]`。認可対象は `catalog`／`audio`／`video`／`events` [S3] | Encoder の実際の track 名と token scope を照合。`outputPath` がそのまま track 名になるとは仮定しない |
| Media／catalog | H.264＋AAC、fMP4/CMAF と catalog [B1] | 現行 JS の高レベル API は LOC＋WebCodecs。MSF02 parser の packaging 一覧に CMAF はない [S1][S5] | DevTools での CMAF 再生は未確認。Relay が Encoder の object／catalog を透過中継できれば、Player Web X で再生を検証できる |

上表の LOC 対応はクライアントの説明であり、Relay が CMAF を拒否する根拠ではない。
また、同じ `catalog` という track 名でも catalog の中身の互換性は別途確認する。
公開 Player デモの namespace 入力は文字列である。Sora の2要素タプルを `/` や `-`
で結合して渡せるとは仮定せず、使用する Player ビルドの表現方法を確認する。

## 検証環境の入手

Sora Labo の説明にある接続先は `sora-moq.sora-labo.shiguredo.app` [S3]。
DevTools をローカルで起動しても Relay が起動するわけではない。
公開した client ライブラリから Sora MoQ Relay を自前構築する手順は確認できなかった。

Sora Labo の[利用規約第3条](https://github.com/shiguredo/sora-labo-doc/blob/750fcf94b340f73f7440f56645adbc51322af7d3/TERMS.md#L44)
には同一・類似サービス事業者の役職員等の登録制限があり、
[第9条](https://github.com/shiguredo/sora-labo-doc/blob/750fcf94b340f73f7440f56645adbc51322af7d3/TERMS.md#L87)
には性能分析等の第三者への開示制限がある。アカウントを使った配信評価では適用と
許諾範囲を時雨堂に確認し、相互接続用の評価接続先を用意してもらう進め方が適切。
今回は登録・認証・配信していない。

時雨堂へ確認する項目:

1. MoQT 18／16の提供可否。native QUIC と WebTransport それぞれの URL、ALPN／protocol、port、path、対応 draft。
2. Encoder が送る token を受け付ける方式。CAT の文字列表現と生バイト、token type、SETUP／PUBLISH／SUBSCRIBE の認可条件。
3. 任意の namespace と rendition track 名の許可。catalog と複数 video rendition、audio の scope。
4. fMP4/CMAF object と Bitmovin catalog の透過中継可否、評価利用と結果共有の範囲。

Bitmovin 側ではアカウントの MoQ Beta 有効化、Encoder `2.292.0` 以上、使用する
Player Web X MoQ ビルドを確認する [B1]。このアカウントの有効化状態は未確認。
時雨堂側の最新 draft に揃える場合は、両製品に対する対応可否を確認する。

## 互換条件が揃った後の試験

最初は1 video＋1 audio、H.264／AAC、1秒の fMP4 segment、専用 namespace、
短時間の Live に限定する。MoQ 出力は Live のみで、他の出力種別との併用、DRM、
SCTE-35 は公開ガイドの対象外 [B1]。既存の S3 出力に MoQ を追加する試験にはしない。

まず以下の公式 Cloudflare draft 16 構成を比較用の候補にできる [B1]。
**以下は API の形を示す設定例であり、時雨堂用の動作確認済み設定ではない。**
Relay の利用条件・token・Bitmovin Beta の確認後に実行する。今回 API 送信はしていない。

`POST /v1/encoding/outputs/moq` の body:

```json
{
  "name": "MoQ interop baseline",
  "relayUrl": "moqt://draft-16.cloudflare.mediaoverquic.com:443",
  "trackNamespace": ["{{UNIQUE_SINGLE_FIELD_NAMESPACE}}"],
  "draftVersion": "DRAFT_16",
  "authToken": "{{PUBLISH_TOKEN}}"
}
```

各 video／audio stream に対する fMP4 muxing の body:

```json
{
  "streams": [{ "streamId": "{{STREAM_ID}}" }],
  "outputs": [{ "outputId": "{{MOQ_OUTPUT_ID}}", "outputPath": "video/" }],
  "segmentLength": 1.0
}
```

上は video の例。audio には別の stream ID と `audio/` の outputPath を使う。
これらは Bitmovin API の body であり、BitOVP の plan JSON や import 用ではない。
時雨堂用には合意した draft と接続先に変更し、認可条件を満たした token を設定する。
Sora の `#msf:...` URI を Encoder の `relayUrl` にコピーするだけでは token 設定にならない。
秘密情報はリポジトリや試験ログに保存しない。

再生は [Player Web X MoQ デモ](https://demo.bitmovin.com/public/pwx-moq/) の Relay、
Namespace、Draft、Catalog に設定する。比較用 Cloudflare 構成では Relay が
`https://draft-16.cloudflare.mediaoverquic.com/{{SUBSCRIBE_ONLY_TOKEN}}`、Draft が16、
Catalog が `catalog`、Media types が `audio,video` [B1]。
この path に token を置く方式を時雨堂の認証方式へ一般化しない。
Player 用 token は publish token と分ける。token を含む URL やスクリーンショットは共有しない。

試験の記録は次の順に分ける:

1. **Transport／SETUP:** Encoder と Player それぞれで合意した draft・認証・接続先を記録。
2. **配信／中継:** Relay が namespace／catalog／media track を受理し、購読側へ object を転送することを確認。
3. **再生:** Player が catalog と init/media を解釈し、映像・音声が継続することを確認。
4. **終了:** Live 停止を確認し、必要な試験ログを秘密情報を除いて保存。

SETUP 成功だけでは再生成功としない。遅延値を報告する場合は測定方法と試験条件も記録する。

## BitOVP への反映範囲

調査基点では `@bitmovin/api-sdk` は1.288.0で `MoqOutput`／`MoqDraftVersion` が存在する。
一方、[planOutputSchema](../packages/core/src/plan/schema.ts) に `MOQ` destination はなく、
[Web の依存](../apps/web/package.json) は `bitmovin-player` 8系。
SDK の型があることと BitOVP のフォーム・plan・Worker・Player が対応することは別である。

このブランチは調査と設定例に限定する。相互接続が確認できた後、credential 管理、
Live 専用 validation、output/muxing のコンパイルと Worker 実行、Player Web X の
限定プレビューを別の変更として設計する。現段階で既存 Live の出力・再生経路を変更しない。

## 確認結果と限界

一次資料は HTTPS で取得し、時雨堂のソースは下記 commit に固定した。
公開 DevTools HTML のタイトルは `MOQT DevTools (draft-23)`。
Player デモ HTML では draft の選択と URL parameter の受付が14／16／18である。
公開ページと下記 GitHub commit のデプロイ同一性は確認していない。

設定例はローカルの SDK 1.288.0 の `MoqOutput`／`Fmp4Muxing` で構築・JSON 化し、
参照値と namespace の保持、draft enum を検証した。`node:test` の結果は **3 passed／0 failed**。
SDK による空の `acl`／`ignoredBy` 配列の付加も期待値に含めて確認した。
これは API の受理や wire 上の認証を証明しない。

ブラウザ操作用ホストが利用できなかったため、画面操作・実再生の確認は行っていない。
QUIC TLS 以降の MoQT SETUP、WebTransport CONNECT、token 発行、Live 起動・課金処理、
性能測定も未実施。

## 一次資料

- [B1: Bitmovin MoQ Output ガイド](https://developer.bitmovin.com/encoding/docs/media-over-quic-moq-output)（取得した Markdown の updatedAt: 2026-11-03）
- [B2: SDK 1.288.0 MoqOutput](https://github.com/bitmovin/bitmovin-api-sdk-javascript/blob/v1.288.0/src/models/MoqOutput.ts)／[MoqDraftVersion](https://github.com/bitmovin/bitmovin-api-sdk-javascript/blob/v1.288.0/src/models/MoqDraftVersion.ts)
- [B3: 公開 Player Web X MoQ デモ](https://demo.bitmovin.com/public/pwx-moq/)（2026-11-17取得 HTML と `moqResource()`）
- [S1: moqt-js README](https://github.com/shiguredo/moqt-js/blob/2b7f494f31496b93e6e545b30d62134df610bb99/README.md)
- [S2: moqt-js 接続処理](https://github.com/shiguredo/moqt-js/blob/2b7f494f31496b93e6e545b30d62134df610bb99/src/connect.ts#L89)（`moqt-23` のみ提示し、選択を確認）
- [S3: Sora MoQ 公開説明](https://github.com/shiguredo/sora-labo-doc/blob/750fcf94b340f73f7440f56645adbc51322af7d3/SORA_MOQ.md)
- [S4: CAT の SETUP token 変換](https://github.com/shiguredo/moqt-js/blob/2b7f494f31496b93e6e545b30d62134df610bb99/src/msf/c4mAuthorization.ts)
- [S5: MSF version／packaging](https://github.com/shiguredo/moqt-js/blob/2b7f494f31496b93e6e545b30d62134df610bb99/src/msf/version.ts#L22)
