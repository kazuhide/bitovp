# 実験用 Local Semantic Gateway

BitOVP workerが固定のローカルLLMへ非同期jobを送るための、Python標準ライブラリによる実験用HTTPSサービスです。Codex/ClaudeのCLIや開発者のSSH鍵を、workerの実行依存へ入れません。SSHは導入・運用時だけに使います。

初期導入先はx1proの`192.168.68.62:11437`。既存のOllama 11434とdriverは変更せず、導入済みの専用runtimeだけを呼びます。

| profile | 固定接続先 | 構成 |
|---|---|---|
| `nvidia` | host loopback 11435 | Ollama 0.40.14、CUDA＋CPU退避 |
| `amd` | host loopback 11436 | 同版、Radeon ROCm・共有メモリ |

モデルは`qwen3.8:27b-q8_0`、manifest digestは`8f5fb6b71ea00052cbe8545738c55ce61112c4e571cb60ca4dad00b131766039`へ固定。要求ごとにruntime版・model digestを照合し、生成後のAPI配置でGPU割当とcontext 8192を確認します。profile名だけをハードウェア利用の証拠にしません。画像入力・追跡や物語品質の合格を示すサービスではありません。

## 契約

すべてのAPIに、private tokenによるBearer認証が必要です。tokenは一つのpreview tenantへ固定します。任意のURL・model・runtime設定・schema・shell・toolを要求へ追加できません。CORSによるブラウザー直接接続も提供しません。

- `GET /health`: Gatewayの版、登録stage、固定モデル、`quarantinedProfiles`、`acceptingJobs`を返します。隔離中や停止中は`status: "degraded"`、`acceptingJobs: false`。backend推論の動作確認は別です。
- `GET /readiness/{profile}`: `amd`または`nvidia`だけを受け付ける認証付きのmetadata診断です。専用runtimeの`/api/version`と`/api/tags`へGETし、固定版・model digestとGPU能力を照合します。停止中・いずれかのprofileが隔離中ならruntimeへ接続しません。モデルの読込・推論・解放は行いません。
- `POST /v1/semantic-jobs`: 初回202、同じ要求の再送200、同じkeyで異なるbodyは409。
- `GET /v1/semantic-jobs/{id}`: 認証tenantに属するjobだけを返します。
- `POST /v1/semantic-jobs/{id}/cancel`: `{}`を送り、取消を要求します。

readinessの成功HTTP応答は常に200で、次の固定キーだけを返します。未認証は401、未登録profile・query付きpathなどは404です。

```text
version: "bitovp-semantic-readiness-v2"
profile: "amd" | "nvidia"
organizationId: tokenに紐づくtenant UUID
scope: "METADATA_ONLY"
ready: codeが"READY"の場合だけtrue
code: "READY" | "GATEWAY_STOPPING" | "RUNTIME_QUARANTINED"
      | "RUNTIME_UNAVAILABLE" | "RUNTIME_VERSION_MISMATCH" | "MODEL_MISMATCH"
      | "GPU_UNVERIFIED"
gpu: READYの場合だけ、新鮮なbitovp-runtime-gpu-capability-v1の能力情報
```

`/health`の設定値と異なりruntimeの現在の登録情報を読みますが、GPUの空き・モデルの読込可否・推論結果の正しさまでは保証しません。各GETは既存の固定loopback接続・接続5秒/応答読取10秒・応答2MiB上限を使い、redirectやproxyを使いません。二つの読取を直列に行うため、clientはその合計時間も考慮します。raw error、接続先host、観測した未承認model名・digestは応答やログへ出しません。

既定の4stage registryへの作成要求は次のキーだけを持ちます。追加のCHOICE stageは後述の専用registryを明示した場合に限ります。

```text
version: "bitovp-semantic-job-v1"
requestKey: UUID
organizationId: tokenに紐づくtenant UUID
profile: "amd" | "nvidia"
stage: "LOCAL_LEDGER_V1" | "LOCAL_BLUEPRINT_V1" | "LOCAL_CAPTION_JA_V1" | "LOCAL_CAPTION_JA_V2"
prompt: 入力を含むUTF-8文字列
inputHash: 呼出元が検証する入力同一性のSHA-256
promptVersion: "local-story-v1" (Ledger/Blueprint) | "caption-ja-v1" | "caption-ja-v2" (日本語字幕)
schemaHash: 登録済みschemaのSHA-256
```

