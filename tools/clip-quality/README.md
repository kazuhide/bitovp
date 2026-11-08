# クリップ品質評価のprivateコーパス

Python 3.9以降のstdlibだけを使う運用CLI。日常のクリップ利用者に正解注釈を入力させる機能ではなく、開発側が同じ入力・尺・版・独立した人手基準で比較するための基盤。

顧客のinventory、work-map、source名、画像、字幕、ASR本文、MP4はリポジトリへ置かない。出力はcheckout外を要求し、専用directoryを0700、JSONとmediaを0600で保存する。署名URLはメモリ内だけに保持し、FFprobe/FFmpegへは短命のcapability付きloopback proxy URLを渡す。S3操作はGET/Range用presignのみ。upload、encoding job、DB、GPU、Docker、外部LLM呼出しはこのCLIにない。

```sh
rtk proxy python3 -m unittest discover -s tools/clip-quality -p 'test_*.py' -v
```

## 入力と作品単位の分割

`manifest` はAWS `list-objects-v2` のJSONと、private work-mapを受け取る。ページが分かれる場合は全ページを統合してから使い、`IsTruncated=true`のまま受け付けない。同じ作品・シリーズ・別名・SD/HD/音声差分を、明示した同じ`workKey`にまとめる。ファイル名の近さだけで作品同一性を確定しない。

work-map例は以下の**架空データ**。`split`を全選定作品に指定すれば明示分割、未指定ならseed固定の作品単位hash順で分割する。指定のある作品とない作品を混在させることはできない。1つのobjectを異なるworkへ二重登録すると拒否する。

```json
{
  "schemaVersion": "clip-quality-work-map-v1",
  "works": [
    {
      "workKey": "fictional-series-a",
      "category": "ANIMATION",
      "selected": true,
      "split": "DEV",
      "assets": [
        {"key": "private/proxy-a.mp4", "representation": "PROXY"},
        {"key": "private/master-a.mov", "representation": "ORIGINAL"}
      ]
    },
    {
      "workKey": "fictional-film-b",
      "category": "LIVE_ACTION_FILM",
      "selected": true,
      "split": "HOLDOUT",
      "assets": [{"key": "private/master-b.mxf", "representation": "ORIGINAL"}]
    }
  ]
}
```

選定はPROXY→REFERENCE→ORIGINAL、その中で低解像度hint・小さいsourceを優先する。filename由来の解像度/categoryは実測や映像を人が見た結果ではない。video streamはprobeで確認する。audio-onlyらしい名前だけでは映像なしと断定しない。色バーなど用途が明示された除外は`excludeReason: "TEST_PATTERN_PURPOSE"`で残す。

```sh
rtk proxy python3 tools/clip-quality/clip_quality.py manifest \
  --inventory /absolute/private/inventory.json \
  --work-map /absolute/private/work-map.json \
  --bucket YOUR_PRIVATE_BUCKET --region ap-northeast-1 \
  --split-seed evaluation-v1 --holdout-count 1 --maximum-works 12 \
  --out /absolute/private/corpus/manifest.json
```

各選定作品について15/30/60秒のcaseを作る。全体manifestとcaseのIDはinventory/work-map/ETag/size/split/希望尺へbindする。source ETagはopaqueな版照合値で、whole-source SHA256として使わない。source全byteを取得していない間は`source.sha256=null`。`normalizationClock`、`recipeIdentity`、`modelIdentity`、品質測定は未実行の間nullで、人手goldenはPENDING。

## Bounded metadata probe

```sh
rtk proxy python3 tools/clip-quality/clip_quality.py probe \
  --manifest /absolute/private/corpus/manifest.json \
  --selection-file /absolute/private/probe-assets.json \
  --out-dir /absolute/private/probes-v1 \
  --limit-bytes 67108864 --deadline-seconds 45
```

selectionは`{"assetIds":["asset-...", "asset-..."]}`。省略時は選定済み表現形式を使う。stdoutはaliasと固定status/countのみで、source keyや署名URLを出さない。

- S3 HTTPS host・bucket・keyの一致、Rangeの206、正確なContent-Range/Length、If-Match/ETagを検査する。redirectやsource変更を黙って受け入れない。
- 最大64MiB/asset、45秒/asset。予算はfetch前に予約し、並行Range要求を合算する。metadata用のopen-ended GETでもwhole sourceを取得しない。
- Range cacheは8MiBまで。完成した各範囲のSHAと、取消途中の未hash受信byteを分ける。これらは元ファイル全体のSHAではない。
- Rangeは固定1MiB境界でcacheし、同じblockの並行取得を共有する。音声/映像の細かい交互seekで、重なった範囲を繰り返しS3から取得しない。
- 同一GET/range/ETagの一時的transport、HTTP500/502/503/504だけ最大3attemptとする。全attemptを同じdeadlineとbyte quotaへ予約し、retry回数・追加予約・受信量を残す。403/412、ETag/Range/length不一致、TLS・未知エラーは非retry。署名URLは開始時発行し、queryの日時と期限をURLを保存せず検査する。
- 子プロセス群を専用sessionで起動し、親watchdogが期限・cleanupを管理する。hard stopでbyte計測が完了しない場合はlower-boundと保守的に課金したquotaを明示し、完全な値を捏造しない。
- FFprobeのheader上の時間は元presentation metadataで、CFR30 normalization clockとは異なる。probe失敗/不足はUNRESOLVED。成功時にvideoなし/audioありと確認できた場合だけAUDIO_ONLY_CONFIRMED。