job IDはUUIDv5です。namespaceは`uuid.NAMESPACE_URL`、名前は`bitovp-semantic:<organizationId>:<requestKey>`。requestHashはbody全体をキー再帰sort・空白なし・Unicode非escapeのUTF-8 JSONへ正規化したSHA-256です。

SQLiteの`UNIQUE(organization, request_key)`と原子的なtransactionで再送を扱います。取消はtenantとjob IDへ記録し、受付前の取消も保存します。取消POSTが`404 JOB_NOT_FOUND`でも、後着する同じIDの作成はCANCELLEDになります。GETの404にはこの意味はありません。

stateはQUEUED、LOADING、RUNNING、VALIDATING、CANCELLING、SUCCEEDED、FAILED、CANCELLED。すべてのjob応答に`cleanupConfirmed`を付けます。未開始の取消や、自分のモデル解放まで確認できた終了だけtrueです。FAILEDだけを解放済みと見なしません。CLEANUP_FAILED、RUNTIME_STOP_UNCONFIRMED、再起動時のRESTARTEDはfalseです。

SUCCEEDEDのresultには最終contentと実行receiptを返します。内部thinkingや入力promptを応答・ログへ出しません。receiptには入力・prompt/schema/request hash、model digest、runtime版、profile、API token統計、API配置報告、経過時間、解放確認を含めます。`schemaVerified:false`は、**GatewayがJSON objectと正常終了までを確認し、完全なstage schema・根拠・時刻の検証はworker側のZodに委ねる**ことを示します。SUCCEEDEDを編集品質の合格へ読み替えません。

## 入力・実行予算

server側の`stages.json`に、許可stageごとのpromptVersion、schemaHash、schema、maxOutputTokensを登録します。schema hashを検証し、外部schema参照を拒否します。clientからschema自体は受け取りません。

contextは8192、thinking=false、temperature=0、seed=41、jobの推論予算は900秒。promptのUTF-8 bytesを`8192 - maxOutputTokens - 1024`以下に制限し、出力とtemplateの余裕を先に確保します。初期ledgerは6144 bytes、blueprintは5632 bytesまで。長編入力はworkerでcoverageを保持して分割します。

日本語字幕stageも出力1536 tokens、prompt 5632 bytesまでです。workerは採用映像の原語cueを最大8件・本文JSON最大2000 UTF-8 bytesへ分割します。原文は省略せず、一件で上限を超える場合は明示的に失敗します。モデルの出力はIDと訳文だけにし、ID完全性をworkerで検証します。実測時刻と原語wordはそのまま保持し、訳語の単語時刻を合成しません。字幕が空なら呼び出しません。不正な翻訳JSONの修正は一回だけで、通信・provider・取消の失敗を意味修正の再試行へ変えません。

現在の文脈付き翻訳は`LOCAL_CAPTION_JA_V2`を使い、旧v1のprompt・identity・証拠は履歴として保持します。字幕のcurrentなsource spanまたはanchorから、同じ素材・time mapのAISA場面、ショット、人物名を参照DATAへ選びます。任意の参照項目は全文のまま最大1400 UTF-8 bytes、本文・採用済み同文脈訳を含むDATA全体は4500 bytesまで。sourceや文脈・ASR policy・model/promptの変更は別cache keyです。同じ確認済みショット文脈の同じ台詞は採用済み表記を引き継ぎ、異なる場面や文脈不明のcueへtextだけで使い回しません。currentな手動訳は上書きしません。これは構造・出典・表記の一貫性の検証であり、訳の意味的正しさの保証ではありません。

PLaMo 3 Translateは字幕専用の別identity・専用jobとして明示設定します。導入条件と実行経路は後述の「PLaMo 翻訳専用の導入境界」を参照してください。StoryのQwen identityは変更しません。

従来の二段stageだけのregistryも読み込めます。現在の翻訳にはv2 stageの登録が必要です。翻訳stageを追加しても、Story identityは旧二段だけを同じ構造でhashし、翻訳identityを別に作るため、登録追加だけで既存Ledger cacheを失効させません。新ASR品質policyによって入力が変わる場合のcache分離は、これとは別です。

一つのworkerと、既存運用CLIと共通の`lab/locks/inference.lock`で実行を直列化します。既にモデルがロードされていればbusyで止め、他のモデルをunloadしません。取消・期限では自分のHTTP接続を停止し、自分が開始したprofileの固定モデルだけを解放します。取消完了は解放確認後に返します。再起動時は進行中jobのownerを失効させ、RESTARTEDとして回収します。

この協調排他は、raw API、共有Ollama、VMAF、別のGPU processまで制御しません。raw OllamaをLANへ公開せず、GatewayだけをTLSで公開します。

## 取消の解放確認と隔離

自分のHTTP接続を閉じ、そのtransport threadが終了しても、backendが受理したモデル読込や推論の終了を証明しません。読込途中では`/api/ps`も空になり得ます。Gatewayは固定モデル名が一致するchatの最終`done: true`をbackend完了ACKとして記録します。自分が開始した要求の後には、psが空でも固定モデルへunloadを送り、モデル名・`done: true`・`done_reason: "unload"`のACKとpsの空を確認します。

chatのbackend完了ACKを受け取れなかった取消・transport lossでは、unloadが応答しても元の読込が後から走らないと断定しません。`FAILED / RUNTIME_STOP_UNCONFIRMED / cleanupConfirmed: false`とします。unload自体の失敗は`CLEANUP_FAILED`で同様に未確認です。

未確認時は共有flockを解放する前に、`gateway/state/jobs.sqlite3`の`runtime_quarantines`へprofileを記録します。単一の推論資源を共有するため、一つでも隔離profileがあれば**全profileの新規受付を503 `RUNTIME_QUARANTINED`で拒否し、既存queueもruntime呼出前に止めます**。同じrequestKeyの結果の再取得は可能です。Gatewayの再起動だけでは解除しません。進行中にクラッシュしたjobも再起動時に隔離対象となり、遅い結果は採用しません。

隔離状態のDB保存まで失敗した場合はworkerを停止し、新規作成POSTも503 `GATEWAY_STOPPING`で拒否します。停止中もGETとcancelは確認用に維持します。単なるstopping状態を正常なhealthとして返しません。

隔離を解除するために、元のjobを成功や`cleanupConfirmed: true`へ書き換えません。`runtime_release_confirmations`へ、offline運用者の実終了確認を別に追記します。元のFAILED、error、payload、result、cleanup値は履歴として残します。確認表のUPDATE/DELETEはSQLite triggerで拒否します。公開APIに記録・解除機能はありません。

確認はjob ID・tenant・profile・request hash・保存payloadのraw hash・terminal row全columnのhash・隔離row hashへ束縛します。固定owned unitの停止、cgroupの空、捕捉した旧PID/start identityの終了をOSから再確認した場合だけ記録します。未証明のfailureや別reason/profileの隔離は維持します。再起動時は完全一致の確認があるfailureだけを再隔離対象から外し、履歴のcleanup値自体は変更しません。

捕捉時の全PID/start identityは`runtime_release_captures`へnonce・capture hashとともに追記し、同表もUPDATE/DELETEを拒否します。importしたcaptureファイルは保持済みDBの完全一致が必要で、PIDやstartTicksを編集したファイルでは停止・解除できません。canonical unitに加え、effective ExecStart、FragmentPath、DropInPaths、NeedDaemonReloadと、MainPIDの実exe／argv／cgroup所有を検証します。未知のdrop-inやoverrideは拒否し、停止直前にも同じ保持済みidentityを再照合します。

x1proでの復旧は新規投入を止め、次のように共通排他を保持して行います。対象jobのprofileに対応する専用backendとGatewayだけを停止します。NVIDIAが対象でなければNVIDIA unitは停止しません。共有11434、VMAF、別利用者process、driverは対象外です。