## Private excerptの準備

```sh
rtk proxy python3 tools/clip-quality/clip_quality.py materialize \
  --manifest /absolute/private/corpus/manifest.json \
  --probes-dir /absolute/private/probes-v1 \
  --selection-file /absolute/private/materialize-assets.json \
  --out-dir /absolute/private/excerpts-v1 \
  --limit-bytes 2147483648 --total-limit-bytes 12884901888 \
  --deadline-seconds 600
```

元映像の300秒を目安に、180秒が範囲内へ収まる整数秒offsetを選ぶ。短い元映像は0秒から実在分だけを使い、paddingで180秒へ増やさない。入力SARを表示上の幅へ反映、flagged interlaceをbwdif、最大1280×720、CFR30、H.264/AAC48kHz stereoの評価用MP4へ変換する。SDR709割当は評価用の明示recipeで、provider normalization proofとは扱わない。PQ/HLGを黙ってSDRへ読み替えず、別のtone-map policyが必要として停止する。

既定は2GiB/asset、全体12GiB、600秒/asset。特定assetだけ事前に明示したbudgetが必要なら、`--asset-limits-file`へ以下の形式を渡せる。上限4GiBで、全体12GiBとdeadlineは上がらない。他assetの上限は変更しない。失敗してから無制限再取得したり、尺・画質を黙って下げたりしない。

```json
{"assetLimits":{"asset-0123456789abcdef01234567":{"limitBytes":4294967296,"reason":"Explicitly approved high-bitrate reference budget"}}}
```

出力は`asset-alias/excerpt.mp4`と`materialize.json`。成功前は`.partial.mp4`で、失敗を完成素材として使わない。source ETag、元offset、元header start、source probe hash、FFmpeg/FFprobe/binary/operator code hash、recipe/hash、出力wholefile SHA、frame count、実尺、音声有無を記録する。clipのAISA/ASR/出力は新excerptの0秒時計を使い、元映像の300秒時計と混同しない。入力seekはdecoder frameへ丸められるので、元offsetは要求値として精度の限界も記録する。

batchのquotaは同じ実行内で合算する。別の診断・再実行を行う場合も、前回の成功/失敗/取消receiptをSHA付きでprivate台帳に残し、上位の全体枠から先に差し引いた残額を`--total-limit-bytes`へ渡す。新しい出力directoryを作ったことは、読取枠を再取得した意味にならない。完全なread proofがない起動済みoperationは、quota全額を保守的に差し引く。

Source/prompt/model版とrecipeを固定した後に、DEVでの調整とHOLDOUTの未見比較を分ける。HOLDOUTの素材準備とprovider解析は採点前でもできるが、その品質結果をチューニングに使えば未見比較ではなくなる。

## LIVEだけの明示budget revision（v2）

通常の上限で180秒が収まらない高bitrate素材について、承認されたprivate revisionに固定した1assetを、最大1追加attemptだけ実行できる。通常materialize/probeの既定を引き上げる操作ではない。

```sh
rtk proxy python3 tools/clip-quality/clip_quality.py materialize-revision \
  --revision-file /absolute/private/live-budget-revision-v2.json
```

revision JSONはstrictなschemaで、次を全て指定する。元manifest/probe/累積ledgerのJSONはprivate regular file（同UID、0600、checkout外）で、指定した全byte SHAと一致しなければ進まない。入力ファイルを実行中に変更した場合も成功へ採用しない。

| field | 値・意味 |
|---|---|
| schemaVersion / revisionId / assetId | `clip-quality-materialize-revision-v2`、UUID、承認した単一asset alias |
| manifestPath / manifestSha256 | corpus manifestのabsolute pathと実SHA |
| probePath / probeSha256 | 同asset/sourceがVIDEO_PRESENTだったprobeのpathと実SHA |
| priorLedgerPath / priorLedgerSha256 / previousChargedBytes | 失敗/取消/retryを含む既存累積台帳へのbindingと、そこに一致する旧debit |
| globalLimitBytes / perAssetLimitBytes | `21474836480`（20GiB累計）/`6442450944`（6GiB） |
| deadlineSeconds / maximumAdditionalAttempts | `900` / `1` |
| cacheBlockBytes / cacheCapacityBytes | `8388608`（8MiB aligned cluster）/`33554432`（32MiB LRU上限） |
| outputDirectory | 新しいprivate absolute directory。既存directoryは拒否 |
| recipeHash / requestedDurationUs | 元の180秒transform recipe（toolIdentityを含める前）のcanonical SHA / `180000000` |
| reason | 元の枠では不足する根拠と、明示した変更理由 |