```python
from pathlib import Path
import subprocess
from gateway import inference_lease
from record_runtime_release import OfflineOperator, private_write

folder = Path.home() / ".local/share/bitovp-llm-lab/gateway"
job_id = "<FAILED job UUID>"
operator = OfflineOperator(folder)
with inference_lease(folder.parent / "locks/inference.lock"):
    capture = operator.capture(job_id)  # active jobsなし、固定owned PID/cgroupを捕捉
    private_write(folder / "state/release-capture.json", capture)  # 新しい名前を使う
    backend = "bitovp-llm-" + capture["bindings"]["profile"] + ".service"
    operator.stop_owned_units(capture)  # effective設定・実process所有を直前にも検証
    receipt = operator.confirm(capture)  # OS再確認、mode600 DB backup、別表へ追記
    private_write(folder / "state/operator-release.json", receipt)
    if not receipt["result"]["quarantineCleared"]:
        raise RuntimeError("同profileに未証明のfailureが残っています")
    subprocess.run(["systemctl", "--user", "start", backend, "bitovp-semantic-gateway.service"], check=True)
```

`capture`が所有者・PID・active状態を確認できない場合や、`confirm`で旧PIDの残存、effective設定変更、cgroup残存等が見つかった場合は進めません。`/api/ps`が空という理由だけで確認を作りません。capture保持前とconfirm前にDBを`state/release-backups/`へmode600でbackupし、対応する元rowを変えていないことも確認します。運用例ではcapture、停止、confirmを同じ排他内で呼び、停止から再開まで他の推論を入れません。

個別のoffline CLIも`record_runtime_release.py capture --directory ... --job-id ... --output ...`、`confirm --directory ... --capture-file ... --output ...`で利用できます。captureファイルは同UID所有のregular mode600、64KiB以下で、confirmは1時間以内・同bootの捕捉だけを受け付けます。CLI単独のconfirmも共通排他を取得します。停止・再開を一続きの排他内で行う場合は上記Python例を使います。

再開後は認証TLS health/readiness、対象psの空、他profileのPID・秘密ファイル保持を確認します。Gatewayをもう一度再起動しても再隔離せず、元jobのFAILED/cleanup:falseが変わらないことを確認します。確認JSONは運用者のOS観測を記録するもので、外部署名や映像品質の保証ではありません。

## 導入と検証

公開registryは、checkoutのcoreから推論なしで生成できます（出力先はrepository外へ指定します）。

```sh
pnpm --filter @bitovp/worker exec tsx scripts/write-local-semantic-stages.ts /absolute/path/to/stages.json
```

### 検証済み編集候補から選ぶ CHOICE stage

`LOCAL_STORY_CHOICE_V1` は、CPUが時間・被写体・構成ルールを検証した編集候補から `planId` を選びます。Gatewayへ新しいカット割や時刻の計算を依頼しません。出力は `planId`、100文字以内の `message`、160文字以内の `uncertainty` で、受信後はcoreが候補への所属と出力全体を厳密に検証します。Gateway receiptの `schemaVerified:false` は従来のままです。

CHOICEは `local-story-choice-v1`、出力上限512 tokens、context8192、thinking=false、prompt上限6656 UTF-8 bytesです。旧Ledger・Blueprint・字幕の上限やmodel identityは変わりません。同じ固定AMD/NVIDIA Qwen profileを使い、PLaMoは字幕専用のままです。

上の既定exportは旧4stageを維持します。CHOICEの検証には別の5stage registryを明示して出力します。生成はmetadataだけで、推論やインストールを行いません。

```sh
pnpm --filter @bitovp/worker exec tsx -e 'import {writeFileSync} from "node:fs"; import {localSemanticPlanningStageRegistry} from "@bitovp/core"; writeFileSync(process.argv[1],JSON.stringify(localSemanticPlanningStageRegistry(),null,2)+"\n")' /absolute/path/to/stages-planning.json
```

このregistryのversionは `bitovp-semantic-stages-planning-v1`、top fieldsは `version`、`legacyRegistryHash`、`choiceRegistryHash`、`stages` だけです。旧4 entriesとCHOICE 1件を含み、独立した `local-story-choice-stages-v1` componentのhashを照合します。旧4stage formatと階層FLOW 6stage formatは引き続き別の契約で、新stageの追加を許しません。

registryを書き換えただけではアプリの新方式は有効になりません。review済みGateway source・5stage registry・アプリ・DBのreceipt kind対応を揃え、metadata probeで5件のschema/prompt/budgetを照合してから、web/workerの公開compose設定で `BITOVP_LOCAL_STORY_CHOICE_ENABLED=1` を指定します。secret env、CA、token、model/profile pinsは変更しません。既設unitへの更新・rollbackは配備時の固定manifestと運用記録に従い、初回provision scriptを再実行しません。

既設Gatewayへの更新時に下の初回導入scriptを再実行しません。運用者がidleと所有unitを確認し、既存directory/unitと公開registryをbackupしてから、`gateway.py`・`gpu_capability.py`・`plamo_runtime.py`とregistryを同じ検証済みsnapshotから更新し、同じunitを再起動します。token・tenant・証明書・profile設定は維持します。healthで旧二段と新翻訳stageのschema/prompt identityを照合した後、別途実推論を確認します。

`/readiness/<profile>` の READY は、固定したruntime版・モデルdigestに加え、`bitovp-runtime-gpu-capability-v1` の新鮮なGPU能力情報を要求します。`gpu_capability.py` は、専用user serviceのMainPID、同一UID・mount/user namespace、専用loopback listener、実行中のbinary、profileのGPU選択条件を照合します。実runtimeとGatewayのUID/GID・補助group・有効capability・LSM contextが異なる場合、runtimeにSeccomp filterがある場合、未知のdevice制限がある場合も能力を確認済みとはしません。DeviceAllowはsystemctlが空値を省略するため、固定unitのD-Bus propertyをbusctlで読み、型付きの空配列 `a(ss) 0` を明示確認します。欠落・不正な型・空でない配列は拒否します。そのruntimeと固定backend libraryのSHAを確認し、同じGPU選択条件でOllama 0.40.14の `gpu-discover` だけを実行します。CUDA/ROCm backendが列挙した実デバイスと正の空きメモリを確認し、CPUのみ・sysfsのみ・未知の状態は `GPU_UNVERIFIED` とします。モデルはロードせず、chat/generate/download/unloadも呼びません。モデルを毎回unloadする待機状態でも能力を確認できます。実推論後のGPU配置と解放確認は引き続き別に必須です。

Workerは4秒以内のmetadata確認をまとめ、5秒間隔で更新します。元のGPU観測時刻を保持し、15秒を超えた成功はWeb受付にもWorkerの新規claimにも使いません。WebはRedisのWorker状態だけを読み、画面からLANを直接probeしません。取得不能時も既存結果の参照、所有タスクのcancel、確定済みartifactの回復は維持します。GPU-discovery子プロセスはGatewayと同じuser unitのメモリ予算に入ります。モデルを使わない管理用preflightで子プロセスの最大RSSが304,412 KiB、親が25,044 KiBだったため、provisionerのGateway予算は有限の `MemoryMax=512M` とします。既設256Mはこの子プロセスの実測だけでも超えます。配備時は所有Gateway unitも512Mへ更新し、そのunit内の実際の認証付きGETで `MemoryPeak`、OOM、再起動数、timeoutを測定してください。管理用shellの成功はGatewayの権限・制限やcgroup内での成功を保証しません。CLIやfixtureの成功だけを実機確認として扱いません。

```sh
python3 tools/local-semantic-gateway/provision_gateway.py \
  --registry /absolute/path/to/stages.json \
  --output /absolute/path/to/private-handoff
python3 -m unittest discover -s tools/local-semantic-gateway -p 'test_gateway.py' -v
```

導入scriptは固定SSH先へ、新しい`lab/gateway`と`bitovp-semantic-gateway.service`だけを作成します。既存のGateway directory/unitがあれば上書きせず停止します。新しいserver証明書・秘密鍵とtokenを生成し、秘密鍵・設定・client envをmode600へ制限。公開証明書はworkerへreadonlyで渡し、hostname/SANと証明書を検証します。

clientへの設定は`BITOVP_LOCAL_SEMANTIC_ENABLED`、`BITOVP_LOCAL_SEMANTIC_GATEWAY_URL`、`BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN`、`BITOVP_LOCAL_SEMANTIC_CA_FILE`、`BITOVP_LOCAL_SEMANTIC_PROFILE`、`BITOVP_LOCAL_SEMANTIC_CONFIG_ID`。secret envはrepositoryへ置きません。

テストはfake runtime、実SQLite、localhostのHTTPS handlerと中断可能な接続を使い、GPU・実モデルへ接続しません。実機のモデル利用とclip品質は別に検証します。