新しい20GiB枠には過去の取得debitを含める。未消費の20GiBを最初から与え直すことはしない。旧台帳のcharge+remaining=旧limitを検査し、旧debitに6GiBの予約を足して新累計上限を超える場合はnetwork前に拒否する。任意のRange診断も、先に旧台帳へ加算してから新revisionをbindする。

元manifest隣の`.materialize-revision-claims/manifest-policy-hash-v2.json`をO_EXCLで先に作り、同manifest+policy全体で追加attemptを1回に固定する。claim内容にはassetを保持し、別asset・出力directory・revision UUIDへ変えても2回目は拒否する。FAILED/取消/結果不明でclaimを自動削除しない。read proofが返らない起動済み処理は6GiB全額を保守的にdebitする。中断時のcleanupを返却proofで確認できない場合は、その不確定性をfalseとしてreceiptへ残す。claim後、native起動前にoperatorが終了した場合もclaimは残り、次の操作で勝手に再利用しない。

8MiB clusterの前読み分も全て予約・受信量・SHAへ記録する。video/audioの離れたhot領域をLRUに残すため32MiBを上限とし、1clusterだけでcacheが満杯になる再取得を避ける。probeは1MiB cluster/8MiB LRUのまま。既存のIf-Match/Range/Length/同deadline/最大3attempt条件を維持し、6GiBや900秒に入らなければ尺や画質を下げず失敗として止める。成功の保証や実S3速度の測定結果ではない。

## 完了済みpartialのoffline finalization

入力のvideoとaudioの実長が異なる場合、container durationから見積もったframe数と数frameずれることがある。その失敗を成功へ書き換えず、native return codeが0で完了したprivate partialだけを、元operation/probeとpartialの全byte SHAへbindして別成果物として確定できる。取得上限で途中停止したものや、native完了が不明なものは対象外。

```sh
rtk proxy python3 tools/clip-quality/clip_quality.py finalize \
  --manifest /absolute/private/corpus/manifest.json \
  --source-receipt /absolute/private/excerpts-v1/asset-alias/materialize.json \
  --source-probe /absolute/private/probes-v1/asset-alias/probe.json \
  --partial /absolute/private/excerpts-v1/asset-alias/excerpt.partial.mp4 \
  --partial-sha256 REPLACE_WITH_THE_ACTUAL_64_HEX_SHA256 \
  --out-dir /absolute/private/finalized-v2/asset-alias \
  --deadline-seconds 600
```

これはnetworkを使わない。60秒以上180秒以下の実CFR30 video frame数Fを基準とし、既存video bitstreamをcopyし、音声は48kHzのF×1600 samplesまでtrimしてAACへ再encodeする。映像を180秒へ伸ばしたり複製したりしない。全video frameをdecodeし、0+index×1000 tick（1/30000時計）を検査する。音声はpresentation duration/startをsample単位で検査し、全decodeのsample数も記録する。AACで最大1023 samplesの末尾decode paddingがあり得る場合はpresentation sampleと分け、完全な同値と偽らない。

copy前後のvideo bitstream hash一致、出力wholefile SHA、元partial/operation/probe SHA、元video/audio start offset、実フレーム時計、audio実時計を新しい`finalize.json`へ残す。元FAILED receipt/partialを変更しない。保存した元source offsetはseek要求値で、元presentationとの厳密なframe対応証明ではない。確定するのは評価proxyの時計であり、provider normalizationの証明とは分ける。出力とreceiptが成功し、cleanupが確認できた別成果物だけを後段へ渡す。

operatorの中断時も、作成したchild process/sessionだけをcleanupしてから中断を伝播する。byte計測が完成しなかった場合の上位台帳は、実際の受信を0にせず、割当quota全額の保守的な差引きを維持する。

## 評価記録の境界

技術的成功（decode、frame/clock、hash）、意味的品質（重要場面・物体の保持）、操作性、速度/メモリは別に評価する。LLM自身の引用整合や自己採点、tracker自身のbox包含率を、独立した人手正解と呼ばない。

人手annotationはprivate別layerに、annotator、確認日時、source/excerpt SHA、clock、対象ID、bbox/区間、注釈方法、未確定箇所を持たせる。実際の反復発話や映像の飛びを消すための正解にはしない。未注釈のcaseへ自動的に合格値を付けない。生成した編集案は通常のpreviewで確認してから、明示したEXPORTで評価する。