本サービスは運用者userとして動く実験用です。専用service user、正式な証明書運用、監視・保持期間・更新手順を含む製品運用は別段階です。PythonのHTTP serverも実験範囲に留めます。[Python HTTP server](https://docs.python.org/3.12/library/http.server.html) · [TLS context](https://docs.python.org/3.12/library/ssl.html#ssl.SSLContext) · [socket shutdown](https://docs.python.org/3.12/library/socket.html#socket.socket.shutdown)

backendのunload契約は[Ollama generate API](https://docs.ollama.com/api/generate)を参照。公開中の[scheduler実装](https://github.com/ollama/ollama/blob/main/server/sched.go)だけで固定runtimeの遅延load不在を証明せず、完了ACKのない要求は隔離します。

## PLaMo 翻訳専用の導入境界

Story は従来の Qwen 固定のままです。翻訳だけを `BITOVP_LOCAL_CAPTION_PROVIDER=PLAMO` と `BITOVP_LOCAL_CAPTION_MANIFEST_FILE=/absolute/public-manifest.json` で明示選択できます。公開 manifest は core の `publicPlamoCaptionManifestSchema` を使い、ID・重み/変換/runtime/テンプレートの hash のみを渡します。実行パス・argv・token を含めません。未指定は従来 Qwen、部分設定・不正・指定 profile 不在は無効です。明示 PLaMo から Qwen への代替実行はありません。公開 metadata は readonly 0644 を許容します。secret env は 0600 のままです。

`plamo-manifest-preflight.ts` は workspace の tsx loader でこの同じ Node selector を実行します。公開 manifest を読めることと厳密 identity だけを検証し、モデルや network へ接続しません。`GET /readiness/plamo/{profile}/{manifestHash}` は認証必須で、配置済み binary/weight/共有ライブラリの SHA、更新時の file identity と専用 unit の effective 設定を照合します。モデルの load・推論は行いません。global quarantine/stopping が優先し、未導入は `MODEL_NOT_INSTALLED`、不一致は `MODEL_MISMATCH`、診断不能は `RUNTIME_UNAVAILABLE`。非 READY の応答に path/identity/raw error を含めません。

運用者の `gateway/plamo-private.json` は mode600 の `bitovp-plamo-private-v1`、`manifest` と `profiles` を持ちます。profile 項目は `identity`、`binaryPath`、`weightsPath`、`libraries:[{path,sha256}]`、`libraryDirectories`、`gpuLayers`、`gpuDevice`、`memoryMaxBytes` のみです。実ファイルは `lab/plamo/` 内、symlink なし、所有 UID の regular file とし、binary/weight/依存 library を実 SHA で照合します。値を架空の SHA で埋めて導入済みと扱いません。

公開 `runtimes.<profile>.backend` は省略可能です。省略時は NVIDIA が `CUDA`、AMD が `ROCM`。AMD の Vulkan 実行は `backend: "VULKAN"` を明示し、private `gpuDevice` を実機で列挙された `Vulkan0` 等にします。明示した backend は identity の `runtimeBackend` と実行 receipt にも結び付きます。既存の backend 省略 manifest/identity の hash は維持します。NVIDIA の Vulkan 指定や profile/device/backend の不一致は拒否します。

runtime の公開 `buildRecipeHash` は `installation_recipe_hash(profile,item)` が作る導入 recipe v4（binary SHAとpath hash、**各private library path hashと対応するSHAの組**、libraryDirectories の**順序付きリストの opaque hash**、GPU profile/device/layers、memory cap、context、recipe version）の canonical hash と一致する必要があります。同 SONAME の探索順や、固定directory間のlibrary配置/SHA対応を変更しても identity/cache が変わります。公開 manifest には private path の文字列を出しません。設置場所だけが変わる場合も保守的に別 identity となります。元の CMake 引数や source/build log は別途運用記録へ保存します。

loader の探索 directory とbinary/libraryの親directoryは、子directoryを持たないflatな専用領域にします。bin/lib/weightsは兄弟に分け、明示したloader rootsにpinned regular artifactだけを置きます。glibc-hwcapsを含む子directory、未列挙ファイル、symlink aliasを入口で拒否し、再帰探索は行いません。全root合計512entryを上限とし、legacy配置も条件を満たさなければmetadata不一致で実行を拒否します。lab外だけでなく既にpinnedの別libraryへhwcaps aliasを向けても、同identityで解決先が変わることを許しません。配置検証は起動時・metadata照合時・nativeへ字幕を渡す前に行います。

`generate_plamo_units.py --directory /absolute/lab/gateway --output /new/empty-directory` は実 artifact 検証後、**inactive unit ファイルを生成するだけ**です。自動 install/enable/start はありません。profile ごとに `bitovp-plamo-caption-nvidia.service`（loopback11438）/`bitovp-plamo-caption-amd.service`（11439）を運用者が配置し確認するまで実行不可です。PLaMo専用unitの生成はGatewayの512M予算、既設Qwenの11435/11436、共有11434の設定・予算を変更しません。専用 unit は別 cgroup、最大80GiBの明示予算・swap0・Restart=no・KillMode=control-group、Gateway に BindsTo します。予算は重みサイズ+2GiB以上を必要としますが、この下限は実 peak や正常完走を保証しません。

専用 `/v1/plamo-caption-jobs` は fixed PFML3 completion のみ、context8192/output1536/temp0/seed41、UTF8 prompt5632bytes以内です。任意 model/URL/schema/argv/tools を受け付けません。原文・時計をモデルに生成させません。1 cue ごとの native job を集約した検証済み batch を、既存 `LOCAL_CAPTION_TRANSLATION_V1` の別 strict v3 proof として保存します。全 cue の検証後のみ文書へ適用し、途中失敗で一部の字幕を公開しません。現実装は job ごとに起動/停止するため、モデル常駐による高速化は実施していません。

共通 inference.lock 内で既設 Qwen が unloaded/専用 unit が inactive なことを確認してから起動します。最初の unit InvocationID/MainPID/startTicks を固定し、同じ起動identityの検証済み `/usr/bin/env` launcher から binary への移行だけを最大5秒待ちます。二度の観測の間にexecが完了した場合は、同じownerの期待binary/argvを再検証して期限内のloopに戻ります。不明な executable や argv を待機理由にしません。起動済み binary/profile と owned PID の GPU 割当を確認し、終了・取消・HTTP失敗のいずれも cgroup 空、捕捉済み旧 PID 終了を確認してから lock を解放し terminal 成功/取消にします。既にinactive/failed、MainPID0、元InvocationIDまたは解除済みの空ID、旧PID終了・cgroup空を証明できた場合はstopを呼びません。MainPID0でもforeign InvocationIDやactivating、未捕捉ownerを解放済みと扱わず、停止もせずcleanup:falseと永続global quarantineに進めます。捕捉済み startTicks を再観測で上書きせず、外部restartやPID再利用で起動identityが変わった場合も新プロセスをownedへ昇格させません。HTTP 接続の終了だけでは解放と扱いません。既存 Qwen 用 offline release CLI の証明を PLaMo job に流用することは拒否します。PLaMo の隔離解除を必要とする実運用は、専用 unit を対象にした独立監査済み operator 手順の追加が必要です。

未配置環境では実行を拒否します。adapterやfixtureの検証は、実際の重みの配置、専用serviceの起動、翻訳精度・速度の検証とは区別します。固定 [llama.cpp server source](https://github.com/ggml-org/llama.cpp/blob/10d4846a572aebf21c0482d140b00e74c0f1ad20/tools/server/README.md) の raw completion/stop/timing と CLI を基にしています。

### 組織に束縛したclip受付

認証付き `GET /readiness/nvidia` と `GET /readiness/amd` は `bitovp-semantic-readiness-v2` を返し、固定tokenが許可する `organizationId` を常に含めます。READYには従来のGPU能力proofも必要です。Workerの `local-clip-availability-v2` はREADY時に `authorizedOrganizationId` を持ち、各task/renderのorganizationIdと比較して新規claimを許可します。Webも認証済みrequest contextのorganizationIdだけを比較し、envや要求bodyから組織の権限を推測しません。旧v1・組織根拠なし・別組織のREADYは受付不可です。GatewayのPOSTに対する403 TENANT_FORBIDDENは維持します。既存artifact/historyと所有cancelはこの新規受付gateから独立して利用できます。
