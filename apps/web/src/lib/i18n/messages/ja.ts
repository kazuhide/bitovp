import type { Messages } from "./en";

/* Japanese catalog. `satisfies Messages` checks complete key coverage without widening literal values. Keep wire identifiers verbatim, localize prose consistently, and share the provisioning clause so scheduling hints cannot contradict each other. Callers supply punctuation. */
const PROVISIONS_AT_CREATE =
	"作成した時点でチャンネルの起動準備が始まり、課金もそこから始まります";

export const ja = {
	creationSubmission: {
		responseUnavailable:
			"作成結果を受信できませんでした。フォームを変更せずに再試行すると、同じジョブやチャンネルの結果を確認できます。",
		sessionUnavailable:
			"セッションを確認できませんでした。このページを再読み込みしてからジョブやチャンネルを作成してください。",
		storageUnavailable:
			"安全に再試行するための情報をブラウザーに保存できませんでした。セッションストレージを有効にして再試行してください。新しいリクエストは送信していません。",
		pendingLimit:
			"このタブには結果が未確認の作成リクエストが多すぎます。既存のリクエストを再試行するか、ジョブとチャンネルの一覧を確認してから新しく作成してください。",
	},
	branding: {
		title: "表示名とアイコン",
		scope:
			"この組織の全ユーザーに表示するナビゲーションの名前とアイコンを変更します。保存すると反映されます。",
		name: "表示名",
		nameHint: "1〜64文字で入力してください。",
		icon: "アイコン",
		iconHint:
			"静止画の PNG・JPEG・WebP。256 KiB 以下、1024 × 1024 ピクセル以下。",
		preview: "プレビュー",
		removeIcon: "アイコンを削除",
		reset: "初期設定に戻す",
		loadFailed:
			"表示名とアイコンを取得できませんでした。再試行してから編集してください。",
		saveFailed:
			"保存できませんでした。入力内容は保持されています。もう一度保存してください。",
		saved: "保存しました。ナビゲーションに反映されました。",
		iconInvalid:
			"画像を読み込めませんでした。256 KiB 以下、1024 × 1024 ピクセル以下の静止画 PNG・JPEG・WebP を選んでください。",
		readOnly: "表示名とアイコンを変更できるのは管理者のみです。",
	},
	tenant: {
		organization: "組織",
		organizations: "組織管理",
		accessAudit: "アクセス履歴",
		accessCaption: "アクセス履歴と接続元IPの制限",
		organizationsCaption: "組織とメンバーのダッシュボード",
		name: "名前",
		slug: "ID",
		create: "組織を作成",
		save: "保存",
		saved: "保存しました",
		current: "現在の組織",
		ipPolicy: "アクセスを許可するIP",
		ipHelp:
			"IPまたはCIDRを1行に1件入力。空欄は制限なし。管理者を含む組織メンバー全員に適用します。設定を誤った場合は全体管理者が変更できます。",
		ipPlaceholder: "203.0.113.10\n2001:db8::/32",
		noHistory: "アクセス履歴はありません",
		historyHelp:
			"ページ訪問とAPIの変更操作を記録します。バックグラウンドの読み取り、管理者および代理閲覧は記録しません。判定はアクセス制限の結果で、処理の最終結果ではありません。",
		who: "アクセスしたユーザー",
		when: "日時",
		path: "ページ／API",
		ip: "接続元IP",
		decision: "アクセス判定",
		allowed: "許可",
		denied: "拒否",
		more: "さらに読み込む",
		viewAs: "メンバーとして閲覧",
		viewingAs: "{name} · {organization} を閲覧中",
		readOnly: "閲覧専用",
		exitViewAs: "代理閲覧を終了",
		member: "メンバー",
		password: "あなたのパスワード",
		view: "ダッシュボードを開く",
		noMembers: "有効なメンバーがいません",
		active: "有効",
		ownerOnly: "全体管理者のみ利用できます",
		usersRequired: "ユーザーアカウント方式で利用できます",
		loading: "読み込み中…",
	},
	ladder: {
		videoCopySource: "コピー元の映像設定",
		audioCopySource: "コピー元の音声設定",
		defaultSettings: "既定の設定から追加",
		copyHelp:
			"既存レンディションの設定をコピーできます。新規設定は「既定の設定から追加」を選択してください。",
	},
	theme: {
		label: "テーマ",
		neon: "Neon · ダーク",
		slate: "Slate · ダーク",
		paper: "Paper · ライト",
		dimmed: "Dimmed · ダーク",
		"solarized-dark": "Solarized · ダーク",
		"solarized-light": "Solarized · ライト",
		"high-contrast": "高コントラスト · ダーク",
		system: "システムに合わせる",
		hint: "このブラウザに保存されます。",
	},
	shell: {
		skipToContent: "本文へ移動",
	},
	rtmpUpdate: {
		title: "RTMP 取り込みポイント",
		apply: "選択したポイントを適用",
		hint: "選択した取り込みポイントを適用後、必要に応じて送信元を再接続し、入力状態を確認してください。",
		queued: "更新をキューに登録しました",
		failed: "RTMP 更新を登録できませんでした",
	},
	providerDiagnostics: {
		title: "プロバイダー診断",
		view: "表示",
		summary: "状態",
		events: "イベント",
		streams: "ストリーム",
		srt: "SRT統計",
		"hd-start": "HD 開始リクエスト",
		hdStartHint:
			"この配信の開始設定を、ストリームキー・URL・認証情報を除いて表示します。",
		refresh: "更新",
		fetched: "取得: {time}",
		srtInput: "SRT入力",
		allInputs: "すべての入力",
		inputId: "入力ID",
		apply: "適用",
		invalidId: "有効なSRT入力UUIDを入力してください。",
		unavailable:
			"プロバイダー診断を取得できませんでした。更新をお試しください。",
		previous: "前へ",
		next: "次へ",
		page: "{page}ページ",
		total: "全{count}件",
		getFinal: "最終Heartbeatを取得",
		downloadFinal: "最終Heartbeatをダウンロード",
		status: "プロバイダー状態",
		empty: "この選択に対応するプロバイダーデータはありません。",
		received: "受信レート",
		lost: "損失パケット",
		dropped: "破棄パケット",
		retransmitted: "再送パケット",
		details: "応答の詳細",
	},
	audioMix: {
		twoSources:
			"モノラル2本を結合するには、ソースで音声トラックを2つ追加してください。",
		title: "音声チャンネルミックス",
		preset: "プリセットから開始",
		swap: "左右入替",
		mono: "モノラル2本 → ステレオ",
		downmix: "5.1 → ステレオ（LFE除外）",
		custom: "カスタム割当",
		layout: "ミックスのチャンネル配置",
		output: "出力チャンネル",
		source: "入力音声",
		channel: "入力チャンネル",
		gain: "ゲイン",
		number: "チャンネル番号（0始まり）",
		add: "出力チャンネル追加",
		addSource: "入力チャンネル追加",
		remove: "チャンネル削除",
		disable: "この音声のミックスを解除",
		unset: "既定（未送信）",
		unknown: "参照先が見つかりません",
		hint: "出力チャンネルは各1行にし、入力チャンネルは名前指定か番号指定に統一します。同じ入力音声の複数チャンネルは出力行の中で追加します。ゲインは倍率（1で維持）です。素材のチャンネル配置を確認してください。",
	},
	vmafSetup: {
		computeAuthHelp:
			"計算ジョブの投入・停止を許可した保存済み認証を選びます。実行環境の認証を使う場合は、アプリの動く環境内で設定が必要です。",
		storageAuthHelp:
			"作業用オブジェクトの読み書き・削除・署名を許可した認証を選びます。両方の権限があれば計算用と同じ認証を選べます。",
		step1: "クラウドと事前準備",
		step2: "用意したリソースを設定",
		step3: "期限と費用",
		next: "次へ",
		back: "戻る",
		saveHint: "保存するのは設定だけです。計測の開始はVMAFラボで別途行います。",
		preparation: "先に用意するもの",
		preparationHint:
			"選択したクラウドの手順に沿って準備し、取得した値を次の画面へ入力します。リソースの作成やイメージの保存には費用が発生する場合があります。この画面はそれらを自動作成しません。",
		exampleHint:
			"以下は入力例であり、あなたのアカウントに作成済みのリソースではありません。プロジェクト・アカウントID、名前、イメージのダイジェストは実際の値に置き換えてください。",
		officialInstructions: "公式の作成手順を開く",
		credentialsLink: "認証情報を別タブで登録",
		identityHelp:
			"実行環境の認証を選ぶには、アプリが動く環境内に認証情報やロールの設定が必要です。MacのターミナルでログインしてもDocker内へは自動で引き継がれません。未設定なら先にクラウド認証情報を登録し、用途に応じて計算用・保存用で選択してください。",
		buildTitle: "VMAF用イメージの用意方法",
		buildHelp:
			"リポジトリのルートで実行します。<REGISTRY_PATH>をECRなどのリポジトリURIへ置き換え、まずベースイメージをpushします。その64桁のダイジェストを<BASE_DIGEST>に入れ、VMAF用イメージをビルド・pushします。画面には最後のイメージのダイジェストを使います。コマンドはクラウドへ保存するため、保存費用が発生する場合があります。例はx86用です。計算ノードとアーキテクチャを揃えてください。",
		awsImageTitle: "1. ECRリポジトリを作り、イメージを登録",
		awsImageBody:
			"Amazon ECR → プライベートリポジトリで、計算先リージョンにvmafを作成します。下記の方法でVMAFイメージをビルドし「プッシュコマンドの表示」に従って登録します。登録したイメージのリポジトリURIとイメージダイジェストを取得します。ECRはイメージの保存先です。",
		awsComputeTitle: "2. EC2のBatch計算環境・キュー・ジョブ定義を作成",
		awsComputeBody:
			"AWS BatchでマネージドEC2計算環境を作成し、最小vCPUを0、最大容量を制限します。ECRからpullできるロール・ネットワークと、動画の一時保存用に500GiBのノードディスクを用意し、ジョブキューを関連付けます。タスクのCPU・メモリは自動選択します。同じダイジェスト付きイメージURIで従来形式のEC2ジョブ定義（containerProperties）を作り、vmaf:1のようなリビジョン付き名を取得します。この連携はFargate・EKS・ecsProperties形式には対応していません。",
		awsStorageTitle: "3. 作業用の非公開S3バケットを作成",
		awsStorageBody:
			"計算先と同じリージョンにS3バケットを作成します。s3://を除いたバケット名を控え、アプリに作業オブジェクトの書き込み・読み取り・削除権限を付与します。取り残されたデータに備えライフサイクルによる期限削除も設定します。入力と結果の一時保存に使います。",
		awsAuthTitle: "4. アプリにBatchとストレージの権限を設定",
		awsAuthBody:
			"アプリにはBatchの投入・参照・一覧・停止と、作業用S3への権限が必要です。計算ノード側のECR取得権限とは別です。保存済みAWS認証情報を選ぶか、アプリの実行環境にIAMロールを設定します。イメージURIにキーを含めないでください。",
		gcpImageTitle: "1. プロジェクトを選びArtifact Registryへ登録",
		gcpImageBody:
			"課金が有効なプロジェクトでBatch・Compute Engine・Artifact Registry・Cloud Logging APIを有効化します。Artifact Registryで、計算先リージョンにDocker形式のvmafリポジトリを作成します。下記のVMAFイメージをpushし、バージョン詳細からsha256付きURIを取得します。",
		gcpComputeTitle: "2. タスク用サービスアカウントと計算先を準備",
		gcpComputeBody:
			"IAMと管理 → サービスアカウントで、例としてvmaf-taskを作成します。必要な範囲にBatch Agent Reporter・Logs Writer・Artifact Registry Readerを付与します。CPUクォータがあるリージョンを選びます。現版は外向き接続がある既定VPCを使用します。マシンサイズとディスク容量はアプリがタスクごとに自動選択します。計測開始時にBatchがVMを作るため、キューIDの設定はありません。",
		gcpStorageTitle: "3. 作業用の非公開Cloud Storageバケットを作成",
		gcpStorageBody:
			"計算先と同じリージョンにGCSバケットを作り、gs://を除いたグローバルに一意の名前を控えます。アプリの保存用認証にはオブジェクトの書き込み・読み取り・削除と署名URLの発行が必要です。サービスアカウント鍵ならローカルで署名でき、鍵を使わない場合は署名用サービスアカウントとsignBlob権限が必要です。",
		gcpAuthTitle: "4. アプリ用サービスアカウントの認証を登録",
		gcpAuthBody:
			"投入側の認証にはBatch Job Editorと、タスク用アカウントへのService Account Userが必要です。ローカルDockerの場合は、組織で許可されたサービスアカウントJSON鍵のclient_email・private_key・project_idを登録するか、Docker内に実行環境認証を設定します。手順2のタスク用アカウントのメールとは別の設定です。",
		azureImageTitle: "1. 対応するコンテナイメージを登録",
		azureImageBody:
			"VMAFイメージをAzure Container Registryなど、Batchプールから取得できるレジストリへ登録します。ダイジェスト付きURIを控え、プール側にレジストリの取得権限を設定します。",
		azureComputeTitle: "2. BatchアカウントとLinuxプールのテンプレートを準備",
		azureComputeBody:
			"AzureポータルのBatchアカウント概要でアカウントエンドポイントを取得します。テンプレートとしてコンテナ対応のLinuxプールを用意し、プールIDを控えます。アプリは計測ごとに容量を自動選択した一時プールを作成します。テンプレートのプールは保持します。",
		azureStorageTitle: "3. Blobコンテナを作成",
		azureStorageBody:
			"計算先に近いストレージアカウントに非公開コンテナを作ります。Blobサービスのエンドポイントとコンテナ名を別々に控え、アプリ用認証にオブジェクト操作とユーザー委任署名の権限を付与します。",
		azureAuthTitle: "4. サービスプリンシパルを登録",
		azureAuthBody:
			"Batchタスクの管理と作業ストレージの利用を許可した認証のテナントID・クライアントID・クライアントシークレットを登録します。計算用と保存用を分けて選択できます。",
		akamaiImageTitle: "1. VMが公開URLから取得できるイメージを登録",
		akamaiImageBody:
			"現在の連携では公開pullできるダイジェスト固定のVMAFイメージが必要です。認証情報や顧客動画を含めずコードだけを登録します。この画面でプライベートレジストリへのログインは設定できません。",
		akamaiComputeTitle: "2. リージョン・起動イメージを選択",
		akamaiComputeBody:
			"Cloud Manager/APIのリージョン・イメージIDを使い、cloud-init対応Linuxイメージを選びます。専用インスタンスのサイズはアプリが自動選択します。VMは計測開始時に作成されます。",
		akamaiStorageTitle: "3. Object Storageとエンドポイントを準備",
		akamaiStorageBody:
			"近いリージョンのObject Storageバケットを作成し、S3エンドポイント・バケット名・リージョンを控えます。Object StorageキーはAWS/S3認証情報として登録します。計算環境用Akamai APIトークンとは別です。",
		akamaiAuthTitle: "4. 独立した後処理用コントローラーを常時稼働",
		akamaiAuthBody:
			"Akamaiの計算用トークンを登録し、このMacとは独立してアプリの後処理コントローラーを稼働させます。VMは電源OFFだけでは課金が止まらず、削除が必要です。スリープするPCだけに後処理を依存する状態では有効にしないでください。",
		labelHelp: "VMAFラボの実行先一覧で見分けられる名前を付けます。",
		idHelp: "英数字とハイフンで一意のIDを付けます。保存後は変更できません。",
		regionHelp:
			"計算リソースとクォータがあるリージョンのコードを入力します。作業ストレージも近くに配置します。",
		imageHelp:
			"公開先レジストリから、@sha256:と64桁のダイジェストを含むURIを取得します。ローカルのDockerタグや:latestだけでは使えません。",
		queueHelp:
			"AWS Batch → ジョブキュー → 対象キューから名前またはARNを取得します。",
		definitionHelp:
			"AWS Batch → ジョブ定義 → 有効なリビジョンから「名前:リビジョン」を取得します。上の欄と同一のイメージダイジェストを指定した定義が必要です。",
		projectHelp:
			"Google Cloudのプロジェクト選択画面にあるプロジェクトIDを使います。表示名や数値のプロジェクト番号ではありません。",
		serviceAccountHelp:
			"IAMと管理 → サービスアカウントからタスク用アカウントのメールを取得します。BatchのVMが使用する認証で、アプリの秘密鍵を入力する欄ではありません。",
		accountUrlHelp:
			"Azureポータル → Batchアカウント → 概要からアカウントエンドポイントを取得します。",
		poolHelp:
			"Batchアカウント → プールから、テンプレートとなるLinuxコンテナプールのIDを取得します。",
		bootHelp:
			"Akamaiで利用可能なcloud-init対応イメージのIDを使います。DockerイメージURIとは別です。",
		bucketHelp:
			"s3://・gs://やフォルダーのパスを含めず、バケット名だけを入力します。",
		containerHelp:
			"ストレージアカウント → コンテナから、コンテナ名だけを取得します。",
		endpointHelp:
			"AWS S3なら空欄にします。AkamaiならバケットのHTTPS S3エンドポイントを取得し、バケットのパスやキーを含めずに入力します。",
		blobHelp:
			"ストレージアカウント → エンドポイントのBlobサービスURLを使い、コンテナのパスやSASトークンは含めません。",
		runHelp: "1タスクの最大実行時間です。短すぎると計測中に停止します。",
		queueTimeHelp: "割り当て・起動を待つ時間の上限です。",
		hourlyHelp:
			"各クラウドの料金計算から、ノード・プールの付随費用も含む1タスクあたりの保守的な時間単価を入力します。現在の料金を推測して自動入力はしません。",
		costTransferHelp:
			"利用リージョンの転送方向・保存費を含めます。0は別枠で計上済み、または無料と確認できた場合だけ指定します。",
		overheadHelp:
			"リクエスト・ログなどの付随費用として1タスクあたりのUSD額を確保します。",
		stagingHelp:
			"一時保存する入力がこの容量を超えるタスクは、投入前に拒否します。",
	},
	vmafSettings: {
		title: "VMAF 実行プロファイル",
		intro:
			"VMAFラボで使う実行設定と認証情報を保存します。保存だけではクラウドリソースは起動しません。",
		profiles: "実行プロファイル",
		credentials: "クラウド実行の認証情報",
		addProfile: "プロファイルを追加",
		addCredential: "クラウド認証情報を追加",
		empty:
			"保存済みプロファイルはありません。ローカル実行は引き続き利用できます。",
		emptyCredentials:
			"クラウド認証情報は未登録です。実行環境のIAMロール等を使う場合、キーの保存は不要です。",
		save: "保存",
		edit: "編集",
		disable: "無効化",
		enabled: "新しい計測で利用可能",
		disabled: "無効",
		version: "バージョン {version}",
		provider: "クラウド",
		label: "名前",
		id: "プロファイルID",
		identity: "実行環境の認証を使用",
		computeCredentialId: "計算環境管理用の認証情報",
		stagingCredentialId: "作業ストレージ用の認証情報",
		secretHelp:
			"キーは暗号化され、保存後は再表示されません。更新時は新しい認証情報を追加し、プロファイルで選択してください。",
		error:
			"設定の取得または保存に失敗しました。入力を確認して再試行してください。",
		invalid:
			"必須項目と入力値を確認してください。既存プロファイルの保存には現在のバージョンが必要です。",
		platform: "計算環境",
		autoCompute:
			"計算リソースは自動選択します。SDは4vCPU・8GiB、HDは8vCPU・32GiB、それ以上は16vCPU・64GiBを使います。ディスク容量は動画に合わせます。選択したペア数でクラウド並列数が決まります。予算とクラウド側の割り当て状況により制限されます。",
		limits: "期限・保存容量・費用の上限",
		storage: "作業ストレージ",
		storageProvider: "ストレージサービス",
		bucket: "バケット",
		container: "コンテナ",
		endpoint: "S3エンドポイント（任意）",
		storageRegion: "ストレージリージョン",
		storageAccountUrl: "BlobサービスURL",
		region: "計算リージョン",
		image: "コンテナイメージ（固定ダイジェスト）",
		timeoutSeconds: "試行ごとの実行期限（秒）",
		queueTimeoutSeconds: "試行ごとの待機期限（秒）",
		maxCostUsdPerHour: "時間あたりの費用上限（USD）",
		transferUsdPerGiB: "転送費上限（USD/GiB）",
		overheadUsd: "タスクあたりのその他費用枠（USD）",
		maxStagingGiB: "入力の最大保存容量（GiB）",
		jobQueue: "AWS Batchキュー",
		jobDefinition: "AWSジョブ定義（リビジョン固定）",
		project: "GCPプロジェクト",
		serviceAccount: "タスク用サービスアカウント",
		accountUrl: "Azure BatchアカウントURL",
		poolId: "AzureプールID",
		bootImage: "Akamai起動イメージ",
		spot: "Spotを使用",
		spotFallback: "Spotを優先し、上限到達後に通常VMへ切り替える",
		spotMaxRetries: "Spotの最大再試行回数",
		spotDeadlineSeconds: "Spot全体の期限（秒）",
		spotPolicyHelp:
			"中断したPairをSpotで再試行し、期限または再試行上限に達した場合だけ通常VMへ切り替えます。ジョブ全体の予算は維持されます。時間単価の上限には通常VMの料金を含めてください。",
		reaperEnabled: "独立した後処理コントローラーが稼働している",
		accessKeyId: "アクセスキーID",
		secretAccessKey: "シークレットアクセスキー",
		clientEmail: "サービスアカウントのメール",
		privateKey: "秘密鍵",
		projectId: "プロジェクトID（任意）",
		tenantId: "テナントID",
		clientId: "クライアントID",
		clientSecret: "クライアントシークレット",
		token: "APIトークン",
		costHelp:
			"リージョン・契約に応じ、起動・待機・保存費を含む保守的な上限を入力してください。これは投入制限であり最終請求額の保証ではありません。",
	},
	library: {
		analysisAll: "解析データの全項目",
		analysisProvider: "元のAISA解析結果（秘密情報は非表示）",
		analysisNormalized: "保存済みの正規化解析（元データなし）",
		analysisEmptyString: "空の文字列",
		analysisEmptyObject: "空のオブジェクト {}",
		analysisEmptyArray: "空の配列 []",
		analysisMore: "次の50項目を表示（{shown}/{total}）",
		analysisFields: {
			metadata: "解析メタデータ",
			version: "プロバイダーバージョン",
			disclaimer: "解析上の注意事項",
			inputLanguageCodes: "入力言語",
			ratings: "コンテンツレーティング",
			rating: "レーティング",
			region: "地域",
			system: "レーティング方式",
			credits: "全体クレジット",
			persons: "人物",
			songs: "楽曲",
			copyright: "著作権表記",
			name: "名前",
			role: "役割",
			department: "部門",
			artist: "アーティスト",
			scenes: "シーン",
			content: "シーン内容",
			characters: "登場人物",
			characterAppearance: "人物の外見",
			approximateAge: "推定年齢",
			playedBy: "演者",
			shots: "ショット",
			mainSubjects: "被写体",
			box2d: "検出枠",
			centerX: "中心X（%）",
			centerY: "中心Y（%）",
			appearanceTimeInSeconds: "ショット内の出現時刻（秒）",
			startInSeconds: "開始時刻（秒）",
			endInSeconds: "終了時刻（秒）",
			duration: "長さ（秒）",
			title: "タイトル",
			description: "説明",
			summary: "概要",
			verboseSummary: "詳細な概要",
			detailedDescription: "詳細説明",
			keywords: "キーワード",
			sensitiveTopics: "センシティブな話題",
			iabSensitiveTopicTaxonomies: "IABセンシティブ分類",
			iab: "IAB分類",
			adOpportunityInformation: "広告機会",
			score: "スコア",
			reason: "理由",
			shotAdvisories: "ショットの注意情報",
		},
		contentCredits: "全体クレジット",
		creditPersons: "人物（キャスト・スタッフ）",
		creditRole: "役割",
		creditDepartment: "部門",
		creditSongs: "楽曲",
		creditArtist: "アーティスト",
		creditCopyright: "著作権表記",

		contentTab: "コンテンツ",
		scenesTab: "シーン",
		gridView: "グリッド表示",
		listView: "一覧表示",
		sceneSearch: "シーンを検索",
		sceneSearchHint: "キーワードを入力してシーンを検索します。",
		sceneSearchEmpty: "条件に一致するシーンはありません。",
		sceneMatch: "一致条件",
		sceneMatchAll: "すべての語",
		sceneMatchAny: "いずれかの語",
		sceneMatchHelp:
			"語を空白で区切ります。シーンのタイトル・キーワード・要約・ショット説明を対象に、すべての語またはいずれかの語の一致を検索します。",
		sceneSort: "並び順",
		sceneSortRelevance: "関連度",
		sceneSortRecent: "更新順",
		sceneSortHelp:
			"関連度は0–100点で、同じ検索条件の結果を比較するための値です。一致する語の数を優先し、同数ならタイトル・キーワード・要約・ショット説明の順に重み付けします。確率やAIの確信度ではありません。更新順はコンテンツの更新日時を使います。",
		sceneRelevance: "関連度 {score}/100",
		sceneLanguage: "解析言語",
		sceneLanguageAll: "すべての言語",
		sceneLanguageHelp:
			"選んだ言語で保存済みのシーン解析を検索します。検索語の翻訳は行いません。",
		sceneLanguagesLoading: "言語を読み込み中…",
		sceneLanguagesFailed: "解析言語を読み込めませんでした。",
		sceneLanguagesRetry: "言語を再読み込み",
		thumbnailLoading: "サムネイルを読み込み中…",
		thumbnailFileMissing: "MP4ファイルなし",
		updating: "更新中…",
		sceneLinkChanged:
			"このシーンへのリンクは現在の保存内容と一致しません。シーンを選び直してください。",
		sceneNavigationHelp:
			"シーンを選ぶと詳細を表示し、映像をその位置に移動します。再生できない場合は詳細のみ切り替わります。",
		scenePage: "{page} / {pages} ページ・{count} シーン",
		noSceneMatches: "検索条件に一致するシーンはありません。",
		filterAll: "すべて",
		filterPlayback: "再生情報あり",
		filterMetadataOnly: "再生情報なし",
		playbackHelp:
			"HLS・DASH・MP4の再生情報が登録されています。実際に再生できるかは再生時に確認します。",
		noPlaybackMetadata: "再生情報なし",
		thumbnailUnavailable: "サムネイルなし",
		previewUnavailable: "プレビュー不可",
		clearFilters: "絞り込みを解除",
		range: "{count}件中 {start}–{end}件",
		emptyFiltered: "条件に一致するコンテンツがありません。",
		refresh: "再試行",
		recapture: "ライブラリに再登録",
		captureSuppressed:
			"リセットでライブラリから削除されました。再登録すると、このジョブのコンテンツをライブラリに戻せます。",
		editingDisabled: "編集は現在無効です",
		sceneCount: "{count} シーン",
		subjectOverlay: "被写体の観測位置を表示",
		subjectOverlayHint:
			"ショット内の観測位置です。被写体の追跡や範囲を示すものではありません。",
		globalMetadata: "メタデータ（全体）",
		sceneMetadata: "メタデータ（シーンごと）",
		currentScene: "現在のシーン",
		noCurrentScene: "現在の再生位置にシーン情報はありません。",
		adOpportunity: "広告機会スコア",
		adThreshold: "強調表示：Ad Score > 0.5",
		adReason: "広告機会の理由",
		dynamics: "緊張度・テンポ",
		settings: "場所・雰囲気",
		characters: "登場人物",
		objects: "物体",
		adCategories: "IAB 広告カテゴリ",
		unreported: "情報なし",
		timeline: "シーンタイムライン",
		zoom: "タイムラインの拡大率",
		sceneOverlay: "シーン情報を重ねて表示",
		automaticImport: "エンコード完了後に解析結果を自動で取り込みます。",
		omittedSubjects:
			"ショット範囲外の被写体観測点を {count} 件除外しました。元のメタデータは保持されています。",
		qcSnapshot: "QC・入力スナップショット（読み取り専用）",
		qcSnapshotNotice:
			"この入力の登録時に保存した QC レポート（最大20件・各結果100件）です。日時は元の記録のものです。過去の証跡であり、新たな計測や再生確認を示すものではありません。",
		playback: "再生マニフェスト",
		title: "コンテンツライブラリ",
		analysis: "AI シーン解析",
		loading: "読み込み中…",
		empty:
			"コンテンツはまだありません。完了した VOD ジョブは自動で登録されます。",
		search: "タイトル・タグを検索",
		archived: "アーカイブ済み",
		active: "有効なコンテンツ",
		previous: "前へ",
		next: "次へ",
		count: "{count} 件",
		openJob: "元のジョブを開く",
		capture: "解析結果を取り込む",
		captureHint:
			"既存の解析結果と再生参照を取り込みます。エンコードは開始しません。",
		pending: "解析結果の取り込み待ち",
		running: "解析結果を取り込み中…",
		ready: "解析結果の取り込み完了",
		error: "解析結果の取り込み失敗",
		retry: "取り込みを再試行",
		unavailable: "解析結果はまだ取り込まれていません。",
		missingLocale: "この言語の解析結果はありません。",
		locale: "解析言語",
		summary: "概要",
		scenes: "シーン",
		shots: "ショット",
		subjects: "被写体",
		classification: "分類",
		searchScenes: "シーンのタイトル・概要・キーワードを検索",
		noScenes: "一致するシーンはありません。",
		seek: "{seconds} 秒へ移動",
		raw: "プロバイダー解析結果（読み取り専用）",
		noPlayback: "再生情報がありません。",
		metadata: "編集用メタデータ",
		contentTitle: "タイトル",
		description: "説明",
		tags: "タグ（カンマ区切り）",
		register: "ライブラリに登録",
		save: "保存",
		saved: "保存しました",
		archive: "アーカイブ",
		restore: "復元",
		conflict:
			"別のセッションで更新されています。最新の内容を再読み込みしてから保存してください。",
		reload: "最新の内容を再読み込み",
		linked: "登録済みコンテンツ",
		identity:
			"入力の同一性は未検証です。この参照はメディアの同一性を証明しません。",
		newContent: "新しいコンテンツを作成",
		destination: "登録先",
		registerSuccess: "コンテンツを登録しました",
	},
	nav: {
		contentLibrary: "コンテンツライブラリ",
		signedInAs: "{name} · {role}",
		brand: "Bitmovin OVP",
		tagline: "エンコード管理コンソール",
		sectionPlatform: "プラットフォーム",
		sectionLibrary: "ライブラリ",
		sectionSystem: "システム",
		menu: "ナビゲーション",
		openMenu: "ナビゲーションメニューを開く",
		dashboard: "ダッシュボード",
		vodJobs: "VOD ジョブ",
		liveChannels: "ライブチャンネル",
		pseudoLiveFeeds: "疑似ライブ配信",
		vmafLab: "VMAF ラボ",
		storage: "ストレージ",
		presets: "プリセット",
		templates: "テンプレート",
		verification: "検証",
		settings: "設定",
		signOut: "サインアウト",
		signingOut: "サインアウトしています…",
		authDisabled: "認証は無効です。このインストールは誰でもアクセスできます。",
		sectionDiagnostics: "診断",
		apiCoverage: "API カバレッジ",
	},
	permission: {
		title: "アクセス権限がありません",
		body: "この画面を表示する権限がありません。管理者にアクセス権を依頼してください。",
		roles: "必要なロール: {required} ／ 現在のロール: {current}",
		checking: "権限を確認しています…",
		unverified:
			"権限を確認できませんでした。ページを再読み込みするか、もう一度お試しください。",
		retry: "再試行",
		reauthenticationTitle: "サインインが必要です",
		reauthenticationBody:
			"セッションの有効期限が切れたか、無効になりました。続行するには、もう一度サインインしてください。",
		reauthenticationAction: "もう一度サインイン",
	},
	locale: {
		label: "言語",
		en: "English",
		ja: "日本語",
		description:
			"UI の文言にのみ適用されます。Bitmovin API の値・リソース ID・ログ出力はそのまま表示されます。",
	},
	login: {
		title: "サインイン",
		subtitle:
			"この Bitmovin OVP インストールのチーム共有パスワードを入力してください。",
		passwordLabel: "チームパスワード",
		usersSubtitle:
			"メールアドレスとご自身のパスワードでサインインしてください。",
		userPasswordLabel: "パスワード",
		emailLabel: "メールアドレス",
		emailRequired: "メールアドレスを入力してください",
		passwordRequired: "パスワードを入力してください",
		submit: "サインイン",
		submitting: "サインインしています…",
		failed: "サインインに失敗しました",
		notConfiguredTitle: "認証が設定されていません",
		notConfiguredBody: "このインストールではまだサインインできません。",
		disabledTitle: "認証は無効です",
		disabledBody:
			"この環境では認証を使用しません。アクセスできる利用者をネットワーク側で制限してください。",
		continueToConsole: "コンソールへ進む",
	},
	setup: {
		title: "初回セットアップ",
		subtitle:
			"このインストールにはまだユーザーがいません。サーバーログの一回限りのセットアップコードで最初の ADMIN アカウントを作成してください。",
		codeLabel: "セットアップコード",
		codeHint:
			"サーバーログに一度だけ出力されます — docker compose logs web | grep setup-code",
		codeRequired: "セットアップコードを入力してください",
		emailLabel: "管理者メールアドレス",
		emailRequired: "メールアドレスを入力してください",
		displayNameLabel: "表示名",
		displayNameRequired: "表示名を入力してください",
		passwordLabel: "パスワード(12 文字以上)",
		passwordRequired: "パスワードを入力してください",
		passwordTooShort: "12 文字以上で入力してください",
		submit: "管理者を作成してサインイン",
		submitting: "作成しています…",
		failed: "セットアップに失敗しました",
	},
	rotate: {
		title: "新しいパスワードの設定",
		subtitle:
			"仮パスワードを置き換えるまで、このアカウントでは操作できません。本人だけが知る新しいパスワードを設定してください。",
		currentLabel: "現在の(仮)パスワード",
		currentRequired: "現在のパスワードを入力してください",
		newLabel: "新しいパスワード(12 文字以上)",
		newRequired: "新しいパスワードを入力してください",
		newTooShort: "12 文字以上で入力してください",
		confirmLabel: "新しいパスワード(確認)",
		confirmMismatch: "パスワードが一致しません",
		submit: "パスワードを変更",
		submitting: "変更しています…",
		failed: "パスワード変更に失敗しました",
	},
	common: {
		accessAdminOnly:
			"この領域は管理者専用です。アクセスが必要な場合は管理者に依頼してください。",
		cancel: "キャンセル",
		close: "閉じる",
		confirm: "確認",
		copy: "コピー",
		copied: "コピーしました",
		delete: "削除",
		edit: "編集",
		loading: "読み込んでいます…",
		none: "なし",
		refresh: "更新",
		retry: "再試行",
		save: "保存",
		saving: "保存しています…",
		sentenceEnd: "。",
		unknown: "不明",
		unknownError: "原因不明のエラー",
		deleting: "削除しています…",
		deleteAria: "{resource} を削除",
		deleteAriaDisabled: "{resource} を削除(無効)",
		renditionNumbered: "レンディション {n}",
		errorPrefix: "エラー",
		name: "名前",
		status: "ステータス",
		created: "作成日時",
		duration: "所要時間",
		progress: "進捗",
		actions: "操作",
		labels: "ラベル",
		region: "リージョン",
		clear: "クリア",
		select: "選択…",
		view: "表示",
		provider: "プロバイダ",
		requestFailed: "リクエストに失敗しました。もう一度お試しください。",
	},
	customerError: {
		tenantIpDenied:
			"このIPからは組織にアクセスできません。管理者へ確認してください。",
		tenantChanged:
			"組織が切り替わりました。画面を再読み込みしてから続けてください。",
		tenantMembershipRequired:
			"この組織へアクセスできません。所属と権限を確認してください。",
		tenantIpInvalid: "各行に有効なIPアドレスまたはCIDRを入力してください。",

		authNotConfigured:
			"認証の設定が完了していません。管理者にログイン方法と認証設定の確認を依頼してください。",
		authProviderUnavailable:
			"このログイン方法は利用できません。管理者に対応済みのログイン方法への変更を依頼してください。",
		authInvalidCredentials:
			"メールアドレスまたはパスワードが正しくありません。",
		authPasswordExpired:
			"仮パスワードの有効期限が切れています。管理者に再発行を依頼してください。",
		authRateLimited:
			"サインインの失敗が続いたため、一時的に受け付けていません。しばらく待ってから再実行してください。",
		authBusy:
			"サインイン要求が集中しています。数秒待ってから再実行してください。",
		authPasswordRequired: "パスワードを入力してください。",
		authEmailRequired: "メールアドレスを入力してください。",
		authCredentialsChanged:
			"サインインの確認中に資格情報が変更されました。現在のパスワードで再実行してください。",
		authModeUnsupported:
			"このログイン方法ではブラウザセッションを作成できません。管理者に認証設定の確認を依頼してください。",
		authSetupRequired:
			"管理者の初期設定が必要です。セットアップ画面で最初の管理者アカウントを作成してください。",
		storageEndpointNotAllowed:
			"このストレージ接続先は現在のデプロイ環境では許可されていません。資格情報を保存する前に、管理者へストレージ接続先の許可リストの確認を依頼してください。",
		storageBrowseUnsupported:
			"この資格情報では、この画面からストレージを参照できません。バケット名とオブジェクトパスを手動で入力するか、参照可能なストレージ資格情報を選択してください。",
		resetCleanupUnconfirmed:
			"以前の処理で作成された配信リソースの後処理を確認できないため、データをリセットできません。システム管理者またはサポート窓口にお問い合わせください。",
		resetProviderResourcesUnconfirmed:
			"クラウドのエンコーディングリソースが動作中の可能性があります。表示されたエンコーディング ID を Bitmovin で確認し、動作中のリソースを停止してからデータのリセットを再実行してください。",
		resetLocalWorkActive:
			"VMAF 測定または疑似ライブ配信が実行中です。それぞれの画面で完了を待つか停止してから、データのリセットを再実行してください。",
		resetActiveWork:
			"エンコーディングまたはライブ処理が実行中です。実行中の処理を停止し、停止完了を待ってからデータのリセットを再実行してください。",
		resetStateChanged:
			"データのリセットを開始する前にシステムの状態が変わりました。現在の状態を確認してから再実行してください。",
		resetAisaSnapshotRequired:
			"完了済みの AI Scene Analysis ジョブが、コンテンツライブラリへの自動退避を待っています。ジョブで進捗を確認してから、この画面に戻ってください。退避前はリセットできません。退避済みのライブラリデータは、ジョブ履歴をリセットしても保持されます。",
		liveNotStartable:
			"チャンネルの状態は {status} です。CREATED、ERROR、STOPPED のときに開始できます。画面を更新し、現在の状態を確認してください。",
		liveRunAlreadyActive:
			"このチャンネルには実行中の配信があります。別の配信を開始せず、その配信を開いてください。",
		liveNotStoppable:
			"チャンネルの状態は {status} です。停止できるのは RUNNING または ERROR のときです。画面を更新し、現在の状態を確認してください。",
		liveStopHandoffMissing:
			"この配信に対する直前の停止要求を確認できません。画面を更新してから再実行してください。",
		liveStopHandoffComplete:
			"直前の停止要求は処理中ではありません。画面を更新し、チャンネルの状態を確認してください。",
		liveNotRestartable:
			"チャンネルの状態は {status} です。再起動できるのは RUNNING または ERROR のときです。画面を更新し、現在の状態を確認してください。",
		liveRestartRequiresNewRun:
			"この配信はすでに終了しているため再起動できません。「チャンネルを開始」で新しい配信を開始してください。",
		liveStateChanged:
			"要求の受付中にチャンネルの状態が変わりました。画面を更新し、現在の状態に合う操作を再実行してください。",
		liveNoEncoding:
			"この操作に使うエンコーディングがまだありません。チャンネルを開始し、起動準備の完了を待ってください。",
		liveCurrentRunMissing:
			"現在の配信を特定できません。画面を更新し、復旧しない場合は管理者へ連絡してください。",
		liveProviderEncodingMissing:
			"現在の配信にはエンコーダがまだ割り当てられていません。チャンネルの起動準備が終わってから再実行してください。",
		liveProviderTransitional:
			"エンコーダはまだ RUNNING ではありません。プロバイダーの状態が RUNNING になってから再実行してください。",
		liveProviderUnobserved:
			"エンコーダの状態をまだ確認できていません。次回の状態確認後に再実行してください。",
		liveProviderUnknown:
			"現在エンコーダの状態を確認できません。30 秒ごとに再確認します。新しい確認結果を待って再実行するか、チャンネルを停止してください。",
		liveProviderTerminal:
			"この配信のエンコーダはすでに終了しています。「チャンネルを開始」で新しい配信を開始してください。",
		liveDeploymentRestricted:
			"このチャンネル設定は現在のデプロイ環境では利用できません。開始前にリージョンと出力先を確認してください。",
		liveTimeshiftRequiresRunning:
			"タイムシフトをリセットできるのは RUNNING のときです。現在の状態は {status} です。",
		liveCueRequiresRunning:
			"SCTE 35 メッセージを送信できるのはチャンネルが RUNNING のときです。現在の状態は {status} です。",
		liveRequestConflict:
			"このリクエスト ID は別の SCTE 35 メッセージに使用されています。新しいリクエスト ID で意図したメッセージを送信してください。",
		liveRequestAmbiguous:
			"SCTE 35 メッセージがすでに送信された可能性があります。再実行する前に操作履歴でスケジュールアクションの実行結果を確認してください。",
		liveRequestInProgress:
			"SCTE 35 メッセージの送信は処理中です。操作履歴でスケジュールアクションの実行結果を確認してから再実行してください。",
		liveAccountMissing:
			"このチャンネルには Bitmovin アカウントが関連付けられていません。ライブ操作の前に正しいアカウントを関連付けてください。",
		liveAccountMismatch:
			"選択した Bitmovin アカウントはこのチャンネルのものではありません。画面を更新し、このチャンネルのアカウントを選択してください。",
		liveRequiresRunning:
			"この操作はチャンネルが RUNNING の間だけ利用できます。現在の状態は {status} です。チャンネルを開始し、入力の接続を確認してから再実行してください。",
		liveIngestNotConnected:
			"入力がまだ CONNECTED ではありません。入力の状態が CONNECTED になってから再実行してください。",
		liveEncodingUnavailable:
			"チャンネルのエンコーディングはまだ利用できません。起動準備の完了を待ってから再実行してください。",
		liveAccountUnavailable:
			"チャンネルの Bitmovin アカウントが見つかりません。利用可能なアカウントを関連付けてからライブ操作を行ってください。",
		vmafNotRunning:
			"VMAF キャプチャはチャンネルが RUNNING の間だけ利用できます。現在の状態は {status} です。",
		vmafOutputUnreadable:
			"出力 {output} のレンディション {rendition} を VMAF で読み取れません。このキャプチャには読み取り可能なオブジェクトストレージ出力を使用してください。",
		vmafFeederRequired:
			"VMAF キャプチャには比較元となる疑似ライブのファイル入力が必要です。ファイル入力を開始または関連付けてから再実行してください。",
		vmafFirstSegmentPending:
			"対象すべての出力セグメントをまだ確認できません。入力・出力を確認し、少し待って再実行してください。",
		vmafReadinessUnobservable:
			"出力の準備を確認できません。出力設定と読み取り権限を確認して再実行してください。",
		channelStopBeforeDelete:
			"チャンネルの状態は {status} です。先にチャンネルを停止し、停止完了後に削除してください。",
		channelVmafInProgress:
			"このチャンネルの VMAF 測定は {status} です。測定が完了してから削除してください。",
		channelStateChanged:
			"処理中にチャンネルの状態が変わりました。画面を更新し、現在の状態を確認してから再実行してください。",
		runtimeCapBeforeProgramEnd:
			"最大配信時間が番組の終了予定より前です。番組終了後になるよう最大配信時間を延長してください。",
		feederLimitReached:
			"同時に実行できるファイル入力は {limit} 件です（現在 {current} 件）。不要なファイル入力を停止し、停止完了後に再実行してください。",
		feederChannelOccupied:
			"このチャンネルでは別のファイル入力が動作中です。新しい入力を切り替えとして準備するか、現在の入力を停止してください。",
		feederSwitchRequiresActive:
			"切り替え元のファイル入力がありません。通常のファイル入力として開始してください。",
		feederChannelNotReady:
			"チャンネルの状態は {status} です。ファイル入力は PROVISIONING または RUNNING のときに開始できます。",
		feederRunMissing:
			"現在の配信を確認できません。チャンネルを開始し、実行の作成完了後に再実行してください。",
		feederStopNotNeeded:
			"ファイル入力はすでに終了しています（状態: {status}）。画面を更新して現在の状態を確認してください。",
		feederStopBeforeDelete:
			"ファイル入力を削除する前に停止してください。停止完了後に画面を更新して削除を再実行してください。",
		feederShutdownPending:
			"ファイル入力の停止確認中です。しばらく待って画面を更新し、停止完了後に削除してください。",
		feederStateChanged:
			"処理中にファイル入力セッションの状態が変わりました。画面を更新し、現在の状態を確認してから再実行してください。",
		feederChannelNotFound:
			"選択したチャンネルは存在しません。チャンネル一覧を更新し、利用可能なチャンネルを選択してください。",
		feederSourceCredentialMissing:
			"選択したストレージ認証情報は利用できません。入力ファイルを読み取れる認証情報を選択または作成してください。",
		feederSrtCredentialInvalid:
			"選択した SRT パスフレーズ認証情報は利用できないか、種類が正しくありません。SRT パスフレーズ用の認証情報を選択してください。",
		feederSourceUnreadable:
			"入力ファイルを読み取れません。ストレージ認証情報、バケット、オブジェクトパス、読み取り権限を確認してから再実行してください。",
		scheduleLeadTimeTooShort:
			"放送開始までにチャンネル起動に必要な {seconds} 秒を確保できません。放送開始を遅らせるか、起動時刻を早めてください。",
		scheduleFireTimeNotFuture:
			"現在より後の実行時刻を選択し、スケジュールアクションを再登録してください。",
		scheduleOutsideRunWindow:
			"このスケジュールアクションはチャンネルの最大配信時間を超えています。実行時刻を早めるか、最大配信時間を延長してください。",
		scheduleContentNotFound:
			"選択した差し込みコンテンツは現在のエンコーディングで利用できません。コンテンツ一覧を更新して選び直してください。",
		scheduleContentNotReady:
			"選択した差し込みコンテンツの状態は {status} です。READY になるまで待ち、一覧を更新してから再実行してください。",
		scheduleNotCancellable:
			"このスケジュールアクションはすでに {status} のためキャンセルできません。スケジュールを更新して最新の状態を確認してください。",
		contentRequestConflict:
			"このリクエスト ID は別の差し込みコンテンツ設定に使用されています。新しいリクエスト ID で意図した差し込みを実行してください。",
		contentStateChanged:
			"差し込みの受付前に現在の配信またはエンコーダが変わりました。画面を更新し、チャンネルが RUNNING、入力が CONNECTED であることを確認してから再実行してください。",
		contentRequestBlocked:
			"この差し込み要求はまだ開始できません。スケジュールで現在の差し込み状態を確認し、再実行するか新しいリクエスト ID を使用してください。",
		contentInsertNotActive:
			"現在再生中の差し込みコンテンツはないため、停止操作は不要です。予約済みの差し込みを更新して現在の状態を確認してください。",
		contentReservationNotCancellable:
			"この差し込み予約はすでにキャンセルできない状態です。予約済みの差し込みを更新して最新の状態を確認してください。",
		// C36 (WP-A2): the slate compatibility preflight.
		slateIncompatible:
			"この素材はライブ配信と一致しません。Bitmovin では READY として登録されますが、差し込み時に失敗します。フレームレート、音声サンプルレートなどが入力と一致する素材を選んでください。",
		slateUnsupportedImage:
			"静止画スレートを登録できませんでした。JPG または PNG を使い、差し込み時に表示時間を指定してください。",
		slateUninspected:
			"素材の検査がまだ完了していません。互換性チェックの完了を待ってから、もう一度登録してください。",
		slateSourceUnsupported:
			"このストレージ認証情報は差し込み素材に使えません。S3、S3 互換、GCS（HMAC）、Azure Blob のいずれかにあるファイルを選んでください。",
		alertChannelNotFound:
			"選択したチャンネルは存在しません。チャンネル一覧に戻り、利用可能なチャンネルを選択してからルールを追加してください。",
		alertAlreadyResolved:
			"このアラートはすでに解決済みです。画面を更新して最新の状態を確認してください。",
	},
	nextAction: {
		regionLabel: "次にやること",
		startEncoderTitle: "チャンネルを開始する",
		startEncoderBody:
			"まだ何も動いていません。起動するとエンコーダのインスタンスが立ち上がり、その後は入力の接続を待ちます。起動時間はリージョンや構成で異なります。",
		recoverTitle: "前回の配信の状態を確認してください",
		recoverBody:
			"診断と終了理由、エンコーダの状態を確認してから次の操作を選んでください。",
		bootTitle: "起動中",
		bootBody:
			"起動時間はリージョンと構成で異なります。取り消すには操作へ移動してください。",
		stoppingTitle: "停止中 — 待つだけです",
		stoppingBody:
			"エンコーダを停止しています。下のステップログに停止手順が出ます。完了するとチャンネルは STOPPED になります。",
		connectInputTitle: "入力を接続してください",
		connectInputBody:
			"エンコーダは起動済みで入力待ちです。入力がバインドされるまで出力タイムラインが存在しないため、スレートを差し込んでも何も映りません。フィーダーを起動するか、Ingest URL へ配信してください。",
		outputTitle: "最初のセグメントを待っています",
		outputBody:
			"入力は接続済みですが、マニフェストにまだ再生可能なレンディションがありません。実測ではプローブ開始から 31.8 秒で最初のセグメントが出ました。",
		alertsTitle: "アラートが発生中です",
		alertsBody:
			"配信中ですがルールが発火しています。他より先に内容を確認し、解消するかチャンネルを停止してください。",
		alertsUnknownTitle: "アラート状態を取得できませんでした",
		alertsUnknownBody:
			"アラート一覧を読み込めなかったため、このチャンネルが正常だとは誰にも言えません。取得失敗は「アラート 0 件」ではありません。アラートのカードを開いて再取得し、アプリが自身の API に到達できているか確認してから監視できている状態として扱ってください。",
		/* An unreadable provider state proves neither running nor stopped. */
		providerUnknownTitle: "Bitmovin エンコーダ状態未確認",
		providerUnknownBody:
			"この配信の Bitmovin エンコーダ状態は未確認、または最新の確認に失敗しているため、オンエア中とは判断できません。30 秒ごとに再確認します。停止は可能です。ほかの配信操作は状態確認後に行ってください。",
		onAirTitle: "オンエア中",
		onAirBody:
			"入力は接続済み、アラートなし、マニフェストは再生可能です。番組終了時にチャンネルを停止してください。",
		startNewRunTitle: "新しい配信を開始",
		startNewRunBody:
			"このチャンネルの前回の配信は終了しています。エンコーディングは FINISHED で再起動できません(Bitmovin の仕様であり故障ではありません)。開始すると新しい配信が始まります — 新しいエンコーダ、同じチャンネル、スケジュールとルールはそのまま有効です。",
		scheduledTitle: "スケジュールが実行します",
		scheduledBody:
			"待機中のスケジュール行が自動で発火します。手動で起動する必要はありません。",
		idleTitle: "やることはありません",
		idleBody:
			"チャンネルは停止中で、待機中のスケジュールもありません。チャンネルを開始するか、スケジュールアクションを登録してください。",
		goActions: "操作へ",
		goFeeders: "フィーダーへ",
		goSchedule: "スケジュールへ",
		goAlerts: "アラートへ",
		goManifests: "マニフェストへ",
		goSteps: "ステップログへ",
	},
	/* Six content levels: headings identify landmarks; descriptions explain their contents. */
	liveLayer: {
		/* Headings name concepts. Lead text lists contents; title help explains the concept. */
		operations: "チャンネルの状態",
		operationsLead: "アラート・マニフェスト・スレート予約",
		operationsHelp:
			"アラート、再生リンク、スレート予約を確認・操作する領域です。現在値は上の「配信状態」で確認できます。",
		programme: "番組・スケジュール",
		programmeLead: "番組の予定・コンテンツ差し込み・緊急停止。",
		input: "入力・擬似ライブ",
		inputLead: "映像がどこから来て、何が送出しているか。",
		delivery: "出力・配信",
		deliveryLead: "DVR・DNS・配信終了後の VOD 化・VMAF 品質キャプチャ",
		deliveryHelp:
			"出力グループとマニフェスト、DVR、配信終了後の VOD 化、VMAF 品質レポートの範囲です。",
		diagnostics: "診断・履歴",
		diagnosticsLead: "生のテレメトリ、過去の配信、一度だけ設定する項目。",
		danger: "取り消せない操作",
		dangerLead: "元に戻せません。日常の配信運用には含まれません。",
	},
	/* Explain operational differences: input and output are separate observations; slate insertion is distinct from input switching, overlays and input-loss slates; file sources are not provider Input resources; automatic shutdown can precede the scheduled end. */
	liveHelp: {
		ingest:
			"RTMP または SRT で接続する入力先のアドレスとストリームキーです。方向(push / listener / caller)は入力設定で決まります。ここに映像が届くと、入力・エンコーダの状態に受信中と表示されます。",
		heartbeat:
			"30 秒ごとにエンコーダから入力とエンコードの統計を取得して表示します。出力先の更新や視聴者側の再生を確認するものではありません — それは出力モニタリングで確認します。",
		origin:
			"出力先の HLS メディアプレイリストを読み取り、セグメント更新・ENDLIST・ライブエッジ遅延を表示します。チャンネル状態や入力・エンコーダの状態とは別の確認で、視聴者側の再生を保証するものではありません。",
		schedule:
			"指定時刻にチャンネルの開始・停止・スレート挿入を実行する予約です。予約済み、実行要求済み、プロバイダー受付済み、メディアで確認済みはそれぞれ別の状態として表示します。遅れた停止は必ず実行されますが、遅れすぎた開始・スレートは未実行になります。",
		slate:
			"番組に上書きして差し込むコンテンツ(スレート)の予約です。予約済みは現在挿入中であることを示しません。AWS MediaLive の input switch・static image overlay・input-loss slate とは別の機能で、入力の切り替えや静止画の重ね合わせは行いません。",
		insertion:
			"差し込むコンテンツをここで登録します。指定時刻の挿入は下の「スケジュールアクション」で設定します。",
		insertionStop:
			"「スケジュールアクション」で挿入した内容を今すぐ停止します。予約リストには影響しません。",
		feeders:
			"保存済みのMP4を繰り返し送出し、ライブチャンネルの入力として使用します。AWS Elemental MediaLiveのInputリソースそのものではありません。",
		runtimeCap:
			"安全のための自動停止です。稼働時間がこの分数に達するとチャンネルを自動で停止します(稼働開始を確認した時点から計測)。予定している番組終了より前に停止することがあり、停止が完了するまでが課金対象です。",
		liveToVod:
			"配信終了後に、ライブ出力から VOD 用のマニフェストを作成します。配信中に書き出されたセグメントをそのまま使うため、別途アーカイブを録画する AWS の Archive output group と同じものではありません。",
	},
	/* Live-specific step names follow operator tasks without renaming the shared VOD labels. */
	liveMirror: {
		title: "ストレージミラー",
		enable: "ストレージにも同時出力する",
		help: "主出力と同じパス・公開設定でセグメントとマニフェストを複製します。MP4アーカイブの公開設定は別です。",
		unsupported:
			"ミラーにはMSL・配信サーバーではなくストレージを選択してください。",
		sameDestination:
			"主出力とは異なるストレージ資格情報かバケットを選択してください。",
		unavailable:
			"ミラーの資格情報が利用できません。ストレージ資格情報を選択してください。",
	},
	liveArchive: {
		title: "MP4 アーカイブ",
		enable: "MP4 アーカイブを保存",
		help: "既存の H.264 映像 1 本と AAC 音声を、ライブ配信と同時に保存します。別のエンコードは作成しません。保存先はストレージのみで、Akamai MSL は選択できません。",
		requiresStreams:
			"先に「エンコード」で H.264 映像と AAC 音声を追加してください。",
		video: "映像",
		audio: "AAC 音声",
		selectStream: "ストリームを選択",
		unavailableStream: "選択したストリームがありません。選び直してください",
		unavailableDestination:
			"選択したストレージがありません。選び直してください",
		destination: "アーカイブの保存先",
		separateStorage: "アーカイブ専用ストレージ",
		originStorage: "既存の主ストレージ出力",
		mirrorStorage: "既存のミラーストレージ出力",
		credential: "接続情報",
		bucket: "バケット / コンテナー",
		path: "アーカイブの保存パス",
		pathHelp:
			"初回は指定パス、再放送は固有プレフィックス付きのパスに保存します。チャンネル複製時は別の保存パスを選んでください。ストレージの配信ミラーにも保存しますが、保存先自身には重複しません。MSL の配信ミラーとは併用できません。",
		filename: "ファイル名",
		access: "アーカイブのアクセス権",
		private: "非公開を指定（既定）",
		publicRead: "公開読み取りを許可",
		destinationDefault: "保存先の既定値を使用（権限を指定しない）",
		verifyAfterStop:
			"停止後にファイルの取得・再生と映像／音声の長さを確認してください。非公開は PRIVATE を指定しますが、バケットポリシーなどによる公開は別途確認が必要です。保存先の既定値では公開される場合があります。ライブ再生用 URL ではなく、配信検証だけではアーカイブ完成・プラン全体の検証は未確定です。",
	},
	liveWizard: {
		outputWidth: "幅（px）",
		outputWidthHint:
			"空欄は入力の縦横比を継承します。幅と高さの両方を指定すると出力サイズを固定します。片方だけの指定は 16:9 として Live HD の範囲を判定します。",
		customLiveNotice: "この設定では Custom Live になります。",
		customLiveExplanation:
			"次の設定ではLive HDへの適合を確認できないため、Custom Liveの課金方式で開始します。エラー時に別の課金方式へ自動再送することはありません。",
		customLegacy: "保存済みプランの従来のCustom Live起動方式を維持します。",
		customRequested: "読み込んだプランでCustom Liveが明示指定されています。",
		customCodec: "コーデック {actual} はLive HD（H264 / AAC）の範囲外です。",
		customInputProtocol:
			"{actual}入力のLive HD対応は未確認です。対応を確認できる入力はRTMP・冗長RTMP・SRTです。",
		customInput:
			"{actual} が入力依存または未指定のため、Live HDへの適合を確認できません。",
		customVideoCount: "映像ストリーム数 {actual}：Live HDは最大{limit}本です。",
		customHdCount: "HD映像ストリーム数 {actual}：Live HDは最大{limit}本です。",
		customLongEdge: "映像の長辺 {actual}px：Live HDの上限は{limit}pxです。",
		customShortEdge: "映像の短辺 {actual}px：Live HDの上限は{limit}pxです。",
		customFps: "フレームレート {actual}fps：Live HDの上限は{limit}fpsです。",
		customVideoBitrate:
			"映像ビットレート {actual}bps：Live HDの1本あたりの上限は{limit}bpsです。",
		customPixels: "映像の合計画素数 {actual}：Live HDの上限は{limit}です。",
		customTotalBitrate:
			"映像の合計ビットレート {actual}bps：Live HDの上限は{limit}bpsです。",
		customAudioCount: "音声ストリーム数 {actual}：Live HDは最大{limit}本です。",
		customAudioBitrate:
			"音声ビットレート {actual}bps：Live HDの上限は{limit}bpsです。",
		customSampleRate:
			"音声サンプルレート {actual}Hz：Live HDの上限は{limit}Hzです。",
		customChannels: "音声チャンネル数 {actual}：Live HDは最大{limit}chです。",
		customMode:
			"エンコードモード {actual} はLive HDのシングルパス方式の範囲外です。",
		customPreset: "プリセット {actual} はLive HDの対応範囲外です。",
		customManifests:
			"出力マニフェスト数 {actual}：Live HDは最大{limit}本です。",
		stepBasics: "基本設定",
		stepInput: "入力",
		stepEncodes: "映像・音声エンコード",
		stepDestinations: "出力先",
		stepOutputGroups: "出力グループ・マニフェスト",
		stepRunSafety: "自動再起動・自動停止",
		stepScheduleActions: "スケジュールアクション",
		stepReview: "確認",
	},
	/* In-page navigation uses a side rail on wide screens and a menu on narrow screens. */
	liveNav: {
		regionLabel: "セクション",
		jumpTo: "セクションへ移動",
		jumpToClose: "閉じる",
	},
	/* Use one polite live region and announce only changes. */
	liveAnnounce: {
		ingestConnected: "取り込みが接続されました。",
		ingestDisconnected: "取り込みが切断されました。",
		heartbeatFresh: "ハートビートが最新に戻りました。",
		heartbeatStale: "ハートビートが古くなりました。",
		alertOpened: "アラートが発生しました(発生中 {count} 件)。",
		alertResolved: "アラートが解決しました(発生中 {count} 件)。",
		scheduleArmed: "{time} に {action} を予約しました。",
		scheduleCancelled: "予約を取り消しました。",
	},
	status: {
		regionLabel: "チャンネルの状況",
		ingest: "Ingest",
		ingestConnected: "接続済み",
		playable: "再生可能",
		never: "未受信",
		unknown: "不明",
		none: "なし",
		clockSkew: "時刻ずれ",
		secondsAgo: "{seconds}秒前",
		summaryNextFire: "次回 {action} {time}",
		summaryNoneArmed: "待機なし",
		summaryFeeders: "{count} 稼働",
		summaryRenditions: "{count} レンディション",
		summaryOpenAlerts: "{count} 件発生中",
		summaryStepsDone: "{done}/{total} 完了",
		summaryStreams: "{count} ストリーム",
		summaryLinks: "{count} 本",
		summaryUnavailable: "取得できませんでした",
		readUnavailable:
			"取得できませんでした。「なし」ではありません。再取得し、アプリが自身の API に到達できているか確認してください。以下に表示されているものがあれば、最後に取得できた内容です。",
		/* Two duration cells in the page header. */
		nextEvent: "次の予定",
		nextEventIn: "{countdown}後に{action}",
		nextEventOverdue: "{action}が{countdown}超過",
		nextEventSlate: "蓋 {seconds}秒",
		runtime: "稼働時間",
		runtimeElapsed: "経過 {elapsed}",
		runtimeRemaining: "経過 {elapsed} · 残り {remaining}",
		runtimeCapReached: "経過 {elapsed} · 上限に到達",
		/* Post-run values freeze at shutdown; they do not include the current time. */
		runtimeRan: "配信時間 {duration}",
		summaryResolvedAlerts: "解決済み {count} 件",
	},
	notFound: {
		title: "ページが見つかりません",
		body: "URL が誤っているか、指していた対象が削除されています。エンコードジョブやレポートは削除できるため、削除済みのものへのリンクはここに来ます。",
		backToDashboard: "ダッシュボードに戻る",
	},
	dashboard: {
		allPanelsHidden: "すべてのダッシュボードパネルが非表示になっています。",

		heading: "ダッシュボード",
		panelsButton: "表示パネル",
		panelsHint:
			"表示するパネルを選びます。選択内容はこのブラウザに保存されます。",
		panelsUsage: "使用量",
		panelsReset: "すべて表示",
		trends: "傾向分析",
		loadFailed: "概要を読み込めませんでした:",
	},
	insights: {
		encodedVolume: "エンコードデータ量 / 日 (GiB)",
		egressVolume: "転送量 / 日 (GiB)",
		statisticsNote:
			"選択したアカウントと期間の統計に基づき、このアプリ以外の使用量も含みます。",

		clear: "DRM なし",
		codecs: "コーデック",
		containers: "コンテナ",
		drm: "DRM",
		formatMix: "配信フォーマット構成(直近の完了ジョブ)",
		jobsByDay: "ジョブ数/日(14 日間)",
		liveAirtime: "ライブ放送時間(チャンネル別・7 日間)",
		minutesByDay: "パイプライン分数/日(実時間・14 日間)",
		moreChannels:
			"+{count} チャンネルは非表示です(放送時間上位 10 件まで表示)。",
		noFinishedJobs: "完了ジョブがまだありません。",
		noJobsYet: "期間内のジョブがまだありません。",
		noLiveRuns: "期間内のライブ実行がありません。",
		seriesCanceled: "キャンセル",
		seriesError: "エラー",
		seriesFinished: "完了",
		seriesMinutes: "分",
		seriesOther: "進行中・その他",
		unparsedPlans:
			"{count} 件の保存プランがパース不能のためフォーマット構成から除外しています(黙って落とさず計数)。",
	},
	jobs: {
		columns: "表示列",
		title: "VOD ジョブ",
		newJob: "VOD ジョブを作成",
		// QC gate column + filter .
		qc: "QC",
		qcPass: "合格",
		qcFail: "不合格",
		filterByLabel: "ラベルで絞り込み…",
		selectAllLoaded: "読み込み済みのジョブをすべて選択",
		loadFailed: "ジョブを読み込めませんでした。",
		label: "ラベル",
		all: "すべて",
		deleteConfirmMany:
			"各ジョブと、その VMAF レポート・ローカルスナップショットを削除します。Bitmovin 側のエンコーディングには手を付けません。取り消せません。",
		deleteConfirmOne:
			"このジョブと、その VMAF レポート・ローカルスナップショットを削除します。Bitmovin 側のエンコーディングには手を付けません。取り消せません。",
		rerunning: "再実行しています…",
		rerunSelected: "選択したジョブを再実行",
		noActiveInSelection: "選択に QUEUED / RUNNING のジョブがありません",
		noTerminalInSelection:
			"選択に終了済みのジョブがありません。先にキャンセルしてください",
		rerunFailed: "再実行に失敗しました",
		cancelFailed: "キャンセルに失敗しました",
		bulkDeleteFailed: "一括削除に失敗しました",
		deleteFailed: "削除に失敗しました",
		noMatches: "現在の絞り込み条件に一致するジョブはありません。",
		emptyHint:
			"ジョブがまだありません。「VOD ジョブを作成」から始めてください。",
		loadMore: "さらに読み込む",
		statusDraft: "下書き",
		statusQueued: "待機中",
		statusRunning: "実行中",
		statusAwaitingQc: "品質確認待ち",
		statusFinished: "完了",
		statusError: "失敗",
		statusCanceled: "キャンセル済み",
		statusQcFailed: "品質基準未達",
		providerFailure:
			"エンコードに失敗しました。技術情報を確認してから再実行してください。",
		technicalDetails: "技術情報",
		providerFailureDetail: "プロバイダーのエラー詳細",
	},
	playback: {
		skipToDetail: "ジョブ詳細へスキップ",
		railLabel: "再生とマニフェスト",
		whyNoUrl: "再生可能な URL がありません",
		enlarge: "拡大表示",
		previewTitle: "再生プレビュー",
		retry: "再生を再試行",
		mp4FileMissing: "保存先にMP4ファイルがありません。",
		accessDenied:
			"出力へのアクセスが拒否されました（401/403）。非公開出力の場合は、再生URLの認証と読み取り権限を確認してください。",
		storageAccessDenied:
			"保存先がMP4の取得を拒否しました。認証情報と読み取り権限を確認してください。",
		previewWhileRunning: "エンコード実行中 — ジャストインタイム マニフェスト",
		previewWaitingForOutput:
			"映像出力を確認できるまで再生を待機しています。確認でき次第、自動で再生します。",
		previewPlayNow: "今すぐ再生",
		previewAfterFinish:
			"エンコードが完了すると、ここで再生プレビューできます。",
		initialManifestTimeout:
			"初回の再生準備を時間内に確認できませんでした。入力の送出と公開バッファーを確認し、再生を再試行してください。",
		waitingForFirstSegment:
			"チャンネルの最初のセグメントを待っています。エンコーダが 1 つ書き出すまでマニフェストは公開されません(試行 {attempt} 回目)。",
		recovering:
			"再生が中断しています。Shaka Player が自動的に再試行しています。配信が復旧すると、この表示は自動的に消えます。",
		recoveryStalled:
			"60 秒経過しても再生が復旧していません。Shaka Player は再試行を続けています。配信経路と下記の再生前提条件を確認してください。",
		hlsUnsupported:
			"このブラウザは HLS 再生に対応していません（hls.js とブラウザ標準 HLS のどちらも利用できません）。",
		dashUnsupported: "このブラウザは DASH 再生に対応していません。",
		corsCheckTitle: "再生の前提条件",
		corsOk:
			"バケットの CORS 設定はこのページを許可し、range 系ヘッダーも公開しています。CORS は原因ではありません。",
		corsNoRules:
			"バケットに CORS 設定がありません。プレイヤーはマニフェストとセグメントを XHR で取得するため、このページのオリジンを許可する必要があります。公開読み取りだけでは不十分です。",
		corsOriginNotAllowed:
			"{origin} からの GET を許可する CORS ルールがないため、再生開始前にすべての取得がブロックされます。",
		corsRangeHeaderNotAllowed:
			"CORS 設定が Range リクエストヘッダーを許可していません。バイト範囲を要求するプレイヤーはプリフライトされ、バケットがそれを拒否します。",
		corsMissingExposeHeaders:
			"CORS 設定で {headers} が公開されていません。必要なレスポンスヘッダーはプレイヤーにより異なるため、この結果だけでは影響を否定できません。Access-Control-Expose-Headers に追加し、ブラウザのネットワークログでマニフェストとセグメントの取得を確認してください。",
		corsMissingExposeHeadersAdvisory:
			"CORS 設定で {headers} が公開されていません。ただし、オープンソース版 HLS プレビューの hls.js は、このヘッダーが公開されていない状態でも再生できます。この項目は参考情報であり、今回の再生失敗の原因とは判定していません。",
		corsDeclaredBase:
			"このバケットには認証情報側で公開ベース URL が宣言されているため、再生はそのホスト経由になります。本チェックが読むのはオリジンバケットの CORS 設定ですが、宣言されたホストがバケットの前段にある CDN なのか(その場合、この設定はプレイヤーに適用されません)、バケット自身のアドレスなのか(その場合はまさにこの設定が適用されます)を判別できません。推測を避けるため、判定は行いません。宣言先がバケット自身であれば、このバケットの CORS 設定こそ確認すべき対象です。CDN やカスタムドメインであれば、そちら側の CORS を確認してください。",
		corsUnknownDriver:
			"このプロバイダの CORS 設定はまだ読み取れないため、CORS が原因かどうかは判定できません。",
		corsUnknownForbidden:
			"この認証情報にはバケットの CORS 設定を読む権限(s3:GetBucketCORS)がないため、CORS が原因かどうかは判定できません。",
		corsUnknownNoBucket:
			"この出力は HTTP で配信されないため、CORS 設定はありません。",
		licenseDomainRefused:
			"Player ライセンス: このドメインは設定された Bitmovin Player キーで許可されていません。Bitmovin ダッシュボードにこのホストを登録するか、hls.js / Shaka Player（既定）へ戻してください。",
		corsCheckFailed: "バケットの CORS 設定を確認できませんでした。",
		reasonNoCredential:
			"この出力先が使用する認証情報が見つからないため、公開ホストが判定できません。",
		reasonNotPublic:
			"出力のACLが非公開（PRIVATE）のため、直接再生できません。再生用の配信URLを設定してください。",
		reasonAzureNoAcl:
			"Azure には Blob 単位の ACL がなく、匿名アクセスはコンテナ単位の設定です。そのためプランからは公開状態を判定できません。認証情報に公開ベース URL を設定してください。",
		reasonOciCompatAuth:
			"OCI の S3 互換エンドポイントは、公開読み取りのオブジェクトであっても認証を要求します。ネイティブ API のパスまたは事前認証リクエスト（PAR）を、公開ベース URL として認証情報に設定してください。",
		reasonSftpNoHttp:
			"SFTP 出力は HTTP で配信されません。前段のオリジンにパスをコピーして使用してください。",
		reasonNoBuckets:
			"この認証情報は HTTP で参照できるバケットを持たないため、再生 URL は存在しません。",
		reasonMissingConfig:
			"公開 URL の組み立てに必要な {field} が、認証情報に設定されていません。",
		reasonBadBaseUrl:
			"{bucket} に設定された公開ベース URL は使用できません。クエリやフラグメントを含まない絶対 http(s) URL を指定してください。",
		reasonInsecureEndpoint:
			"この出力は https ではなく http で配信されています。ブラウザは混在コンテンツとしてブロックします。TLS 付きのオリジンを前段に置き、そのベース URL を認証情報に設定してください。",
		reasonMslEdgeUrlNotConfigured:
			"この Akamai MSL 認証情報には配信エッジのベース URL が登録されていないため、再生リンクを組み立てられません。認証情報に Akamai のエッジベース URL を登録してください。",
		openCredentialSettings: "認証情報を開く",
	},
	jobDetail: {
		encodingModeFromLadder: "ラダーごとに指定",
		vmafLoadFailed: "VMAFレポートを読み込めませんでした。",
		retryVmafOnly: "VMAFのみ再試行",
		retryVmafOnlyHint:
			"既存の出力を使ってローカルで再計算します。再エンコードは行いません。",
		vmafRunning: "VMAFを計算中です。",
		vmafRetryQueued:
			"VMAFの再試行を受け付けました。エンコードは再実行しません。",
		ridesInContainerOf: "{key} のコンテナに同梱",
		alsoCarries: "{keys} も同梱",
		chainIngest: "Ingest {mode} 位置 {position}",
		chainFile: "ファイル {type}",
		chainDolby: "Dolby {kind} {detail}",
		chainTrim: "入力クリップ {kind}",
		chainConcat: "連結 位置 {position}",
		chainConcatMain: "連結 位置 {position}(メイン)",
		readByEncoding: "エンコード側が読み込み",
		renditions: "レンディション",
		videoRenditions: "映像",
		audioRenditions: "音声",
		subtitleRenditions: "字幕",
		colKey: "キー",
		colCodec: "コーデック",
		colResolution: "解像度",
		colChannels: "チャンネル",
		colBitrate: "ビットレート",
		colProfile: "プロファイル",
		colSampleRate: "サンプリングレート",
		colMode: "モード",
		colMuxings: "Muxing 数",
		/* Per-Title results describe actual encoder output, rather than requested renditions. */
		ptResults: "Per-Title 結果(エンコーダが実際に生成したもの)",
		ptAbsent:
			"未取得です。この機能より前に実行されたジョブは、Bitmovin 側にエンコーディングが残っている間(約 90 日)なら後から取得できます。",
		ptFailed: "結果を読み取れませんでした: {error}",
		ptCaptureNow: "今すぐ取得",
		ptCapturing: "取得中…",
		ptCaptureFailed: "取得に失敗しました: {error}",
		ptFromRun: "実行終了時に取得 — {at}",
		ptFromBackfill: "Bitmovin から後追いで取得 — {at}",
		ptScanStreamsListed: "列挙したストリーム数",
		ptScanResultsCaptured: "取得した結果数",
		ptScanMuxingsListed: "列挙した muxing 数",
		ptScanTemplatesListed: "列挙したテンプレート数",
		ptScanTemplatesDeclared: "宣言されたテンプレート数",
		ptScanUnattributed: "帰属先不明",
		ptScanConfigErrors: "コーデック設定の読取り失敗数",
		ptScanDetailLabel: "スキャン内訳 — 列挙数と取得数",
		ptIncomplete:
			"このスキャンは一覧の途中で打ち切られました。以下の段が全てとは限りません。",
		ptConfigErrors:
			"コーデック設定 {count} 件を読み取れなかったため、該当行にパラメータは表示されません。",
		ptNoResults:
			"取得は成功しましたが、結果ストリームは 1 件もありませんでした。このエンコーディングでは Per-Title アルゴリズムが何も生成していません。",
		ptColStream: "ストリーム",
		ptColApplied: "適用解像度",
		ptColAvgBitrate: "平均ビットレート",
		ptColMaxBitrate: "最大ビットレート",
		ptColSegments: "セグメント数",
		ptColMuxing: "Muxing",
		ptPathTitle:
			"このレンディションが実際に出力されたパスです。エンコード完了後に確定します。",
		ptDrmPathTitle: "このレグの {type} DRM が書き込む暗号化出力",
		/* Include the object path in each copy button name so assistive technology can distinguish them. */
		ptCopyPath:
			"レンディション {rendition}・{muxing} の出力パスをコピー: {path}",
		ptCopyDrmPath:
			"レンディション {rendition}・{muxing} の {drm} 暗号化出力パスをコピー: {path}",
		ptColParams: "パラメータ",
		ptResultParamCount: "設定 {count} 項目",
		ptResultParamsLabel: "エンコーダが選んだコーデック設定(実測)",
		ptResultParamsMissing: "未取得",
		ptFromTemplate: "テンプレート {rendition} 由来",
		ptUnattributed: "帰属先不明({count} 件)",
		// Keep the four fail-closed witnesses aligned with attributeResult.
		ptWhyUnattributed:
			"まずQC用ファイル名の一意な一致で結果を関連付けます。ファイル名がない場合、固定設定の結果はエンコーダが返した固定設定の一致、自動選択の結果はテンプレート固有の出力パスの一意な一致を使います。パスの根拠がない自動選択の結果に限り、同じコーデックの自動選択テンプレートが1つなら関連付けます。根拠が曖昧・不一致なら推測せず「帰属先不明」に残します。",
		perTitle: "Per-Title",
		perTitleScaled: "アルゴリズムが決定",
		noMuxings: "muxing なし",
		muxingDetail: "Muxing の詳細",
		viaDrmOutputs: "DRM リソースの出力経由で書き込み",
		filterChain: "フィルタチェーン",
		streamId: "ストリーム ID",
		codecConfigId: "コーデック設定 ID",
		planParameters: "プラン上のパラメータ",
		schemaDefault: "既定値",
		expandRow: "詳細を表示",
		expandRowNamed: "{rendition} の詳細を表示",
		collapseRowNamed: "{rendition} の詳細を隠す",
		collapseRow: "詳細を隠す",
		inputFiles: "入力ファイル",
		deletedCredential: "削除済みの資格情報",
		storageIo: "ストレージ入出力",
		storageInputs: "読み込み元",
		storageOutputs: "書き込み先",
		templatedPath: "テンプレート",
		playable: "再生可能",
		region: "リージョン",
		encoderVersion: "エンコーダバージョン",
		encodingMode: "エンコーディングモード",
		labels: "ラベル",
		created: "作成日時",
		encodeDuration: "エンコード時間",
		encoderStartup: "エンコーダ起動時間",
		template: "テンプレート",
		templateRevBehind: "{name}(rev {launched} → 現在 {current})",
		templateDeleted: "テンプレート削除済み(rev {rev})",
		encodingId: "エンコーディング ID",
		loadFailed: "ジョブを読み込めませんでした。",
		loading: "ジョブを読み込んでいます",
		canceling: "キャンセルしています…",
		manifests: "マニフェスト",
		copyManifestUrl: "{kind} マニフェストの URL をコピー: {value}",
		copyManifestPath: "{kind} マニフェストのパスをコピー: {value}",
		play: "再生",
		vmafReports: "VMAF レポート",
		measureVmaf: "VMAF を再計測",
		// QC gate panel .
		qcGateTitle: "QC ゲート",
		qcGateAwaiting: "測定待ち",
		qcGateMeasurementFailed: "測定失敗",
		qcGateNoVerdict: "判定なし",
		qcGateBlocking: "不合格時はマニフェスト生成を保留",
		qcGateMarkOnly: "不合格でも記録のみ(配信は継続)",
		qcGateAwaitingBody:
			"エンコードは完了しています。VMAF 測定の判定が出るまでマニフェスト生成を保留しています。",
		qcGateMetric: "指標",
		qcGateScope: "範囲",
		qcGateThreshold: "しきい値",
		qcGateTarget: "対象",
		qcGateActual: "実測値",
		qcGateResult: "結果",
		qcGateUnmeasured: "未測定",
		qcGateAllRenditions: "全レンディション",
		qcGateViewReport: "VMAF レポートを見る",
		qcGateExportJson: "レポート (JSON)",
		qcGateExportCsv: "レポート (CSV)",
		qcGateExportHtml: "印刷用レポート (HTML)",
		// Override-and-deliver .
		qcGateOverrideButton: "それでも配信する",
		qcGateOverrideConfirm: "確認: 不合格のまま配信",
		qcGateOverriding: "配信処理中…",
		qcGateOverridden: "{at} に不合格のまま配信を強制しました。",
		qcGateOverriddenNoVerdict:
			"{at} に判定なしのまま配信を強制しました(測定は完了していません)。",
		qcGateOverrideFailed: "強制配信に失敗しました: {error}",
		viewReport: "レポートを見る →",
		stepTimeline: "ステップ履歴",
		stepLogUnavailable: "このジョブのステップログはありません。",
		noResources: "このジョブのリソースはまだ記録されていません。",
		copyAsCurl: "cURL としてコピー",
		resourceId: "リソース ID",
		requeuing: "キューに再投入しています…",
		retryResume: "リトライ(再開)",
		creating: "作成しています…",
		rerunAsNew: "新規ジョブとして再実行（リトライ）",
		copyAndEdit: "設定をコピーして編集",
		retryFailed: "リトライに失敗しました",
		alreadyTerminal: "このジョブは既に完了またはキャンセルされています。",
		auxConfigLabel: "{key} — 全設定",
		auxOutputs: "サムネイル・スプライト・キーフレーム",
		filterConfigLabel: "フィルター {key} — 設定",
		keyframeInline: "{time} 秒地点",
		keyframesHeading: "キーフレーム",
		paramsCount: "{count} 個のパラメータ",
		spriteInline: "ストリーム {stream} · {distance} {unit} ごと",
		spritesHeading: "スプライト(トリックプレイ)",
		thumbnailInline: "ストリーム {stream} · {height}p · {count} 箇所({unit})",
		thumbnailsHeading: "サムネイル",
	},
	encodingActions: {
		title: "エンコード操作(上級)",
		lastStatus: "Bitmovin 側の最終ステータス",
		priority: "スケジューリング優先度",
		priorityShort: "優先度",
		priorityUpdated: "優先度を更新しました。",
		applying: "適用しています…",
		applyPriority: "優先度を適用",
		moveToInfrastructure: "インフラを変更",
		infrastructure: "インフラ",
		pickInfrastructure: "インフラを選択",
		infrastructureIdPlaceholder: "インフラ ID (UUID)",
		infrastructureIdHelp: "移動先のインフラ ID (UUID) を入力してください",
		moving: "移動しています…",
		encodingMoved: "エンコードを移動しました。",
	},
	storage: {
		title: "ストレージブラウザ",
		locationPresets: "保存先プリセット",
		selectCredential: "資格情報を選択…",
		//  (UX-02e): the option suffix for a credential this screen
		// cannot browse — was a hard-coded English "(not browsable)".
		notBrowsableSuffix: "（この画面から参照できません）",
		credential: "資格情報",
		bucket: "バケット",
		bucketAccessDenied:
			"この資格情報はこのバケット(コンテナ)で拒否されました。別のバケットにスコープされているか、このバケットの一覧権限が無い可能性があります。バケット一覧はアカウント全体を返すため、ここに出ていても開けないことがあります。別のバケットを選ぶか、権限を持つ資格情報を使ってください。",
		credentialRejected:
			"拒否されたのはバケットではなく資格情報そのものです。アクセスキーとシークレットを確認してください(フォームは書き込み専用なので、打ち間違えたシークレットは読み返せません)。あわせてこのマシンの時刻も確認してください — 15 分以上ずれていると拒否されます。資格情報を再入力するのが通常の対処です。",
		bucketListDenied: "この資格情報ではバケット一覧を取得できません。",
		browseUnsupported:
			"この資格情報では、この画面からストレージを参照できません。バケット名とオブジェクトパスを手動で入力するか、参照可能なストレージ資格情報を選択してください。",
		noAccess: "(この資格情報では権限なし)",
		findCredentialFor: "開ける資格情報を探す:",
		searchingCredentials: "他の資格情報を試しています…",
		credentialCanOpen: "この資格情報で開けます:",
		noCredentialCanOpen:
			"他の資格情報でもこのバケットは開けませんでした。このバケットにスコープされた鍵が必要です。",
		noCredentialCanOpenTruncated:
			"試した範囲の資格情報では開けませんでした。上限に達したため全ては試していません。",
		bucketName: "バケット名",
		bucketNamePlaceholder: "バケット名",
		listingBuckets: "バケットを一覧しています…",
		bucketListingUnavailable: "バケット一覧を取得できません",
		noBucketsListed:
			"この資格情報で一覧できるバケットがありません。アカウントにバケットが無いか、このキーの権限では見えません。",
		open: "開く",
		useCurrentPrefix: "現在のプレフィックスを出力先にする",
		prefixBreadcrumb: "プレフィックスのパンくず",
		credentialsLoadFailed: "ストレージ資格情報を読み込めませんでした。",
		loadMoreFailed: "追加の読み込みに失敗しました:",
		tryAgain: "再試行してください",
		listFailed: "オブジェクト一覧の取得に失敗しました",
		presetSaveFailed: "プリセットの保存に失敗しました",
		pickBucket: "参照するバケットを選択または入力してください。",
		pickCredential: "参照を開始するにはストレージ資格情報を選択してください。",
		size: "サイズ",
		modified: "更新日時",
		useAsOutput: "出力先に使う",
		useAsInput: "入力に使う",
		inspect: "検査",
		emptyPrefix:
			"表示するものがありません。プレフィックスが空か、絞り込みで除外されています。",
		filterByName: "名前で絞り込み",
		filterByExtension: "拡張子で絞り込み",
		extPlaceholder: "拡張子 (mp4)",
		loadingObjects: "オブジェクトを読み込んでいます",
		searchPrefix: "このプレフィックス内を検索…",
		filterInPrefix: "プレフィックス内で絞り込み…",
		loadMorePaged: "さらに読み込む(100 件/ページ)",
		selection: "選択中",
		input: "入力",
		output: "出力",
		saveAsPreset: "保存先プリセットとして保存",
		presetLabelPlaceholder: "プリセット名",
		presetRole: "プリセットの用途",
	},
	inspect: {
		requesting: "検査を要求しています…",
		probing: "解析中:オブジェクトの先頭を上限付きで読み取っています…",
		container: "コンテナ",
		bitrate: "ビットレート",
		streams: "ストリーム",
		rawJson: "生 JSON(ffprobe の全出力)",
		requestFailed: "検査の要求に失敗しました",
		inspecting: "検査しています…",
		reinspect: "再検査",
		historyTitle: "検査履歴({count})",
		failed: "検査に失敗しました",
		codec: "コーデック",
		profile: "プロファイル",
		resolution: "解像度",
		channels: "チャンネル数",
		sampleRate: "サンプリングレート",
		language: "言語",
	},
	qc: {
		measureAdvanced: "計測オプション",
		measureSource: "計測対象",
		measureSourceAuto: "自動（ジョブ設定に従う）",
		measureSourceMirror: "QCミラー",
		measureSourceMp4: "既存のMP4出力",
		measureSourceHint: "選択したジョブに対象の出力が必要です。",
		measurePsnr: "PSNR",
		measurePsnrInherit: "ジョブ設定に従う",
		measurePsnrOn: "PSNRを計測",
		measurePsnrOff: "PSNRを計測しない",
		measureMethod: "計測方式",
		measureMethodDefault: "標準",
		measureMethodFrameIndex: "フレーム番号・BT.709・10-bit",
		measureMethodHint:
			"フレーム番号による比較にはクラウド実行と既存MP4出力が必要です。標準とは異なるスコア世代になります。",
		measureSelectJob: "計測する完了済みジョブを選択してください。",
		measureJobsEmpty: "完了済みのジョブがありません。",
		measureJobsLoadFailed: "完了済みジョブを取得できませんでした。",
		measureSelectionMissing:
			"選択したジョブが見つかりません。別のジョブを選択してください。",
		measureProfileMissing:
			"選択したクラウドプロファイルが見つかりません。実行先を選び直してください。",
		measureCreated: "計測を作成しました。レポートを表示",
		resultlessReports:
			"{count}件のレポートには比較できるレンディションがありません: {ids}",

		previewOpen: "比較プレビューを開く",
		previewClose: "比較プレビューを閉じる",
		previewA: "レンディション A",
		previewB: "レンディション B",
		previewNone: "なし",
		previewFrame: "選択フレーム",
		previewPrevious: "前のフレーム",
		previewNext: "次のフレーム",
		previewPlay: "同時再生",
		previewPause: "同時停止",
		previewTiming: "計測フレーム {frame} · {fps} fps · {seconds}秒",
		previewCaveat:
			"画質を自動切替せず、固定のQC動画を表示します。ブラウザーでは計測フレームの時刻へ近似シークするため、FPS変換やデコードにより隣接フレームになる場合があります。mpvの厳密なフレーム再生とは異なります。",
		previewUnavailable:
			"比較には、版を特定できるVODのQC動画と計測時のFPSが必要です。古いレポートには情報が保存されていない場合があります。",
		previewLiveUnavailable:
			"計測したLive収録動画が保持されていません。現在のライブ映像は、この計測フレームの代わりには使用できません。",
		previewFailed:
			"再生できません。QC動画の削除・上書き、またはブラウザー非対応の形式が考えられます。両方のプレビューを停止しました。",
		previewLoading: "比較動画を読み込み中…",
		previewNoScore: "表示用スコアサンプルに含まれていません",
		measureExisting: "既存ジョブを計測…",
		measureJob: "完了済みジョブ",
		measureModel: "モデル",
		measureRun: "計測",
		cancelCloud: "クラウド計測を停止",
		cancelCloudTitle: "このクラウド計測を停止しますか？",
		cancelCloudConfirm:
			"「{name}」を停止します。レポートは保持されます。停止後もリソースのクリーンアップが続き、完了までは課金が続く場合があります。",
		cancelCloudFailed: "クラウド計測を停止できませんでした。",
		computeTasks: "クラウド処理の状態",
		computeScoringFrames: "計測フレーム {done}/{total}（{percent}%）",
		computeStandard: "通常VM",
		computeAttempt: "試行 {attempt} 回目",
		computeUpdated: "更新 {time}",
		computeStale: "更新待ち",
		computePhaseMANIFEST: "準備中",
		computePhaseREFERENCE_DOWNLOAD: "参照動画を取得中",
		computePhaseDISTORTED_DOWNLOAD: "出力動画を取得中",
		computePhaseMODEL_DOWNLOAD: "モデルを取得中",
		computePhaseREFERENCE_PROBE: "参照動画を検査中",
		computePhaseDISTORTED_PROBE: "出力動画を検査中",
		computePhaseALIGNMENT: "フレーム対応を検査中",
		computePhaseSCORING: "品質を計測中",
		computePhaseRESULT_UPLOAD: "結果を保存中",
		computePhaseRECEIPT_UPLOAD: "完了処理中",
		computePhaseSTAGING: "入力を準備中",
		computePhaseQUEUED: "VMの起動待ち",
		computePhaseRETRYING: "再試行中",
		computeReserved: "予約額 USD {amount}",
		computeCleaned: "クリーンアップ完了",
		computeCleanupPending: "クリーンアップ待ち",
		computeAttention: "管理者による確認が必要",
		executionTarget: "実行先",
		executionLocal: "ローカル",
		executionBudget: "予算 (USD)",
		executionBudgetInvalid:
			"0 より大きく、100,000 USD 以下の予算を入力してください。",
		executionBudgetHint:
			"クラウド実行は課金されます。予算は全出力の計測に適用され、タスクを開始できるかの判断に使います。最終請求額を保証するものではありません。",
		executionLocalOnly: "クラウド設定がないため、ローカルで計測します。",
		executionProfilesUnavailable:
			"クラウド設定を取得できませんでした。ローカルで計測できます。",
		executionCloudReport: "クラウド · {profile} · 予算 USD {budget}",
		staleScoringGeneration: "計測世代 {version} — 過小評価",
		subsampledBadge: "{stride} フレームごと — 最小値はサンプル値",
		mixedScoringGenerations:
			"これらのレポートは異なる世代のパイプラインで計測されており({generations})、数値は比較できません。世代 1 は 2026-08-11 のタイムスタンプ修正より前で、品質を過小評価します(同一エンコードで修正前 23.08、修正後 84.21)。このグラフを品質差として読む前に、古いレポートを再実行してください。",
		mixedModels:
			"これらのレポートは異なる VMAF モデルで計測されているため({models})、このグラフは 2 つのエンコードではなく 2 つの視聴条件を重ねて表示しています。モデルの違いは些細な差ではありません。同一のペアで実測したところ、vmaf_v1.0.16_3d0h は 83.01、vmaf_v1.0.16_3d0h_2160 は 92.44 で、モデルだけで 9.4 ポイント差が出ました。同じモデルのレポート同士で比較するか、各曲線を個別に読んでください。",
		mixedSubsampling:
			"これらのレポートはフレームの間引き幅が異なります(n_subsample {strides})。そのため最小値は比較できません。間引きありのレポートの最小値は「サンプルの中での最悪フレーム」であり、フル精度のレポートの最小値は「実際の最悪フレーム」です。プール後の平均値はほぼ変わらないため、この違いは見落としやすいです。最小値や調和平均を品質差として読む前に、フル精度で再計測してください。",
		title: "VMAF ラボ",
		compareSelected: "選択したレポートを比較",
		loadFailed: "VMAF レポートを読み込めませんでした。",
		report: "レポート",
		mode: "モード",
		model: "モデル",
		meanPerRendition: "レンディション別 平均 VMAF",
		deleteTitle: "この VMAF レポートを削除しますか?",
		deleteConfirmMany:
			"各レポートと、そのフレームごとの結果すべてを削除します。取り消せません。",
		deleteConfirmOne:
			"このレポートと、そのフレームごとの結果すべてを削除します。取り消せません。",
		selectAllLoaded: "読み込み済みのレポートをすべて選択",
		waitToSelect: "レポートが完了するまで選択できません",
		needTwoFinished: "比較するには完了したレポートを 2 件以上選択してください",
		needOneTerminal: "完了またはエラーのレポートを 1 件以上選択してください",
		erroredNotComparable: "エラーのレポートは削除できますが比較はできません",
		deleteFailed: "削除に失敗しました",
		bulkDeleteFailed: "一括削除に失敗しました",
		loadMore: "さらに読み込む",
		backToLab: "VMAF ラボに戻る",
		//  (UX-02e locale leaks): the list's pending cell, the compare
		// screen's deleted-report line and the delete button's resource name.
		pendingScore: "処理待ち",
		mayHaveBeenDeleted: "削除済みの可能性があります。",
		reportResourceLabel: "レポート {label}",
		noRenditionsToCompare:
			"読み込んだレポートに、比較できるレンディション結果がありません。",
		perFrame: "フレームごとの VMAF",
		qualityLadder: "画質ラダー",
		compareReports: "レポートを比較",
		all: "すべて",
		noneSelected: "なし",
		loadingReports: "レポートを読み込んでいます",
		reportLoadFailed: "VMAF レポートを読み込めませんでした。",
		reportTitle: "VMAF レポート",
		pseudoLiveAlignment: "疑似ライブの同期",
		alignmentDiagnostics: "同期診断（詳細）",
		noRenditionResults: "このレポートはレンディション結果なしで完了しました。",
		loadingReport: "VMAF レポートを読み込んでいます",
		windowedVmaf: "区間別 VMAF",
		pooledSummary: "集計サマリ",
		confidence: "信頼度",
		offsetFrames: "オフセット(フレーム)",
		reasonZerosDominate:
			"{frames} フレーム中 {zeros} フレームが 1.0 未満({percent}%)。これは品質の測定値ではなく、位置ずれ・異常な入力・モデルの想定を大きく外れたラダーのいずれかです",
		reasonZerosOrdinary:
			"{frames} フレーム中 {zeros} フレームが 1.0 未満({percent}%)。ハードカットを含む素材では通常の範囲です",
		reasonNoZeroFrames: "1.0 未満のフレームはありません",
		reasonP25BelowOne:
			"第1四分位が 1.0 未満です。少なくとも全体の 1/4 のフレームが 0 点であり、品質の測定値として成立していません",
		reasonHarmonicCollapsed:
			"算術平均は 0 でないのに調和平均が 0 に落ちています。0 点のフレームが少なくとも 1 つあり、この集計値は比較に使えません",
		reasonSound: "分布は健全に見えます",
		reasonTooFewRungs: "ビットレートを持つ段が 2 つ未満です",
		reasonAllStepsMove:
			"意味のあるビットレート差はすべてスコアを動かしています",
		reasonFlatSteps: "スコアが動かなかったビットレート差: {steps}",
		comparisonUnknown: "比較条件が不明",
		hintHarmonicMean:
			"調和平均(n ÷ Σ(1/score))。低スコアのフレームを算術平均より強く罰します — 体感品質のための標準的な VMAF 集約値です。",
		hintLow1Percent:
			"VMAF 1% low: 最悪 1% のフレームの平均。持続的なワーストケース品質 — 最も荒れた区間で視聴者が気づくものです。",
		hintMean:
			"全フレームの VMAF スコアの算術平均。高いほど良好です。通常は 0–100 ですが上限で切られてはいません — 大画面向けにチューニングされたモデルは同じバイト列で 100 を超えることがあり、軸はクリップせず伸びます。見出しの「平均品質」の数値です。",
		hintMinMax: "クリップ全体での単一フレーム VMAF の最小値と最大値。",
		hintPercentiles:
			"ソート済みフレームスコアのパーセンタイル。p5 = スコアがこの値を下回るフレームは全体の 5% のみ。低い側の裾(p1/p5/p10)は平均より体感品質を左右します。",
		hintPsnr:
			"ピーク信号対雑音比(dB、Y プレーン)。VMAF より単純な忠実度指標で、高いほど良好ですが体感品質との相関は弱めです。完全に同一のフレームは 100 dB で頭打ちになります。",
		hintWorstFrame:
			"スコア最低の単一フレーム(フレーム番号 + VMAF)。クリップ中で最も深い落ち込みで、時系列グラフにマークされます。",
		hintAlignmentConfidence:
			"同期(位置合わせ)は ±1 フレームのベストエフォートです: B フレームの並べ替えとエンコーダのパイプライン遅延により、対応する出力フレームは 1 フレーム早く/遅く現れることがあります。1 フレームずれてもほぼ正しい VMAF になります(隣接フレームは非常に似ているため)が、厳密な一致の証明にはなりません。オフセットは ±1 の精度として扱い、この信頼度でゲートしてください。",
		hintLoopMap:
			"キャプチャしたウィンドウをループするソースへ写像し直したものです。各エントリはソースループの折り返し 1 回分: それが始まる出力フレーム、再開するソースフレーム(最初の部分ループを除き 0)、ループ番号。≥3 ループのキャプチャなら ≥3 エントリになります。",
		hintFrameOffset:
			"復元されたフレームオフセット: source_index(i) = (i + offset) mod F。キャプチャウィンドウの先頭におけるループソースの位相を、フレーム毎シグネチャの相互相関でフレーム精度まで詰めたものです。",
		geometryUpscaled: "{rendition}p → {reference}p({upscale}× アップスケール)",
		geometryNative: "{rendition}p → {reference}p(等倍)",
		summaryModelPart: "モデル {model}。",
		summaryCrossResolution:
			"解像度をまたぐ VMAF: {rendition}p のレンディションを {upscale}× にアップスケールし、{reference}p のソースと比較しました。{model}攻めたラダーではスコアが低く出るのは想定内で、それ自体はエンコーダの欠陥を意味しません。",
		summaryNative:
			"等倍解像度の VMAF: {rendition}p を {reference}p のソースと比較しました。{model}ここでのスコア低下は実際の品質問題です。",
		summaryUnknownWithModel:
			"{model} で採点しました。ソースの解像度が不明なため、比較条件を提示できません。",
		summaryUnknownNoModel:
			"比較条件が不明です: レンディション側もソース側も高さが記録されていません。",
		degenerateBadge: "品質値として成立していません",
		ladderFlatBadge: "ラダーが分離していません",
		coarseAnchor: "粗アンカー",
		coarseFullSearch: "全域探索",
		loopOffsetMap: "ループオフセット表",
		loop: "ループ",
		outputFrameStart: "出力側の開始フレーム",
		sourceFrameStart: "ソース側の開始フレーム",
		confidenceCaveat: "同期信頼度の注意",
		alignmentUnverified:
			"整列未検証 — このスコアは診断用であり、品質評価の確定値ではありません。計算完了はフレーム位置合わせの確認完了を意味しません。",
		alignmentExcludedFrames: "信頼度による除外フレーム",
		alignmentMaskedFrames: "ループ境界のマスクフレーム",
		frameOffset: "フレームオフセット",
		rendition: "レンディション",
		meanHint: "「平均」の説明",
		harmonicHint: "「調和平均」の説明",
		worstFrameHint: "「最悪フレーム」の説明",
		mean: "平均",
		meanVmafSeries: "平均 VMAF",
		harmonic: "調和平均",
		min: "最小",
		max: "最大",
		worstFrame: "最悪フレーム",
		psnrMin: "PSNR 最小",
		psnrMax: "PSNR 最大",
		noFrameData: "このレポートにはフレームごとのデータがありません。",
		hidePsnr: "PSNR (dB) を隠す",
		showPsnr: "PSNR (dB) を表示",
		noSeriesFrame:
			"系列が選択されていません。上でひとつ以上選ぶとフレームごとの VMAF を描画します。",
		noSeriesData: "選択した系列にフレームごとのデータがありません。",
		noSeriesLadder:
			"系列が選択されていません。上でひとつ以上選ぶと画質ラダーを描画します。",
		scoreLegend:
			"主観評価尺度の目安: 20 ≈ bad · 40 ≈ poor · 60 ≈ fair · 80 ≈ good · 100 ≈ excellent",
		scoreLegendDisclaimer:
			"連続尺度上のおおよその目安で、区間の境界や合否基準ではありません。モデル・表示解像度・視聴距離などの評価条件を揃えて比較してください。v1の一部モデルは110まで扱います。",
		sortBitrateAscending: "ビットレートの低い順に並べ替え",
		sortBitrateDescending: "ビットレートの高い順に並べ替え",
		startFrame: "開始フレーム",
		endFrame: "終了フレーム",
		frameRangeCurrent: "現在のフレーム範囲: {start}–{end}",
		frameRangeInvalid: "開始フレームは終了フレームより後にできません。",
		frameRangeOutOfBounds: "{min}〜{max} の範囲で指定してください。",
	},
	notif: {
		deleteConfirm: "通知チャネル「{name}」を削除しますか？",

		// Page-level heading (E2E 2026-08-14: the one screen without an h1).
		pageHeading: "通知",
		pageHeadingSub: "外部への通知チャンネルと、送信するイベントの設定です。",
		addChannel: "チャンネルを追加",
		attempts: "回試行",
		channelName: "チャンネル名",
		channels: "チャンネル",
		createChannel: "チャンネルを作成",
		createFailed: "チャンネルを作成できませんでした。",
		credential: "Webhook クレデンシャル",
		disable: "無効化",
		disabled: "無効",
		enable: "有効化",
		enabled: "有効",
		eventKinds: "イベント種別",
		genericWebhook: "汎用 Webhook",
		kind: "種別",
		labelFilter: "ラベルフィルタ(任意)",
		labelFilterHint:
			"カンマ区切り。いずれかのラベルを持つジョブにマッチします。空欄なら選択した種別の全イベントに配送します。",
		needsWebhookCredential:
			"NOTIFICATION_WEBHOOK クレデンシャルがありません — 先に 設定 → クレデンシャル で作成してください(URL は vault 管理です)。",
		noChannelsYet: "チャンネルはまだありません。",
		noDeliveriesYet: "配送履歴はまだありません。",
		recentDeliveries: "最近の配送(キューから読取)",
		selectCredential: "クレデンシャルを選択…",
	},
	verification: {
		heading: "検証ラン",
		caption:
			"ハーネスの実行 1 回につき 1 行です。どのコードとスキーマに対して走ったか、どのソースのバイト列を読んだか、各シナリオの判定、そして生成されたレポートのシールを記録します。",
		loading: "検証ランを読み込んでいます…",
		loadFailed: "検証ランを読み込めませんでした。",
		noRuns: "記録された検証ランはまだありません。",
		colRun: "ラン",
		colKind: "対象",
		colStatus: "状態",
		colStarted: "開始",
		colCommit: "コミット",
		colCounts: "判定",
		notSealed: "シール未取得",
		drift: "スキーマ乖離",
		backToList: "検証ラン一覧へ戻る",
		fingerprint: "フィンガープリント",
		commit: "コミット",
		checkoutMigration: "チェックアウトのマイグレーション",
		dbMigration: "データベースのマイグレーション",
		driftLabel: "スキーマ乖離",
		driftYes:
			"あり — チェックアウトとデータベースのマイグレーションが一致しません",
		driftNo: "なし",
		startedAt: "開始",
		finishedAt: "終了",
		baseUrlOrigin: "製品のオリジン",
		actor: "実行者",
		account: "Bitmovin アカウント",
		resumedFrom: "再開元のラン",
		resumeDecision: "再開判定",
		source: "ソース",
		sourceObject: "ソースオブジェクト",
		sourceIdentity: "ソースの同一性",
		sourceIdentityUnknown: "記録なし",
		scenarios: "シナリオ",
		noOutcomes: "このランにはシナリオの結果が記録されていません。",
		colScenario: "シナリオ",
		colVerdict: "判定",
		colReason: "理由",
		colEncoding: "エンコード",
		colChecks: "チェック",
		colPlanSha: "プランのダイジェスト",
		providerReadback: "プロバイダーからの読み戻し",
		noProviderReadback:
			"プロバイダーからの読み戻しはありません。このランが放棄したエンコードはありませんでした。",
		cleanup: "クリーンアップ",
		noCleanup: "終了状態まで追い込む必要のあったジョブはありません。",
		providerTerminal: "プロバイダー側の終了",
		viewJob: "エンコードジョブを開く",
		seal: "レポートのシール",
		reportPath: "レポートのパス",
		reportSha: "レポートの SHA-256",
		sealValue: "シール",
		sealAlgorithm: "シール方式",
		sealKeyId: "シール鍵 ID",
		evidenceVersion: "証跡形式のバージョン",
		retentionUntil: "証跡の保持期限",
		sealedAt: "シール取得日時",
		refreshFailed:
			"更新できませんでした。最後に読み込んだ状態を表示しています。",
		lastUpdated: "最終更新",
		liveEvidence: "ライブ配信の証拠",
		noLiveEvidence:
			"ライブ配信の証拠は記録されていません。このランではサンプル取得まで到達したライブシナリオがありませんでした。",
		evidenceComplete: "完全",
		evidenceIncomplete: "不完全",
		evidenceAiring: "放送回",
		evidenceProbes: "プローブ",
		evidenceMedia: "確認したメディア",
		evidenceProgression: "進行",
		evidenceMissing: "欠落",
	},
	hevcV2: {
		mctf: "動き補償付き時間方向フィルタ (MCTF)",
		mctfHelp:
			"未設定はプロバイダー既定値を使用します。OFF は時間方向フィルタを無効化し、AUTO と ON は明示指定です。Per-Title の TargetQualityQP とは別のコーデック設定です。",
		perceptualConfig: "知覚品質の設定",
		perceptualHelp:
			"未設定では設定全体を送信しません。ネイティブ HEVCv2 の SMART_PASS では、未設定は CQP を使用し、PERCEPTUAL_QUALITY_MODE を選ぶと perceptualEncodingMode が OFF でもレート制御は PQP に切り替わります。OFF は知覚エンコードを無効にする明示指定ですが、CQP には戻りません。低品質フレームが減る保証はありません。",
		perceptualEncodingMode: "知覚エンコードモード",
		perceptualStrength: "知覚強度 (perceptualStrength)",
		perceptualPenaltyStrength: "知覚ペナルティ強度 (perceptualPenaltyStrength)",
		perceptualPenaltyKnee: "知覚ペナルティのニー (perceptualPenaltyKnee)",
		perceptualTemporalStrength: "知覚時間方向強度 (perceptualTemporalStrength)",
		pixelPerDegree: "1度あたりの画素数 (pixelPerDegree)",
		unitRange: "任意の 0〜1 の値。未設定はプロバイダー既定値を使用します。",
		positiveRange: "任意の正の値。未設定はプロバイダー既定値を使用します。",

		advanced: "HEVCv2 詳細設定",
		bcfOverride: "BCF オーバーライド",
		mixed:
			"HEVCv2 をすべての映像ラダーに選択し、基本設定で BCF オーバーライドを選択してください。",
		unavailable: "選択されたアカウントでは HEVCv2 を利用できません。",
		jsonOnly:
			"HEVCv2 プランは JSON で保存してください。テンプレート YAML には書き出せません。",
	},
	heartbeatWebhook: {
		slots:
			"エンコードの hook が上限の 5 件です。他アプリの登録は削除せず、Poll を継続します。",
		ambiguous:
			"登録結果が未確定です。再試行・削除前にプロバイダ側の所有関係を確認中です。Poll を継続します。",
		providerFailed:
			"プロバイダへの登録に失敗しました。アカウント権限と接続を確認してください。Poll を継続します。",
		budget: "次の登録処理枠を待っています。Poll を継続します。",
		modeLabel: "登録方式",
		modeLegacy: "従来のアカウント単位",
		title: "heartbeat webhook の間隔",
		intro:
			"Heartbeat はライブ配信ごとに個別登録します。エンコーダが未対応または対応状況が不明な場合は、定期的な状態確認を続けます。変更は次の配信から適用され、実行中の配信の間隔は変わりません。",
		intervalLabel: "設定する送信間隔（秒）",
		intervalHint:
			"1〜{max}。0 で heartbeat を無効にします。実際の受信間隔とは異なる場合があります。",
		effective: "設定した送信間隔: {interval} 秒 — {source}",
		effectiveOff: "現在有効: hook を登録しない — {source}",
		sourceGui: "この画面の設定",
		sourceEnv: "デプロイ環境変数",
		sourceDefault: "コードの既定値",
		envDefault: "デプロイ既定: {interval} 秒",
		envDefaultOff: "デプロイ既定: hook を登録しない",
		codeDefault:
			"デプロイ環境変数は未設定です。コードの既定値は {interval} 秒です",
		save: "保存",
		reset: "デプロイ既定に戻す",
		saved:
			"保存しました。次の配信から適用されます。実行中の配信の間隔は変わりません。",
		resetDone: "デプロイ既定に戻しました。",
		loadFailed: "heartbeat 設定を読み込めませんでした",
		invalid: "整数で入力してください: 送信間隔は 0 または 1〜{maxInterval}。",
	},
	usage: {
		loadedLabels: "ラベル {loaded} / {total} 件取得済み",
		partialLabelSearch: "取得済みのラベルを検索します。残りを読み込み中です。",
		findExactLabel: "完全一致で検索",
		exactLabelMissing: "この名前のラベルはありません。",
		labelCatalogHint:
			"Bitmovinのラベル一覧です。最大1分前の取得内容を表示する場合があります。",
		noLabels: "選択できるラベルがありません。",
		labelFilters: "ラベルで絞り込む",
		searchLabels: "ラベルを検索",
		noMatchingLabels: "一致するラベルがありません。",
		clearLabel: "ラベルの絞り込みを解除",
		label: "エンコードラベル",
		allLabels: "すべてのエンコード使用量",
		labelSubtitle:
			"{label} のエンコード統計です。このアプリ以外の使用量も含みます。",
		labelHint:
			"提供元のラベルを一つ選択します。VOD とライブの合算を最大 90 日分、その都度取得し、ローカル保存はしません。カンマを含むラベルは個別選択できません。",
		labelCombinedHint:
			"一つのエンコードに複数のラベルが付く場合があります。選択したラベルだけを表示し、重複するラベル同士を合計しません。ラベル統計には Live Units がありません。",
		combined: "VOD・ライブ合算",
		labelsLoadFailed: "エンコードラベルを取得できませんでした",
		retryLabels: "ラベルを再取得",
		labelIncomplete:
			"{count} 日分のラベル統計に未提供の値があります。欠測と不完全な期間合計はゼロで表示しません。",
		billableEgressTitle: "日別課金対象転送量 (GiB)",
		account: "Bitmovin アカウント",
		noAccounts: "Bitmovin アカウントが未登録です",
		fromDate: "開始日 (UTC)",
		toDate: "終了日 (UTC)",
		applyRange: "期間を表示",
		selectedRange: "表示期間: {from} — {to} (UTC)",
		autoQueued: "最新の統計の取得待ち",
		autoRunning: "最新の統計を取得中",
		autoRetry: "最新の統計を再取得",
		backfill: "この期間の統計を取得",
		backfillHint:
			"このアプリ以外で実行したジョブを含む、このアカウントの使用量を取得します。取得済みの統計も更新します。",
		backfillqueued: "取得待ち",
		backfillrunning: "取得中",
		backfillcompleted: "取得完了",
		backfillfailed: "取得失敗",
		backfillRows: "{count} 件の日次データを保存",
		backfillFailed: "統計を取得できませんでした。再度お試しください。",
		incomplete:
			"{count} 日分の統計が不足しています。合計と傾向分析は一部のデータのみです。",

		subtitle:
			"Bitmovin アカウント全体のエンコード統計です。このアプリ以外で実行したジョブも含みます。",
		negativeMinutes:
			"取得した課金対象分数に負の値が含まれています。統計の内訳を確認してください。表示値は補正していません。",
		minutesTitle: "日別のエンコード課金換算分",
		breakdownTitle: "コーデック×解像度",
		breakdownNote:
			"エンコードのストリーム内訳です。追加機能・トランスマックス分は別扱いです。",
		classBreakdownNote:
			"SD・HD・UHD は API の解像度区分で、実際の縦横サイズではありません。",
		missingCodecRecords:
			"内訳未取得の記録が {count} 件あるため、この表は一部の内訳です。",
		otherApiValues: "その他の API 報告値",
		otherApiValuesNote:
			"追加機能・トランスマックス分はエンコード分へ合算しません。負の値も報告どおり保持し、その意味は推測していません。",
		featureMinutes: "追加機能の分数",
		transmuxingMinutes: "トランスマックスの分数",
		liveUnits: "Live Units",
		notRetrieved: "未取得",
		liveUnitsNote:
			"Live HD Units は専用の Live options 統計 API から取得します。日次のエンコード課金換算分は別の指標で、Custom Live だけの合計ではありません。分数から Units へ換算しません。取得後も提供元の集計が更新される場合があります。",
		liveUnitsTitle: "日別の Live HD Units",
		liveMetric: "ライブのグラフ指標",
		liveMinutesMetric: "ライブ: エンコード課金換算分",
		liveUnitsMissing:
			"選択したアカウントの Live HD Units が {count} 日分揃っていません。欠落日や期間合計を 0 として表示しません。",
		rawTime: "timeEncoded（API の生値）",
		rawTimeNote:
			"timeEncoded は単位と集計の意味を確認中です。出力時間への換算や課金計算には使用しません。",
		period7: "7 日間",
		period30: "30 日間",
		period90: "90 日間",
		allAccounts: "すべてのアカウント",
		vod: "VOD",
		live: "ライブ",
		totalMinutes: "エンコード課金換算分",
		totalEncoded: "出力時間（API報告）",
		refreshedAt: "統計の取得時刻: {time}",
		neverRefreshed:
			"すべてのアカウント・種別の統計をまだ読み込んでいません。起動から 1 分以内に Bitmovin の日次統計を読み込み、以後は 6 時間ごとに更新します。",
		pendingDays:
			"この期間のうち {count} 日分は最後の読込より新しい日です(Bitmovin の日次集計は遅れて確定します。次回の読込で取り込みます)。",
		loadFailed: "使用量を読み込めませんでした",
		empty: "この期間の使用量はありません",
		emptyBreakdown: "この期間のコーデック×解像度の内訳は返されていません",
		bucket: "バケット",
		codec: "コーデック",
		resolution: "解像度",
		minutes: "課金換算分（API報告）",
		encodedTime: "出力時間（API報告）",
		retentionNote:
			"取得した過去の統計は保存されます。取得できる範囲は Bitmovin が返すデータによります。",
	},
	pageTitles: {
		verification: "検証ラン",
		verificationRun: "検証ランの詳細",
		playerSettings: "プレイヤー設定",
		apiCoverage: "API カバレッジ",
		features: "機能",
		reset: "データのリセット",
		apiTokens: "API トークン",
		watchFolders: "監視フォルダ",
		dashboard: "ダッシュボード",
		notFound: "ページが見つかりません",
		notifications: "通知",
		signIn: "サインイン",
		setup: "初回セットアップ",
		changePassword: "パスワード変更",
		users: "ユーザー",
		vodJobs: "VOD ジョブ",
		vodJob: "VOD ジョブ",
		newVodJob: "VOD ジョブを作成",
		liveChannels: "ライブチャンネル",
		liveChannel: "ライブチャンネル",
		newLiveChannel: "ライブチャンネルを作成",
		pseudoLiveFeeds: "疑似ライブ配信",
		feederSession: "フィーダーセッション",
		vmafLab: "VMAF ラボ",
		vmafReport: "VMAF レポート",
		compareVmafReports: "VMAF レポートの比較",
		storage: "ストレージ",
		presets: "テンプレート・プリセット",
		templates: "テンプレート",
		settings: "設定",
		bitmovinAccounts: "Bitmovin アカウント",
		storageCredentials: "資格情報",
		infrastructure: "インフラ",
		live: "ライブ",
		webhooks: "Webhook",
	},
	lifecycle: {
		/* Lifecycle durations shown here must be measured and include their sample counts. */
		aria: "エンコーダライフサイクル",
		s1: "① 起動要求",
		s1Hint:
			"エンコーダ未起動。手動起動またはスケジュールの START 行が起動します。",
		s1ErrorHint:
			"チャンネルは ERROR — Bitmovin 側でエンコーダが残っている可能性があります(停止で解放)。ここからの起動はプロビジョニング再開です。",
		/* Provider encoding state stays unknown until confirmed. A finished encoding must not imply that resources may still be running. */
		providerUnknownHint:
			"プロバイダー状態を確認できません — この配信のエンコーディングに対する Bitmovin の状態読み取りが失敗しています(最終確認 {at}、未確認 {since} から)。30 秒ごとに再確認します。停止は可能です。起動・再起動・スレート・SCTE-35・タイムシフト・新規フィーダーは再確認できるまで待機します。",
		providerUnobservedHint:
			"Bitmovin エンコーダ状態の初回確認を待っています。確認できるまではオンエア中と判定しません。",
		providerUnknownNever: "なし",
		providerTerminalHint:
			"Bitmovin がこの配信のエンコーディングを {status} と報告しました({at})— エンコーダは解放済みで再起動できません。起動すると新しい配信(新しいエンコーダ・新しい Ingest 座標)が始まります。",
		s2: "② インスタンス起動中",
		s2Hint:
			"Bitmovin がエンコーダインスタンスを起動中です。起動時間はリージョンや構成で異なります。過去の実測は設定の「ライブ」で確認できます。まだ入力は受信できません。",
		s3: "③ 入力待機",
		s3Hint:
			"エンコーダは起動済みで listen 中。まだ何も配信されていません — スレートも出力も「接続済みの入力」が必要です。フィード(またはフィーダー)を接続してください。スレート素材の登録はこの段階から可能です。",
		s4: "④ 入力接続 — エンコード・配信中",
		s4Hint:
			"パイプライン稼働中: 蓋被せ(スレート挿入)はここから有効。稼働・給送中チャンネルでの再生プローブは開始 31.8 秒で初回セグメントを観測(n=1。接続→初回セグメント自体は未計測)。",
		s7: "⑦ 停止",
		s7Hint:
			"停止中は完了を待ってください。終了したエンコーディングは再起動できません。停止後は「新しい配信を開始」で新しいエンコーダを作成します。差し込み素材は新しい配信で再登録します。",
	},
	live: {
		cancelStartFailed: "開始を取り消せませんでした。再試行してください。",
		cancelStartAccepted: "開始の取り消しを受け付けました。",
		cancelStartPending: "取り消し処理中",
		cancelStart: "開始を取り消す",
		title: "ライブチャンネル",
		providerStatusUnconfirmed: "{status} · Bitmovin 状態未確認",
		newChannel: "ライブチャンネルを作成",
		inventory: {
			title: "Live エンコーダの照合",
			hint: "手動確認時点の参考値で、所有者を確定するものではありません。未登録・停止済みチャンネルとの不一致は要確認ですが、他ツールのエンコーダを含む可能性があります。自動停止はしません。",
			account: "Bitmovin アカウント",
			select: "アカウントを選択",
			check: "今すぐ確認",
			checking: "確認中…",
			unknown: "未確認・件数不明",
			failed:
				"確認失敗・件数不明。再試行してください。大量のリソースは管理者に個別確認を依頼してください。",
			summary:
				"要確認: {count} 件 · 未終了: {running} · 未登録: {unexplained} · 終了済みチャンネルとの不一致: {contradicted} · 作成中: {inFlight}",
			checked: "確認日時:",
		},
		actions: "操作",
		loadFailed: "ライブチャンネルを読み込めませんでした。",
		encodingId: "エンコーディング ID",
		emptyHint:
			"ライブチャンネルがまだありません。「ライブチャンネルを作成」から始めてください。",
		stopBeforeDeleting: "削除する前にチャンネルを停止してください",
		deleteConfirm:
			"このチャンネルと、そのフィーダーセッション・heartbeat・ライブ VMAF レポートを削除します。Bitmovin 側のエンコーディングには手を付けません。取り消せません。",
		deleteNamed: "「{name}」を削除しますか?",
		deleteTitle: "このチャンネルを削除しますか?",
		deleteFailed: "削除に失敗しました",
		loadMore: "さらに読み込む",
		list: {
			health: "健全性",
			nextEvent: "次の予定",
			runtime: "稼働時間",
			filter: "表示",
			filterAll: "すべて",
			filterActive: "稼働中",
			filterError: "要対応",
			filterErrorHint:
				"「要対応」は ERROR 状態だけではありません。健全性列が示す異常 — 発生中のアラート、応答が止まったハートビート、失敗したフィーダー、更新が止まった出力 — もすべて含みます。",
			filterSoon: "まもなく予定あり",
			sort: "並び順",
			sortAnomaly: "異常を優先",
			sortCreated: "新しい順",
			searchPlaceholder: "名前で絞り込む",
			scopeNote:
				"絞り込みと並び替えは、ここまでに読み込んだ {count} 件に対して適用されます。残りを含めるには追加で読み込んでください。",
			matchNone: "この条件に一致するチャンネルはありません。",
			rowMenu: "「{name}」の操作",
			openChannel: "チャンネルを開く",
			countdownDue: "予定時刻を過ぎています",
			countdownIn: "あと {duration}",
			elapsed: "{duration} 経過",
			remaining: "上限まで {duration}",
			noCap: "上限なし",
			capExceeded: "上限を超過",
			outputAdvancing: "進行中",
			lastOutput: "最終出力",
			outputAdvanced: "進行を確認",
			outputStalled: "停止",
			outputEnded: "終了 (ENDLIST)",
			outputUnobserved: "未観測",
			feederLabel: "フィーダー",
			feederErrors: "{count} 件失敗",
		},
		channelLoadFailed: "ライブチャンネルを読み込めませんでした。",
		loadingChannel: "ライブチャンネルを読み込んでいます",
		/* Primary labels describe input and monitoring; implementation-specific heartbeat terminology stays secondary. */
		ingestCoordinates: "入力エンドポイント",
		planUnavailableHints: "プランがないため接続情報を特定できません。",
		heartbeat: "入力・エンコーダの状態",
		history: "履歴",
		ladder: "ラダー",
		lastRun: "直近の配信",
		push: {
			pollOnly: "定期的な状態確認のみ（エンコーダ未対応）",
			perEncoding: "エンコード単位＋customData",
			pendingVersion: "対応する実選択版の確認待ち（Poll 継続）",
			actualVersion: "実際のエンコーダバージョン",
			registration: "Webhook 登録",
			registered: "登録済み（受信確認は別）",
			notRegistered: "未登録・Poll 継続",
			retired: "登録は退役済み",
			title: "署名検証済み Push テレメトリー",
			receiving: "新しいサンプルを確認",
			unavailable: "受信情報を確認できません",
			never: "表示できる Push 計測なし",
			stale: "最近のサンプル更新を確認できません",
			clockSkew: "受信時刻を確認してください",
			ended: "終了した配信の受信履歴",
			receivedAt: "表示サンプルの初回受信",
			sampledAt: "プロバイダーのサンプル時刻",
			observedCadence: "異なる直近 2 サンプルの受信間隔",
			configuredCadence: "現在の送信間隔設定（実測ではありません）",
			off: "無効",
			sampleInput: "サンプル内の入力状態",
			boundary:
				"署名検証済み通知の重複を除いた計測です。受信・サンプル時刻とも 90 秒以内の Push を優先し、なければ新しい Poll を使います。受信時刻は表示サンプルの初回受信です。表示中の RUNNING 画面は約 15 秒ごとに更新します。",
			sampleFresh:
				"プロバイダーのサンプル時刻は直近です。Push の受信成功だけでは再生成功を保証しません。",
			sampleStale:
				"プロバイダーのサンプルが古いため、現在の入力状態ではありません。",
			sampleUnknown:
				"サンプル時刻が不明なため、現在の入力状態は確認できません。",
			sampleSkew:
				"プロバイダーのサンプル時刻が未来です。現在の入力状態は確認できません。",
			sampleHistorical: "終了時のサンプルです。現在の入力状態ではありません。",
		},
		health: {
			diagnosis: {
				ENDED: "終了した配信の記録です。",
				UNKNOWN:
					"現在の入力状態は未確認です。通知の受信状況と入力元を確認してください。",
				INPUT_WAITING:
					"入力待ちです。送信元の接続先と送信開始を確認してください。",
				INPUT_LOST:
					"入力の切断・異常を検出しました。送信元とネットワークを確認してください。",
				OUTPUT_STALLED:
					"出力更新の停止を検出しました。出力先の詳細を確認してください。",
				OUTPUT_UNKNOWN: "入力接続を確認しました。出力更新は未確認です。",
				PUSH_UNAVAILABLE:
					"Push の更新を確認できないため Poll で表示中です。配信停止を意味しません。",
				HEALTHY:
					"入力接続・出力更新を確認しました。視聴側の再生を保証するものではありません。",
			},
			source: "状態の根拠: {source}",
			qualityTitle: "入力品質の注意 {count} 件",
			qualityHint:
				"入力の観測値に基づく目安です。平均フレーム数・最大 GOP は直近1分で、出力設定の違反判定ではありません。",
			packetStalled:
				"入力 {streamIndex} ({mediaType}): {ageSeconds} 秒パケットなし。送信元を確認してください。",
			rateLow:
				"映像入力 {streamIndex}: 平均 {actualFps} fps / 宣言 {declaredFps} fps。送信負荷・フレーム落ちを確認してください。",
			gopLong:
				"映像入力 {streamIndex}: 最大 GOP {maximumMs} ms。送信元のキーフレーム間隔を確認してください。",
			packetGrowth:
				"前回サンプル以降に欠落・破損パケットが計 {count} 増加。送信元とネットワークを確認してください。",
			panelTitle: "配信状態",
			sources:
				"新しい Push を優先し、未受信時は Poll で補完。出力先の監視は独立して確認します。履歴の状態線は Push を受信した区間は Push、それ以外は Poll で描きます。アラート件数は Poll ベースです。",
			ingestDetails: "入力の詳細",
			lastSeen: "最終確認 {when}",
			laneAlerts: "アラート {count} 件",
			laneAlertsUnknown: "アラート 不明",
			ended: "終了",
			starting: "起動待ち",
			encoderIp: "エンコーダ IP",
			region: "リージョン",
			latestWarning: "最新の警告",
			noWarning: "警告なし",
			outputNotObserved: "未観測",
			edgeDelayMax: "エッジ遅延（最大）",
			seconds: "{s} 秒",
			toManifests: "再生リンクへ",
			droppedCounts: "累計 {total}（前回比 +{delta}）",
			ingest: "入力",
			encoder: "エンコーダ",
			output: "出力",
			ok: "正常",
			down: "未検出",
			unobservable: "計測対象外(HLS なし)",
			stale:
				"90 秒以内の Poll 状態サンプルがありません。Push 受信や配信停止とは別の判定です。",
			timelineTitle: "配信タイムライン",
			stateHistory: "観測された状態",
			stateHistoryDescription:
				"入力・エンコーダ・出力の観測状態が続きます。状態が変わらない中間の観測は省略しています。未観測の時刻の状態は推測しません。",
			stateHistoryEmpty: "状態の観測データはありません。",
			eventStartRequested: "開始要求",
			eventQueued: "キュー投入",
			eventRunning: "エンコーダ起動",
			eventInputConnected: "入力接続",
			eventInputDisconnected: "入力切断",
			eventInputReconnected: "入力再接続",
			timelineSources: "接続イベント: Push ／ 状態線: Poll",
			timelineSourcesPush:
				"接続イベント: Push ／ 状態線: Push(受信区間)・Poll(未受信区間)",
			pushLanesTruncated:
				"状態線に反映した Push は直近の受信分だけです。それ以前の区間は Poll で描いています。",
			pushCoverage:
				"Push イベントは直近300受信内の最大100件です。全履歴や映像反映の証明ではありません。",
			pushTruncated:
				"直近の通知・イベントを表示中。以前の記録は受信ログで確認できます。",
			pushLogLink: "Push受信ログへ",
			eventOutputActive: "出力生成開始",
			eventContentInserted: "コンテンツ挿入予約",
			eventContentStopped: "挿入停止要求",
			eventStopped: "エンコーダ停止",
			actionsTruncated:
				"コンテンツ操作イベントは先頭 100 件のみ表示しています。",
			eventScte35: "SCTE-35 キュー",
			eventEsam: "ESAM シグナル",
			eventStopRequested: "停止要求",
			eventRestartRequested: "再起動要求",
			eventTimeshiftReset: "タイムシフトリセット",
			startup: "エンコーダ起動時間: {duration}",
			startingElapsed: "エンコーダ起動中 — 経過 {duration}",
			loading: "配信の状態を読み込んでいます…",
			loadFailed: "配信の状態を読み込めませんでした。",
			noData: "この配信の Poll 状態サンプルはまだありません。",
			truncated:
				"タイムラインは直近 24 時間分のみ表示しています。それより前のサンプルは省略されました。",
		},
		ladderVideo: "映像レンディション",
		ladderAudio: "音声レンディション",
		ladderOther: "その他のレンディション",
		ladderKey: "キー",
		ladderCodec: "コーデック",
		ladderHeight: "解像度",
		ladderBitrate: "ビットレート",
		ladderDetail: "パラメータ",
		ladderParams: "{count} 個のパラメータ",
		ladderParamsLabel: "レンディション {key} — 全パラメータ",
		planUnavailableLadder:
			"保存されたプランを解析できないため、ラダーを表示できません。",
		dvr: "DVR / タイムシフト",
		planUnavailableDvr: "プランがないため DVR ウィンドウが不明です。",
		/* This upstream operation is not a provider Input resource. */
		feeders: "ファイル入力（擬似ライブ）",
		contentInsertion: "コンテンツ差し込み",
		dnsMappings: "DNS マッピング",
		liveToVod: "ライブ → VOD",
		vmafCapture: "VMAF キャプチャ",
		stepTimeline: "ステップ履歴",
		stepLogUnavailable: "このチャンネルのステップログはありません。",
		/* This section lists reservations, not proof of active insertion. Preserve keys used as section identifiers. */
		slateNow: "スレートの予約",
		advanced: "複製・テンプレート",
		dangerZone: "このチャンネルを削除",
		dangerZoneLead:
			"削除するとチャンネルと、そのフィーダーセッション・ハートビート・ライブ VMAF レポートが消えます。Bitmovin のエンコーディングはそのまま残ります。",
		cueNeedsRunning:
			"SCTE-35 キューは RUNNING のチャンネルにのみ挿入できます。",
		manifestUrlsDisclose: "マニフェスト URL をすべて表示",
		manifestUrlsDiscloseClose: "マニフェスト URL を隠す",
		/* Primary actions describe channel tasks; the provider encoder is a secondary detail. */
		start: "チャンネルを開始",
		startNewRun: "新しい配信を開始",
		/* Akamai MSL uses account API authentication, not a storage credential. Operators select the destination explicitly and enter its four required fields. */
		outputDestination: "配信先",
		destinationStorage: "オブジェクトストレージ",
		destinationAkamaiMsl: "Akamai MSL",
		outputDestinationHelp:
			"オブジェクトストレージは、資格情報を登録済みのバケットにセグメントを書き出します。Akamai MSL は、Akamai 側で払い出されたストリームへ直接配信します。",
		mslStreamId: "ストリーム ID",
		mslStreamIdHelp: "このイベント用に Akamai が発行した数値のストリーム ID。",
		mslEventName: "イベント名",
		mslEventNameHelp:
			"Akamai のイベント名。払い出された文字列をそのまま入力します。",
		mslStreamFormat: "ストリーム形式",
		mslStreamFormatHelp:
			"これは表示上のラベルではなくエンコード構成への制約です。DASH は fMP4 セグメントと DASH マニフェスト、HLS は TS セグメントと HLS マニフェスト、CMAF は fMP4 と両方のマニフェストが必要です。食い違いは送信前にプラン内容の欄に表示されます。",
		mslVersion: "MSL プロトコルバージョン",
		mslVersionHelp:
			"MSL5 は encoder 2.283.0 以降が必要で、セグメント命名の文法も異なります(本アプリが自動で導出します)。EOL 2026-12-31 まで MSL4 が既定です。AKAMAI_MSL 資格情報の Digest publishing は MSL5 専用で、MSL4 出力に設定すると Bitmovin が拒否します。",
		startResume: "チャンネルを開始(再開)",
		stop: "チャンネルを停止",
		restart: "チャンネルを再起動",
		/* Failure messages require dedicated action nouns rather than reusing verb-shaped button labels. */
		actionLabelStart: "チャンネルの開始",
		actionLabelStop: "チャンネルの停止",
		actionLabelRestart: "チャンネルの再起動",
		actionLabelResetTimeshift: "タイムシフトリセット",
		actionLabelScte35: "SCTE 35 メッセージの送信",
		actionRejected: "{label}を実行できませんでした：{message}",
		actionFailed: "{label}を実行できませんでした：{message}",
		actionFailedGeneric:
			"{label}に失敗しました。画面を更新して再実行し、解消しない場合は管理者に連絡してください。",
		actionReasonUnknown:
			"要求を完了できませんでした。画面を更新して再実行し、解消しない場合は管理者へ連絡してください。",
		errorDetails: "エラー詳細",
		recordedFailure:
			"配信処理で問題が発生しました。操作履歴と現在のチャンネル状態を確認し、必要に応じて再実行してください。",
		actionAccepted: "{label}を受け付けました。",
		duplicate: "設定をコピーして編集",
		stopChannelTitle: "チャンネルを停止しますか?",
		stopChannelBody:
			"このチャンネルのライブエンコーディングを停止します。接続中のファイル入力セッションも一緒に停止します。視聴者はストリームを失います。",
		stopChannel: "チャンネルを停止",
		restartChannelTitle: "チャンネルを再起動しますか?",
		restartChannelBody:
			"実行中のエンコーディングを再起動します。エンコーダが復帰するまでストリームは中断します。",
		restartChannel: "チャンネルを再起動",
		insertCue: "SCTE-35 キューを挿入",
		cueDuration: "キュー長 (秒)",
		cueEnqueued: "SCTE-35 キューを登録しました。",
		sending: "送信しています…",
		insertCueShort: "キューを挿入",
		manifestsAllHint: "マニフェスト(未選択 = すべて)",
		channelWord: "チャンネル",
	},
	heartbeat: {
		stream: "ストリーム",
		type: "種類",
		codec: "コーデック",
		resolution: "解像度",
		rate: "レート",
		bitrate: "ビットレート",
		keyframeAvg: "キーフレーム平均 (ms)",
		keyframeMax: "キーフレーム最大 (ms)",
		keyframeLastMinute: "直近 1 分 平均 / 最大 (ms)",
		noStreamDetails: "最新サンプルにストリーム別の詳細がありません。",
		events: "イベント",
		droppedVideo: "映像ドロップ",
		droppedAudio: "音声ドロップ",
		corruptVideo: "映像破損",
		corruptAudio: "音声破損",
		noHistory:
			"heartbeat の履歴がまだありません。30 秒ごとの収集が進むとグラフが埋まります。",
		loadingHistory: "heartbeat 履歴を読み込んでいます",
	},
	pushLog: {
		title: "Push Heartbeat 受信ログ",
		hint: "最新の受信が先頭です。署名検証済みの受信を再送も含めて1通知1行で表示します。過去の計測記録であり、現在の正常性や再生の証明ではありません。詳細は許可した計測項目のみです。Poll履歴・エクスポートは下段に分離しています。",
		sampledAt: "Provider 計測時刻",
		receivedAt: "アプリ受信時刻",
		auto: "現在の稼働runのログを前景で開いている間、最新受信を2秒ごとに更新します。",
		paused:
			"自動更新は停止中です（閉じたログ・終了済み・過去run・過去ページ・背景）。",
		inspecting:
			"詳細を確認中のため更新を停止しています。すべての詳細を閉じると再開します。",
		details: "詳細",
		empty: "このrunの署名検証済みPush受信は保存されていません。",
		older: "古い受信",
		latest: "最新の受信へ",
		retry: "再試行",
		current: "現在のrun（再起動に追従）",
		poll: "Poll履歴・エクスポート（約30秒間隔の計測）",
	},
	heartbeatLog: {
		title: "heartbeat ログ",
		summary: "配信ごとのPush受信・Poll履歴を分けて確認",
		run: "配信",
		operatorOnly: "heartbeat ログはオペレーター向けです。",
		noRuns:
			"このチャンネルはまだ配信していないため、heartbeat ログはありません。",
		loading: "heartbeat ログを読み込んでいます…",
		empty: "この配信の heartbeat サンプルは保持されていません。",
		eventsTitle: "エンコーダのイベント(最新サンプル時点)",
		noEvents: "この配信でエンコーダはイベントを報告していません。",
		export: "JSON をエクスポート(管理者)",
		summaryLine:
			"定期取得の要約: {samples} サンプル · 入力接続 {connectedMinutes} 分 · 警告/エラー {warnings} 件（Push受信は別表示）",
		rowsPruned: "サマリー前にサンプルが削除済み",
		time: "時刻",
		ingest: "入力",
		incomingMbps: "受信 Mbps",
		fps: "fps",
		keyframe: "キーフレーム 平均 / 最大 (ms)",
		packets: "ドロップ V/A · 破損 V/A",
		manifestAge: "マニフェスト経過 (秒)",
		segmentMean: "セグメント平均 (ms)",
		events: "イベント",
		raw: "生データ",
		rawToggle: "JSON",
		rowsLoaded: "{count} 行を読み込み済み",
		loadMore: "さらに読み込む",
		columnsHint:
			"受信 Mbps と fps は最初の映像ストリームの実測 incomingBitrate と rate、キーフレームは keyFrameIntervalAvg / Max、マニフェスト経過は取得時刻と最新 HLS マニフェスト更新の差、イベントはその取得で新たに現れたものだけです。すべてのプロバイダー項目は JSON で確認できます。",
	},
	dvr: {
		resetTitle: "タイムシフトをリセット(RUNNING 時のみ)",
		resetEnqueued:
			"リセットを登録しました。実行中のエンコーディングに順次適用します。",
		residualPeriod: "残存期間 (秒)",
		offsetSeconds: "オフセット (秒)",
		resetting: "リセットしています…",
		reset: "タイムシフトをリセット",
	},
	feeder: {
		pickChannel: "チャンネル",
		title: "ファイル入力（擬似ライブ）",
		loadFailed: "フィーダーセッションを読み込めませんでした。",
		session: "セッション",
		channel: "チャンネル",
		protocol: "プロトコル",
		source: "ソース",
		started: "開始日時",
		stop: "停止",
		noSessions: "このチャンネルのフィーダーセッションはまだありません。",
		browseStorage: "ストレージを参照…",
		rtmpPush: "RTMP プッシュ",
		srtCaller: "SRT Caller（発信側）",
		noPassphrase: "パスフレーズなし",
		sourceObject: "入力ファイル（MP4）",
		pickViaBrowse: "「ストレージを参照」から選択",
		rtmpUrl: "RTMP URL",
		rtmpUrlPlaceholder: "rtmp://<encoder-ip>/live",
		streamKey: "ストリームキー",
		srtHost: "SRT ホスト",
		srtPort: "SRT ポート",
		passphraseCredential: "パスフレーズの資格情報",
		hideForm: "フォームを隠す",
		revealFill: "ストリームキーを取得",
		revealing: "取得中…",
		showKey: "キーを表示",
		hideKey: "キーを隠す",
		inputDestinationPreparing: "入力先を準備中です。",
		keyContextUnavailable:
			"ストリームキーの情報を取得できません。チャンネルの Bitmovin アカウントを確認するか、入力先の準備完了までお待ちください。",
		revealNone:
			"このエンコーディングに割り当て済みのストリームキーがまだありません — チャンネルが RUNNING になると発行されます。",
		revealFailed: "ストリームキーを開示できませんでした。",
		revealMultiple:
			"このエンコーディングには複数のストリームキー（プライマリとバックアップ）が割り当てられています。設定 → ライブ → ストリームキーで対象を選んで取得してください。",
		staticKeyHint:
			"静的入力では、割り当て済みのストリームキーを使用します。チャンネル設定のキーは使用できません。",
		newSession: "ファイル入力を開始",
		/* A pushing feeder without a matching heartbeat is unconfirmed, not healthy; the worker can reconnect unbound sessions. */
		pushingUnconfirmed:
			"フィーダーは PUSHING を報告していますが、エンコーダが受信していることを確認できる最近の heartbeat がありません。heartbeat が届くまで push は未確認として扱ってください。",
		pushingNotBound:
			"フィーダーは push 中ですが、エンコーダはまだ入力をバインドしていません。自動的に新しい接続で再試行します。長く続く場合は Ingest 座標とソースファイルを確認するか、フィーダーを作り直してください。",
		inputConfirmed:
			"入力を確認しました。ライブエンコーダがこのファイル入力を受信しています。",
		prefilledFromEncoderIp:
			"チャンネルのエンコーダ IP から自動入力しています。編集できます",
		encoderIpUnknownRunning:
			"チャンネルが RUNNING になるまでエンコーダ IP は不明です。手入力するか待ってください",
		prefilledFromEncoderIpShort: "チャンネルのエンコーダ IP から自動入力",
		encoderIpUnknown: "RUNNING になるまでエンコーダ IP は不明です",
		prefilledFromSrtPort: "チャンネルの SRT listener ポートから自動入力",
		srtPortRange: "Bitmovin の SRT listener ポートは 2088〜2091 です",
		creating: "作成しています…",
		startSession: "ファイル入力を開始",
		/* Immediate and scheduled switching both use two phases. */
		switchFromActive:
			"稼働中のフィーダーから切り替える(先に準備、その後入れ替え)",
		switchFromActiveHint:
			"新しいソースのダウンロード・probe・稼働中フィードとの整合確認を済ませてから停止に入ります。稼働中のフィーダーは新しいソースの準備が完了してから停止し、旧プッシュの終了が確認されてから新しいプッシュを開始します — 同一 ingest への二重プッシュより無音区間を優先します。",
		switchSession: "準備して切り替え",
		phaseStaging: "準備中",
		phaseReady: "準備完了 — 切替待ち",
		stopBeforeDeleting: "削除する前にセッションを停止してください",
		deleteTitle: "このフィーダーセッションを削除しますか?",
		deleteConfirm:
			"このセッションと、そのログ末尾・ループ境界を削除します。送出中のプロセスには手を付けません。取り消せません。",
		stopTitle: "フィーダーセッションを停止しますか?",
		stopBody:
			"送出を停止します(停止要求 → 5 秒待機 → 強制終了)。セッションは 1 回限りです。もう一度流すには新しいセッションを作成してください。",
		stopSession: "セッションを停止",
		detailLoadFailed: "フィーダーセッションを読み込めませんでした。",
		loadingSession: "フィーダーセッションを読み込んでいます",
		sessionWord: "ファイル入力セッション",
		sessionDetailTitle: "ファイル入力セッション",
		detailLead:
			"保存済みのMP4をライブチャンネルへ繰り返し送出した履歴と、入力先・現在の状態を確認できます。",
		inputDestination: "入力先",
		technicalInformation: "技術情報",
		resourceId: "リソース ID",
		channelResourceId: "ライブチャンネル ID",
		diagnostics: "診断",
		diagnosticsLead: "管理者・サポート向けの運用情報です。",
		diagnosticsLoading: "診断情報を読み込んでいます…",
		diagnosticsLoadFailed: "診断情報を読み込めませんでした。",
		ownerHost: "実行ホスト",
		processId: "プロセス識別子",
		processGoneAt: "終了確認日時",
		recordedFailure: "記録されたエラー",
		notAvailable: "情報なし",
		internalFailure:
			"ファイル入力を継続できませんでした。管理者に診断情報の確認を依頼してください。",
		timing: "タイミング",
		loop: "ループ",
		wallClock: "実時刻",
		streamTime: "ストリーム時刻 (秒)",
		noLogLines: "ログ行がまだありません。",
	},
	/* Translate structured difference attributes and plans; preserve measurements and legacy free text. */
	mediaDifference: {
		videoStream: "映像ストリーム",
		videoCodec: "映像コーデック",
		resolution: "解像度",
		frameRate: "フレームレート",
		h264Profile: "H.264 プロファイル",
		h264Level: "H.264 レベル",
		pixelFormat: "ピクセル形式",
		audioStreams: "音声ストリーム数",
		audioCodec: "音声コーデック",
		audioSampleRate: "音声サンプリング周波数",
		audioChannels: "音声チャンネル数",
		videoPosition: "映像ストリームの位置",
		container: "コンテナ",
		kind: "メディアの種類",
		unknown: "不明な属性",
		present: "あり",
		absent: "なし",
		willReencode: "（一致するよう再エンコード予定）",
	},
	feederError: {
		ingestUnsatisfied:
			"ソースがチャンネルの取り込み要件を満たせません: {detail}。エンコーダは接続を受け付けても何も publish しません。",
		sourceMismatch:
			"ソースがこのチャンネルの取り込み内容と一致しません（{origin}）— エンコーダは属性の変化を警告して入力を切断し、プレイリストは静止した映像のまま進み続けます:\n{differences}",
		slatePosition:
			"スレートクリップがライブストリームと一致しません: Bitmovin はストリーム位置 0 に映像ストリームを必要としますが、このファイルはそこに {found} を持っています。コンテンツは READY として登録された後、挿入時に失敗します。",
		slateMismatch:
			"スレートクリップがライブストリームと一致しないため、コンテンツが READY として登録されても挿入時（オンエア時）に失敗します:\n{differences}",
		// C36: stills are admitted since ; renders only for rows refused before that.
		slateImage:
			"静止画スレートを登録できませんでした。JPG または PNG を使い、差し込み時に表示時間を指定してください。",
		/* Identify the comparison source substituted into the source-mismatch message. */
		origin: {
			runSource: "この run が開始したソース",
			heartbeat: "エンコーダの最新ハートビート",
		},
	},
	contentInsertion: {
		feedbackAccepted: "予約要求を受け付けました",
		feedbackIdentity: "コンテンツ {contentId} · 予約 {reservationId}",
		feedbackProvider: "予約応答の状態: {status}",
		feedbackUnconfirmed: "映像への反映は未確認です。",
		feedbackOutputAdvancing:
			"{source}: 出力更新を確認。差し込み内容の一致は未確認。",
		feedbackOutputNotAdvancing:
			"{source}: 出力更新は未確認。差し込み失敗の判定ではありません。",
		feedbackOutputUnknown: "現在の出力更新は未確認です。",
		feedbackPreview: "プレビューで確認",
		needsRunning: "コンテンツ差し込みには RUNNING のチャンネルが必要です。",
		stopped: "差し込みコンテンツの停止リクエストを受け付けました。",
		registered: "登録済みコンテンツ",
		schedule: "スケジュール",
		noneRegistered:
			"このエンコーディングに登録されたコンテンツはまだありません。",
		register: "コンテンツを登録",
		scheduled: "スケジュール済み",
		deschedule: "予約を解除",
		descheduleNamed:
			"{runAt} に実行する「{name}」の予約を解除 (予約 ID: {scheduledId})",
		nothingScheduled: "予約はありません。",
		slateLead:
			"差し込みコンテンツの予約を表示します。「予約済み」は、現在挿入中であることを示しません。",
		requirementsHint: "「コンテンツ差し込みの要件」の説明",
		loadingInsertable: "差し込み可能なコンテンツを読み込んでいます",
		runAt: "実行時刻(空欄 = 即時実行)",
		runAtInvalid: "実行時刻を正しく入力してください。",
		durationSeconds: "長さ (秒)",
		nameOptional: "名前(任意)",
		namePlaceholder: "brb-slate",
		inputPath: "入力パス",
		inputPathPlaceholder: "/slates/brb.mp4",
		inputId: "入力 ID",
		loadingScheduled: "予約を読み込んでいます",
		stopSending: "停止リクエストを送信しています…",
		requestFailed: "リクエストに失敗しました",
		scheduling: "スケジュールしています…",
		registering: "登録しています…",
		/* This section lists slate reservations. Localize provider status for operators and retain raw values under technical details. */
		runAsap: "即時実行",
		reservationDuration: "{seconds} 秒間",
		statusCreated: "登録処理中",
		statusScheduled: "予約済み",
		statusToBeDescheduled: "予約解除中",
		statusDescheduled: "予約解除済み",
		statusError: "予約エラー",
		statusUnknown: "予約状態を確認できません",
		technicalDisclose: "技術情報を表示",
		technicalDiscloseClose: "技術情報を閉じる",
		technicalLead:
			"Bitmovin が返した予約の生データです。status は Bitmovin の予約ステータスで、再生中かどうかの情報は含まれません。",
		/* Emergency stop belongs to operations, separately from reservations. */
		stopTitle: "差し込みコンテンツの緊急停止",
		stopLead:
			"再生中の差し込みコンテンツを止めてライブ入力へ戻す緊急操作です。今後の予約は解除されません。予約の解除は「スレートの予約」で行ってください。",
		stopAction: "再生中の差し込みコンテンツを停止してライブ入力へ戻す",
		stopConfirmTitle: "再生中の差し込みコンテンツを停止しますか?",
		stopConfirmBody:
			"再生中の差し込みコンテンツを停止してライブ入力へ戻すリクエストを送信します。今後の予約はそのまま残ります。何も再生されていない場合、この操作は失敗します。",
		stopConfirm: "停止してライブ入力へ戻す",
		stopNeedsRunning: "この操作は配信中のチャンネルでのみ使えます。",
		// C36 (WP-A1/A2): pick the file, check it against the live stream,
		// then register. READY means registered, not playable.
		readyMeansRegistered:
			"READY は Bitmovin がファイルを登録したことを示すだけで、配信と一致することは意味しません。一致するかどうかは登録前の互換性チェックで判定します。",
		registerLead:
			"ストレージから素材を選び、ライブ配信との互換性を確認してから登録します。Bitmovin がストレージから直接ダウンロードするため、このアプリを経由したアップロードは行いません。",
		sourceFile: "素材ファイル",
		sourceFileHelp:
			"映像ストリームがストリーム位置 0 にあり、ライブ配信とコーデック・解像度・フレームレートが一致し、音声ストリーム数・サンプルレート・チャンネル数も同じ動画ファイル。JPG・PNG の静止画も登録できます(無音で、黒背景に収めて表示され、差し込み時に表示時間の指定が必要です)。Bitmovin は差し込み実行時までこれを検査しないため、ここでチェックします。",
		checkCompatibility: "互換性を確認",
		checking: "確認中…",
		registerNeedsCheck: "先に互換性チェックを実行してください。",
		preflightPending:
			"ファイルを検査しています（先頭部分の読み取りと ffprobe を実行）。通常は数秒で完了します。",
		verdictOk: "ライブ配信と互換性があります。",
		verdictIncompatible:
			"ライブ配信と互換性がないため登録できません。差し込みは実行時に失敗します。",
		verdictUnverified:
			"互換性を確認できませんでした。登録はできますが、差し込みの再生は保証されません。",
		standDownNoIngestReference:
			"このチャンネルにはまだ比較対象の入力情報がありません（heartbeat も記録済みソースもありません）。",
		standDownNoProbe:
			"検査結果にこのファイルのストリーム情報が含まれていません。",
		standDownNoCredential:
			"このオブジェクトを読み取れる保存済みストレージ認証情報がないため、検査していません。",
		standDownInputUnresolved:
			"Bitmovin の入力からストレージのバケットを特定できなかったため、検査していません。",
		standDownInspectionFailed:
			"ファイルの検査に失敗しました。理由はストレージブラウザーの「検査」で確認してください。",
		standDownNoComparableAttribute:
			"このチャンネルの入力参照には、このファイルと比較できる属性がありません。何も検証されていません。",
		comparedOn: "比較した属性: {compared}",
		notComparable: "この参照では比較できない属性: {attributes}",
		leadingSlashStripped: "先頭のスラッシュを除去し、{path} として登録します。",
		imageNotice:
			"静止画です。無音で、黒背景に収めて表示されます。差し込み時に表示時間を指定してください。",
		differencesTitle: "ライブ配信との差異",
		differenceBlocking: "登録不可",
		differenceReported: "参考情報",
		advancedOpen: "詳細設定: Bitmovin 入力 ID で登録",
		advancedClose: "詳細設定を閉じる",
		advancedLead:
			"このアプリに認証情報を保存していない入力にある素材向けです。同じ互換性チェックを実行し、ファイルを検査できない場合はその旨を表示します。",
		/* The server adapts selected content to the live input before registration; describe that operation rather than presenting it as rejection. */
		prepImage:
			"静止画です。そのまま登録します。無音で黒背景に収めて表示され、差し込み時に表示時間の指定が必要です。",
		prepAsIs: "ライブ入力に一致する MPEG-TS です。そのまま登録します。",
		prepNormalize:
			"ライブ入力に合わせて MPEG-TS へ変換してから登録します(変換で合わせる項目: {reasons})。",
		prepWait:
			"ライブ入力がまだ接続されていません。登録すると入力の接続後に自動で変換し、登録します。",
		prepRefused: "登録できません。ファイルを確認してください。",
		prepRefusedUnprobed:
			"登録できません。ファイルを検査できなかったため、内容が分かりません。",
		prepRefusedNoContainer:
			"登録できません。動画または静止画として読み取れないファイルです。",
		prepRefusedNoVideo:
			"登録できません。映像ストリームがありません(スレートは動画または静止画が必要です)。",
		prepRefusedInspection:
			"登録できません。ファイルの検査に失敗しました。ストレージブラウザーの「検査」で理由を確認してください。",
		differenceConverted: "変換で解消",
		prepDestinationOutput:
			"変換後のファイルはチャンネルの出力ストレージ {location}/ に書き出します(素材の場所への書き込み権限は不要です)。",
		prepDestinationSource:
			"このチャンネルには S3 系の出力ストレージがないため、変換後のファイルは素材の隣 {location}/ に書き出します。素材の場所への書き込み権限が必要です。",
		normalizationAccepted:
			"変換を開始しました。進捗は「変換・登録中の素材」に表示され、完了すると登録済みコンテンツに現れます。",
		normalizationAcceptedWaiting:
			"受け付けました。ライブ入力の接続後に自動で変換して登録します。進捗は「変換・登録中の素材」に表示されます。",
		normalizationsTitle: "変換・登録中の素材",
		normalizationsLead:
			"ライブ入力に合わせた変換と登録の進み具合です。完了した素材は登録済みコンテンツに移ります。失敗した場合は理由を表示します。",
		normStatusWaiting: "入力待ち",
		normStatusQueued: "待機中",
		normStatusNormalizing: "変換中",
		normStatusRegistering: "登録中",
		normStatusReady: "登録済み",
		normStatusError: "失敗",
		normFailed:
			"変換または登録に失敗しました。素材を確認して登録し直してください。",
	},
	esam: {
		//  (UX-02e): was a hard-coded English validation sentence.
		matchTimeInvalid: "一致時刻を正しく入力してください。",
		needsRunning:
			"ESAM media point は RUNNING のチャンネルにのみ挿入できます。",
		title: "ESAM media point を挿入",
		signals: "シグナル(1 件以上)",
		addSignal: "シグナルを追加",
		hint: "「ESAM media point」の説明",
		matchTime: "一致時刻(任意)",
		offset: "オフセット",
		insertFailed:
			"挿入に失敗しました。入力とチャンネルの状態を確認してから再実行してください。",
		inserting: "挿入しています…",
		insert: "media point を挿入",
	},
	liveToVod: {
		stopFirst: "先にチャンネルを停止してください。ライブ → VOD は",
		complete: "完全な",
		manifests: "マニフェスト",
		needManifest: "マニフェストの種類を 1 つ以上選択してください。",
		noSupportedFamily: "この録画形式では VOD マニフェストを生成できません。",
		lastRun: "前回の実行:",
		destination: "出力先:",
		finishedAtSuffix: " · {at} 完了",
		refreshSuffix: " · 更新で進捗を表示",
		manifestPath: "マニフェストのパス",
		manifestPathPlaceholder: "output/my-channel",
		startFailed: "ライブ → VOD を開始できませんでした",
		startUnsupportedFamily:
			"選択したマニフェストは、この録画形式では生成できません。選択内容を変更してください。",
		startInvalidPath:
			"マニフェストのパスは、録画フォルダーと同じ階層か上位の階層を指定してください。",
		startAlreadyRunning: "ライブ → VOD の生成はすでに実行中です。",
		startNotStopped:
			"録画を完全な状態で公開するため、先にチャンネルを停止してください。",
		generating: "生成しています…",
		publish: "VOD として公開",
		families: "マニフェストの種類",
		partialHint:
			"一方のマニフェストは完了し、もう一方は失敗しました。もう一度公開すると失敗した種類だけを生成し、完了済みのマニフェストは保持されます。",
		statusRunning: "生成中",
		statusFinished: "完了",
		statusPartial: "一部完了",
		statusError: "失敗",
		familyStatusPending: "待機中",
		familyStatusCreated: "生成開始待ち",
		familyStatusRunning: "生成中",
		familyStatusFinished: "生成完了",
		familyStatusError: "失敗",
		familyStatusUnsupported: "対応していません",
		unsupportedFamily:
			"この録画形式では {family} マニフェストを生成できません。",
		errorEnqueue:
			"生成リクエストを受け付けられませんでした。しばらく待ってから再実行してください。",
		errorQueueUnknown:
			"生成リクエストの受付状態を確認できません。画面を更新して状態を確認してから再実行してください。",
		errorProvider:
			"マニフェストの生成状況を確認できませんでした。再実行してください。",
		errorCleanup:
			"前回生成したマニフェストの削除を確認できません。再実行せず、管理者へ連絡してください。",
		errorInvalidRecord:
			"前回の生成結果が不完全です。管理者へ連絡してください。",
		technicalDetails: "技術詳細（管理者向け）",
	},
	dns: {
		needsRunning: "DNS マッピングはチャンネルが RUNNING の間だけ表示されます。",
		loading: "DNS マッピングを読み込んでいます",
		hostname: "DNS ホスト名",
	},
	captureVmaf: {
		invalidWindow: "10〜600秒の整数を入力してください。",
		needsRunning:
			"VMAF キャプチャはチャンネルが RUNNING の間だけ利用できます。",
		window: "キャプチャ長 (秒)",
		failed:
			"キャプチャに失敗しました。チャンネルと出力の状態を確認してから再実行してください。",
		starting: "開始しています…",
		capture: "VMAF をキャプチャ",
	},
	subtitles: {
		dashboard:
			"要対応、配信中、開始予定、最近の失敗の順に並べた運用概要です。各カードから対象の画面へ移動できます。",
		vodJobs: "エンコードの作成、進行状況、結果を確認できます。",
		liveChannels:
			"ライブチャンネルの開始、入力・出力の監視、スケジュール、停止を管理します。",
		feeders:
			"保存済みのMP4を繰り返し送出し、ライブチャンネルの入力として使用します。AWS Elemental MediaLiveのInputリソースそのものではありません。",
		vmafLab:
			"VMAFとPSNRによる品質レポート。レンディションごとに平均・下位1%・パーセンタイル・フレームごとの時系列を表示します。",
	},
	empty: {
		noVmafReports:
			"VMAF レポートがまだありません。VOD ジョブで VMAF を有効にすると、完了後にここに表示されます。",
		noFeederSessions:
			"ファイル入力のセッションはまだありません。「ファイル入力を開始」から保存済みの MP4 とライブチャンネルを選択してください。",
	},
	prose: {
		storageIntro:
			"設定 → 資格情報 に登録した資格情報でバケットを参照します。アクセスの確認、URI のコピー、そして",
		storageCredentialsHint: "設定 → 資格情報 で追加または確認してください。",
		inspectBounded:
			"プレビューは意図的に上限付きです。先頭を上限まで読み、必要なら上限付きの再読み取りを 1 回だけ行います。オブジェクト全体は読みません。したがってインデックスがファイル末尾にあるコンテナ(faststart でない MP4)はここでは扱えません。その場合は",
		noHeartbeatSample:
			"heartbeat のサンプルがまだありません。30 秒ごとに RUNNING の全チャンネルから収集します。",
		heartbeatDeltas:
			"差分は 30 秒ポーリングごとの値です。エンコーダのカウンタはエンコーディング開始からの累積で、下に累計を表示しています。開始直後の初回ポーリングは仕様上ゼロ差分になります。",
		noConnectEvents:
			"最新の heartbeat に接続/切断イベントはありません。正常なストリームでは初回接続以降は発生しません。",
		captureVmafIntro:
			"直近の出力区間をキャプチャし、ループしているフィーダーのソースと libvmaf で比較採点します。疑似ライブ同期エンジンがループオフセットを復元し、信頼度を報告し、ドリフトを検出します。実行を開始するとレポートが開きます。",
		captureVmafNoFeeder:
			"接続中の疑似ライブフィーダーがありません。VMAF キャプチャには、参照としてループ元の MP4 が必要です。先にフィーダーセッションを開始してください。",
		deliveryMirrorPathsFollowPrimary:
			"ミラーは主出力と同じファイルを同じパスに書き出します。異なるのはバケットだけです。プレフィックスを別に指定する項目はありません。プランはミラーを出力への参照として記録し、各ファイルは主出力が使うパスへそのまま複製されます。主出力のフォルダを変更すれば、ミラーもそれに追従します。",
		esamNoAccount:
			"このチャンネルに Bitmovin アカウントが紐付いていません。ESAM の挿入は利用できません。",
		esamIntro:
			"事前に組み立てた SCTE-35 ペイロード(SCTE-250 / ESAM)を実行中のストリームへ挿入します。エンコーディングは次の設定で開始されている必要があります:",
		contentNoAccount:
			"このチャンネルに Bitmovin アカウントが紐付いていません。コンテンツ差し込みは利用できません。",
		contentIntro:
			"Bitmovin がライブストリームへ差し込める登録済みメディアです。動画ファイルはライブストリームのコーデック・解像度・フレームレートと一致し、同数の音声ストリームを、同じサンプル形式・チャンネル数・サンプリングレートで持つ必要があります。",
		contentLoadFailed: "登録済みコンテンツを読み込めませんでした",
		scheduleLoadFailed: "スケジュールを読み込めませんでした",
		dvrNoManifestIds:
			"ステップログにプロビジョニング済みのマニフェスト ID がまだありません。リセットは全マニフェストに適用されます。",
		cueNoManifestIds:
			"ステップログにプロビジョニング済みのマニフェスト ID がありません。キューは全マニフェストに送られます。",
		dnsLoadFailed: "DNS マッピングを読み込めませんでした",
		dnsNoMapping:
			"このエンコーディングの DNS マッピングはありません。上の Ingest 先情報にコントリビューションエンコーダを向けるか、設定 → ライブ でマッピングを作成してください。",
		noLoopBoundaries:
			"ループ境界がまだ記録されていません。ソースが 1 周した時点で最初の 1 件が入ります。",
		vmafRunning:
			"VMAF 実行中… libvmaf パイプラインが完了するとフレームスコアがここに表示されます。",
		noLadderMetadata:
			"これらのレンディションにビットレート/高さのメタデータがありません。ラダー表示は利用できません。",
		noLadderMetadataSelected:
			"選択したレンディションにビットレート/高さのメタデータがありません。ラダー表示は利用できません。",
		noReportsLoaded: "要求されたレポートをいずれも読み込めませんでした",
		noSavedPresets:
			"保存済みプリセットがまだありません。ウィザードでプランを作り、「プリセットとして保存」でここに保存してください。",
		presetGalleryIntro:
			"代表的な配信構成をすぐに試せるサンプルです。資格情報、入力パス、保存先を確認して使用してください。読み込むと、フォームで表現できる場合はウィザードのフォームに反映し、そうでない高度なシナリオではプレースホルダのチェックリスト付きでインポート済みプランモードを開きます。",
		noEncodingYet:
			"このジョブにはまだ Bitmovin のエンコーディングがありません。エンコーディングが作成されると実行時操作が使えるようになります。",
		lastStatusExplainer:
			"このエンコーディングについて最後に観測した状態です。TRANSFER_ERROR はエンコーディングは完了したが出力のアップロードが失敗したことを意味します。転送だけを再試行することはできないため、復旧方法は再実行です。",
		noAccountAttached:
			"このジョブに Bitmovin アカウントが紐付いていません。インフラを一覧するには再度紐付けてください。",
	},
	settings: {
		basic: "基本設定",
		basicCaption: "言語・テーマ、Bitmovin アカウント、再生、機能、通知。",
		aReservedKeyCanBeRe:
			"予約したキーは複数のライブエンコーディングで再利用できるため、",
		aStaticIpIsAttachedWhen:
			"静的 IP は LIVE エンコーディング作成時に紐付けられます (Encoding.staticIpId)。アドレスのライフサイクルはここで管理し、選択は",
		accessKey: "アクセスキー",
		acquireEncoding: "エンコーディングを取得",
		acquiredEncoding: "取得したエンコーディング",
		acquiring: "取得しています…",
		addAccount: "アカウントを追加",
		addBitmovinAccount: "Bitmovin アカウントを追加",
		addCredential: "資格情報を追加",
		addDnsMapping: "DNS マッピングを追加",
		addId: "ID を追加",
		addMapping: "マッピングを追加",
		addOneFirst: "先に 1 件追加してください",
		addPoolIdManually: "プール ID を手入力",
		addRegionSettings: "リージョン設定を追加",
		addS3AkamaiOciGcsAzure:
			"S3 / Akamai / OCI / GCS / Azure の資格情報を追加すると、バケットの参照と Bitmovin の入力・出力の作成ができます。",
		addSchedule: "スケジュールを追加",
		addYourBitmovinApiKeyTo:
			"Bitmovin API キーを追加するとエンコーディングを作成できます。",
		addYourFirstAccount: "最初のアカウントを追加",
		addYourFirstCredential: "最初の資格情報を追加",
		adding: "追加しています…",
		advancedLegacyStaticAccessKeysDeprecated:
			"詳細設定(レガシー):静的アクセスキー(Bitmovin では非推奨)",
		apiKey: "API キー",
		apiKeyWriteOnlyOrgId:
			"API キー(書き込み専用)、組織 ID、エンコーダバージョンの固定、既定リージョン、疎通確認。",
		apiKeysAreEncryptedAtRest:
			"API キーは保存時に暗号化され、サーバー側でのみ使用されます。",
		apiToken: "API トークン",
		apiTokensCaption:
			"スクリプト / CI 用の Bearer マシントークン — ここで発行、表示は一度きり",
		awsAccountNumber: "AWS アカウント番号",
		bitmovinAccount: "Bitmovin アカウント",
		bitmovinAccounts: "Bitmovin アカウント",
		bitmovinAllocatesTheAddressAsynchronouslyIt:
			"Bitmovin はアドレスを非同期に確保します。最初はステータス CREATING で表示されます。",
		bitmovinApiAuditLog: "Bitmovin API 監査ログ",
		bitmovinNotificationReceiverAutoRegistrationOn:
			"Bitmovin からの通知を受信するエンドポイントです。受信状況、署名検証、直近の配信をここで確認できます。",
		bitmovinNotificationReceiverSignatureVerificatio:
			"Bitmovin の通知受信、署名検証の状態、直近の配信、API 監査ログ。",
		clearErrorEncodings: "エラーのエンコーディングを消去",
		cloudConnect: "Cloud Connect",
		cloudConnectAccountsCannotBeEdited:
			"Cloud Connect アカウントは編集できません。Bitmovin API に更新呼び出しがないためです。変更するには削除して作り直してください。",
		cloudConnectAwsGceAzureAkamai:
			"Cloud Connect (AWS / GCE / Azure / Akamai / OCI) とリージョン設定、ライブ Ingest 用の静的 IP、開始・停止スケジュール付きの事前起動エンコーダプール。",
		cloudConnectBringYourOwnCloud:
			"Cloud Connect(自社クラウド持ち込み)、ライブ Ingest 用の静的 IP、事前起動エンコーダプール:いずれもサーバー側でプロキシします。クラウドの秘密情報は Bitmovin へ渡すだけで、ここには保存しません。",
		cloudRegion: "クラウドリージョン",
		compartmentOcid: "コンパートメント OCID",
		copyTheseIntoYourContributionEncoder:
			"これらをコントリビューションエンコーダに設定してください。このエンコーディングを管理チャンネルとして取り込む機能はまだ実装されていません。",
		couldNotListPools: "プールを一覧できませんでした",
		createAPoolOfPreStarted:
			"事前起動したライブエンコーディングのプールを作成すると、即座にライブ開始できます。",
		createAPoolOfStandingEncoders:
			"常時起動エンコーダのプールを作成すると、エンコード開始の待ち時間を削減できます。",
		createAccount: "アカウントを作成",
		createCredential: "資格情報を作成",
		createPool: "プールを作成",
		createPrewarmedEncoderPool: "事前起動エンコーダプールを作成",
		createStandbyPool: "スタンバイプールを作成",
		creating: "作成しています…",
		credentialsMode: "資格情報のモード",
		credentialsPassThroughToBitmovinThis:
			"資格情報は Bitmovin へ渡すだけです。このアプリは保存しません。",
		defaultCloudRegion: "既定のクラウドリージョン",
		diskSize: "ディスクサイズ",
		dnsHostname: "DNS ホスト名",
		dnsMappings: "DNS マッピング",
		dnsMappingsMoreInformation: "「DNS マッピング」の説明",
		dynamicPoolGrowsOnDemandCapped:
			"動的プール:需要に応じて増加し、上限は 10 インスタンスです",
		editBitmovinAccount: "Bitmovin アカウントを編集",
		editCredential: "資格情報を編集",
		emailPrivateKeyProject: "メールアドレス + 秘密鍵 + プロジェクト",
		encoderVersion: "エンコーダバージョン",
		encodingId: "エンコーディング ID",
		encodingTemplate: "エンコーディングテンプレート",
		encodingsEventLogAndAcquire: "エンコーディング、イベントログ、取得操作。",
		encodingsKeptPreStartedSoA:
			"チャンネルを数秒でライブにできるよう、事前に起動しておくエンコーディングです。",
		encryptedAtRestAes256Gcm:
			"エンコーダが認証に使うものすべて — ストレージ、DRM、ライブ入力、連携。保存時に暗号化 (AES-256-GCM)。秘密情報は書き込み専用で、置き換えはできますが読み出しはできません。アクセス確認とバケット参照は ライブラリ → ストレージ から。",
		failedToLoadAccounts: "アカウントを読み込めませんでした",
		failedToLoadBitmovinAccounts: "Bitmovin アカウントを読み込めませんでした",
		failedToLoadCredentials: "資格情報を読み込めませんでした",
		failedToLoadDeliveries: "配信を読み込めませんでした。",
		failedToLoadDnsMappings: "DNS マッピングを読み込めませんでした",
		failedToLoadEncodings: "エンコーディングを読み込めませんでした",
		failedToLoadPools: "プールを読み込めませんでした",
		failedToLoadRegionSettings: "リージョン設定を読み込めませんでした",
		failedToLoadSchedules: "スケジュールを読み込めませんでした",
		failedToLoadStandbyPools: "スタンバイプールを読み込めませんでした",
		failedToLoadStaticIps: "静的 IP を読み込めませんでした",
		failedToLoadStreamKeys: "ストリームキーを読み込めませんでした",
		failedToLoadTheAuditLog: "監査ログを読み込めませんでした。",
		failedToLoadTheEventLog: "イベントログを読み込めませんでした",
		failedToLoadThePayload: "ペイロードを読み込めませんでした。",
		freesEveryKeyHeldByOne:
			"1 つのエンコーディングが保持する全キーを解放します。解放はキー単位ではなくエンコーディング単位で行われます。",
		giveALiveEncoderAStable:
			"ライブエンコーダに安定したホスト名を与え、コントリビューションエンコーダが",
		gpuInstances: "GPU インスタンス",
		iamRoleName: "IAM ロール名",
		invalidDate: "日付が不正です",
		leaveTheValueBlankAndBitmovin:
			"値を空欄にすると Bitmovin が安全なランダムキーを生成します。推奨はこちらです。",
		loadMore: "さらに読み込む",
		loading: "読み込んでいます…",
		loadingAccounts: "アカウントを読み込んでいます",
		loadingBitmovinAccounts: "Bitmovin アカウントを読み込んでいます",
		loadingCloudConnectAccounts: "Cloud Connect アカウントを読み込んでいます",
		loadingCredentials: "資格情報を読み込んでいます",
		loadingDnsMappings: "DNS マッピングを読み込んでいます",
		loadingPoolDetails: "プールの詳細を読み込んでいます",
		loadingPoolEventLog: "プールのイベントログを読み込んでいます",
		loadingPools: "プールを読み込んでいます",
		loadingPrewarmedPools: "事前起動プールを読み込んでいます",
		loadingRegionSettings: "リージョン設定を読み込んでいます",
		loadingSchedules: "スケジュールを読み込んでいます",
		loadingStandbyEncodings: "スタンバイエンコーディングを読み込んでいます",
		loadingStandbyPools: "スタンバイプールを読み込んでいます",
		loadingStaticIps: "静的 IP を読み込んでいます",
		loadingStreamKeys: "ストリームキーを読み込んでいます",
		main: "main",
		manifestUrl: "マニフェスト URL",
		mapASubdomainOntoARunning:
			"サブドメインを実行中のライブエンコーディングに割り当てます。",
		noApiCallsRecordedYetTry:
			"API 呼び出しの記録がまだありません。Bitmovin アカウントで「疎通確認」を試してください。",
		noBitmovinAccountsYet: "Bitmovin アカウントがまだありません",
		noCredentialsYet: "資格情報がまだありません",
		noDeliveriesYetWebhookEventsAppear:
			"配信がまだありません。Bitmovin が送信すると webhook イベントがここに表示されます。",
		noDnsMappingsYet: "DNS マッピングがまだありません",
		noEventsLogged: "記録されたイベントはありません。",
		noPoolsInThisAccountCreate:
			"このアカウントにプールがありません。設定 → インフラ で作成するか、下に ID を貼り付けてください。",
		noPrewarmedPoolsYet: "事前起動プールがまだありません",
		noRegionSettingsYet: "リージョン設定がまだありません。",
		noSchedulesYet: "スケジュールがまだありません。",
		noStandbyEncodingsInThisPool:
			"このプールにスタンバイエンコーディングはありません。",
		noStandbyPoolsYet: "スタンバイプールがまだありません",
		noStaticIpsYet: "静的 IP がまだありません",
		noStreamKeysYet: "ストリームキーがまだありません",
		notificationsCaption:
			"イベント種別ごとの Slack / 汎用 Webhook 通知(ラベルフィルタ対応)",
		ocid1CompartmentOc1: "ocid1.compartment.oc1..",
		ocid1TenancyOc1: "ocid1.tenancy.oc1..",
		poolsBillWhileStartedScheduleStops:
			"プールは STARTED の間課金されます。使わない時間帯は停止をスケジュールしてください。",
		preWarmedPoolIds: "事前起動プール ID",
		prewarmedPools: "事前起動プール",
		privateKey: "秘密鍵",
		projectId: "プロジェクト ID",
		recentDeliveries: "直近の配信",
		regionSettings: "リージョン設定",
		regionSettingsHaveNoUpdateApi:
			"リージョン設定に更新 API はありません。変更するには削除して作り直してください。",
		replaceSecretMaterial: "秘密情報を差し替え",
		requestAFixedIngestAddressFor:
			"ライブエンコーディング用に固定の Ingest アドレスを要求します。",
		requestFailed: "リクエストに失敗しました",
		requestIp: "IP を要求",
		requestStaticIp: "静的 IP を要求",
		requesting: "要求しています…",
		reserveAKeyToGiveA:
			"キーを予約すると、コントリビューションエンコーダに安定した Ingest 用資格情報を渡せます。",
		reserveKey: "キーを予約",
		ingestPointWord: "Ingest ポイント",
		reserveStreamKey: "ストリームキーを予約",
		reservedStreamKeysCreateDeleteUnassign:
			"予約済みストリームキー(作成 / 削除 / 割り当て解除)、DNS Ingest ホスト名、取得付きスタンバイプール:アカウントレベルのライブリソースです。",
		reservedStreamKeysDnsIngestHostnames:
			"予約済みストリームキー、DNS Ingest ホスト名、スタンバイプール:個々のチャンネルより長く存続するアカウントレベルのライブリソースです。",
		reserving: "予約しています…",
		resourceGroupId: "リソースグループ ID",
		revealKey: "キーを表示",
		rotateApiKey: "API キーをローテーション",
		s3CompatEndpoint: "S3 互換エンドポイント:",
		mslEdgeCandidateLegend: "MSL4 配信 URL の候補",
		mslEdgeCandidateExplain:
			"Akamai から案内されたホスト名を入力し、ストリーム形式を選ぶと、上のストリーム ID とイベント名から候補を組み立てます。ホスト名は推測しません。MSL5 は Akamai Control Center に表示される値を上の欄へ貼り付けてください。",
		mslEdgeCandidateHost: "Akamai ホスト名",
		mslEdgeCandidateFormat: "ストリーム形式",
		mslEdgeCandidateFill: "候補を入力",
		mslEdgeCandidatePreview: "候補:",
		s3S3RoleGenericS3Akamai:
			"S3 / S3 ロール / Generic S3(Akamai・OCI プリセット)/ GCS HMAC / GCS サービスアカウント / Azure:保存時に暗号化されます。",
		saveChanges: "変更を保存",
		saveTheAccountFirstToPick:
			"先にアカウントを保存するとプールから選択できます。または下にプール ID を貼り付けてください。",
		saving: "保存しています…",
		secretFieldsAreEncryptedWithThe:
			"秘密フィールドはデータベースに届く前にサーバーの MASTER_KEY で暗号化されます。",
		secretKey: "シークレットキー",
		secretMaterialWriteOnlyAes256:
			"秘密情報:書き込み専用、保存時に AES-256-GCM で暗号化",
		serviceAccountEmail: "サービスアカウントのメールアドレス",
		serviceAccountJson: "サービスアカウント JSON",
		standbyPools: "スタンバイプール",
		standbyPoolsMoreInformation: "「スタンバイプール」の説明",
		standingEncoderInstancesThatSkipStartup:
			"起動待ちを回避する常時起動エンコーダインスタンスです。プールは 設定 → Bitmovin アカウント(既定の事前起動プール ID)またはエンコーディングごとに参照します。",
		standingEncodersBillWhileThePool:
			"常時起動エンコーダはプールが存在する間課金されます。実際の同時ライブ数に合わせてサイズを決めてください。",
		starting: "開始しています…",
		staticIpUsageMoreInformation: "「静的 IP の使い方」の説明",
		staticIps: "静的 IP",
		stopping: "停止しています…",
		// : renamed from "Storage credentials". The screen has
		// always held DRM, live-ingest and integration secrets too, and a title
		// that contradicts its contents teaches operators to distrust the labels.
		storageCredentials: "資格情報",
		groupStorage: "ストレージ",
		groupDrm: "DRM",
		groupLiveIngest: "ライブ入力",
		groupIntegration: "連携",
		streamKey: "ストリームキー",
		streamKeys: "ストリームキー",
		streamKeysMoreInformation: "「ストリームキー」の説明",
		streamUrl: "ストリーム URL",
		subscriptionId: "サブスクリプション ID",
		targetPoolSize: "目標プールサイズ",
		templateUnavailableNotDecodableText:
			"テンプレートを表示できません(テキストとしてデコードできません)。",
		tenancyOcid: "テナンシー OCID",
		tenantId: "テナント ID",
		testConnection: "疎通確認",
		testing: "確認しています…",
		theApiKeyIsEncryptedWith:
			"API キーはデータベースに届く前にサーバーの MASTER_KEY で暗号化されます。",
		theMappingBelongsToOneLive:
			"マッピングは 1 つのライブエンコーディングに属します。Bitmovin にアカウントレベルの作成 API はありません。",
		timedStartStopActionsUtcBitmovin:
			"時刻指定の START/STOP 動作(UTC。Bitmovin は秒を無視します)。",
		triggerTime: "実行時刻",
		unassignByEncoding: "エンコーディング単位で割り当て解除",
		unassignStreamKeys: "ストリームキーの割り当てを解除",
		unassigning: "解除しています…",
		webhookEventsAreReceivedAndVerified:
			"webhook イベントは診断用に受信・検証されます。ジョブとチャンネルの状態はポーリングで駆動しており、webhook 駆動のディスパッチは有効ではありません。",
		webhookPayload: "webhook ペイロード",
		workspaceConfiguration: "ワークスペースの設定。",
	},
	apiCoverage: {
		requestFields: {
			title: "SDK のリクエスト属性",
			scopeNotice:
				"SDK がリクエスト本文のモデルに宣言する最上位の属性を、操作ごとに数えています。レスポンスと共用の属性も含むため、すべてが書き込み可能とは限りません。",
			assignmentNotice:
				"「直接指定の記述あり」は、SDK 呼び出しへ直接渡すオブジェクトやモデル生成の属性名を確認したものです。省略可能・undefined の値も含み、画面からの設定や実際の送信を保証しません。スプレッド構文・変数・ヘルパー・複数候補の型は追跡しません。「未確認」は「未実装」を意味しません。",
			bodyOperations: "本文を持つ操作",
			expandedOperations: "属性を展開した操作",
			unexpandedOperations: "本文を展開できなかった操作",
			totalFields: "最上位の属性数（操作ごと）",
			sourceAssigned: "直接指定の記述あり",
			unconfirmed: "未確認の属性",
			searchLabel: "リクエスト属性を検索",
			searchPlaceholder: "属性名・型・モデル・API・ソース…",
			property: "属性名・型",
			model: "本文モデル",
			sdkDeclaration: "SDK の宣言",
			noMatches: "条件に一致するリクエスト属性はありません。",
			unexpandedTitle: "展開できなかった本文",
			unexpandedReason: "理由",
			unknownReason: "展開済みのモデルがありません。",
			arrayReason: "本文が配列になっています。",
			unknownBodyReason: "本文の具体的な型が宣言されていません。",
			unionReason: "本文の型に複数の候補があります。",
			dictionaryReason: "本文の属性名が固定されていません。",
			unsupportedReason: "この本文の型は、現在の属性抽出の対象外です。",
			noUnexpanded: "条件に一致する未展開の本文はありません。",
			previousFields: "リクエスト属性の前のページ",
			nextFields: "リクエスト属性の次のページ",
			previousBodies: "未展開の本文の前のページ",
			nextBodies: "未展開の本文の次のページ",
		},
		currentNotice:
			"SDK の Encoding API 操作と、現行ソースの呼び出しを照合した集計です。実行検証・課金検証ではありません。動的な呼び出しは未確認に残るため、未確認は未実装を意味しません。",
		sourceConfirmed: "ソースで確認",
		unconfirmed: "未確認",
		confirmedOperations: "呼び出しを確認した操作",
		confirmedCreates: "呼び出しを確認した SDK create メソッド",
		currentProvenance:
			"生成: {date} · ソースコミット: {repo} · ソース指紋: {source} · SDK: {sdk} · SDK 指紋: {sdkFingerprint} · 対象: Encoding API",
		sdkMatches:
			"SDK バージョンは一致しています。実行成功を保証するものではありません。",
		sourceEvidence: "ソースの根拠",
		sdkMethod: "SDK メソッド",
		parameterSnapshotTitle: "参考: 過去のパラメータ調査",
		parameterSnapshotNotice:
			"パラメータ分類は再調査していません。現在の設定可能範囲や最新の操作集計とは別の参考情報です。",
		parameterProvenance: "調査日: {date} · SDK: {sdk}",
		historicalNotice:
			"過去の調査スナップショットです。現在の API 対応率・利用可否、実行検証や課金検証を示すものではありません。",
		noMatches: "条件に一致するエンドポイントはありません。",
		loading: "カバレッジセンサスを読み込み中…",
		loadFailed: "カバレッジセンサスの読み込みに失敗しました",
		staleWarning:
			"インストール済み SDK は {installed}、調査対象 SDK は {surveyed} で異なります。このスナップショットは SDK 更新に合わせて更新されていません。",
		sdkVersion: "インストール済み SDK",
		surveyedAgainst: "調査対象 SDK: {version}",
		operationsImplemented: "実装済みオペレーション",
		createOperations: "create オペレーション",
		paramsReachable: "操作者が設定可能なパラメータ",
		provenance:
			"調査日: {date} · 調査コミット: {repo}。現在の利用可否は、各機能の設定画面で確認してください。",
		byFamily: "ファミリ別オペレーション",
		family: "ファミリ",
		total: "総数",
		implemented: "実装済み",
		substituted: "別経路で提供",
		notImplemented: "未実装",
		share: "割合",
		paramsByFamily: "ファミリ別パラメータ(実装済みファミリ)",
		paramsLegend:
			"wizard/advanced = フォーム項目 · raw-JSON = プラン全体インポートのみ · auto-derived = コンパイラが導出 · not settable = プランスキーマに無く、どの経路でも到達不能",
		fields: "フィールド数",
		autoDerived: "自動/固定",
		notSettable: "設定不能",
		endpoints: "全エンドポイント",
		searchLabel: "エンドポイントを検索",
		searchPlaceholder: "パス・SDK メソッド・根拠ファイル…",
		allFamilies: "全ファミリ",
		allStates: "全状態",
		matchCount: "{n} 件一致",
		endpoint: "エンドポイント",
		operation: "操作",
		state: "状態",
		channel: "チャンネル",
		note: "備考",
		prev: "前へ",
		next: "次へ",
	},
	settingsBuild: {
		title: "この画面を配信する Web ビルド",
		scope:
			"この Web の情報です。worker、別の Web、Bitmovin エンコーダのバージョンは示しません。",
		version: "アプリバージョン",
		commit: "コミット",
		unknown: "不明",
	},
	settingsX: {
		users: "ユーザー",
		usersCaption: "ロール付きの個人アカウント(ADMIN)",
		resetQueuesUnreachable:
			"データのリセットは完了しましたが、待機中の処理を一部消去できませんでした。新しい処理を開始する前に、システム管理者またはサポート窓口へお問い合わせください。",
		features: "機能",
		player: "プレイヤーと Analytics",
		apiCoverage: "API カバレッジ",
		apiCoverageCaption:
			"API 操作の最新ソース集計と根拠を確認します。過去のパラメータ調査は別欄に表示します。",
		/* Separate workspace, authentication and access, and administrator-only diagnostics. */
		groupAccess: "認証とアクセス",
		groupDiagnostics: "運用管理",
		groupDiagnosticsCaption:
			"利用可能なエンコード機能と配信検証の履歴を確認します。",
		verificationCaption: "配信検証の実行結果",
		playerCaption:
			"VOD/Live のプレビューに使うプレイヤーを選択します。Bitmovin Analytics は Bitmovin Player 選択時のみ利用できます。",
		playerLoadFailed: "プレイヤー設定を読み込めませんでした。",
		playerProvider: "プレビュー用プレイヤー",
		playerProviderHint:
			"hls.js / Shaka Player はライセンス不要です。Bitmovin Player はライセンスキーが必要です。",
		playerProviderNative: "hls.js / Shaka Player（既定）",
		playerProviderBitmovin: "Bitmovin Player（ライセンスキー必須）",
		playerOpenSourceHint:
			"hls.js / Shaka Player のプレビューでは Bitmovin Analytics へデータを送信しません。",
		playerLicenseKey: "Player ライセンスキー",
		publicClientKeyHint:
			"公開クライアントキー: 設計上ブラウザへ送る鍵で、Bitmovin 側でドメイン固定。",
		analyticsLicenseKey: "Analytics ライセンスキー",
		analyticsKeyHint:
			"Bitmovin Player でのみ使用します。本番とは別のキーを使い、QA の視聴が視聴者データに混ざらないようにします。",
		playerSaveFailed: "プレイヤー設定の保存に失敗しました。",
		playerSaved: "保存しました。次のページ読み込みから新しい設定が使われます。",
		featuresCaption: "この環境で使う機能のオン・オフを切り替えます。",
		featureQcVmaf: "VMAF ラボと QC",
		featureQcVmafHint:
			"既定はオフです。オフの間は VMAF ラボ・ウィザードの QC ゲート編集・ジョブごとの QC 表示が消え、新しい計測も作られず、qc ブロックを含むプランは拒否されます。既存のゲートで停止・失敗しているジョブは解除できるまま(QC パネル・オーバーライド・証跡出力は動きます)。",
		featuresLoadFailed: "機能設定を読み込めませんでした。",
		featuresSavedReloadHint:
			"保存しました。ナビゲーションとウィザードに反映するにはページを再読み込みしてください。",
		featuresReload: "今すぐ再読み込み",
		reset: "データのリセット",
		resetCaption:
			"削除するデータと設定を選択してください。対象の処理中止と後片付けは自動で行います。この操作は取り消せません。",
		resetDeletes: "選択したデータ {count} 件を削除します",
		resetSelectAll: "すべて選択",
		resetSelectNone: "すべて解除",
		resetAuditReceiptNote:
			"過去の操作履歴は削除し、今回のリセット記録を新たに残します。",
		resetOrganizationOnly:
			"現在の組織のデータのみをリセットします。ユーザーアカウント、組織への所属、他の組織、プラットフォーム設定は保持されます。",
		resetSelectionKept:
			"未選択の種類、保存済みメディア、環境設定ファイル（.env）は保持します。配信の停止に必要な情報は後処理の完了まで一時的に保持します。",
		resetDependenciesAdded: "関連する種類も選択しました：{categories}。",
		resetDependenciesRemoved: "依存する種類も解除しました：{categories}。",
		resetDeletedCounts: "削除した件数",
		resetSetupRequired:
			"ユーザーを削除しました。初期設定を開き、管理者を作成してください。開かない場合はページを再読み込みしてください。",
		resetOpenSetup: "初期設定を開く",
		resetDeleteContentLibrary: "コンテンツライブラリ",
		resetDeleteChannelAlertRules: "チャンネル固有のアラートルール",
		resetDeleteAlertRules: "共通アラートルール",
		resetDeleteWebhookRegistrations: "Webhook 登録",
		resetDeleteVerificationHistory: "配信検証履歴",
		resetDeleteWatchFolders: "監視フォルダー",
		resetDeleteNotificationRules: "通知ルール",
		resetDeleteNotificationChannels: "通知先",
		resetDeleteStoragePresets: "ストレージ保存先",
		resetDeletePresets: "プリセット",
		resetDeleteUsageStatistics: "使用量統計",
		resetDeleteBitmovinAccounts: "Bitmovin アカウント",
		resetDeleteCredentials: "資格情報",
		resetDeleteApiTokens: "API トークン",
		resetDeleteApplicationSettings: "アプリケーション設定",
		resetDeleteSetupCodes: "初期設定コード",
		resetDeleteUsers: "ユーザー",
		resetDeleteVodJobs: "VOD ジョブとマニフェスト履歴",
		resetDeleteLiveChannels: "ライブチャンネルと配信履歴",
		resetDeleteLiveSchedules: "ライブ予約と操作履歴",
		resetDeletePseudoLiveFeeds: "疑似ライブ配信の履歴",
		resetDeleteVmafMeasurements: "VMAF 測定と結果",
		resetDeleteStorageChecks: "ストレージ確認履歴",
		resetDeleteWatchFolderHistory: "監視フォルダの検知履歴",
		resetDeleteAlertHistory: "アラート履歴",
		resetDeleteWebhookHistory: "Webhook 配信履歴",
		resetDeleteAuditHistory: "操作履歴",
		resetKeeps:
			"認証情報、Bitmovin アカウント、ストレージ保存先、プリセット、監視フォルダ、通知、API トークン、ユーザーアカウント、アプリ設定は保持されます。",
		resetPreserves:
			"安全な運用に必要なシステム記録は保持され、削除件数には含まれません。",
		resetBitmovinNote:
			"Bitmovin 側には一切触れません(クラウド上の停止・削除は行わず、保存済みオブジェクトもそのままです)。",
		resetBlockedLocal:
			"VMAF 測定または疑似ライブ配信が実行中です。それぞれの画面で完了を待つか停止してから、データのリセットを再実行してください。",
		resetBlocked:
			"エンコーディングまたはライブ処理が実行中です。表示された処理を停止し、停止完了を待ってからデータのリセットを再実行してください。",
		resetDisarmNote:
			"監視ルール {count} 件を無効化します。検知履歴も削除されるため、有効のままだと対象プレフィックス配下の全オブジェクトを新規として再検知し、それぞれ課金対象のエンコードを投入します。次の案件を始めるときに再度有効化してください。",
		resetBlockedTruncated:
			"{total} 件中 {shown} 件を表示しています。VOD ジョブ、ライブチャンネル、疑似ライブ配信、VMAF ラボの各画面で残りの処理を完了または停止してください。",
		resetAuditUnknown:
			"リセット履歴の保存を確認できませんでしたが、保存されている可能性があります。管理者が確認するまで、下のエンコーディング ID を控えてください。",
		resetDisarmedList:
			"無効化した監視ルール: {rules}。次の案件を始めるときに、必要なものを再度有効化してください。",
		resetAuditMissing:
			"リセット履歴を保存できませんでした。下のエンコーディング ID を控え、システム管理者またはサポート窓口にお問い合わせください。",
		resetEncodersRecorded:
			"Bitmovin のエンコーディング ID を {count} 件、監査証跡に記録しました。迷子のエンコーダが見つかってもここから辿れます。",
		resetEncodersRecordedTruncated:
			"Bitmovin のエンコーディング ID {total} 件中 {shown} 件を監査証跡に記録しました。残り {omitted} 件は保存されていません。システム管理者またはサポート窓口へお問い合わせください。",
		resetProviderPointersHeading:
			"この画面を離れる前に、次の Bitmovin エンコーディング ID を控えてください。",
		resetProviderPointersTruncated:
			"{total} 件中 {shown} 件のエンコーディング ID を表示しています。残りの ID は監査証跡に保存されていません。システム管理者またはサポート窓口へお問い合わせください。",
		resetProviderResourcesTruncated:
			"クラウドエンコーディングリソース {total} 件中 {shown} 件を表示しています。残りは VOD ジョブとライブチャンネルの各画面で確認してください。",
		resetTemporaryStreamKeysUnconfirmed:
			"データのリセットは完了しましたが、一時ライブストリームキーの後処理を確認できませんでした。新しいライブチャンネルを開始する前に、Bitmovin で一時ストリームキーを確認してください。",
		resetResultReportUnconfirmed:
			"データのリセットは完了した可能性がありますが、結果レポートを確認できませんでした。次の操作を行う前に、現在のデータと Bitmovin のリソースを確認してください。システム管理者またはサポート窓口へ連絡し、確認が終わるまでリセットを再実行しないでください。",
		resetScopedNote:
			"削除対象のチャンネルに紐づくアラートルール {count} 件も削除されます。全チャンネルを対象とするルールは保持されます。",
		resetActivePseudoLive: "疑似ライブ配信 ({status})",
		resetActiveVmaf: "VMAF 測定 ({status})",
		resetActivePseudoLiveNamed: "{channel} · {source} · {date} 開始 ({status})",
		resetActiveVmafNamed: "{name} · {date} 開始 ({status})",
		resetActiveVodVmaf: "VOD 品質測定 · {date} 開始 ({status})",
		resetActiveLiveVmaf: "ライブキャプチャ · {date} 開始 ({status})",
		resetResourceVodJob: "VOD ジョブ",
		resetResourceLiveChannel: "ライブチャンネル",
		resetStatusDraft: "下書き",
		resetStatusQueued: "待機中",
		resetStatusEncoding: "エンコード中",
		resetStatusAwaitingQuality: "品質確認待ち",
		resetStatusCompleted: "完了",
		resetStatusError: "エラー",
		resetStatusCanceled: "キャンセル済み",
		resetStatusQualityFailed: "品質基準未達",
		resetStatusCreated: "作成済み",
		resetStatusPreparing: "準備中",
		resetStatusLive: "配信中",
		resetStatusStopping: "停止処理中",
		resetStatusStopped: "停止済み",
		resetStatusDownloading: "ソース取得中",
		resetStatusSending: "送信中",
		resetStatusMeasuring: "測定中",
		resetReconcileAction: "Bitmovin と照合する",
		resetReconcilePending: "Bitmovin と照合中…",
		resetReconcileHint:
			"停止済み・未開始の状態を照合します。不在のものはアカウントと不存在を確認できた場合のみ解除し、実行中・待機中・確認不能は残します。停止や削除は行いません。",
		resetReconcileDone:
			"照合結果: 停止・未開始・不存在確認 {confirmed} 件、実行中・待機中 {running} 件、確認不能 {unverified} 件。",
		resetBlockedEncoders:
			"クラウドのエンコーディングリソースが動作中の可能性があります。表示されたエンコーディング ID を Bitmovin で確認し、動作中のリソースを停止してからデータのリセットを再実行してください。",
		resetAisaJobLink: "未退避のジョブを開く",
		resetBlockedVerification:
			"以前の処理で作成された配信リソースの後処理を確認できないため、データをリセットできません。システム管理者またはサポート窓口にお問い合わせください。",
		resetConfirmLabel: "確認のため {word} と入力してください。元に戻せません。",
		resetAction: "リセットする",
		resetDone: "リセットが完了しました。",
		resetLoadFailed: "リセット対象を読み込めませんでした。",
		apiTokens: "API トークン",
		live: "ライブ",
		liveChannelsInThisApp: "このアプリのライブチャンネル",
		encodingIdOrPasteOne: "エンコーディング ID(貼り付けも可)",
		deleteStandbyPoolNamed:
			"プール「{name}」を削除しますか? 保持しているスタンバイエンコーディングもすべて削除されます。",
		addProviderAccount: "{provider} アカウントを追加",
		addProviderCloudConnect: "{provider} Cloud Connect アカウントを追加",
		awsInfrastructureSuffix: " · AWS インフラ {id}",
		connectYourOwnProviderAccount:
			"自社の {provider} アカウントを接続すると、自前のインフラでエンコーディングを実行できます。",
		connectedLatency: "接続成功 · {ms}ms",
		couldNotListChannels: "このアプリのライブチャンネルを取得できませんでした",
		deleteProviderAccountNamed:
			"{provider} アカウント「{name}」を削除しますか? 更新用 API はないため、元に戻すには作り直すしかありません。",
		deleteStreamKeyAssignedTail:
			" このキーは現在 ASSIGNED です。割り当てを解除するまで Bitmovin は削除を拒否します。",
		dnsIntro:
			"ライブエンコーダに固定のホスト名を与えると、再起動で IP が変わってもコントリビューションエンコーダの向き先を変更する必要がなくなります。",
		encodingIdCopyLabel: "エンコーディング ID",
		encodingIdLine: "エンコーディング {id}",
		encodingWord: "エンコーディング",
		failed: "失敗",
		infrastructureManagedPerAccount:
			"インフラは Bitmovin アカウント単位で管理します。",
		keyCountOne: "キー {count} 個",
		keyCountOther: "キー {count} 個",
		liveResourcesManagedPerAccount:
			"ライブリソースは Bitmovin アカウント単位で管理します。",
		managedCloudSuffix: " · マネージドクラウド",
		noLiveChannelWithEncoding:
			"このアプリのライブチャンネルには、まだ Bitmovin エンコーディングが紐づいていません。下にエンコーディング ID を貼り付けてください。",
		noProviderAccounts: "{provider} の Cloud Connect アカウントがありません",
		notifications: "通知",
		orgLabel: "組織 {id}",
		pasteIdsManuallyBelow: "— 下に ID を手入力してください。",
		perRegionNetworkConfig:
			"この {provider} アカウントのリージョン別ネットワーク設定です。",
		prewarmedPoolSummary:
			"{version} · {region} · ディスク {disk} GB · 目標 {target}",
		prioritySuffix: " · 優先度 {value}",
		releaseStaticIpUsedTail:
			" このアドレスは現在エンコーディングに USED として使われています。",
		reservedKeyIntro:
			"予約済みキーは複数のライブエンコーディングで再利用できるため、コントリビューションエンコーダの設定は 1 つで済みます。Bitmovin は単一エンコーディング用の",
		reservedKeyIntroTail: "キーも発行し、それもここに表示されます。",
		roleArn: "ロール ARN:",
		showingAccounts: "アカウント:{shown}",
		showingMappings: "マッピング:{shown}",
		showingPools: "プール:{shown}",
		showingPoolsNoPaging:
			"プール:{shown}。Bitmovin のプール一覧はページングパラメータを取りません。",
		showingRecentChannels:
			"直近 {count} 件のチャンネルを表示しています。一覧にない場合は ID を貼り付けてください。",
		showingStaticIps: "静的 IP:{shown}",
		showingStreamKeys: "ストリームキー:{shown}",
		shownOfTotal: "{total} 件中 {shown} 件",
		standbyIntro:
			"チャンネルを数秒で開始できるよう、事前起動しておくエンコーディングです。待機インスタンスはプールが存在する間、課金され続けます。",
		standbyPoolCounts:
			"準備完了 {ready} · 準備中 {preparing} · エラー {error} · 目標 {target}",
		staticIpIntro:
			"静的 IP は LIVE エンコーディングの作成時に紐づけられます (Encoding.staticIpId)。アドレスのライフサイクルはここで管理し、選択はライブウィザードで行います。",
		templateSuffix: " · テンプレート {name}",
		webhooks: "Webhook",
		infrastructure: "インフラ",
		deleteAccountNamed: "アカウント「{name}」を削除しますか?",
		deleteCredentialNamed:
			"資格情報「{name}」を削除しますか? これを使用している保存先プリセットも削除されます。",
		deleteDnsMapping: "DNS マッピング {name} を削除しますか?",
		deletePoolNamed: "プール「{name}」を削除しますか?",
		deleteStreamKeyNamed: "ストリームキー「{name}」を削除しますか?",
		releaseStaticIp: "静的 IP {name} を解放しますか?",
		deleteRegionSettings:
			"{provider} の {region} リージョン設定を削除しますか?",
		regionSettingsFor: "{name} のリージョン設定",
		schedulesFor: "{name} のスケジュール",
		standbyPoolFor: "{name} のスタンバイプール",
		removePoolId: "プール {id} を削除",
		receivedAt: "{when} に受信",
		holdsKeys: "保持: {names}",
	},
	settingsForms: {
		action: "動作",
		allInfrastructureBelowLivesInThisAccount:
			"以下のインフラはすべて、このアカウントの Bitmovin 組織に属します",
		allLiveResourcesBelowLiveInThis:
			"以下のライブリソースはすべて、このアカウントの Bitmovin 組織に属します",
		at: "時刻",
		awsInfrastructureIdOptional: "AWS インフラ ID(任意)",
		call: "呼び出し",
		cloudConnectInfrastructureIdOptional: "Cloud Connect インフラ ID(任意)",
		cloudConnectRunsBitmovinEncodersInsideYour:
			"Cloud Connect は Bitmovin のエンコーダを自社のクラウドアカウント内で実行します",
		created: "作成日時",
		defaultsAppliedToNewEncodingsPickFrom:
			"新しいエンコーディングに適用される既定値です。このアカウントのプールから選ぶか、他組織の ID を貼り付けてください",
		delete: "削除",
		descriptionOptional: "説明(任意)",
		details: "詳細",
		duration: "所要時間",
		dynamic10: "動的(10 以下)",
		eachIpServesOneEncodingAtA:
			"1 つの IP は同時に 1 つのエンコーディングにしか使えません:すでに USED の IP でエンコーディングを開始すると、そのエンコーディングは ERROR になります。何も参照していないときだけ解放(削除)してください。",
		eachPoolStartsItsEncodingsFromAn:
			"各プールはエンコーディングテンプレートからエンコーディングを起動します。プールは targetPoolSize に向けて自動的に補充されるため、不調なインスタンスを 1 つ削除しても安全です。取得すると、そのエンコーディングの Ingest ポイントとマニフェスト URL が渡されます。このアプリで管理チャンネルとして取り込む機能はまだ実装されていないため、座標をコピーして使ってください。",
		edit: "編集",
		eitherTheWholeServiceAccountJsonOr:
			"サービスアカウント JSON 全体、またはメール / キー / プロジェクトに分けて指定します",
		encoding: "エンコーディング",
		encodings: "エンコーディング",
		endpoint: "エンドポイント",
		eventLogNewestFirst: "イベントログ(新しい順)",
		externalIdOptional: "外部 ID(任意)",
		fallbackRegionsCommaSeparated: "フォールバックリージョン（優先順）",
		infrastructure: "インフラ",
		instancesKeptReadyForStreaming1100:
			"配信用に待機させるインスタンス数(1〜100)",
		k12DigitAccountId: "12 桁のアカウント ID",
		label: "ラベル",
		leaveBlankForBitmovinManagedCloud:
			"Bitmovin マネージドクラウドを使う場合は空欄",
		leaveTheValueBlankAndBitmovinGenerates:
			"値を空欄にすると Bitmovin が安全なランダムキーを生成します。自分で指定する場合は、全体で一意かつ推測不可能な値にしてください:キーを知っている人は誰でもライブエンコーディングに配信できます。ASSIGNED のキーは削除できません。まず割り当てを解除するか、エンコーディングを停止してください。",
		live: "ライブ",
		localTimeStoredAsUtcSecondsAre:
			"ローカル時刻。UTC で保存され、秒は無視されます",
		lowercaseLettersDigitsAndDashesMax63:
			"英小文字・数字・ハイフン、最大 63 文字",
		manifest: "マニフェスト",
		modernPathBitmovinAssumesThisRoleNo:
			"推奨の方式:Bitmovin がこのロールを引き受けるため、固定キーは不要です",
		mustBeASpecificRegionOrExternal:
			"個別のリージョンを指定してください(または EXTERNAL と Cloud Connect インフラ ID)。AUTO や大陸・プロバイダ単位の集約値は拒否されます",
		mustBeGloballyUniqueAndUnguessableBlank:
			"全体で一意かつ推測不可能な値にしてください。空欄のほうが安全です",
		name: "名前",
		nameOptional: "名前(任意)",
		onlyForAwsCloudConnectInfrastructuresLeave:
			"AWS Cloud Connect インフラ専用です。Bitmovin マネージドクラウドの場合は空欄",
		pasteThePlainTemplateItIsBase64:
			"テンプレートをそのまま貼り付けてください。送信時に base64 エンコードされます",
		payload: "ペイロード",
		pickOneOfThisAppSLive:
			"このアプリのライブチャンネルから選ぶか、このアプリが作成していないエンコーディングの ID を貼り付けてください",
		poolIdOtherOrg: "プール ID(他組織)",
		processed: "処理時刻",
		processingPending: "未処理",
		provider: "プロバイダ",
		received: "受信時刻",
		region: "リージョン",
		reservedKeysPersistTemporaryOnesAreTied:
			"RESERVED のキーは残り続けます。TEMPORARY のキーは 1 つのエンコーディングに紐づきます",
		retry: "再試行",
		schedules: "スケジュール",
		schedulingPriority0100: "スケジューリング優先度(0〜100)",
		secretConfigured: "シークレット設定済み",
		sentAsXTenantOrgIdOn:
			"すべての API 呼び出しで X-Tenant-Org-Id として送信されます",
		serviceAccountCredentialsJson: "サービスアカウントの資格情報(JSON)",
		signature: "署名",
		signatureUnverified: "未検証",
		signatureVerified: "検証済み",
		stableBetaOrAPinnedVersion: "STABLE / BETA、またはバージョン固定",
		standingInstancesKeptWarmWhileStarted:
			"STARTED の間、常時ウォーム状態で維持されるインスタンス数",
		start: "開始",
		status: "ステータス",
		stop: "停止",
		subdomain: "サブドメイン",
		tenantOrgIdOptional: "テナント組織 ID(任意)",
		theLiveEncodingCurrentlyHoldingTheKey:
			"そのキーを現在保持しているライブエンコーディングです。選択するか、ID を貼り付けてください",
		theSubdomainIsOneDnsLabelLowercase:
			"サブドメインは DNS ラベル 1 つです:英小文字・数字・ハイフンで最大 63 文字。マッピングは特定のエンコーディングに属し、Bitmovin にはアカウントレベルの作成・削除がないため、どちらもエンコーディング ID を指定します。稼働中の各チャンネルの詳細ページでも、そのチャンネル自身のマッピングを確認できます。",
		type: "種類",
		unassign: "割り当て解除",
		valueOptional: "値(任意)",
		view: "表示",
		webhooks: "Webhook",
		writeOnlyEncryptedAtRestNeverShown:
			"書き込み専用:保存時に暗号化され、二度と表示されません",
		writeOnlyPassesThroughToBitmovinNever:
			"書き込み専用:Bitmovin へ渡されるだけで、ここには保存されません",
	},
	fields: {
		spekeUrl: "SPEKEエンドポイント",
		spekeApiKey: "APIキー（任意）",
		spekeGatewayRegion: "API Gatewayリージョン（任意）",
		spekeExternalIdMode: "External IDモード（任意）",
		spekeVaultHelp:
			"エンドポイントと認証情報を暗号化保管します。Basic認証はユーザー名とパスワードを両方指定してください。",
		spekeRoleHelp:
			"AWSロールARNを指定する場合は必須です。SPEKE API Gatewayのリージョンを指定してください。",
		lmiScte35Help:
			"SCTE-35を受信Originへ渡します。再生用マニフェストはOrigin側で生成します。",
		lmiPublishingPoint: "公開先URL",
		lmiPublishingPointHelp:
			"Originの公開先URL（例：https://origin.example/live/channel.isml）。暗号化して保存します。",
		lmiScte35Passthrough: "SCTE-35を引き継ぐ",
		k165535: "1–65535",
		k16ByteCencFairplayContentKey:
			"16 バイトの CENC / FairPlay コンテンツキー。kid はプランに残ります",
		accessKey: "アクセスキー",
		accessKeyId: "アクセスキー ID",
		accountKey: "アカウントキー",
		accountLegacyKeys: "アカウント {number}(旧方式のキー)",
		aes128Exactly16CharactersAes:
			"AES-128 はちょうど 16 文字、AES-256 はちょうど 32 文字。チャンネル開始時に解決し、プランには保存しません",
		apiTokenConfigured: "API トークン設定済み(書き込み専用)",
		appliesToBitmovinIOBrowsing:
			"Bitmovin の入出力に適用されます。ブラウズは常に V4 で署名します",
		azureSummary: "{subscription} · {group} · テナント {tenant}",
		bitmovinAssumesThisRoleNoStatic:
			"Bitmovin がこのロールを引き受けます。固定キーは保存しません",
		contentKey32HexChars: "コンテンツキー(16 進 32 文字)",
		customerSecretKey: "カスタマーシークレットキー",
		customerSecretKeyId: "カスタマーシークレットキー ID",
		decryptionKeyOptional: "復号キー(任意)",
		externalIdOptional: "外部 ID(任意)",
		firewallId: "ファイアウォール ID",
		hmacAccessKey: "HMAC アクセスキー",
		hmacSecret: "HMAC シークレット",
		host: "ホスト",
		mslStreamId: "ストリーム ID",
		mslEventName: "イベント名",
		mslPublishingUsername: "MSL5 publishing ユーザー名 (Digest)",
		mslPublishingPairBothOrNeither:
			"MSL5 セグメント publishing 用の HTTP Digest ユーザー名。両方を指定するか、両方とも空にしてください — 片方だけは provisioning 時に Bitmovin から拒否されます。",
		mslPublishingPassword: "MSL5 publishing パスワード (Digest)",
		mslPublishingOnlyMsl5:
			"MSL5 専用: MSL4 出力にこれらを設定すると Bitmovin が拒否するため、MSL4 チャンネルでは無視されます。書き込み専用 — 保存後は読み取れません。",
		mslEdgeBaseUrlOptional: "配信エッジのベース URL(任意)",
		mslEdgeBaseUrlHint:
			"視聴者がストリームを読み込む Akamai の配信ルート。https のみ、クエリと末尾のスラッシュは不可。MSL4 は https://<ホスト名>/hls/live/<ストリーム ID>/<イベント名>、MSL5 は Akamai Control Center に表示される値。アプリは /<マニフェスト名> を付加します。このリンクは視聴者側のエッジであり、エンコーダが配信中である証明ではありません。",
		kantarServicePassword: "Kantar サービスパスワード",
		kantarServiceUserEncryptedAlongsideThe:
			"Kantar のサービスユーザー。パスワードと共に暗号化され、保存後は読み出せません",
		limitParallelEncodingsOptional: "同時実行エンコーディング数の上限(任意)",
		login: "ログイン名",
		namespace: "ネームスペース",
		network: "ネットワーク",
		networkName: "ネットワーク名",
		nexguardLicense: "NexGuard ライセンス",
		numericAkamaiIdsAreNumbersUnlike:
			"数値で入力します。Akamai の ID は他のプロバイダと違って数値です",
		ociUserSettingsCustomerSecretKeys:
			"OCI → ユーザー設定 → カスタマーシークレットキー",
		passphrase16Or32Chars: "パスフレーズ(16 文字または 32 文字)",
		password: "パスワード",
		passwordOptional: "パスワード(任意)",
		pasteTheFullKeyFileClient:
			"キーファイル全体を貼り付けてください(client_email、private_key)",
		poisBasicAuthUserEncryptedAlongside:
			"POIS の Basic 認証ユーザー。パスワードと共に暗号化され、保存後は読み出せません",
		port: "ポート",
		portOptional: "ポート(任意)",
		publicBaseUrlsOptional: "公開ベース URL(任意)",
		oneLinePerBucketBucketHttpsCdn:
			"1 バケット 1 行で記述します: bucket = https://cdn.example.com/base。バケットが公開配信されている場所を宣言し、出力先 ACL から導出した URL より優先されます。公開 URL を推定できない Azure コンテナと OCI では必須です。",
		provideAtLeastOneOfPassword:
			"パスワードと復号キーのうち、少なくとも一方を指定してください",
		region: "リージョン",
		regionEndpointEndingInLinodeobjectsCom:
			".linodeobjects.com で終わるリージョンエンドポイント:Bitmovin の GenericS3 として V4 署名で保存されます",
		resolvedByTheLiveWorkerAt:
			"チャンネル開始時に解決します。プランは資格情報への参照のみを保持します",
		roleArn: "ロール ARN",
		secretAccessKey: "シークレットアクセスキー",
		secretKey: "シークレットキー",
		securityGroupId: "セキュリティグループ ID",
		serviceAccountJson: "サービスアカウント JSON",
		serviceAccountKeyJson: "サービスアカウントキー JSON",
		signatureVersion: "署名バージョン",
		sshPortOptional: "SSH ポート(任意)",
		storageAccountName: "ストレージアカウント名",
		subnetId: "サブネット ID",
		subnetName: "サブネット名",
		subnetOcid: "サブネット OCID",
		useTls: "TLS を使用",
		username: "ユーザー名",
		webhookUrl: "Webhook URL",
		webhookUrlHint:
			"https:// のみ — パスワードと同様に扱ってください(Slack incoming webhook は投稿権限そのものです)。SECRET_EGRESS_ALLOWED_HOSTS を設定している場合、ホストをそこに含める必要があります",
	},
	webhookReg: {
		account: "Bitmovin アカウント",
		accountLead:
			"アカウント単位で残っている hook — このアプリの以前の登録と、他のアプリの登録。不要なものを削除してください。ここから新たに登録することはありません。",
		colKind: "種別",
		colLastDelivery: "最終配信",
		colSubject: "エンコーディング",
		colUrl: "receiver URL",
		confirmExternalUnregister:
			"このアプリの登録ではありません — もう一度クリックで削除",
		external: "外部",
		listFailed: "登録一覧を取得できませんでした。",
		noDelivery: "未配信",
		noneRegistered: "このアカウントに webhook 登録はありません。",
		noPerEncoding:
			"エンコーディング単位の登録はまだありません — ジョブやライブ配信にエンコーディングが作られると表示されます。",
		noteIngressChanged: "公開 ingress が変わったため再登録",
		noteIngressUnavailable: "公開 ingress がないため待機中",
		noteKeyRotated: "署名鍵が更新されたため再登録",
		noteOrphan: "エンコーディングが削除されたため hook を削除",
		noteTerminal: "エンコーディングが終了したため hook を削除",
		perEncodingLead:
			"実行中のジョブとライブ配信ごとに自動登録されます(finished / error / transfer error / live manifest ready)。エンコーディング終了時に削除され、公開 ingress が変わると再登録されます。",
		perEncodingTitle: "エンコーディング単位の登録",
		removeFailed: "削除に失敗しました。",
		reregisterFailed: "再登録を依頼できませんでした。",
		reregisterNow: "今すぐ再登録",
		reregisterRequested:
			"依頼しました — 待機中の登録は {seconds} 秒以内に再試行されます。",
		runSubject: "{name} · 配信 #{seq}",
		selectAccount: "アカウントを選択…",
		statusActive: "有効",
		statusDeleted: "削除済み",
		statusFailed: "失敗",
		statusSkipped: "待機中",
		thisApp: "このアプリ",
		title: "アカウント単位の hook(Bitmovin → このアプリ)",
		unregister: "登録解除",
		urlCurrent: "現在の ingress",
		urlStale: "以前の ingress",
	},
	ingress: {
		snapshotNote:
			"この情報はページを開いた時点のものです。最新の状態は「更新」で確認してください。",
		checked: "確認時刻 {when}",
		legacyRow: "このアプリ(旧・署名なし)",
		mode: "モード",
		modeNamedTunnel: "named tunnel(INGRESS_HOSTNAME)",
		modeNone: "なし",
		modeQuickTunnel: "quick tunnel(cloudflared)",
		modeStatic: "static(PUBLIC_BASE_URL)",
		none: "公開 ingress がありません — Bitmovin はこのインストールへ到達できません。{reason}",
		notReported:
			"公開 ingress がまだ報告されていません — バックグラウンド処理は起動していますか?",
		receiver: "署名付き receiver",
		receiverHint:
			"登録はエンコーディングごとに自動で行われ、それぞれ固有の receiver URL と署名鍵(表示されません)を持ちます。Bitmovin ダッシュボードで手動登録した hook は鍵を持てず、受信時に拒否されます。",
		secretEnv: "署名検証 有効(BITMOVIN_WEBHOOK_SECRET)",
		secretGenerated: "署名検証 有効(自動生成鍵)",
		secretUnavailable: "署名鍵を利用できません(MASTER_KEY)",
		since: "{when} から",
		stale:
			"最終確認 {when} — バックグラウンド処理が停止している可能性があります。",
		title: "公開 ingress",
	},
	wizard: {
		onDemandDrmTemplateUnavailable:
			"OnDemand MP4 DRMのYAML出力は利用できません。DRMを維持するにはプランJSONを保存するか、このアプリから実行してください。",
		spekeTemplateUnavailable: "SPEKE設定はプランJSONで保存できます。",
		spekeOtherSystems: "その他のシステムID（任意）",
		spekeProvider: "SPEKE鍵プロバイダー",
		spekeSystems: "DRMシステム",
		spekeSystemsHelp: "鍵プロバイダーが対応するDRMを1つ以上選択してください。",
		spekeContentHelp:
			"省略時はIDが生成されます。Content IDとKIDが同じ場合は同じ鍵を要求します。",
		spekeIvHelp: "FairPlayの場合は必須です。32桁の16進数で指定してください。",
		burnInSrt: "SRT 字幕の焼き込み",
		burnInSrtHelp:
			"入力ファイルから SRT 素材を選択します。字幕が映像に焼き込まれます。",
		burnInSrtNone: "なし",
		subtitleEncoding: "文字コード",

		gcsRegion: "GCSリージョン",
		gcsRegionHint:
			"Google Cloudのリージョンを選択します。未指定はプロバイダー既定値です。",
		segmentNamingTemplate: "セグメント命名テンプレート",
		segmentNamingTemplateHint:
			"指定時はセグメント名より優先されます。例: seg-{rand_chars:8}-%number%.m4s",
		credentialsLoadFailed:
			"資格情報を読み込めませんでした。再試行してストレージの資格情報を選択してください。",
		accountsLoadFailed:
			"Bitmovinアカウントを読み込めませんでした。再試行してアカウントを選択してください。",
		aisaDisabledQcOnly:
			"VMAF専用エンコードではAIシーン解析を行いません。保存した設定を使うにはVMAF専用をオフにしてください。",
		previewPlacementNeedsJit:
			"プレビュー配置にはジャストインタイムが必要です。生成タイミングを変更するか、開始時の配置をVOD（既定）に戻してください。",
		encodingModeFromLadder: "ラダーのモード・プリセットを使用",
		encodingModeFromLadderHint:
			"手順3のラダーでモードまたはプリセットを設定します。重複を避けるため、ジョブ全体のモードは送信しません。",
		noPreset: "なし（エンコーディングモードを使用）",
		copiedPerTitleBitrateFixed:
			"コピー内の Per-Title テンプレートに残っていた固定ビットレートを解除しました。他の設定値と元のジョブは変更していません。",
		copySourceFailed:
			"コピー元のジョブを読み込めません。リンクを確認して再度お試しください。ジョブは作成されていません。",
		copiedJobHint:
			"設定をコピーしました。確認・編集後にエンコードを開始してください。新しいジョブはまだ作成されていません。",
		muxedAudioNone: "同梱しない(映像のみ)",
		muxedAudio: "同梱する音声",
		muxedAudioHint:
			"このセグメントの中を一緒に流れる音声です。自前で音声を運ぶ variant には EXT-X-MEDIA グループが不要で、運ばない variant は独立した音声コンテナを参照します。",
		ownContainer: "独立コンテナ",
		ownContainerLabel: "この音声用に作る",
		ownContainerOnHint:
			"この音声だけのコンテナを作り、EXT-X-MEDIA グループから参照します。この音声を必要とする variant がすべて自前で運んでいる場合以外は、オンのままにしてください。",
		ownContainerOffHint:
			"独立したコンテナを作りません。この音声は、同梱先の映像コンテナの中だけで配信されます。",
		ownContainerOffUncarriedHint:
			"この音声を運ぶ映像コンテナがないため、コンテナを作ります。オフのままだと音声が配信から丸ごと消えます。",
		aManifestInThisPlanMultipliesHls:
			"このプランのマニフェストは音声グループごとに HLS バリアントを増やします:各音声レンディションにメディアエントリ(グループ ID / 名前 / URI)を、各映像レンディションにバリアントラベルを与えてください。指定しないとマスタープレイリストが不完全になります。dolby-dv-hdr10-sdr プリセットに完全な形があります。",
		aPresetWithThatNameAlreadyExists:
			"同名のプリセットが既に存在します。別の名前を指定してください。",
		aclPublicReadNeededForDirectPlayback:
			"ACL PUBLIC_READ（公開読み取りを要求）",
		adaptiveSpatialTransform: "適応的空間変換",
		addAdaptationSet: "アダプテーションセットを追加",
		addAudio: "音声を追加",
		addCenc: "CENC を追加",
		addConcatenation: "連結を追加",
		addContainerFormat: "コンテナ形式を追加",
		addDash: "DASH を追加",
		addDeinterlaceFilter: "フィルターを追加",
		addDolbyStream: "Dolby ストリームを追加",
		addEncoding: "エンコーディングを追加",
		addFairplay: "FairPlay を追加",
		addHls: "HLS を追加",
		addHlsMediaEntry: "HLS メディアエントリを追加",
		addIngestTrack: "Ingest トラックを追加",
		addInputFile: "入力ファイルを追加",
		addKeyframe: "キーフレームを追加",
		addNexguardWatermarking: "NexGuard ウォーターマークを追加",
		addSmooth: "SMOOTH を追加",
		addSource: "ソースを追加",
		addSprite: "スプライトを追加",
		addSubtitle: "字幕を追加",
		addThumbnail: "サムネイルを追加",
		addTrim: "入力クリップを追加",
		addVideo: "映像を追加",
		addWebvttSubtitle: "WebVTT 字幕を追加",
		additionalManifests: "追加マニフェスト",
		addsAProgressiveMp4QcMirrorPer:
			"映像レンディションごとにプログレッシブ MP4 の QC ミラーを作成し(出力先の qc/ 配下)、エンコードが FINISHED した後で libvmaf によりソースと自動的に比較します。レポートは VMAF ラボ (/qc) に表示されます。",
		adoptConfigurationThreshold: "設定採用のしきい値",
		advanced: "詳細設定",
		advancedAv1: "詳細設定(AV1)",
		advancedH264: "詳細設定(H264)",
		advancedH265: "詳細設定(H265)",
		advancedNeededOnlyForMultiAudioGroup:
			"詳細設定:複数音声グループの HLS、または複数ラダーの DASH(Dolby DV/HDR10/SDR プリセット)でのみ必要です。上で宣言した DASH アダプテーションセットへレンディションを振り分け、HLS バリアントラベルを与え、あるいは EXT-X-MEDIA エントリを追加します。HLS/DASH マニフェストが 1 つだけなら未設定のままにしてください。",
		advancedPaddingAspect: "詳細設定(パディング、アスペクト)",
		advancedPlacementHlsAudioGroups: "詳細な配置(HLS 音声グループ)",
		advancedVp9: "詳細設定(VP9)",
		ai: "ai",
		alsoComputePsnr: "PSNR も計算する",
		alsoComputePsnrMoreInformation: "「PSNR も計算する」の説明",
		anEncryptionRowTargetsThisOutputIts:
			"暗号化行がこの出力を対象にしています。その宛先は省略され、DRM 出力側が書き込みます。ここに値を入れるとそれを上書きします。",
		analysisJson: "analysis.json",
		apiDefaultCtr: "(API 既定は CTR)",
		appliesWhileARenditionUsesTheImplicit:
			"レンディションが暗黙の映像トラックを使う間、適用されます",
		appliesWhileARenditionUsesTheImplicit2:
			"レンディションが暗黙の音声トラックを使う間、適用されます",
		apply: "適用",
		aqMode: "AQ モード",
		aqStrength: "AQ 強度",
		arnrMaxFrames: "ARNR 最大フレーム数",
		arnrStrength: "ARNR 強度",
		arnrType: "ARNR 種別",
		aspectMode: "アスペクトモード",
		assetDescriptionFilename: "アセット記述ファイル名",
		attachDolbyVisionMetadata: "Dolby Vision メタデータを添付",
		attachFilter: "フィルタを適用",
		attachmentOrderMattersPositionIsTheCreate:
			"適用順序に意味があります。位置はストリーム上での作成順です。フィルタはラダーステップのフィルタ一覧で定義します。",
		audioGroupId: "音声グループ ID",
		audioInputFile: "音声入力ファイル",
		audioLanguage: "音声言語",
		audioMediaUri: "音声メディア URI",
		audioMuxingKind: "音声 muxing 種別",
		audioRenditions: "音声レンディション",
		audioVariantStreams: "音声バリアントストリーム",
		audioVideoSyncMode: "音声 / 映像の同期モード",
		autoEnable: "自動有効化",
		autoLevelSetup: "レベル自動設定",
		autoNull: "自動 (null)",
		automaticAdPlacementAllsceneboundaries:
			"広告位置の自動挿入 (allSceneBoundaries)",
		aisaSchedule: "広告キューポイントの時刻指定",
		aisaDefaultLanguage: "英語の解析結果は標準で含まれます。",
		aisaAdditionalLanguagesHelp:
			"英語以外に必要な言語を、ja、de のような言語コードで最大 3 つ指定します。複数ある場合はカンマで区切ってください。",
		aisaPosition: "位置（秒）",
		aisaMaxDeviation: "最大許容ずれ（秒）",
		aisaDuration: "長さ（秒・任意）",
		aisaAddCue: "キューポイントを追加",
		aisaRemoveCue: "キューポイントを削除",
		aisaNeedsCue: "キューポイントを 1 件以上追加してください。",
		aisaNonnegativeNumber: "0 以上の数値を入力してください。",
		aisaScheduleHelp:
			"最大許容ずれが 0 の場合、シーン境界への調整は行いません。コーデック間で実際の切断フレームが一致する保証はありません。",
		autorepresentationsEmptyObjectEnablesDefault:
			"autoRepresentations(空オブジェクトで既定値が有効になります)",
		bFrames: "B フレーム",
		back: "戻る",
		base64PublicManifestMetadata: "Base64:公開マニフェストのメタデータ",
		baselinePreset: "比較元プリセット",
		basics: "基本",
		beforeYouStartPresetChecklist: "開始前のチェックリスト",
		bitmovinAccount: "Bitmovin アカウント",
		bitrateBps: "ビットレート (bps)",
		bitrateSelection: "ビットレートの決め方",
		blocked: "ブロック",
		browseStorage: "ストレージを参照…",
		browseThePresetGallery: "プリセットギャラリーを見る",
		bucket: "バケット",
		buckets: "バケット",
		bufsizeBits: "バッファサイズ (bits)",
		cabac: "CABAC",
		campaignAUhd: "campaign-a, uhd",
		change: "変更",
		channelLayout: "チャンネルレイアウト",
		channelName: "チャンネル名",
		clEnumEmptyClStereo: "CL_* 列挙:空欄 = CL_STEREO",
		clientManifest: "クライアントマニフェスト",
		closedCaptions: "クローズドキャプション",
		cloudRegion: "クラウドリージョン",
		codec: "コーデック",
		codecBufsizeFactor: "コーデックのバッファサイズ係数",
		codecMaxBitrateFactor: "コーデックの最大ビットレート係数",
		codecMinBitrateFactor: "コーデックの最小ビットレート係数",
		colorConfig: "カラー設定",
		colorPrimaries: "原色点",
		colorSpace: "色空間",
		colorTransfer: "伝達特性",
		commaSeparatedEncodingLabelsTagsThatGroup:
			"カンマ区切り:Bitmovin の統計で結果をまとめる Encoding.labels のタグです。空欄 = なし",
		commaSeparatedInTheChosenUnit: "カンマ区切り、選択した単位で指定",
		compareYourBuiltPlanAgainstASample:
			"作成したプランをサンプルや保存済みプリセットと比較します",
		complexityFactor: "複雑度係数",
		configuredInSettingsBitmovinAccounts:
			"設定 → Bitmovin アカウントで登録します",
		container: "コンテナ",
		contentKeyVault: "コンテンツキー(保管庫)",
		contentKey32Hex: "コンテンツキー(32 桁の hex)",
		contentKeyMustBe32Hex: "キーは 32 桁の hex(16 バイト)で入力してください。",
		enterKeyDirectly: "キーを直接入力…",
		inlineKeyDefaultLabel: "ウィザード入力キー",
		inlineKeyStoredEncrypted:
			"DRM_CENC 資格情報として保存します — AES-256-GCM で暗号化保管、以後は書き込み専用。プランには参照のみが載ります。",
		saveKeyAndUse: "キーを保存して使用",
		contentKeysStayInTheVaultA:
			"DRM資格情報は暗号化保管され、各行には参照のみが載ります。暗号化出力はDRMの宛先へ書き込まれます。",
		contentReference: "コンテンツ参照",
		copyChromaLoc: "クロマ位置をコピー",
		copyColorRange: "カラーレンジをコピー",
		copyColorSpace: "色空間をコピー",
		copyPreview: "プレビューをコピー",
		copyPrimaries: "原色点をコピー",
		copyTransfer: "伝達特性をコピー",
		couldNotReadTheSelectedFile: "選択したファイルを読み込めませんでした",
		couldNotSaveThePreset: "プリセットを保存できませんでした。",
		cpuUsed: "CPU 使用度",
		creationMode: "作成モード",
		credential: "資格情報",
		credentials: "資格情報",
		current: "現在:",
		dashAdaptationSet: "DASH アダプテーションセット",
		dashAdaptationSetRoutingAppearsHereOnce:
			"DASH アダプテーションセットの振り分けは、DASH マニフェストがアダプテーションセットを宣言すると(マニフェストステップ)ここに表示されます。Dolby の複数ラダープリセットで使用します。",
		dashOptions: "DASH オプション",
		dashStreamMpd: "DASH (stream.mpd)",
		default: "(既定)",
		default10: "既定 10",
		default6: "既定 6",
		defaultApi: "既定 (API)",
		defaultEnWebvttSegNumberVtt: "既定 en_webvtt_seg_%number%.vtt",
		defaultInitHdr: "既定 init.hdr",
		defaultInitMp4: "既定 init.mp4",
		defaultSegNumberChk: "既定 seg_%number%.chk",
		defaultSegNumberTs: "既定 seg_%number%.ts",
		addDeliveryMirror: "配信先を追加",
		deliveryMirror: "配信ミラー",
		deliveryMirrors: "追加の配信先(ミラー)",
		defaultSegmentNumberM4s: "既定 segment_%number%.m4s",
		defaultThumbnailNumberJpg: "既定 thumbnail-%number%.jpg",
		defaultVodHighQuality: "既定 VOD_HIGH_QUALITY",
		demoChannelJp: "Demo Channel JP",
		description: "説明",
		destinationPath: "宛先パス",
		dialogueIntelligence: "ダイアログインテリジェンス",
		diffVsPreset: "プリセットとの差分",
		discardImport: "インポートを破棄",
		dismissPresetNotice: "プリセットの通知を閉じる",
		dolbyDvHdr10SdrLaddersRunAs:
			"Dolby DV/HDR10/SDR のラダーは、別々のエンコーディングとして実行され(1 つのエンコーディングにダイナミックレンジ形式を混在させると API が拒否します)、その muxing が共有マニフェストへマージされます。複数エンコーディングのプランは POST_ENCODING 専用です。JIT ではプレビューで PLAN_MULTI_ENCODING_JIT が発生します。行を追加すると、ストリーム・レンディション・キーフレームにエンコーディングの選択欄が現れます。",
		dolbyVisionMetadata: "Dolby Vision メタデータ",
		dolbyvisionBox: "DolbyVision ボックス",
		drmCencCredentialTheKeyItselfNever:
			"DRM_CENC 資格情報:キー自体はプランに入りません",
		drmKind: "DRM 種別",
		drmOutputOwnsTheDestination: "宛先は DRM 出力が保持します",
		durationS: "長さ (秒)",
		dvProfile: "DV プロファイル",
		dvTrackSignalingOnTheMp4Box: "MP4 ボックス上の DV トラックシグナリング",
		dynamicRangeFormat: "ダイナミックレンジ形式",
		enableAiSceneAnalysisTheSamplesRun:
			"AI シーン解析を有効にする(サンプルはエンコーダ BETA で実行しています)",
		enableKantarAudioWatermarking: "Kantar 音声ウォーターマークを有効にする",
		encoderVersion: "エンコーダバージョン",
		encoding: "エンコーディング",
		encodingLevelKeyframesCutSegmentsAtAd:
			"エンコーディングレベルのキーフレームは、広告挿入時刻(秒)でセグメントを分割します。",
		encodingMode: "エンコーディングモード",
		encodingStartOptions: "エンコーディング開始オプション",
		encodingModePresetConflict:
			"画質プリセットを使う場合は、「エンコーディング開始オプション」の「エンコーディングモード」を「(既定)」に戻してください。",
		mixedEncodingModeGuidance:
			"動画コーデックごとの別ジョブを推奨します。複数のコーデックを同じジョブで使う場合は、プリセットなしの明示設定と共通のエンコーディングモードが必要です。",
		onDemandClearDrmGuidance:
			"OnDemand DASH の MP4 は、暗号化の有無でエンコード設定を分けてください。DRM が付いた MP4 muxing を、暗号化しないマニフェストから参照することはできません。",
		encryptionMode: "暗号化モード",
		endPictureTiming: "終了ピクチャタイミング",
		endTimecode: "終了タイムコード",
		enterManually: "手入力する",
		fairplayIv32Hex: "FairPlay IV(16 進 32 文字)",
		fairplayUri: "FairPlay URI",
		false: "false",
		fileStream: "ファイルストリーム",
		filename: "ファイル名",
		filenamePattern: "ファイル名パターン",
		filter: "フィルタ",
		filterKey: "フィルタキー",
		filtersDeinterlace: "フィルター（適用順）",
		defineAndAttachDeinterlace: "インターレース解除を定義して適用",
		fixTheValidationIssuesAboveBeforeSaving:
			"保存する前に上の検証エラーを解消してください。有効なプランのみプリセットとして保存できます。",
		forcedRenditionAboveHighest: "最上位より上に強制レンディション",
		forcedRenditionFactor: "強制レンディションの係数",
		forcedRenditionMode: "強制レンディションのモード",
		fragmentDurationMs: "フラグメント長 (ms)",
		frameRateFps: "フレームレート (fps)",
		frameSelection: "フレーム選択",
		gBRWpLMasteringMetadata: "G(…)B(…)R(…)WP(…)L(…) のマスタリングメタデータ",
		generationTiming: "生成タイミング",
		gridColumnsVtiles: "グリッド列数 (vTiles)",
		gridRowsHtiles: "グリッド行数 (hTiles)",
		groupId: "グループ ID",
		h264PictureTiming: "H264 ピクチャタイミング",
		handleVariableInputFps: "可変入力 FPS を処理する",
		handleVariableInputFpsMoreInformation: "「可変入力 FPS を処理する」の説明",
		hdr: "HDR",
		heightP: "高さ (p)",
		heightPx: "高さ (px)",
		hideImport: "インポートを隠す",
		highComplexityBoundary: "高複雑度の境界",
		hlsOptions: "HLS オプション",
		hlsStreamM3u8: "HLS (stream.m3u8)",
		hlsVariantLabel: "HLS バリアントラベル",
		host: "ホスト",
		hostPortLiveInTheSftpCredential:
			"ホストとポートは SFTP 資格情報側で設定します",
		noCredentialNeeded: "資格情報不要",
		httpsAuthFree: "HTTPS(認証なし)",
		iFramePlaylists: "I フレームプレイリスト",
		imageFilename: "画像ファイル名",
		imagesPerFile: "1 ファイルあたりの画像数",
		implicitAudioReadsTheSameObjectAs:
			"暗黙の音声は既定で映像と同じオブジェクトを読み込みます。音声が別オブジェクト(A/V 分離)の場合は、別の入力ファイルを指定してください。",
		implicitAudioTrackEncoding: "暗黙の音声トラック → エンコーディング",
		implicitSet: "(暗黙に設定)",
		implicitVideoTrackEncoding: "暗黙の映像トラック → エンコーディング",
		importPlanJson: "プラン JSON をインポート…",
		importPlanJsonExpert: "プラン JSON をインポート(上級者向け)",
		incomplete: "不完全",
		infrastructureAdvanced: "インフラ(詳細設定)",
		infrastructureId: "インフラ ID",
		infrastructureRegion: "インフラのリージョン",
		ingestTrackFileStreamOrDolbyStream:
			"ソースステップの Ingest トラック、ファイルストリーム、または Dolby ストリーム",
		initSegment: "初期化セグメント",
		initSegmentNameTemplate: "初期化セグメント名テンプレート",
		framesPerCmafChunk: "CMAFチャンクのフレーム数",
		cmafCompatibility:
			"CMAFはH264/AACのDASHまたはLive Media Ingestに対応します。HLSとDRMは未対応です。",
		injectedIntoBitmovinAccountidTheOneException:
			"bitmovin.accountId に注入されます。そのまま送信するという原則の唯一の例外です",
		inputAudioTrackImplicit: "入力音声トラック(暗黙)",
		inputFile: "入力ファイル",
		inputFile1PrimaryRequired: "入力ファイル 1(主ファイル・必須)",
		inputFiles: "入力ファイル",
		inputFormat: "入力形式",
		inputStreamNeedsAVisionMetadataSidecar:
			"INPUT_STREAM には VISION_METADATA のサイドカーストリームが必要です",
		inputVideoTrackImplicit: "入力映像トラック(暗黙)",
		intervalDistance: "間隔(距離)",
		intervalStartRecommendedForTrickPlay:
			"トリックプレイには INTERVAL_START を推奨します",
		iv32HexChars: "IV(16 進 32 文字)",
		jobName: "ジョブ名",
		jpgJpegPng: ".jpg / .jpeg / .png",
		justInTimeWithTheEncodingStart:
			"ジャストインタイム(エンコーディング開始時)",
		k2RungH264AacJitHls: "H264 2 段 + AAC、JIT HLS",
		kantarChannelThisContentIsReportedUnder:
			"このコンテンツを Kantar に報告する際のチャンネル",
		kantarCredential: "Kantar 資格情報",
		kantarLicenseIdInteger: "Kantar ライセンス ID(整数)",
		kantarWatermarkingServiceEndpoint:
			"Kantar ウォーターマークサービスのエンドポイント",
		key: "キー",
		kid32HexChars: "kid(16 進 32 文字)",
		kidIsPublicNeverPasteTheContent:
			"kid は公開情報です。ここにコンテンツキーを貼り付けないでください",
		kind: "種別",
		label: "ラベル",
		labels: "ラベル",
		ladder: "ラダー",
		lang: "言語",
		language: "言語",
		level: "レベル",
		levelHighTier: "レベル High Tier",
		licenseId: "ライセンス ID",
		licenseUri: "ライセンス URI",
		loadFile: "ファイルを読み込む…",
		lossless: "ロスレス",
		loudnessControlAtmos: "ラウドネス制御(Atmos)",
		lowComplexityBoundary: "低複雑度の境界",
		mainReferenceStream: "メイン(基準ストリーム)",
		manifestFilename: "マニフェストのファイル名",
		manifestType: "マニフェスト種別",
		manifests: "マニフェスト",
		masterDisplay: "マスターディスプレイ",
		masterVersion: "マスターバージョン",
		maxBitrateBps: "最大ビットレート (bps)",
		maxBitrateStepSize: "最大ビットレートの刻み",
		maxCtuSize: "最大 CTU サイズ",
		maxKeyframeInterval: "最大キーフレーム間隔",
		maxcll: "MaxCLL",
		maxfall: "MaxFALL",
		mediaUri: "メディア URI",
		mediaVersion: "メディアバージョン",
		metadataInputFileOptional: "メタデータ入力ファイル(任意)",
		metadataSource: "メタデータのソース",
		metadataStream: "メタデータストリーム",
		meteringMode: "メータリングモード",
		minBitrateBps: "最小ビットレート (bps)",
		minBitrateStepSize: "最小ビットレートの刻み",
		minKeyframeInterval: "最小キーフレーム間隔",
		mode: "モード",
		motionEstimation: "動き推定",
		motionSearch: "動き探索",
		motionSearchRange: "動き探索範囲",
		multiLegPlansWhichLegThisManifest:
			"複数レッグのプラン:このマニフェストが列挙するレッグ",
		mustBeReplacedWithYourRealObject:
			"を、開始前に実際のオブジェクトパスに置き換えてください。",
		mvPredictionMode: "MV 予測モード",
		mvSearchRangeMax: "MV 探索範囲の最大値",
		myPresets: "マイプリセット",
		namesThisLadderSVariantEntriesWhen:
			"マスターが音声グループごとにバリアントを増やすとき、このラダーのバリアントエントリに付ける名前です。ラダー全体で揃えてください(dolby-dv-hdr10-sdr プリセットでは dv81 / sdr)。音声グループが 1 つだけの HLS では不要です。",
		newVodJob: "VOD ジョブを作成",
		nexguardLicense: "NexGuard ライセンス",
		nexguardWatermarking: "NexGuard ウォーターマーク",
		next: "次へ",
		noAudioRenditionsVideoOnlyPlansSkip:
			"音声レンディションがありません。映像のみのプランは暗黙の音声 Ingest トラックを使いません。",
		noManifestsSelectedSegmentsWillBeWritten:
			"セグメント出力が含まれていますが、マニフェストが選択されていません。セグメントには再生用プレイリストが付属しません。",
		noVideoRenditionsAudioOnlyPlansAre:
			"映像レンディションがありません。音声のみのプランも有効です(Dolby Atmos マスターなど)。",
		none: "(なし)",
		noneAddOneToExtractJpegThumbnails:
			"なし。追加すると、指定位置でレンディションから JPEG サムネイルを抽出します。",
		noneAddOneToGenerateATiled:
			"なし。追加すると、レンディションから指定間隔でサンプリングしたタイル状のスクラブプレビュー画像と WebVTT インデックスを生成します。",
		null: "null",
		offsetS: "オフセット (秒)",
		onDemandProfile: "ON_DEMAND プロファイル",
		oneOrMoreContainerOutputsPerRendition:
			"レンディションごとに 1 つ以上のコンテナ出力を作り、それぞれの暗号化をその場で設定します。1 つのストリームに複数のコンテナを設定できます(per-title H264 サンプルのように DASH 用 fMP4 + HLS 用 TS など)。追加したコンテナには、それぞれ別のリソースキーが割り当てられます。",
		oneTileEveryNUnits: "N 単位ごとに 1 タイル",
		onlyNeededForMultiAudioGroupHls:
			"複数音声グループの HLS(Dolby ラダー)でのみ必要です。dolby プリセットを参照してください。音声グループが 1 つなら既定の配置で正しいため、未設定のままにします。",
		optionalShownInThePresetGallery: "任意:プリセットギャラリーに表示されます",
		optionalVtt: "任意、.vtt",
		output: "出力",
		outputLanguageCodes: "解析結果の追加言語",
		outputPath: "出力パス",
		packaging: "パッケージング",
		paddingAfterS: "後方パディング (秒)",
		paddingBeforeS: "前方パディング (秒)",
		parity: "パリティ",
		partitionedPlansMustAssignEveryRenditionTo:
			"分割プランでは、すべてのレンディションをエンコーディングに割り当てる必要があります",
		pasteAFullEncodingplanEverySdkField:
			"プランJSONを貼り付けるかファイルから読み込み、ウィザードで編集できます。ウィザードで保持できない設定はJSON編集モードで保持します。読み込みだけでは作成・実行せず、テンプレート保存と実行は別の操作です。",
		perRenditionPlacementHlsGroupsDashSets:
			"レンディションごとの配置(HLS グループ / DASH セット)",
		perTitleAndMultiEncodingPlansMust:
			"Per-Title と複数エンコーディングのプランは、マニフェストをエンコード完了後に生成してください。プレビューの検証がこれを強制します。",
		perTitleConfiguration: "Per-Title の設定",
		perTitleFixedResolutionBitrate: "per-title の固定解像度とビットレート",
		perTitleLeavesBitrateToTheAlgorithm:
			"per-title ではビットレートをアルゴリズムに任せます (null)",
		perTitleSamplesPinRateToNull:
			"per-title のサンプルはレートを null(自動)に固定します",
		perTitleTemplatesLeaveBitrateToThe:
			"per-title のテンプレートはビットレートをアルゴリズムに任せます(マニフェストはエンコード完了後に生成)",
		perTitleVariantUri: "per-title バリアント URI",
		pinnedEncoderVersion: "固定するエンコーダバージョン",
		pinnedVersion: "バージョンを固定…",
		pinnedVersionEG22660: "固定バージョン(例: 2.266.0)",
		pixelFormat: "ピクセルフォーマット",
		placeholder: "プレースホルダー",
		placeholderPaths: "プレースホルダーのパス",
		placeholdersResolved: "プレースホルダー解決済み",
		placementExtras: "配置と追加設定",
		planDefault: "(プランの既定)",
		planIsIncomplete: "プランが未完成です",
		planJson: "プラン JSON",
		planPreview: "プランのプレビュー",
		playreadyLaUrl: "PlayReady LA URL",
		playreadyPssh: "PlayReady PSSH",
		position: "位置",
		positions: "位置",
		postEncodingAfterFinished: "エンコード後(FINISHED 後)",
		preset: "プリセット:",
		preset2: "プリセット",
		presetChecklist: "プリセットのチェックリスト",
		presetConfiguration: "プリセットの設定",
		presetName: "プリセット名",
		chooseFromTemplates: "テンプレートから選択…",
		presetsAreThePythonSampleGoldenPlans:
			"プリセットは代表的な配信構成のサンプルです:下のプレースホルダーの資格情報とストレージを自分のもの(設定 → 資格情報 で管理)に置き換えてから、Bitmovin アカウントを選択してください。ここで警告されないサンプルのオブジェクトパスも、自分のバケット構成に合わせて調整が必要な場合があります。自由に書き換えたい場合は、破棄して編集済みの JSON を再インポートしてください。",
		preview: "プレビュー",
		previewWatchWhileEncodingManifestListsOn:
			"プレビュー = 開始リクエストに載せる、エンコード中視聴用のマニフェスト一覧",
		producesOnlyThePerVideoQcMirror:
			"映像ごとの QC ミラー MP4(出力先の qc/ 配下)のみを生成します。HLS/DASH の muxing やマニフェスト、音声、サムネイル / スプライト / DRM は作りません。VMAF / PSNR の測定だけを目的とした、高速で安価なエンコードです。ストレージ出力の選択は必要です(ミラーがそこへ書き込まれます)。有効な間、配信形式とマニフェストの設定は無効になります。",
		profile: "プロファイル",
		psnrDbRidesTheSameLibvmafPass:
			"PSNR (dB) は同じ libvmaf のパスで計算され、レポート内で VMAF と並べて表示されます。",
		psyRdo: "Psy RDO",
		psyRdoq: "Psy RDOQ",
		psyTrellis: "Psy トレリス",
		publicInitializationVectorTheKeyStaysIn:
			"公開される初期化ベクトルです。キーは保管庫に留まります",
		qpMax: "QP 最大",
		qpMin: "QP 最小",
		quality: "品質",
		rateOvershoot: "レート超過 %",
		rateUndershoot: "レート不足 %",
		rcLookahead: "RC 先読み",
		rePointToOutput: "出力を付け替える",
		realObjectPathExt: "real/object/path.ext",
		referenceFrames: "参照フレーム数",
		relativeToBaseEmptyTheMuxingS:
			"ベースからの相対パス:空欄 = muxing から自動で決まるパス",
		relativeToTheBaseOutputPath: "ベース出力パスからの相対パス",
		relativeToTheBaseOutputPathWhere:
			"ベース出力パスからの相対パス:Kantar の処理レポートが書き込まれる場所です",
		remove: "削除",
		removeContainer: "コンテナを削除",
		removeDolbyVisionMetadata: "Dolby Vision メタデータを削除",
		removeEncryption: "暗号化を削除",
		removeHlsMediaEntry: "HLS メディアエントリを削除",
		removeNexguardWatermarking: "NexGuard ウォーターマークを削除",
		renditionsJoinASetViaTheirDash:
			"レンディションは「DASH アダプテーションセット」の追加設定でセットに参加します。指定がなければ暗黙の映像 + 音声のペアになります。",
		replaceWithVaultCredential: "保管庫の資格情報に置き換える…",
		reportPath: "レポートのパス",
		reports: "レポート",
		representationType: "Representation 種別",
		requiredEGVideoMp4VideoIsmv: "必須(例: video.mp4 / video.ismv)",
		review: "確認",
		reviewThePlanOnTheRightThe:
			"プランのプレビューを確認してください。操作一覧は、実際に実行される内容そのものです(順序も同じです)。",
		routesThisRenditionIntoTheMatchingSet:
			"マニフェスト → DASH オプション(ラベル振り分け)で宣言した、対応するセットへこのレンディションを振り分けます。Dolby の複数ラダープリセットが DV/HDR10/SDR のラダーを分けている仕組みです。未設定 = 暗黙の映像 / 音声ペア。",
		runVmafQcAfterEncoding: "エンコード後に VMAF QC を実行する",
		runVmafQcAfterEncodingMoreInformation:
			"「エンコード後に VMAF QC を実行する」の説明",
		sameObjectAsTheVideo: "(映像と同じオブジェクト)",
		sameObjectAsTheVideoUnlessChanged:
			"変更しない限り、映像と同じオブジェクトです",
		sampleRateHz: "サンプリング周波数 (Hz)",
		samples: "サンプル",
		sao: "SAO",
		saveAsPreset: "プリセットとして保存",
		savedItIsNowInThePreset:
			"保存しました。プリセットギャラリーの「マイプリセット」に登録されています。",
		saving: "保存しています…",
		sceneCutThreshold: "シーンカットのしきい値",
		segmentLengthS: "セグメント長 (秒)",
		segmentNaming: "セグメントの命名",
		selectABaseline: "比較元を選択…",
		selectABitmovinAccountInStep1:
			"開始する前に、ステップ 1 で Bitmovin アカウントを選択してください。",
		selectAccount: "アカウントを選択…",
		selectCredential: "資格情報を選択…",
		selectFileStream: "ファイルストリームを選択…",
		selectFilter: "フィルタを選択…",
		selectInputFile: "入力ファイルを選択…",
		selectSourceStream: "ソースストリームを選択…",
		selectStream: "ストリームを選択…",
		selectingAnS3CredentialOpensTheBrowser:
			"S3 の資格情報を選ぶとブラウザが開きます",
		selectionMode: "選択モード",
		separateDolbyVisionMetadataSidecarEmptyEmbed:
			"Dolby Vision メタデータの別サイドカー。空欄 = 埋め込み",
		serverManifest: "サーバーマニフェスト",
		serverUrl: "サーバー URL",
		set: "設定済み",
		setWithManifestTypeForFragmentedMp4:
			"フラグメント化 MP4 ではマニフェスト種別と一緒に指定します。両方空欄 = プログレッシブ",
		severalManifestsOfOneKindAreValid:
			"同じ種類のマニフェストを複数持たせられます。segment-timeline のサンプルは TEMPLATE と TIMELINE の DASH マニフェストを並べて書き出します。",
		showSummary: "概要を表示",
		singleMp4SegmentbaseRepresentationsDashOnDem:
			"単一 MP4 の SegmentBase representation(DASH_ON_DEMAND muxing)",
		skdLicenseTokenUri: "skd:// ライセンストークン URI",
		slices: "スライス数",
		sourceStream: "ソースストリーム",
		sources: "ソース",
		speechThreshold: "音声しきい値 (%)",
		sprite: "スプライト",
		spriteJpg: "sprite.jpg",
		spriteJpgResourceName: "sprite.jpg(リソース名)",
		spriteName: "スプライト名",
		spriteVtt: "sprite.vtt",
		spritesTrickPlay: "スプライト(トリックプレイ)",
		startEncoding: "エンコーディングを開始",
		startEncodingImportedPlan: "エンコーディングを開始(インポートしたプラン)",
		startOptionsAdvanced: "開始オプション(詳細設定)",
		startPictureTiming: "開始ピクチャタイミング",
		startPlacement: "開始位置",
		startRequestPertitleBlocksPairThemWith:
			"Per-Title の開始設定は、ラダー側の Per-Title ストリームモードと組み合わせます。マニフェストはエンコード完了後に生成してください。",
		startTimecode: "開始タイムコード",
		startencodingrequestEncodingmodeEmptyApiDefa:
			"エンコーディングモード:空欄の場合はプロバイダーの既定値を使用します。",
		startencodingrequestHandlevariableinputfpsDr:
			"可変フレームレートの入力:フレームを間引くか複製して、映像と音声の同期を保ちます。",
		startencodingrequestTweaksFailsWithDolbyDigi:
			"エンコーダの詳細調整は Dolby Digital、Dolby Digital Plus、Dolby Atmos の音声と併用できません。送信前にプランを検証します。",
		starting: "開始しています…",
		stream: "ストリーム",
		streamMode: "ストリームモード",
		modeMixed: "混在",
		modePerTitle: "Per-Title",
		modeStandard: "標準",
		streamModeAll: "ストリームモード(全映像レンディション)",
		strength: "強度",
		subMe: "Sub-ME",
		subMeNumeric: "Sub-ME(数値)",
		submitFailed: "送信に失敗しました",
		subtitleTracksWebvtt: "字幕トラック (WebVTT)",
		subtitleWebvtt: "字幕 · WEBVTT",
		targetQualityCrf: "目標品質 CRF",
		targetQualityQp: "目標品質 QP",
		templateYaml: "Template YAML",
		theInputStreamThisTrimWraps: "このクリップが包む入力ストリーム",
		theObjectAStreamReadsWhenIt:
			"ストリームがこのファイルを参照したときに読み込むオブジェクト",
		theObjectDeclaredInInputFilesThis:
			"このストリームが読み込むオブジェクト(入力ファイルで宣言済み)",
		thePlanIsSubmittedAsImportedThe:
			"元のJSONを保持しています。「JSONを編集」で変更し、テンプレートとして保存するか、明示的にジョブを作成してください。プランにアカウントがない場合は、選択中のアカウントを使います。",
		theProcessingReportIsOperationalDataSo:
			"処理レポートは運用データなので、配信出力が公開設定でも通常は PRIVATE で書き込まれます。チェックを外すと、他の宛先と同じようにストレージ出力の公開 / 非公開設定を継承します。",
		theseEncryptionRowsTargetAnOutputKey:
			"これらの暗号化行は、既に存在しない出力キー(レンディションの名前変更または削除)を対象にしています。現在の出力へ付け替えるか、行を削除してください。そのままではプレビューが未解決の参照として警告します。",
		thisPlanHasNoAudioRenditionAdd:
			"このプランには音声レンディションがありません。ラダーステップで追加してください。追加しないとプランは拒否されます(Kantar は音声にウォーターマークを入れます)。",
		thisPlanReferencesNoVaultCredentials:
			"このプランは保管庫の資格情報を参照していません。",
		thumbnail: "サムネイル",
		thumbnailNumberJpg: "thumbnail-%number%.jpg",
		thumbnails: "サムネイル",
		tileColumns: "タイル列数",
		tileHeightPx: "タイル高さ (px)",
		tileWidthPx: "タイル幅 (px)",
		timeBasedSeconds: "時間指定 (秒)",
		timeS: "時刻 (秒)",
		timecodeTrackSmpte12m: "タイムコードトラック (SMPTE-12M)",
		trellis: "トレリス",
		true: "true",
		tuInterDepth: "TU インター深度",
		tuIntraDepth: "TU イントラ深度",
		type: "種類",
		unassigned: "(未割り当て)",
		unit: "単位",
		unset: "(未設定)",
		useInsteadOfRowsColumnsNotBoth:
			"行 × 列の代わりに指定します(両方は指定できません)",
		valid: "有効 ✓",
		variantLabelsMostlyBelongOnVideoRenditions:
			"バリアントラベルは主に映像レンディションに付けます。音声 / 字幕の配置は下のメディアエントリで行います。",
		variantsPerAudioGroup: "音声グループごとのバリアント",
		vaultCredentialTheLicenseItselfNeverEnters:
			"保管庫の資格情報:ライセンス自体はプランに入りません",
		vaultCredentialTheServiceLoginPasswordNever:
			"保管庫の資格情報:サービスのログイン / パスワードはプランに入りません",
		videoMuxingKind: "映像 muxing 種別",
		videoRenditions: "映像レンディション",
		visionMetadataStreamsFromTheSourcesStep:
			"ソースステップの VISION_METADATA ストリーム",
		vmafModel: "VMAF モデル",
		vmafOnlySkipDeliveryOutputs: "VMAF のみ(配信出力を作らない)",
		vmafOnlySkipDeliveryOutputsMoreInformation:
			"「VMAF のみ(配信出力を作らない)」の説明",
		vodDefault: "VOD(既定)",
		vodPreview: "VOD + プレビュー",
		watermarkType: "ウォーターマーク種別",
		webvttFileStreamsComeFromTheSources:
			"WEBVTT のファイルストリームはソースステップで定義します",
		webvttIndex: "WebVTT インデックス",
		weightPredictionB: "重み付き予測 (B)",
		weightPredictionP: "重み付き予測 (P)",
		weightedPredictionP: "重み付き予測 (P)",
		widevinePssh: "Widevine PSSH",
		widthOrHeightRequired: "幅または高さが必要です",
		widthOrHeightRequiredOtherIsDerived:
			"幅または高さが必要です。もう一方は自動で決まります",
		withColumnsOrUseImagesFile:
			"列数と併用します。または「1 ファイルあたりの画像数」を使います",
		withRowsOrUseImagesFile:
			"行数と併用します。または「1 ファイルあたりの画像数」を使います",
		wizardSteps: "ウィザードのステップ",
		writeTheReportPrivatelyAclPrivate:
			"レポートを非公開で書き込む (ACL PRIVATE)",
		writeTheReportPrivatelyAclPrivateMore:
			"「レポートを非公開で書き込む (ACL PRIVATE)」の説明",
		yourIdentifierForThisAssetInKantar:
			"Kantar のレポート上でこのアセットを指す識別子",
		yuv420p10leForMain10Hdr10: "MAIN10/HDR10 では YUV420P10LE",
	},
	delivery: {
		galleryTitle: "納品プリセット",
		galleryIntro:
			"ファイル納品向けの仕様プリセットです。プランと機械可読な要件表がセットになっており、読み込むと wizard が仕様からの逸脱を警告します。.bitovp-preset.json としてエクスポートすれば、自社プラットフォームの納品仕様をファイルとして管理できます(同梱するのは汎用例のみで、他社仕様は含みません)。",
		importButton: "プリセットファイルを取り込む",
		importing: "取り込み中…",
		importFailed: "取り込みに失敗しました: {error}",
		importSelfDeviations:
			"自己逸脱 {count} 件付きで取り込みました。ファイルの例プラン自身が要件を満たしていません — 利用前に確認してください。",
		requirementCol: "要件",
		exportButton: "JSON をエクスポート",
		suggestedGateLine: "推奨 QC ゲート: {metric} ≥ {gte}(参考値)",
	},
	wizardX: {
		importLoadedForEditing:
			"プランをウィザードに読み込みました。内容を確認して作成するか、テンプレートとして保存できます。",
		importCannotEditWithoutLoss:
			"このプランにはウィザードで保持できない設定があります。元のJSONを保持しています。「JSONを編集」から変更してください。",
		importEditJson: "JSONを編集",
		muxedAudioCarrying: "このセグメントの中で {key} を運びます。",
		qcDisabledCarriedBlock:
			"このプランは QC/VMAF の設定を含んでいますが、この環境では QC/VMAF がオフのため開始できません。設定を削除して続けるか、設定画面で QC/VMAF を有効にしてください。",
		qcDisabledRemoveBlock: "QC 設定を削除",
		// QC gate editor .
		qcGateHint:
			"VMAF/PSNR 測定に対するしきい値ルールです。PER_RENDITION は全レンディションが個別に基準を満たす必要があり、OVERALL はラダー平均で判定します。MARK_ONLY は判定を記録するだけ、BLOCK_MANIFESTS はゲート合格(または強制配信)までマニフェスト生成を保留します。",
		qcGateHintMoreInformation: "QC ゲートの詳細",
		qcGateAddRule: "ゲートルールを追加",
		qcGateRemoveRule: "ゲートルールを削除",
		qcGateTargets: "対象レンディション(未選択 = 全て)",
		qcGateOnFail: "不合格時の動作",
		qcGatePsnrOffOption: "{metric}(先に PSNR を有効化)",
		qcGateBlockNeedsPost:
			"BLOCK にはすべてのマニフェストをエンコード完了後に生成する必要があります。JIT マニフェストは測定前に生成されてしまうためです。",
		// Delivery-spec drift banner .
		deliverySpecLoaded: "配信仕様: {name}",
		deliveryCommitmentLabel: "適合の扱い",
		deliveryCommitNone: "バナーのみ(コミットしない)",
		deliveryCommitWarn: "逸脱を記録して続行(WARN)",
		deliveryCommitRefuse: "逸脱時は送信を拒否(REFUSE)",
		deliveryDrift: "{name} から {count} 件逸脱しています",
		deliveryDriftShow: "逸脱を表示",
		deliveryDriftHide: "逸脱を隠す",
		deliveryDriftDismiss: "閉じる",
		deliveryDriftRequirement: "要件",
		deliveryDriftFound: "現在の値",
		deliveryDriftAbsent: "(なし)",
		importLiveMustBeObject:
			"ライブチャンネルのプランは JSON オブジェクトである必要があります",
		importMustBeObject: "プランは JSON オブジェクトである必要があります",
		importNotValidJson: "JSON として不正です: {detail}",
		importParseError: "構文エラー",
		reasonUsesUnrepresentedOptions:
			"ウィザードのフォームがまだ表現できないオプションを使っています",
		reasonCannotBeRebuilt: "ウィザードのフォームから再構成できません",
		reasonNotAValidPlan: "有効なエンコーディングプランではありません",
		adaptationSetsCount: "アダプテーションセット({count})",
		aiSceneAnalysis: "AI シーン解析",
		audioNBitrate: "音声 {n} のビットレート",
		audioNSampleRate: "音声 {n} のサンプリング周波数",
		audioWord: "音声",
		bitmovinAccountFromPlan: "プランに含まれる Bitmovin アカウント:",
		c9PairsIvSize: "IV サイズは暗号化モードから自動で決まります: {pairing}",
		completeValidPlanToDiff:
			"「{name}」と差分を取るには、有効なプランを完成させてください。",
		concatenationKey: "連結({key})",
		concatenationStreamsCount: "連結ストリーム({count})",
		couldNotLoadPreset: "プリセットを読み込めませんでした:",
		couldNotLoadPresetNamed: "プリセット「{name}」を読み込めませんでした。",
		deinterlaceFiltersCount: "フィルター設定 ({count})",
		/* Multiple-output labels must not expose internal work-item references. */
		deliveryMirrorsHint:
			"全レンディションとマニフェストを各ミラーにも同一パス・同一 ACL で書き込みます — 1 回のエンコードで複数ストレージへ配信します。",
		derivedPathHint:
			"ベース出力パスからの相対パス:空欄 = 自動で決まるパス「{path}」。per-title の出力には {uuidToken}/{bitrateToken} のプレースホルダーが必要です。",
		enableCodecPerTitle: "{codec} の per-title 設定を有効にする",
		encryptionDrmCount: "暗号化 / DRM({count})",
		extraContainerOf: "{key} の追加コンテナ",
		fieldsDifferOne:
			"「{name}」と {count} 個のフィールドが異なります(プリセット → 現在)。",
		fieldsDifferOther:
			"「{name}」と {count} 個のフィールドが異なります(プリセット → 現在)。",
		identicalToNamed: "「{name}」と同一です。",
		importedPlan: "インポートしたプラン",
		inputFileN: "入力ファイル {n}",
		inputFilesCount: "入力ファイル({count})",
		issueCountOne: "問題 {count} 件",
		issueCountOther: "問題 {count} 件",
		kantarAudioWatermarking: "Kantar 音声ウォーターマーク",
		keyColon: "キー:",
		keyframesAdCuesCount: "キーフレーム:広告キュー({count})",
		labelsAndInfrastructure: "ラベルとインフラ",
		loadedPreset: "プリセット:",
		loadedPresetTail:
			" をウィザードに読み込みました。サンプルの資格情報はクリアされています。ソースと出力のステップで自分のものを選び、各ステップを確認してから開始してください。",
		loadingNamed: "「{name}」を読み込んでいます…",
		loadingPreset: "プリセットを読み込んでいます",
		locationLabelForSection: "{section}[{index}] の{label}",
		mediaKey: "メディア {key}",
		missingInputParen: "(入力が見つかりません)",
		missingParen: "(見つかりません)",
		multiEncodingPartitionCount: "複数エンコーディングの分割({count})",
		noExtraOptionsFor: "{label} に追加オプションはありません。",
		notDeclaredParen: "(宣言されていません)",
		onSuffix: "(有効)",
		operationsCount: "操作 {count} 件",
		placeholderTokensHint:
			"これらのトークンは実際のオブジェクトパスの代わりです。自分のパスを入力してください。{height}/{bitrate}/{uuid} のような実行時プレースホルダーはプランに残るため、ここには表示されません。",
		placeholdersMustBeReplaced:
			"開始する前に、{count} 個のプレースホルダー値を置き換える必要があります",
		presetDoesNotExist: "(存在しません)。",
		presetFallbackReason:
			"このプリセットには、ステップ形式のウィザードのフォームがまだ対応していません({reason})。編集可能なプランとして読み込まれているので、下で調整してそのまま送信できます。",
		qualityControlVmaf: "品質管理 (VMAF)",
		removeAdaptationSetN: "アダプテーションセット {n} を削除",
		removeAudioN: "音声 {n} を削除",
		removeConcatenationStreamN: "連結ストリーム {n} を削除",
		removeEncodingN: "エンコーディング {n} を削除",
		removeFilterAttachmentN: "フィルタ適用 {n} を削除",
		removeFilterN: "フィルタ {n} を削除",
		removeInputFileN: "入力ファイル {n} を削除",
		removeKeyframeN: "キーフレーム {n} を削除",
		removeManifestN: "マニフェスト {n} を削除",
		removeSourceN: "ソース {n} を削除",
		removeStreamKey: "ストリーム {key} を削除",
		removeSubtitleN: "字幕 {n} を削除",
		removeTrimmingStreamN: "入力クリップ {n} を削除",
		removeVideoN: "映像 {n} を削除",
		replacementCredentialFor: "{id} の置き換え先資格情報",
		replacementFor: "{token} の置き換え先",
		samplePlaceholderPaths: "{count} 件のサンプルプレースホルダーパス",
		schemaColon: "スキーマ:",
		setKeyConflictingTypes:
			"セットキー「{key}」はマニフェスト間で型が矛盾しています。どちらかの名前を変えてください。型の不一致は検証でブロックされます",
		setSuffix: "(設定済み)",
		sourceN: "ソース {n}",
		streamsCount: "ストリーム({count})",
		subtitleWord: "字幕",
		toResolveCount: "未解決 {count} 件",
		tokenPathsLabel: "{token} を使うパス",
		tokenUsedAt: "{token}(使用箇所: {paths})",
		trimSourceKey: "クリップ · {source}({key})",
		trimmingStreamsCount: "入力クリップ({count})",
		videoNBitrate: "映像 {n} のビットレート",
		videoNHeight: "映像 {n} の高さ",
		videoWord: "映像",
		vmafV1DockerWorker: "{model}(VMAF v1:同梱モデル)",
	},
	tokens: {
		active: "有効",
		dismissSecret: "保存した — 閉じる",
		expired: "期限切れ",
		expiresDays: "有効期限(日数、任意)",
		expiresDaysHint: "空欄 = 無期限。",
		intro:
			"Bearer トークンはスクリプトや CI を /api/* に対して認証します(サインイン済みセッションと同等の権限)。シークレットはハッシュのみ保存され、表示は一度きりです。トークンからトークンは発行できません。",
		lastUsed: "最終使用",
		listHeading: "トークン一覧",
		mint: "トークンを発行",
		mintFailed: "トークンを発行できませんでした。",
		mintHeading: "トークンを発行",
		mintedHint:
			"保存されるのはハッシュのみ — この値は二度と表示できません。送信方法: Authorization: Bearer <secret>",
		mintedOnce:
			"トークン「{name}」を発行しました — 今すぐシークレットをコピーしてください:",
		name: "名前",
		never: "未使用",
		noneYet: "トークンはまだありません。",
		revoke: "失効",
		revokeFailed:
			"取り消しに失敗しました — トークンはまだ有効です。再試行してください。",
		revokeLatencyHint: "60 秒以内に反映されます(検証キャッシュの TTL)。",
		confirmRevoke: "完全に取り消しますか?",
		created: "作成",
		expires: "期限",
		listFailed: "トークン一覧を読み込めませんでした。",
		revoked: "失効済み",
		title: "API トークン",
	},
	users: {
		title: "ユーザー",
		intro:
			"ロール付きの個人アカウント。VIEWER は閲覧のみ、OPERATOR はジョブとチャンネルを実行、ADMIN は加えて資格情報・設定・ユーザーを管理します。作成したユーザーには一度だけ表示される仮パスワードが発行され、初回サインインで変更が必要です。",
		createHeading: "ユーザーを作成",
		email: "メールアドレス",
		emailHint: "Bitmovin アカウントのメールアドレスがユーザー名です。",
		displayName: "表示名",
		role: "ロール",
		create: "ユーザーを作成",
		createFailed: "ユーザーを作成できませんでした。",
		createdOnce:
			"ユーザー「{email}」を作成しました — 仮パスワードを今すぐコピーしてください:",
		createdHint:
			"一度だけ表示されます。これでサインインし、直ちに本人のパスワードを設定する必要があります。72 時間で失効します。",
		dismissTempPassword: "送付しました — 閉じる",
		listHeading: "ユーザー",
		listFailed: "ユーザー一覧を読み込めませんでした。",
		noneYet: "ユーザーがいません。",
		active: "有効",
		inactive: "無効",
		lastLogin: "最終サインイン",
		never: "なし",
		mustChange: "パスワード変更が必要",
		deactivate: "無効化",
		reactivate: "再有効化",
		resetPassword: "パスワードをリセット",
		resetConfirm: "新しい仮パスワードを発行しますか?",
		changeOwnPassword: "自分のパスワードを変更",
		changeRole: "ロールを変更",
		actionFailed: "変更を適用できませんでした。再試行してください。",
		you: "あなた",
	},
	wizardDraft: {
		available: "保存済みの下書きがあります",
		restore: "復元",
		discard: "破棄",
		help: "このブラウザに7日間保存します。秘密値・URL・DRM・フィルタ設定・インポートしたJSONは保存しません。開始前に確認してください。",
	},
	templates: {
		savedDeliveryHeading: "保存済みの配信プリセット",
		emptyDelivery:
			"保存済みの配信プリセットはありません。下の配信仕様をインポートすると保存できます。",
		savedView: "保存済み",
		deliveryView: "配信プリセット",
		samplesView: "サンプル",
		retry: "再試行",
		loadVodFailed: "VODテンプレートを読み込めませんでした。",
		loadLiveFailed: "Liveテンプレートを読み込めませんでした。",
		loadDeliveryFailed: "保存済みの配信プリセットを読み込めませんでした。",
		deleteFailed:
			"テンプレートを削除できませんでした。もう一度お試しください。",
		deliveryDeleteFailed:
			"プリセットを削除できませんでした。もう一度お試しください。",
		deliveryDeleteBlockedByRules:
			"監視ルールがこのプリセットを参照しています。参照を解除してから削除してください。",
		heading: "テンプレート",
		intro:
			"テンプレートは固めたワークフローの保存版です。起動時に聞かれるのは素材ファイル・出力プレフィックス・名前だけで、それ以外はテンプレートの設定のまま実行されます。VOD ウィザードのプリセット保存から作成できます。",
		loading: "読み込み中…",
		empty: "テンプレートはまだありません。",
		emptyHint:
			"VOD ウィザードでジョブを組んでプリセットとして保存すると、ここに起動可能なテンプレートとして表示されます。",
		revision: "rev {n}",
		usesAndUpdated: "利用 {uses} 件 · 更新 {date}",
		launch: "起動",
		createVodJob: "VOD ジョブを作成",
		createLiveChannel: "ライブチャンネルを作成",
		edit: "編集",
		delete: "削除",
		confirmDelete: "本当に削除しますか?",
		deleteBlockedByRules:
			"ウォッチルールがこのテンプレートを参照しています。先にルールを削除するか付け替えてください。",
		launchTitle: "「{name}」を起動",
		notAPlan:
			"このテンプレートの本文は有効なエンコーディングプランではありません。",
		sources: "素材",
		sourceOriginal:
			"テンプレートの元パスです。そのままなら同じ素材で再実行します。",
		sourceMoved: "この起動用に上書きされています。",
		browse: "参照",
		noSources: "このプランにはファイル素材がありません(差し替え対象なし)。",
		outputPrefix: "出力プレフィックス",
		outputPrefixPreview: "展開結果: {preview}",
		jobName: "ジョブ名",
		create: "ジョブを作成",
		creating: "作成中…",
		editInWizard: "ウィザードで詳細を編集して作成",
		updateTemplate: "テンプレートを更新",
		updating: "更新中…",
		editingBanner:
			"テンプレート「{name}」を編集中 — 更新は今後の起動に反映されます。起動済みジョブは各自のコピーを保持します。",
		launchLiveTitle: "「{name}」からチャンネルを起動",
		notALivePlan:
			"このテンプレートの本文は有効なライブチャンネルプランではありません。",
		channelName: "チャンネル名",
		createChannel: "チャンネルを作成",
		filterAll: "すべて",
		filterJobs: "ジョブテンプレート",
		filterChannels: "チャンネルテンプレート",
		kindJob: "ジョブ",
		kindChannel: "チャンネル",
		saveAsTemplate: "テンプレートとして保存",
		templateName: "テンプレート名",
		templateSaved: "テンプレート「{name}」として保存しました。",
		saveTemplateFailed: "保存に失敗しました: {error}",
		livePrefixEmpty:
			"出力プレフィックスが空に展開されました。テンプレート自身のパスに書くと前のチャンネルの出力を上書きします。空でないプレフィックスを指定してください。",
		editConflict:
			"読み込み後にこのテンプレートが変更されています。ページを再読み込みして編集をやり直してください。",
	},
	ui: {
		aChannelWithoutAManifestHasNo:
			"マニフェストがないチャンネルには再生面がありません。HLS と DASH のいずれか、または両方を有効にしてください。",
		aMovieFileNeedsItsVideoStream:
			"動画ファイルは映像ストリームが位置 0 にあり、ライブストリームと完全に一致(コーデック・解像度・フレームレート)し、音声レイアウトも同じである必要があります。画像 (PNG, JPEG, GIF, BMP, TIFF, WebP など) には再生時間の情報がないため、画像をスケジュールするときは durationInSeconds が必須です。動画では任意です。指定より長いファイルは切り詰められ、短いファイルはループ再生されます。",
		aTimeBasedRescheduleCloudConnectAccounts:
			"。Cloud Connect アカウントは 設定 → インフラ で管理します。",
		accountDefaultRtmpInputResolvedByListing:
			"アカウント既定の RTMP 入力:一覧取得で解決します(API に作成用の呼び出しがありません)",
		acquisitionPointIdentity: "取得ポイント識別子",
		adAvailOffsetMs: "広告枠オフセット (ms)",
		adBreakLengthSignalledToDownstreamSystems:
			"下流システムへ通知する広告ブレークの長さ",
		adInsertion: "広告挿入",
		adMarkersSource: "広告マーカーの取得元",
		addAudio: "音声を追加",
		addBackup: "バックアップを追加",
		addIngestPoint: "Ingest ポイントを追加",
		addStaticPoint: "静的ポイントを追加",
		addVideo: "映像を追加",
		adinsertionsettingsEnableesammediapointinser:
			"adInsertionSettings.enableEsamMediaPointInsertion",
		all: "すべて",
		allLegs: "(すべてのレッグ)",
		audioGroupId: "音声グループ ID",
		audioLanguage: "音声言語",
		audioMuxingPin: "音声 muxing の固定",
		audioRenditionsAacDdDd: "音声レンディション(AAC / DD+ / DD)",
		autoRestart: "自動再起動",
		autoShutdown: "自動停止",
		automaticallyRestartWhenTheEncodingHitsAn:
			"エンコーディングがエラーになったとき自動的に再起動します。無人で自己回復させたいチャンネルでは有効に、失敗をその場で止めて調査したい場合は無効にしてください。",
		availabilityStartTime: "配信開始時刻",
		back: "戻る",
		backupSrtInputsFailover: "バックアップ SRT 入力(フェイルオーバー)",
		basics: "基本",
		bitmovinAccount: "Bitmovin アカウント",
		bitmovinAposS: "Bitmovin’s",
		bitmovinDialsYourSourceHost: "Bitmovin が送信元ホストに発信します",
		bitmovinListensYourEncoderCallsTheEncoder:
			"Bitmovin が待ち受けます。エンコーダ側からエンコーダ IP に接続します",
		bitmovinOvp: "Bitmovin OVP",
		bitmovinPullsAnHlsSourceUrl: "Bitmovin が HLS のソース URL を取得します",
		bitrateBps: "ビットレート (bps)",
		blocked: "ブロック",
		browse: "参照…",
		browseABucketAndChooseTheSource:
			"バケットを参照してソースファイルを選んでください。",
		browseStorageFillsCredentialBucketKeyThe:
			"ストレージを参照すると資格情報 / バケット / キーが入力されます。実行時にローカルへ一時保存します",
		bucket: "バケット",
		bucketNameManual: "バケット名(手入力)",
		byDefaultAMarkerAppearsInThe:
			"既定では、ブレーク開始前にマーカーがプレイリストへ現れます。AWS MediaTailor はブレークが始まってから初めてマーカーを期待するため、MediaTailor(や同種の広告サーバー)がブレークのタイミングを誤る場合はこれを有効にしてください。",
		bytesReadTimeoutS: "バイト読み取りのタイムアウト (秒)",
		bytesWrittenTimeoutS: "バイト書き込みのタイムアウト (秒)",
		c19WhenAnHlsManifestSetsA:
			"HLS マニフェストが program-date-time の SOURCE を設定する場合、このモードと一致していなければなりません。HLS の PDT ソースが食い違うとエンコーディングが失敗します(どちらか一方だけ設定するか、両方を揃えてください)。空欄 = 送信しません。",
		cacheControl: "Cache-Control",
		campaignAUhd: "campaign-a, uhd",
		cancel: "キャンセル",
		cancelTheJobBeforeDeleting: "削除する前にジョブをキャンセルしてください",
		carrierIsFmp4OnlyTsHasNo:
			"の搬送は fMP4 のみです(TS には emsg ボックスがありません)。DASH も fMP4 が必要です。チャンネルが稼働してからチャンネルページでキューを挿入してください。",
		cbcIv16Bytes: "CBC → IV_16_BYTES",
		channelLayout: "チャンネルレイアウト",
		channelName: "チャンネル名",
		clockSynchronizationMode: "クロック同期モード",
		close: "閉じる",
		cloudRegion: "クラウドリージョン",
		codec: "コーデック",
		commaSeparatedEncodingLabelsTagsThatGroup:
			"カンマ区切り:Bitmovin の統計で結果をまとめる Encoding.labels のタグです。空欄 = なし",
		completeTheRequiredFields: "— 必須項目を入力してください —",
		configuredInSettingsBitmovinAccounts:
			"設定 → Bitmovin アカウントで登録します",
		confirm: "確認",
		container: "コンテナ",
		copyPlanJson: "プラン JSON をコピー",
		create: "作成",
		createChannelImportedPlan: "チャンネルを作成(インポートしたプラン)",
		createFailed: "作成に失敗しました",
		createLiveChannel: "ライブチャンネルを作成",
		creating: "作成しています…",
		credential: "資格情報",
		ctrIv8Bytes: "CTR → IV_8_BYTES",
		curlUnavailable: "cURL は利用できません",
		curlNoEndpoint:
			"{kind} に対応する Bitmovin の単一エンドポイントがありません",
		curlUnresolvedPathParams:
			"{kind} の URL パスパラメータをすべて解決できませんでした",
		curlNoStepEntry: "ステップの記録がありません",
		dagaaaaaaaaapWdwaa: "/DAgAAAAAAAAAP/wDwAA…",
		dashDvrBudgetC8: "DASH の DVR 予算",
		dashManifest: "DASH マニフェスト",
		dashManifestIntervalS: "DASH マニフェストの間隔 (秒)",
		dashManifestsUpdateTimeoutS: "DASH マニフェスト更新のタイムアウト (秒)",
		dashPlayback: "DASH 再生",
		dashTemplateManifest: "DASH TEMPLATE マニフェスト",
		dashTimelineManifest: "DASH TIMELINE マニフェスト",
		decryptionType: "復号方式",
		default: "(既定)",
		defaultExtXDaterange: "(既定 EXT_X_DATERANGE)",
		defaultSinglePeriod: "(既定 SINGLE_PERIOD)",
		defaultXmlBin: "(既定 XML_BIN)",
		defaultsSinglePeriodXmlBin: "(既定 SINGLE_PERIOD / XML_BIN)",
		delayThresholdS: "遅延しきい値 (秒)",
		delete: "削除",
		deleteThisJob: "このジョブを削除しますか?",
		deleteThisVmafReport: "この VMAF レポートを削除しますか?",
		deleting: "削除しています…",
		disablePreAnnouncing: "事前アナウンスを無効にする",
		disablePreAnnouncingMoreInformation: "「事前アナウンスを無効にする」の説明",
		discardImport: "インポートを破棄",
		dolbyDigital: "Dolby Digital+",
		dolbyDigital2: "Dolby Digital",
		dynamicRtmpEncoderIpApplication: "動的 (rtmp://<encoder-ip>/<application>)",
		eachInputFileIsOneObjectThe:
			"各入力ファイルはジョブが読み込む 1 つのオブジェクトです。資格情報・バケット・オブジェクトパスはファイルごとに指定します。最初のものが主となる映像ソース(必須)で、音声マスターや Dolby サイドカー、字幕は追加してください。下のストリームはファイルを参照するだけで、パスはファイル側のものを使い、再入力はしません。",
		eachMediaSegmentImmutableOnceWritten:
			"各メディアセグメント:書き込み後は不変です",
		embedsAnInaudibleKantarWatermarkInThe:
			"可聴域外の Kantar ウォーターマークを音声レンディションに埋め込みます。映像のみのプランには埋め込む対象がないため、プラン検証で拒否されます。これはエンコーディング単位の設定で、1 エンコーディングにつき 1 つだけ指定できます。複数エンコーディングのラダーでは、同じプラン内の他のエンコーディングすべてに同じ設定が適用されます。Kantar サービスのログインとパスワードは保管庫にのみ保存されます(設定 → 資格情報 の「Kantar 音声ウォーターマーク」で管理)。プランは資格情報の参照だけを持ち、ログイン自体は持ちません。",
		emptyClStereo: "空欄 = CL_STEREO",
		emptyNoDvrWindowLiveEdgeOnly: "空欄 = DVR ウィンドウなし(ライブエッジのみ)",
		emsg: "emsg",
		enableEsamMediaPointInsertion: "ESAM メディアポイント挿入を有効にする",
		enableEsamMediaPointInsertionInThe:
			"チャンネルを開始する「前」に、ライブウィザードの開始オプションで ESAM メディアポイント挿入を有効にしてください。すでに稼働中のエンコーディングでは有効にできません。マッチ時刻は、シグナルをストリームに合わせ込む時刻です(空欄なら可能な限り早く挿入します)。各シグナルのオフセットは、その時刻に対する相対量を PT10S や -PT1.5S のような ISO 8601 期間で指定します。",
		enableScte35AdMarkers: "SCTE-35 広告マーカーを有効にする",
		encoderVersion: "エンコーダバージョン",
		encodingPlacementAdvanced: "エンコーディングの配置(詳細設定)",
		endpointTakesOnlyAnInfrastructureIdIt:
			"エンドポイントはインフラ ID のみを受け取ります。このエンコーディングを別の Cloud Connect (BYOC) インフラへ移します。これは時刻指定の再スケジュールでは",
		esamMediaPointInsertionMoreInformation:
			"「ESAM メディアポイント挿入」の説明",
		esamPoisScte250: "ESAM / POIS (SCTE-250)",
		eventStreamSignalling: "イベントストリームのシグナリング",
		everySourceBeyondTheImplicitVideoAudio:
			"暗黙の映像 / 音声ペア以外のすべてのソースをまとめた一覧です:追加の Ingest トラック、WebVTT 字幕サイドカー、Dolby Atmos / Vision / メタデータ入力。各ストリームは宣言済みの入力ファイルを読み込み、レンディションと字幕トラックは「配置と追加設定」でラベルによって参照します。",
		/* Explain restart conditions and their effect on delivery before listing API minimum values. */
		everyTimeoutHasAnApiMinimumOf:
			"入力が途切れた・出力が止まった・エンコーダが応答しないなどの条件を検知すると、エンコーダを自動で再起動します。再起動中は配信が中断し、視聴者にはストリームの途切れとして見えます。各タイムアウトの最小値は 30 秒で、それより短い値は切り上げではなく拒否されます。",
		extXDaterange: "#EXT-X-DATERANGE",
		failedToListObjects: "オブジェクト一覧の取得に失敗しました",
		failedToLoadCredentials: "資格情報を読み込めませんでした。",
		failoverDelayThresholdS: "フェイルオーバーの遅延しきい値 (秒)",
		ffmpegLoopFeedersReStreamLoop1:
			"ストレージ上の MP4 をこのチャンネルの Ingest へ繰り返し流し込むループフィーダーです。セッションは 1 回限りで、停止したら新しいセッションを作成してください。",
		ffprobeReturnedNoRecognizableFormatOrStream:
			"ffprobe が認識可能なフォーマット / ストリーム情報を返しませんでした。生の出力を下に示します。",
		ffprobeStreams: "ffprobe のストリーム",
		firstConnectTimeoutMin: "初回接続のタイムアウト (分)",
		fixTheValidationErrorsAboveToCompile:
			"— 操作一覧を生成するには、上の検証エラーを解消してください —",
		fmp4InitMp4ImmutableForTheLife:
			"fMP4 の init.mp4:チャンネルの存続期間中は不変です",
		framesWrittenTimeoutS: "フレーム書き込みのタイムアウト (秒)",
		gateForInsertingEsamMediaPointsWhile:
			"チャンネル稼働中に ESAM メディアポイントを挿入するためのゲートです:エンコーダが SCTE-35 データストリームを少なくとも 1 つ保持し、POIS 主導のメディアポイントを適用できるようにします。無効の場合、上の ESAM 設定はシグナルを報告するだけになります。",
		generateCreatesOneAssignUsesAnAccount:
			"GENERATE は新規に生成し、ASSIGN はアカウントの StreamKey ID を使います",
		generatesDefaultVodManifestsOverThisChannel:
			"このチャンネルの録画に対して既定の VOD マニフェストを生成し、チャンネルが使用中の出力先の隣に書き込みます。",
		guardAudioRenditionsWithAudiostreamcountGt0:
			"AUDIOSTREAMCOUNT > 0 で音声レンディションをガードします(無音ソースでは音声をスキップ)",
		guiFirstOnlineVideoPlatformExposingThe:
			"Bitmovin Encoding API の全機能を GUI から扱えるオンライン動画プラットフォーム",
		heightP: "高さ (p)",
		hideImport: "インポートを隠す",
		hint: "ヒント",
		hlsDvrBudgetC8: "HLS の DVR 予算",
		hlsManifest: "HLS マニフェスト",
		hlsManifestIntervalIsDeliberatelyAbsentThe:
			"HLS マニフェストの間隔は意図的にありません。Bitmovin API が未使用と明記しています(メディアプレイリストが変わるたびにマスタープレイリストは再アップロードされます)。",
		hlsManifestsUpdateTimeoutS: "HLS マニフェスト更新のタイムアウト (秒)",
		hlsMediaEntryWritesAnExtX:
			"HLS メディアエントリ:このレンディション用の EXT-X-MEDIA 行を書き出します。グループ ID が音声バリアントを束ね、名前がプレイヤーに表示されるラベル、URI がメディアプレイリストです。音声グループごとにバリアントを増やす場合(dolby プリセット)は音声レンディションごとに必須で、それ以外では指定不要です。",
		hlsMultiVariantPlaylist: "HLS マルチバリアントプレイリスト",
		hlsPlayback: "HLS 再生",
		hlsPull: "HLS プル",
		hlsVariantPlaylist: "HLS バリアントプレイリスト",
		host: "ホスト",
		howMuchOfTheExistingDvrWindow:
			"既存の DVR ウィンドウのうち、リセット後に残す量",
		howOftenTheTagRepeats: "タグを繰り返す間隔",
		identifiesThisEncoderToThePoisScte:
			"このエンコーダを POIS に識別させます (SCTE-250 AcquisitionPointIdentity)",
		importPlanJson: "プラン JSON をインポート…",
		importedPlanActiveTheFormIsBypassed:
			"インポートしたプランが有効です。フォームは使われず、JSON がそのまま送信されます。",
		incomplete: "不完全",
		/* Explain that automatic shutdown can precede the scheduled end and affect charges. */
		independentOfAutoRestartARestartDoes:
			"条件を満たすとチャンネルを自動で停止します: 入力が一定時間途切れた、合計稼働時間が上限に達した、最初の接続が一定時間なかった。予定している番組終了より前に停止することがあり、停止が完了するまでが課金対象です。自動再起動とは独立しており、再起動してもこれらのタイマーはリセットされません。",
		infrastructureAdvanced: "インフラ(詳細設定)",
		infrastructureId: "インフラ ID",
		infrastructureRegion: "インフラのリージョン",
		ingestPointsExactlyOneModeTheSdk:
			"Ingest ポイント(混在できないため、モードは 1 つだけです)",
		initSegment: "初期化セグメント",
		injectedIntoBitmovinAccountidTheOneException:
			"bitmovin.accountId に注入されます。そのまま送信するという原則の唯一の例外です",
		input: "入力",
		inputIdOrPasteOneFromAnother:
			"入力 ID(他組織のものを貼り付けても構いません)",
		inputKind: "入力種別",
		inputName: "入力名",
		insertExtXProgramDateTimeTags: "EXT-X-PROGRAM-DATE-TIME タグを挿入する",
		intervalSeconds: "間隔 (秒)",
		intervalSegments: "間隔(セグメント数)",
		job: "ジョブ",
		k128Aes128: "128 (AES-128)",
		k1Low: "1% low",
		k1LowMoreInformation: "「1% low」の説明",
		k256Aes256: "256 (AES-256)",
		k30sUnsetApiDefaultNeverSendsAn:
			"30 秒以上。未設定 = API の既定。「再アップロードしない (null)」は明示的な null を送って再アップロードを無効にします。",
		keyLength: "キー長",
		labels: "ラベル",
		ladder: "ラダー",
		latencyMs: "レイテンシ (ms)",
		leaveEveryBoxClearToSendThe:
			"すべてのチェックを外すと既定のセットが送信されます。特定のタグを必要とするプレイヤーやパッケージャがある場合にだけ追加してください。不要な環境では無害に無視されます。",
		lettersOnlyAZAZ3: "英字のみ (a–z, A–Z)、3〜20 文字:^[a-zA-Z]{3,20}$",
		streamKeyManagedByStaticPoint:
			"静的 ingest point の設定(GENERATE / ASSIGN)で決まります。開始リクエスト用のキーは自動で埋めます。",
		listenerBitmovinListensOrCallerBitmovinDials:
			"リスナー(Bitmovin が待ち受け)またはコーラー(Bitmovin が送信元に発信)",
		listenerPort: "リスナーポート",
		listingUnavailableTypeBelow: "一覧を取得できません。下に入力してください",
		noBucketsListedTypeBelow:
			"一覧は成功しましたがバケットが 0 件でした。アカウントにバケットが無いか、このキーからは見えません。バケット名を入力すれば直接開けます。",
		liveChannelPlanJson: "ライブチャンネルのプラン JSON",
		liveEdgeOffsetS: "ライブエッジのオフセット (秒)",
		liveEncodingMode: "ライブエンコーディングモード",
		livePresets: "ライブプリセット",
		loadInWizard: "ウィザードに読み込む",
		loadPlan: "プランを読み込む",
		loadingYourPresets: "プリセットを読み込んでいます…",
		localTimeSentAsUtc: "ローカル時刻。UTC で送信されます",
		localTimeSentAsUtcBlankInserts:
			"ローカル時刻。UTC で送信されます。空欄なら可能な限り早く挿入します",
		locationPresets: "保存先プリセット:",
		loopOffsetConfidenceDrift: "ループオフセット · 信頼度 · ドリフト",
		manifestName: "マニフェスト名",
		manifests: "マニフェスト",
		maxAcceptedTransmissionLatencyBothPartiesMax:
			"許容する最大伝送レイテンシ:双方の最大値のうち大きい方が採用されます",
		maximumOverallStreamDuration: "ストリーム全体の最大長",
		meanVmafVsBitrate: "平均 VMAF 対ビットレート",
		meanVmafVsBitrateOneCurvePer:
			"平均 VMAF 対ビットレート · レポートごとに 1 本の曲線",
		mediaSegment: "メディアセグメント",
		millisecondsAddedToTheStreamtimePtsOf:
			"送出シグナルの StreamTime/PTS に加算するミリ秒:負の値はシグナルを前倒しします",
		min: "最小",
		minBitrateBps: "最小ビットレート (bps)",
		minMoreInformation: "「最小」の説明",
		minimumUpdatePeriodMs: "最小更新間隔 (ms)",
		mode: "モード",
		moreInformation: "この項目の説明",
		mostRecentOutputSegmentsToAlign10:
			"位置合わせに使う直近の出力セグメント (10〜600 秒)",
		moveFailed: "移動に失敗しました",
		movflagsFaststart: "-movflags +faststart",
		mpdWrittenForSegmenttemplateRepresentations:
			"SegmentTemplate 表現向けに書き出される MPD",
		mpdWrittenForSegmenttimelineRepresentations:
			"SegmentTimeline 表現向けに書き出される MPD",
		multipleIngestPointsWithAutomaticFailover:
			"自動フェイルオーバー付きの複数 Ingest ポイント",
		mustMatchTheVaultedPassphrase12816:
			"保管庫のパスフレーズと一致させてください(128 ↔ 16 文字、256 ↔ 32 文字)",
		muxingInitFileIntervalS: "muxing 初期化ファイルの間隔 (秒)",
		myPresets: "マイプリセット",
		namedBucketPrefixShortcutsOfferedAsOne:
			"の保存ができます。バケットとプレフィックスの組み合わせに名前を付けたショートカットで、VOD ウィザードの「ストレージを参照…」でワンクリックの選択肢として表示されます。",
		navigateToTheDestinationPrefixThenUse:
			"宛先のプレフィックスまで移動し、それを出力のベースとして使用してください。",
		neverReUploadNull: "再アップロードしない (null)",
		newLiveChannel: "ライブチャンネルを作成",
		next: "次へ",
		noBackupsTheSingleSrtConnectionIs:
			"バックアップなし:単一の SRT 接続が唯一のソースです。",
		noPassphrase: "パスフレーズなし",
		noVideoRenditionsAudioOnlyChannelsAre:
			"映像レンディションがありません。音声のみのチャンネルは例外的です。再生のために映像の段を少なくとも 1 つ追加してください。",
		none: "なし",
		none2: "(なし)",
		not: "ありません",
		oncePerPlaylistWritesOneTagPer:
			"ONCE_PER_PLAYLIST はプレイリストごとに 1 つのタグを書き、*_INTERVAL のモードは繰り返します",
		onlyValidWhenNoCodecConfigSets:
			"どのコーデック設定もエンコーディングモードを指定していないときのみ有効です",
		open: "開く",
		operations: "操作",
		optionalEmptyTheAccountDefaultResolveBy:
			"任意。空欄 = 上のアカウント既定(一覧取得で解決)。ID を指定した場合はそのまま使われ、一覧取得は行いません。アカウントに複数の RTMP 入力がある場合に指定してください。",
		optionalStreamPathId: "ストリームのパス / ID(任意)",
		optionalZoneRegionTagSentWithEvery:
			"すべてのシグナルに付与するゾーン / リージョンのタグ(任意)",
		orTypeBucket: "またはバケットを入力",
		outOfBandAdSignalingTheEncoder:
			"帯域外の広告シグナリングです:エンコーダは検出したすべての SCTE-35 メッセージを POIS に報告し、その応答を適用します。POIS の Basic 認証は POIS_ENDPOINT の保管庫資格情報を ID で参照します。設定 → 資格情報 で管理してください。ユーザー名とパスワードはプランに入らず、開始時に解決されます。稼働中のメディアポイント挿入には、下の広告挿入ゲートも必要です。",
		outputCredential: "出力の資格情報",
		outputFolder: "出力フォルダ",
		outputsScte35MarkersSoAnInserted:
			"挿入したキューが下流で見えるように SCTE-35 マーカーを出力します。HLS は fMP4 と TS の両方で動作します。",
		overview: "概要",
		p1MoreInformation: "「p1」の説明",
		passphraseCredential: "パスフレーズの資格情報",
		pasteALivechannelplanEGALive:
			"LiveChannelPlan を貼り付けてください。そのまま送信されます",
		path: "パス",
		pdtSource: "PDT のソース",
		perArtifact: "アーティファクト単位",
		perRenditionMediaPlaylistsRefreshedEverySegm:
			"レンディションごとのメディアプレイリスト:ライブではセグメントごとに更新されます",
		periodOption: "Period のオプション",
		pickALivePresetTheValidatorWarns:
			"LIVE_* のプリセットを選んでください。VOD プリセットには検証で警告が出ます",
		pickAnInputObject: "入力オブジェクトを選択",
		pickAnOutputPrefix: "出力プレフィックスを選択",
		pickOneOfThisProviderSInfrastructures:
			"このプロバイダのインフラから選ぶか、他組織の ID を貼り付けてください。",
		pickOrTypeABucket: "バケットを選択するか入力してください。",
		pinOneFamilyWhenRenditionsCarryFmp4:
			"レンディションが FMP4 と TS のレッグを併せ持つ場合、どちらかに固定します",
		pinThisEncodingOntoACloudConnect:
			"このエンコーディングを Cloud Connect (BYOC) のインフラに固定します。Cloud Connect アカウントは 設定 → インフラ で管理します。2 つのフィールドは必ず両方指定してください。ここでのリージョンはインフラ「内部」のリージョンで、エンコーディング自身のクラウドリージョンは自動的に EXTERNAL に切り替わります(Cloud Connect では Bitmovin が要求します)。",
		pinThisEncodingOntoACloudConnect2:
			"このエンコーディングを Cloud Connect (BYOC) のインフラに固定します。Cloud Connect アカウントは 設定 → インフラ で管理します。2 つのフィールドは必ず両方指定してください。ここでのリージョンはインフラ「内部」のリージョンで、チャンネル自身のクラウドリージョンは自動的に EXTERNAL に切り替わります(Cloud Connect では Bitmovin が要求します)。",
		pinnedEncoderVersion: "固定するエンコーダバージョン",
		pinnedVersion: "バージョンを固定…",
		pinnedVersionEG22660: "固定バージョン(例: 2.266.0)",
		placementMode: "配置モード",
		planJson: "プラン JSON",
		planLevelFilterResourcesAttachThemPer:
			"プランレベルのフィルタリソースです。レンディションごとに「配置と追加設定」で適用してください。",
		playerFailedToLoad: "プレイヤーの読み込みに失敗しました",
		playlistTagsAreWrittenAtTheManifest:
			"のプレイリストタグはマニフェストレベルで書き出されます。セグメント内の",
		poisCredentialId: "POIS 資格情報 ID",
		poisEndpoint: "POIS エンドポイント",
		poisEndpointVaultCredentialUsernamePasswordI:
			"POIS_ENDPOINT の保管庫資格情報(ユーザー名 + パスワード):ID のみを指定します。空欄 = 認証なしの POIS",
		port: "ポート",
		prefixBreadcrumb: "プレフィックスのパンくず",
		preset: "プリセット",
		programDateTimeSettings: "Program-date-time の設定",
		psnrDb: "PSNR (dB)",
		psnrDb2: "PSNR dB",
		psnrMeanMoreInformation: "「PSNR 平均」の説明",
		publicMaxAge0NoCache: "public, max-age=0, no-cache",
		rawRequest: "リクエスト",
		rawResponse: "レスポンス",
		rawSnapshots: "リクエスト/レスポンス(raw)",
		rawSnapshotsLabel:
			"ステップ {step} — 永続化スナップショット(秘匿値は除去済み)",
		reUploadSettings: "再アップロードの設定",
		redundantRtmp: "冗長 RTMP",
		refs: "参照",
		relativeToTheChannelSOutputEmpty:
			"チャンネルの出力からの相対パス。空欄 = 収録先のフォルダそのもの。Bitmovin は default マニフェストが列挙する全 muxing の上位に置かれることを要求するため、指定できるのはそのフォルダかその親だけです。",
		remove: "削除",
		representationType: "Representation 種別",
		reprioritizeFailed: "優先度の変更に失敗しました",
		requiredForImageContentTruncatesLoopsMovies:
			"画像コンテンツでは必須。動画では切り詰め / ループします",
		requiredForLiveFixedLaddersOnly: "ライブでは必須:固定ラダーのみ",
		reschedule: "reschedule",
		reservedInSettingsInfrastructureConsumedWhen:
			"設定 → インフラ で予約し、エンコーディングの作成時に消費されます。すでに USED の IP を使うとエンコーディングは ERROR になります",
		resourceId: "リソース ID",
		resources: "リソース",
		responseUnavailableStepRanButNoResponse:
			"レスポンスがありません(ステップは実行されましたが、レスポンスが記録されていません)",
		restartIfDashManifestsStopUpdatingFor:
			"DASH マニフェストがこの時間だけ更新されなくなったら再起動します(最小 30 秒)。DASH が主要な出力の場合に設定してください。",
		restartIfHlsManifestsStopUpdatingFor:
			"HLS マニフェストがこの時間だけ更新されなくなったら再起動します(最小 30 秒)。HLS が主要な配信経路で、プレイリストの停止が問題になる場合に設定してください。",
		restartIfNoDataAtAllIs:
			"データがまったく書き込まれない状態がこの時間続いたら再起動します(最小 30 秒)。あらゆる出力停止を捉える、粗いストール監視です。",
		restartIfNoFramesAreEncodedFor:
			"フレームがこの時間だけエンコードされなかったら再起動します(最小 30 秒)。muxing より上流のデコード / パイプラインのストールを捉えます。",
		restartIfNoSegmentsAreWrittenFor:
			"セグメントがこの時間だけ書き込まれなかったら再起動します(最小 30 秒)。セグメント出力に対する最も直接的な「出力停止」監視です。",
		restartOnEncoderError: "エンコーダエラー時に再起動する",
		restartOnEncoderErrorMoreInformation:
			"「エンコーダエラー時に再起動する」の説明",
		review: "確認",
		reviewThePlanOnTheRightThe:
			"プランのプレビューを確認してください。操作一覧は、実際にプロビジョニングされる内容そのものです(順序も同じです)。チャンネルは作成と同時にプロビジョニングが始まり、開始と停止はその後チャンネルに対する操作として行います。",
		rtmp: "RTMP",
		rtmpEncoderIpLive: "rtmp://<encoder-ip>/live",
		rtmpInputId: "RTMP 入力 ID",
		running: "稼働中",
		s3AzureBlobSftpLiveSegmentsAnd:
			"S3 / Azure Blob / SFTP:ライブのセグメントとマニフェストがここに書き込まれます",
		sameForAudioLegs: "音声レッグも同様",
		samplePresets: "サンプルプリセット",
		sampleRateHz: "サンプリング周波数 (Hz)",
		scheduleExpression: "スケジュール式",
		schemaDefaultVodWarns: "(スキーマ既定:VOD、警告あり)",
		sdkPassthroughEGAes128: "Bitmovin API にそのまま渡します(例: AES_128)",
		searchPresets: "プリセットを検索",
		searchTitleDescriptionFamily: "タイトル・説明・ファミリーを検索…",
		secondsWithoutSignalBeforeSwitchingIngestPoi:
			"Ingest ポイントを切り替えるまでの無信号秒数",
		secondsWithoutSignalBeforeSwitchingToA:
			"バックアップへ切り替えるまでの無信号秒数",
		segmentLengthS: "セグメント長 (秒)",
		segmentsWrittenTimeoutS: "セグメント書き込みのタイムアウト (秒)",
		segmenttemplateVsSegmenttimeline:
			"SegmentTemplate と SegmentTimeline の比較",
		selectABitmovinAccountInStep1:
			"作成する前に、ステップ 1 で Bitmovin アカウントを選択してください。",
		selectAccount: "アカウントを選択…",
		selectBucket: "バケットを選択…",
		selectCredential: "資格情報を選択…",
		// Owner request 2026-08-19: register a credential without abandoning
		// a half-filled wizard. The copy says NEW TAB because the form's
		// state does not survive a route change.
		addCredentialNewTab: "資格情報を追加(新しいタブで開きます)",
		sharedByEveryMuxingFeedsTheC8:
			"すべての muxing で共有されます。DVR 要素予算に影響します",
		shiftAppliedToTheWindowStart: "ウィンドウ開始位置に適用するシフト量",
		showingTheFirst500InputsOnlyPaste:
			"先頭 500 件の入力のみ表示しています。一覧にない場合は ID を貼り付けてください。",
		shutDownAfterNoInputBytesFor:
			"入力バイトがこの時間途絶えたらシャットダウンします",
		shutDownIfNoEncoderEverConnects:
			"エンコーダが一度も接続しない場合はシャットダウンします",
		signalProcessingUrlTheEncoderPostsA:
			"シグナル処理の URL:エンコーダが SCTE-35 メッセージを検出するたびに SignalProcessingEvent を POST します",
		signalingDeliveryAdvanced: "シグナリングと配信(詳細設定)",
		singlePeriodKeepsOneContinuousPeriodMulti:
			"SINGLE_PERIOD は連続した 1 つの period を保ち、MULTI_PERIOD はキューごとに新しい period を分けます(一部の広告サーバーが必要としますが、プレイヤーには負担です)",
		sourceHost: "送信元ホスト",
		sourcePort: "送信元ポート",
		sourceUrl: "ソース URL",
		srt: "SRT",
		srtIsCallerOnlyTheFeederDials:
			"SRT はコーラー専用です:フィーダーが Bitmovin のリスナーに発信します",
		srtListenerPortsAreRestrictedTo2088:
			"SRT の LISTENER ポートは 2088〜2091 に限定されています(Bitmovin の制約)",
		start: "開始",
		starting: "開始しています…",
		staticIpId: "静的 IP の ID",
		staticRtmpsIngest: "静的 ({url})",
		stitchOrderedSourceInputStreamsIntoOne:
			"並べた順にソース入力ストリームを 1 つへ連結します。ちょうど 1 つのソースをメインに指定してください(スケーリング・アスペクト比・FPS・サンプリングレートの基準になります)。レンディションは「配置と追加設定」で選択して結果を読み込みます。",
		stop: "停止",
		stream: "ストリーム",
		streamKey: "ストリームキー",
		streamKeyConfig: "ストリームキーの設定",
		streamTimeoutMin: "ストリームのタイムアウト (分)",
		streamkeyId: "StreamKey ID",
		suggestedFromTheChannelEditable:
			"チャンネルから推測した値です(編集できます)",
		suggestedPresentationDelayMs: "推奨提示遅延 (ms)",
		systemClockTheEncoderClockEmbeddedTimestamps:
			"SYSTEM_CLOCK = エンコーダのクロック、EMBEDDED = Ingest に含まれるタイムスタンプ",
		theBitmovinInputResourceHoldingTheFile:
			"そのファイルを保持している Bitmovin の入力リソースです。選択するか、ID を貼り付けてください",
		theChannelNameIsAppendedAutomaticallyOutputs:
			"チャンネル名は自動的に付加されます。出力は <フォルダ>/<チャンネル名> の下に置かれます(映像は video/{heightToken}p、音声は audio/{bitrateToken}、マニフェストはベース直下)。",
		theMasterM3u8UsuallyShortLivedRendition:
			"マスター .m3u8:通常は短命です(レンディション一覧が変わりうるため)",
		thisReportFinishedWithNoRenditionResults:
			"このレポートはレンディションの結果なしで完了しました。",
		thisSessionOnlyMediaPointsAreNot:
			"(このセッションのみ。メディアポイントはステップログに記録されません。履歴は API 監査ログを参照してください)",
		timeshiftDvrWindowS: "タイムシフト / DVR ウィンドウ (秒)",
		trimASourceInputStreamToA:
			"ソース入力ストリームを部分区間に切り出します(開始リクエストの trimming とは独立した、現行の入力ストリーム方式です)。レンディションは「配置と追加設定」で選択してクリップ結果を読み込みます。",
		ts: "TS",
		tsHlsOnlyAacOnly: "TS = HLS 専用、AAC 専用",
		tsHlsOnlyH264Only: "TS = HLS 専用、H264 専用",
		type: "種類",
		unsetApiDefaultsToTheSegmentDuration:
			"未設定 = API はセグメント長を既定値とします",
		unsetNotWrittenToTheMpd: "未設定 = MPD に書き出しません",
		searchInputsByName: "名前で input を検索",
		search: "検索",
		prewarmedPoolIds: "プリウォームプール id(このプランのみ)",
		perPlanPoolPinningHint:
			"このエンコーディングをプリウォームプールに固定します — 空のままならアカウント既定が適用されます",
		couldNotListInfrastructures:
			"インフラストラクチャの一覧を取得できませんでした",
		infrastructureFamiliesSkipped:
			"一部のファミリを一覧できませんでした({families})— 該当する場合は id を貼り付けてください",
		noInfrastructuresInAccount:
			"このアカウントに Cloud Connect インフラストラクチャはありません",
		infrastructuresInAccount: "このアカウントのインフラストラクチャ",
		infrastructureIdCopyLabel: "インフラストラクチャ id",
		couldNotListStaticIps: "静的 IP の一覧を取得できませんでした",
		noStaticIpsInAccount: "このアカウントに予約済みの静的 IP はありません",
		staticIpsTruncated:
			"{total} 件中 {shown} 件を表示しています — 一覧にない場合は id を貼り付けてください",
		staticIpsInAccount: "このアカウントの静的 IP",
		staticIpIdCopyLabel: "静的 IP id",
		useCurrentPrefix: "現在のプレフィックスを使う",
		useTheUseAsInputActionOn:
			"ファイル行の「入力として使う」操作を使ってください。",
		usesTheAccountSDefaultRtmpInput:
			"アカウント既定の RTMP 入力を使います。アカウントの入力一覧から自動で選びます。アカウントに RTMP 入力がない場合や複数ある場合は、推測せずに明確なエラーでプロビジョニングを失敗させます。",
		usingAPastedIdNotInThe:
			"貼り付けた ID を使用しています。上の一覧にはありません。",
		validateAmpLoad: "検証して読み込む",
		validateSaveAmpCompare: "検証・保存して比較",
		vaultSrtPassphraseRefResolvedAtSpawn:
			"保管庫の SRT_PASSPHRASE 参照:起動時に解決され、保存されません",
		vaultSrtPassphraseRefThePassphraseItself:
			"保管庫の SRT_PASSPHRASE 参照:パスフレーズ自体はプランに入りません",
		vaultZixiRefPasswordAndOrDecryption:
			"保管庫の ZIXI 参照(パスワードと復号キーのいずれかまたは両方):指定は必須です",
		videoMuxingPin: "映像 muxing の固定",
		videoRenditionsH264H265: "映像レンディション(H264 / H265)",
		vmafLab: "VMAF ラボ",
		vmafLab2: "← VMAF ラボ",
		vodPresetsLivePresetVodWarning:
			"VOD プリセット(LIVE_PRESET_VOD の警告あり)",
		waitForTheReportToFinishBefore:
			"削除する前にレポートの完了を待ってください",
		whenBothAreSetMismatchedModesFail:
			"と一致していなければなりません。両方を設定した場合、モードが食い違うとエンコーディングは失敗します。",
		whereScte35MarkersAreReadFrom: "SCTE-35 マーカーの読み取り元",
		whereThePdtWallClockComesFrom:
			"PDT の実時刻の取得元と書き出し頻度です。ここで指定したソースは、開始リクエストの広告挿入",
		wizardSteps: "ウィザードのステップ",
		xmlBinCarriesTheBinarySpliceInfo:
			"XML_BIN はバイナリの splice info を Signal.Binary として搬送し、XML は解析済みの SCTE-35 を XML 要素として書き出します",
		zixi: "Zixi",
		zixiBroadcasterPull: "Zixi ブロードキャスタから取得",
		zixiCredential: "Zixi の資格情報",
		zixiFeederExampleCom: "zixi-feeder.example.com",
		zoneIdentity: "ゾーン識別子",
	},
	origin: {
		/* Name the output-side observation directly instead of exposing internal observer terminology. */
		title: "出力モニタリング",
		explainer:
			"出力先のメディアプレイリストを直接読み取った結果です — エンコーダの自己申告とは独立した確認です。",
		lastFetch: "取得 {at}",
		noneYet:
			"出力モニタリングはまだ始まっていません — チャンネルが稼働中になってから数秒以内に始まります。",
		unavailable:
			"出力の状態を確認できません。出力先の設定とアクセス権を確認してください。",
		summaryUnavailable: "配信先の直接確認不可",
		playlistReadLimitReached:
			"一部の HLS を完全に確認できません（取得上限 256 KiB）",
		playlistReadLimitHelp:
			"前回の直接確認で、一部のプレイリストが読み取り上限に達しました。完全性と進行を確認できず、不完全な内容で停止・ENDLIST を判定しません。マニフェストのサイズと DVR 設定を確認してください。Push/Poll の報告とは別の証拠です。",
		stale: "停滞",
		advancing: "進行中",
		edgeDelay: "エッジ遅延 {s} 秒",
	},
	startup: {
		reSaveForAccount:
			"Bitmovin アカウント未設定 — この出力先を再保存し、プローブが動くアカウントを選択してください",
		runsUnder: "{account} で実行",
		account: "Bitmovin アカウント",
		pickAccount: "アカウントを選択…",
		title: "起動時間",
		explainer:
			"開始から RUNNING までに各リージョンが要した時間。このインストール自身のチャンネル起動から計測しています。キュー時間は Bitmovin のエンコーダ割り当て時間を、当方のリソース作成呼び出しと切り分けたものです。",
		window: "期間",
		windowDays: "直近 {days} 日",
		loadFailed: "起動プロファイルを読み込めませんでした。",
		empty: "サンプルはまだありません — 最初のチャンネル起動後に表示されます。",
		region: "リージョン",
		source: "ソース",
		failures: "失敗",
		censored: "打ち切り",
		max: "最大",
		sourceChannel: "チャンネル",
		sourceProbe: "プローブ",
		smallNNote:
			"P50/P90 のない行はサンプル不足（20 未満）でパーセンタイルが正直に出せないため、最大値と件数を表示しています。",
		probeDestination: "プローブ出力先",
		probeDestinationExplainer:
			"起動プローブはここで明示指定した領域だけに書き込みます — 顧客の出力先には決してデフォルトしません。保存時に削除権限を検証します（番兵キー方式）: プローブ後始末はこのアプリ唯一の破壊的ストレージ操作で、一覧専用の資格情報は 10 回のプローブ後ではなく今この場で失敗すべきだからです。",
		abandonAfter: "{minutes} 分で打ち切り",
		noDestinationYet: "プローブ出力先はまだ指定されていません。",
		credential: "資格情報",
		pickCredential: "資格情報を選択…",
		bucket: "バケット",
		prefix: "プレフィックス",
		prefixHint: "8 文字以上 — 短いものは拒否されます",
		abandonDeadline: "打ち切り期限（分）",
		verifyingDelete: "削除権限を検証中…",
		saveDestination: "検証して保存",
		designationFailed: "プローブ出力先を保存できませんでした。",
		deleteVerified: "削除権限を検証し保存しました。",
		runProbes: "起動プローブを実行",
		runProbesExplainer:
			"各プローブは対象リージョンで実際に最小構成のライブエンコーダを起動し、RUNNING までの時間を測って停止し、出力を削除します。プローブは課金されます。直列に実行され、結果は 1 レンディション構成での計測値です。",
		probeCount: "本数",
		worstCaseLine:
			"最悪ケース: 全プローブが打ち切り期限まで達した場合、{count} 本 × 最大 {perProbe} 分(打ち切り期限+停止待ち)= 計 {minutes} 分のエンコーダ時間が課金されます。",
		acknowledgeWorstCase: "上記の最悪ケースの費用を了承します。",
		launchProbes: "プローブを開始",
		destinationFirst: "先に出力先を指定してください。",
		launchFailed: "プローブバッチを投入できませんでした。",
		probesEnqueued:
			"プローブバッチを投入しました — サンプルが届き次第、上の表に反映されます。",
		probeList: "プローブ",
		noProbesYet: "プローブはまだ実行されていません。",
		strandedProbe:
			"停止未確認 — 開いて停止を再試行してください（データリセットを塞ぎます）",
		openProbe: "開く",
	},
	runs: {
		loadFailed: "チャンネルの実行履歴を読み込めませんでした。",
		loading: "配信履歴を読み込み中…",
		empty: "配信はまだありません — このチャンネルは一度も開始されていません。",
		seq: "配信 #{n}",
		window: "{from} → {to}",
		queueSeconds: "キュー {s} 秒",
		heading: "配信履歴",
	},
	uiX: {
		matchCountOne: "一致 {count} 件",
		matchCountOther: "一致 {count} 件",
		opPayloadLabel: "ステップ {step} — オペレーションペイロード",
		opsListFailed: "オペレーション一覧を読み込めませんでした。",
		opsListLabel: "{name} — コンパイル済みオペレーション",
		scanningThePrefix: "プレフィックスを走査しています…",
		downsampledExportFull:
			"表示用に間引いています · 全 {frames} フレームの系列はエクスポートしてください",
		perFrameVmaf: "フレームごとの VMAF",
		addOrCheckCredentials: "設定 → 資格情報 で追加または確認してください。",
		cacheControlHint:
			"ヘッダーをアップロード時に書き込みます。S3 / GCS / Azure の出力でのみ有効で、他のプロバイダは無視します(プラン検証が警告します)。空欄 = プロバイダの既定値。",
		couldNotStartNewRun: "新しい実行を開始できませんでした",
		enterTheBucketName: "— バケット名を入力してください:",
		failedToLoadDnsMappings: "DNS マッピングを読み込めませんでした",
		failedToLoadRegisteredContent: "登録済みコンテンツを読み込めませんでした",
		failedToLoadSchedule: "スケジュールを読み込めませんでした",
		heartbeatHistoryHint:
			"直近 {minutes} 分のポーリングごとのパケット増分です(30 秒間隔で取得)。点は Ingest ステータスの変化を示します(緑 = 接続、橙 = それ以外)。累計は上の現在状態パネルにあります。",
		heartbeatHistoryRunHint:
			"この配信全体のポーリングごとのパケット増分です(30 秒間隔)。点は Ingest ステータスの変化を示します(緑 = 接続、橙 = それ以外)。",
		logTailAutoRefreshing: "、自動更新中",
		logTailShowing: "(直近 {count} 行、機密をマスク済み{suffix})",
		loopBoundariesShowing:
			"(直近 {shown} 件 / 全 {total} 件:実時刻とソースのストリーム時刻の対応。VMAF の位置合わせに使用します)",
		thisJobIsUnchanged: "このジョブは変更されていません。",
		vmafOnlyManifestsNote:
			"「VMAF のみ」が有効です(エンコーディングオプション → 品質管理):このエンコードは映像ごとの QC ミラー MP4 だけを生成するため、HLS/DASH の muxing とマニフェストはスキップされます。配信マニフェストを設定するには「VMAF のみ」を無効にしてください。",
		vmafOnlyPackagingNote:
			"「VMAF のみ」が有効です(エンコーディングオプション → 品質管理):このエンコードは映像ごとの QC ミラー MP4 だけを出力するため、配信用の muxing・サムネイル・スプライトはスキップされます。設定するには「VMAF のみ」を無効にしてください。",
		pickTwoReportsTail:
			"を開き、レポートを 2 つ以上選択して「{label}」を選んでください。",
		libvmafModelTooltip:
			"比較するレポートでは同じモデルを使用してください。通常は標準視聴条件（推奨）を選択します。",
		dashRepushTooltip:
			"DASH マニフェストを再送信する間隔です(最小 30 秒、「なし」は明示的な null で無効化)。再検証しないキャッシュの背後で MPD を一定間隔で更新させる必要がある場合に設定します。",
		encodingsHoldingAKey:
			"キーを保持しているエンコーディングと、このアプリのライブチャンネル",
		initRepushTooltip:
			"fMP4 の初期化セグメントを再アップロードする間隔です(最小 30 秒、または「なし」)。配信中に init ファイルを失う・壊す可能性のあるオリジン / CDN からの復旧用に設定します。",
		inputIdNoun: "入力 ID",
		inputsInThisAccount: "このアカウントの入力",
		jobOutputPathHint:
			"ジョブ名は自動的に付加されます。出力は <フォルダ>/<ジョブ名> の下に置かれます(映像は video/{heightToken}p、音声は audio/{bitrateToken})。",
		noInputsInAccount:
			"この Bitmovin アカウントには入力がありません。まず作成する(またはエンコーディングを実行する)か、下に ID を貼り付けてください。",
		objectPath: "オブジェクトパス",
		outputFolderLabel: "出力フォルダ",
		outputStep: "出力",
		restartOnFixedSchedule:
			"決まったスケジュール(Unix crontab)で再起動します。24/7 チャンネルの計画メンテナンス用で、障害とは連動しません。",
		shutDownNeverConnects:
			"開始後この時間内にソースが一度も接続しなければシャットダウンします。早めに開始したもののエンコーダが現れなかったチャンネルを回収します。",
		shutDownNoInput:
			"この時間だけ入力が来なければシャットダウンします。配信中にソースが切断された後、エンコーダの課金を止めます。注意: 自動再起動ではこのタイマーはリセットされません。",
		shutDownTotalRuntime:
			"入力の有無にかかわらず、この合計稼働時間でシャットダウンします。長さが決まっているイベントのコスト・稼働時間の上限です。",
		defaultEn: '既定 "en"',
		defaultEnglishSample: '既定 "english - sample"',
		defaultStreamIsm: '既定 "stream.ism"',
		defaultStreamIsmc: '既定 "stream.ismc"',
		defaultSubtitle: '既定 "SUBTITLE"',
		defaultSubtitlesEnM3u8: '既定 "subtitles_en.m3u8"',
		emptyAudio: '空欄 = "audio"',
		emptyEnLang: '空欄 = "en"',
		emptyHlsInput: '空欄 = "HLS Input"',
		emptyRedundantRtmpInput: '空欄 = "Redundant RTMP Input"',
		emptySrtInput: '空欄 = "SRT Input"',
		dvrBudgetTooltip:
			"Live DVR/タイムシフトのマニフェストはまだ取得可能な全セグメントを列挙し、Bitmovin は合計 ~54,000 要素まで保持します。各レンディションが(timeshift ÷ セグメント長)個のセグメントを加えるため、ウィンドウが長い・セグメントが短い・レンディションが多いほど数が増えます。ウィンドウは ~3 時間(10,800 秒)以下を推奨 — 大きなマニフェストは更新を遅くします。このゲージは値を上限で切り詰めることはありません。予算の ~80% を超えたら警告するだけです。",
		liveEdgeOffsetTooltip:
			"プレイヤーが最新セグメントからどれだけ後ろで再生を始めるか。推奨は ~10–12 秒(セグメント約 2–3 個分 — Bitmovin のリファレンスサンプルは 10–12 を使用)。大きいほど遅延は増えるが ingest/CDN ジッタへのバッファ余裕が増し、小さいほど低遅延だがライブエッジ付近でのリバッファリスクが上がります。",
		hlsLiveEdgeOffsetTooltip:
			"HLS マニフェストへのセグメント公開を遅らせるバッファーの秒数です。プレイヤーの再生開始位置ではありません。小さくすると公開遅延は減りますが、入力・配信の揺らぎに対する余裕も減ります。",
		hlsLiveEdgeOffsetDefaultHint:
			"空欄は配信サービスの既定値（120秒）を使用し、公開遅延が増える場合があります。変更する場合は開始前に秒数を入力してください。",
		hlsTimeshiftDefaultHelp:
			"空欄は配信サービスの既定値を使用します。DVRなしの指定ではありません。",
		emptyStreamM3u8: '空欄 = "stream.m3u8"',
		emptyStreamMpd: '空欄 = "stream.mpd"',
		emptyZixiInput: '空欄 = "Zixi Input"',
		iso6391CommaSeparated: 'ISO 639-1、カンマ区切り:"en" は暗黙に含まれます',
		unixCrontabExample: 'Unix crontab 形式(例: "0 5 * * 1")',
		fixValidationForTemplateYaml:
			"— Template YAML を書き出すには、上の検証エラーを解消してください(プラン JSON は引き続き利用できます)—",
		cancelSelected: "選択したものをキャンセル",
		cancelSelectedCount: "選択したものをキャンセル({count})",
		driftDetectedFullOne:
			"ドリフトを検出しました: ウィンドウ全体でオフセットが {count} フレーム分ばらついています(セグメント別オフセット {offsets})。取得中にエンコーダ / クロックのずれで位置合わせが動いたため、ウィンドウ端付近のスコアは信頼度が下がります。",
		driftDetectedFullOther:
			"ドリフトを検出しました: ウィンドウ全体でオフセットが {count} フレーム分ばらついています(セグメント別オフセット {offsets})。取得中にエンコーダ / クロックのずれで位置合わせが動いたため、ウィンドウ端付近のスコアは信頼度が下がります。",
		esamRejectsTail: "これがないと Bitmovin は挿入を拒否します。",
		ffprobeNoData:
			"ffprobe が認識可能なフォーマット / ストリーム情報を返しませんでした。生の出力を下に示します。",
		ffprobeStreamsCaption: "ffprobe のストリーム",
		inspectBoundedTailRest:
			" を付けて再多重化してください。あるいは、そのままエンコーディングを実行してください。入力全体が読み込まれます。",
		liveToVodTail:
			"録画である必要があります。セグメントの書き込みが続いている間に生成したマニフェストは途中で切れてしまいます。(ステータス: {status})",
		noBrowsableCredential:
			"参照できる資格情報がありません。設定で AWS S3 の資格情報を追加してください。",
		asOfSweep: "{when} 時点(30 秒間隔で取得)",
		credentialsUnavailable:
			"資格情報を取得できません。上のエラーを確認してください。",
		deletePresetLabel: "プリセット {label} を削除",
		failedCount: "· 失敗 {count} 件",
		feederSession: "フィーダーセッション",
		feedersAttachRunningOnly:
			"フィーダーを接続できるのは RUNNING または PROVISIONING のチャンネルのみです(ステータス: {status})。作成は拒否されます。",
		ffprobeBoundedTitle:
			"{bucket}/{key}:上限付きの読み取りで ffprobe を実行します(先頭を上限まで読み、必要なら上限付きのリトライを 1 回だけ行います)。部分読み取りでは全体ビットレートを確定できないため、— と表示します。ストリーム別の値と生 JSON は ffprobe の観測値です。",
		healthy: "正常",
		sampleStale:
			"サンプルが古く、現在の状態を保証しません(最終スイープが保証窓を超過)。",
		ingestStatusBadge: "Ingest {status}",
		lastCueInsertedAt: "最後にキューを挿入した時刻:",
		lastMediaPointInsertedAt: "最後にメディアポイントを挿入した時刻:",
		logTail: "ログの末尾",
		loopBoundaries: "ループ境界",
		newJobQueued: "新しいジョブをキューに追加しました。",
		openJobId: "{id} を開く →",
		pickTwoReportsHead:
			"比較するには、完了済みの VMAF レポートを 2 つ以上選んでください —",
		pidValue: "プロセス ID {pid}",
		priorityRangeHint:
			"{min}〜{max}(既定 {dflt})。数値が大きいほど、組織のキュー内で先に実行されます。そのため、実行が空きを待っている間にしか効果はありません。",
		readBytes: "読み取り {bytes}",
		scanTruncated:
			"{matches}(先頭のみ)。{scanned} 件で走査を打ち切ったため、さらに存在する可能性があります。「さらに読み込む」で走査を続けるか、より狭いフォルダを開いてください。",
		scanWholePrefix:
			"{matches}。{scanned} 件のオブジェクトを走査し、プレフィックス全体を確認しました。",
		selectCredentialToBrowse: "参照を始めるには資格情報を選択してください。",
		startedStopped: "開始 {started} · 停止 {stopped}",
		stepsFraction: "{done}/{total}",
		targetProtocolMasked: "送信先({protocol};ストリームキーは非表示)",
		thisPollLifetime: "今回のポーリング · 累計 {total}",
		timeshiftResetRunningOnly:
			"タイムシフトをリセットできるのは RUNNING のチャンネルのみです(ステータス: {status})。",
		unhealthy: "異常",
		concurrentCount: "並列 {count}",
		coresCountOne: "{count} コア",
		coresCountOther: "{count} コア",
		driftSpreadTail: "、ばらつきは 1 フレーム以内)。",
		noDriftHead: "ドリフトは検出されていません(セグメント別オフセット",
		bitrateAxis: "ビットレート",
		bitrateAxisWithUnit: "ビットレート (kbps)",
		captureRejected: "取得が拒否されました: {message}",
		capturedFramesLine:
			"取得フレーム {captured} · ソース {source} フレーム @ {fps}",
		copyCoordinate: "{label} をコピー",
		copyLabelledValue: "{label} をコピー: {value}",
		copyUriFor: "{name} の URI をコピー",
		copyValue: "{value} をコピー",
		couldNotListInputs: "このアカウントの入力を取得できませんでした",
		deleteJobNamed: "「{name}」を削除しますか?",
		deleteNJobsOne: "ジョブ {count} 件を削除しますか?",
		deleteNJobsOther: "ジョブ {count} 件を削除しますか?",
		deleteNReportsOne: "レポート {count} 件を削除しますか?",
		deleteNReportsOther: "レポート {count} 件を削除しますか?",
		deletePresetNamed: "プリセット {name} を削除",
		downsampledSeries: "間引き表示 · {total} 系列中 {shown} 系列",
		driftDetectedOne:
			"ドリフトを検出しました: ウィンドウ全体でオフセットが {count} フレーム分ばらついています。VMAF はセグメント単位で位置合わせしており、全体では合わせていません。",
		driftDetectedOther:
			"ドリフトを検出しました: ウィンドウ全体でオフセットが {count} フレーム分ばらついています。VMAF はセグメント単位で位置合わせしており、全体では合わせていません。",
		encodingIdLine: "エンコーディング {id}",
		fromEncodingJob: "元のエンコーディングジョブ:",
		heightAxis: "高さ",
		heightAxisWithUnit: "高さ (px)",
		hlsPlaybackFailed: "HLS の再生に失敗しました({type})",
		idNoun: "ID",
		insertionRejected: "挿入が拒否されました: {message}",
		libvmafThreadsOne: "libvmaf スレッド {count} 本",
		libvmafThreadsOther: "libvmaf スレッド {count} 本",
		loadingList: "{list} を読み込んでいます",
		loopsInWindowOne: "ウィンドウ内のループ {count} 回",
		loopsInWindowOther: "ウィンドウ内のループ {count} 回",
		noDriftDetected:
			"ドリフトは検出されていません(セグメント別オフセット {offsets}、ばらつきは 1 フレーム以内)。",
		noPresetsMatch:
			"「{query}」に一致するプリセットはありません。「dolby」や「per-title」のようなファミリー名で試してください。",
		onlyRunningCanBeMoved:
			"移動できるのは実行中のジョブのみです(ステータス: {status})",
		onlyRunningCanBeReprioritized:
			"優先度を変更できるのは実行中のジョブのみです(ステータス: {status})",
		opsCount: "操作 {count} 件",
		pasteAnIdBelow: "{message}:下に ID を貼り付けてください。",
		presetCountOne: "プリセット {count} 件",
		presetCountOther: "プリセット {count} 件",
		psnrForRendition: "{rendition} の PSNR",
		removeSignalN: "シグナル {n} を削除",
		reportCountOne: "レポート {count} 件",
		reportCountOther: "レポート {count} 件",
		renditionCountOne: "レンディション {count} 件",
		renditionCountOther: "レンディション {count} 件",
		renditionsOmittedOne:
			"{axis}を持たないレンディション {count} 件をラダーから除外しました。",
		renditionsOmittedLabel: "ラダーから省かれたレンディション",
		renditionsOmittedOther:
			"{axis}を持たないレンディション {count} 件をラダーから除外しました。",
		reportShortId: "レポート {id}",
		requestResponseAt: "リクエスト / レスポンス({when})",
		insertionAccepted: "挿入受付",
		insertionUnverified: "結果未確認",
		insertionProtocol: "受付記録（詳細）",
		insertionAcceptedHelp:
			"挿入要求の受付記録です。映像・音声への反映や成功を示しません。現在の配信では提供元の予約一覧で状態を確認し、実際の出力も確認してください。予約が提供元から消えた後の結果は、この履歴には保存されません。",
		resourceCreatedByStep: "{id}({step} が作成)",
		runningOn: "実行環境: {parts}",
		savedCount: "保存済み {count} 件",
		scenariosCount: "シナリオ {count} 件",
		scoredUnitsOne: "{total} 単位中 {done} 単位を採点",
		scoredUnitsOther: "{total} 単位中 {done} 単位を採点",
		scte35BinaryMax: "SCTE-35 バイナリ(base64、{max} 文字以内)",
		selectJobNamed: "{name} を選択",
		selectReport: "レポート {label} を選択",
		selectReportUnavailable:
			"レポート {label} を選択(まだ {status} のため選択できません)",
		selectedCount: "{count} 件選択中",
		selectedJobsCount: "選択中のジョブ {count} 件",
		selectedReportsCount: "選択中のレポート {count} 件",
		seriesCount: "{count} 系列",
		seriesShown: "系列({total} 件中 {shown} 件を表示)",
		skippedReportsOne:
			"読み込みに失敗したレポート {count} 件をスキップしました:",
		skippedReportsOther:
			"読み込みに失敗したレポート {count} 件をスキップしました:",
		stepsProgress: "{total} ステップ中 {done} ステップ",
		stoppedSiblingsOne:
			"同じジョブの他のエンコーディング {count} 件を停止しました(このステップが失敗した時点でも課金は継続していました)",
		auditErrorLabel: "Bitmovin 呼び出しエラー",
		stoppedSiblingsLabel: "停止した兄弟エンコーディング(ID)",
		stoppedSiblingsOther:
			"同じジョブの他のエンコーディング {count} 件を停止しました(このステップが失敗した時点でも課金は継続していました)",
		toggleSeries: "系列 {label} の表示を切り替え",
		upToNJobsPerBulk: "一括リクエストあたり最大 {max} 件のジョブ",
		upToNReportsCompared:
			"比較できるレポートは最大 {max} 件です。いくつか選択を解除してください",
		upToNReportsPerBulk: "一括リクエストあたり最大 {max} 件のレポート",
		applicationName: "アプリケーション名",
		audioRendition: "音声レンディション",
		backup: "バックアップ",
		bitmovinAccountFromPlan: "プランに含まれる Bitmovin アカウント:",
		couldNotDuplicateInvalidPlan:
			"チャンネル {name} を複製できませんでした。保存されているプランが有効なライブプランではなくなっています。空のフォームから開始します。",
		couldNotDuplicateUnrepresentedOptions:
			"チャンネル {name} を複製できませんでした。プランにフォームで表現できない設定が含まれており、そのまま開くと別のチャンネルになります。空のフォームから開始します。",
		couldNotLoadChannelToDuplicate:
			"複製元のチャンネル {id} を読み込めませんでした。リンクを確認し、再試行してください。",
		countOfLabel: "{label}({count})",
		dashSignalling: "DASH のシグナリング",
		duplicatedFromNamed:
			"「{name}」から複製しました。アカウント・入力・ストリームキーなど必要な項目を修正してから、新しいチャンネルを作成してください。",
		dvrPerLegLabel: "レグ毎のセグメント数",
		dvrLegName: "レグ {n}",
		dvrLegSegments: "{count} セグメント",
		dvrMathMixed:
			"Σ ceil({timeshift}s / segmentLength) を {renditions} レンディション分 = {total} / 約 {budget} 要素",
		dvrMathUniform:
			"ceil({timeshift}s / {segment}s) = {segments} セグメント × {renditions} レンディション = {total} / 約 {budget} 要素",
		dvrMathUniformOne:
			"ceil({timeshift}s / {segment}s) = {segments} セグメント × {renditions} レンディション = {total} / 約 {budget} 要素",
		hlsPlaylistMarkers: "HLS プレイリストマーカー",
		ingestPoint: "Ingest ポイント",
		intervalRequiredFor: "{mode} では間隔が必須です",
		maxInBudgetTimeshift: "このラダーで予算内に収まる最大タイムシフト:",
		modeField: "モード",
		moreInformationFor: "「{label}」の説明",
		nameField: "名前",
		namedNField: "{item} {n} の{field}",
		noDvrWindowHint:
			"DVR 予算は未算定です。タイムシフト空欄は配信サービスの既定値を使用します。正のタイムシフトと有効なセグメント設定で、マニフェスト要素予算(約 {budget} 要素)を見積もります。",
		overBudgetBlocks:
			"約 {budget} 要素の予算を超えています。検証がこのプランをブロックします。タイムシフトを短くする、セグメントを長くする、ラダーを削るなどしてください(値が自動で丸められることはありません)。",
		overBudgetPct: "予算超過 +{pct}%",
		pctOfBudget: "予算の {pct}%",
		recommendedSecTail: "({sec} 秒)。Bitmovin の推奨は 3 時間以内です。",
		removeNamedN: "{item} {n} を削除",
		staticPoint: "静的ポイント",
		videoRendition: "映像レンディション",
	},
	ingest: {
		availableOnceRunning: "— チャンネルが RUNNING になると表示されます —",
		backupListenerN: "バックアップリスナー {n}",
		bitmovinCallsHost: "Bitmovin が {host}:{port} に接続します",
		dynamicIngestPointHint:
			"動的な Ingest ポイント:フェイルオーバーは自動で切り替わります",
		encoderIp: "エンコーダ IP",
		fullRtmpTarget: "RTMP 送信先(完全形)",
		fullRtmpTargetHint:
			"URL とストリームキーを結合したもの(1 つの文字列で指定するプレイヤー / エンコーダ向け)",
		hlsSourceHint: "Bitmovin がこの HLS ソースを取得します",
		hlsSourceUrl: "HLS ソース URL",
		ingestPointNamed: "Ingest ポイント {name}",
		rtmpPushUrl: "RTMP 送信先 URL",
		rtmpPushUrlHint:
			"エンコーダの送信先をここに設定してください。下のストリームキーがストリーム名になります",
		srtCallerHint: "エンコーダはコーラーモードで動作します",
		srtCallerHintWithPassphrase:
			"エンコーダはコーラーモードで動作します。保管庫のパスフレーズと一致させてください",
		srtCallerTarget: "SRT コーラーの接続先(Bitmovin が待ち受け)",
		srtSourceBitmovinCalls: "SRT ソース(Bitmovin が接続)",
		srtSourceHint:
			"このアドレスでエンコーダをリスナーモードで動かしてください。Bitmovin から接続します",
		startRequestStreamKeyHint:
			"開始リクエストのストリームキーです(SRT のパスフレーズではありません)",
		staticIngestPointHint:
			"FQDN 固定の Ingest ポイントです。ストリームキーは StreamKey リソースから取得します",
		staticIngestPointNamed: "静的な Ingest ポイント {name}",
		streamKey: "ストリームキー",
		zixiSource: "Zixi ソース",
		zixiSourceHint:
			"Bitmovin がこの Zixi ブロードキャスタから取得します(資格情報は保管庫から)",
	},
	presetGallery: {
		// Family labels + one title/description pair per SAMPLE_PRESETS name
		// (keys ARE the stable preset names — : core is UI-free, the
		// copy lives here; the gallery's totality test fails on a missing pair).
		family: {
			"ai-scene-analysis": "AI Scene Analysis",
			"audio-only": "音声のみ",
			"dash-timeline": "DASH セグメントタイムライン",
			dolby: "Dolby Vision & Atmos",
			drm: "DRM",
			filters: "フィルタ",
			"fixed-bitrate": "固定ビットレート",
			"forensic-watermark": "フォレンジック・ウォーターマーク",
			hdr10: "HDR10",
			keyframes: "キーフレーム(広告キュー)",
			pertitle: "Per-Title",
			webvtt: "WebVTT 字幕",
		},
		"ai-scene-analysis-batch-item": {
			title: "AI Scene Analysis — バッチランナー項目",
			description:
				"AISA バッチドライバのパラメータ化された1実行分: per-title H264 + アセット記述、HLS+DASH。",
		},
		"ai-scene-analysis-passthrough": {
			title: "AI Scene Analysis — MP4 パススルー",
			description:
				"映像のみの最小 H264 MP4 に、ja/ko 出力付きの AI Scene Analysis アセット記述を添えた構成(エンコーダ BETA)。",
		},
		"ai-scene-analysis-passthrough-test": {
			title: "AI Scene Analysis パススルー(test 実行系)",
			description:
				"test_ スクリプトが実行する AISA パススルーの構造クローン(パスは秘匿化)。",
		},
		"ai-scene-analysis-pertitle": {
			title: "AI Scene Analysis — per-title H264",
			description:
				"自動広告挿入キュータグと多言語 AISA 出力を備えた H264 per-title ラダー、HLS+DASH は post-encoding 生成。",
		},
		"ai-scene-analysis-pertitle-test": {
			title: "AI Scene Analysis per-title(test 実行系)",
			description:
				"test_ スクリプトが実行する per-title AISA の構造クローン(パスは秘匿化)。",
		},
		"audio-only-aac-fmp4-hls-dash": {
			title: "音声のみ AAC → fMP4 HLS+DASH",
			description:
				"映像トラックなしの AAC 専用ラダー — 音声のみの adaptation set と HLS_V6 音声バリアントストリーム。",
		},
		"cenc-cbc-drm-on-aws": {
			title: "CENC cbcs DRM(Widevine+PlayReady+FairPlay)fMP4、DASH+HLS",
			description:
				"5段 H264 ラダー。全 fMP4 muxing を CENC CBC で暗号化し、Widevine PSSH・PlayReady LA-URL・FairPlay iv/uri を搭載(IV は16バイト)。",
		},
		"dash-hls-sftp-output-just-in-time": {
			title: "SFTP オリジン出力 — JIT マニフェスト",
			description:
				"H264+AAC fMP4 を SFTP オリジンへ。HLS+DASH はエンコーディング開始と同時に just-in-time 生成。",
		},
		"dash-hls-sftp-output-post-encoding": {
			title: "SFTP オリジン出力 — post-encoding マニフェスト",
			description:
				"SFTP ペアの POST_ENCODING 側: 同一プランで、マニフェストは FINISHED 後に生成。",
		},
		"dash-template-and-timeline-on-aws": {
			title: "DASH SegmentTemplate と SegmentTimeline の並置",
			description:
				"1つのエンコーディングに2つの DASH マニフェスト — 同じ fMP4 muxing 上の template.mpd(TEMPLATE)と timeline.mpd(TIMELINE)。",
		},
		"deinterlace-filter": {
			title: "デインターレース・フィルタチェーン",
			description:
				"映像ストリームのエンコード前に DEINTERLACE フィルタ(自動判定 META_DATA_AND_CONTENT_BASED)を適用。",
		},
		"dolby-atmos-progressive-mp4": {
			title: "Dolby Atmos → プログレッシブ MP4",
			description:
				"音声のみの Atmos DAMF マスターを単一のプログレッシブ MP4 ダウンロードへ多重化 — マニフェストなし。",
		},
		"dolby-audio-only-atmos-adm": {
			title: "音声のみ Dolby Atmos(ADM)→ HLS+DASH",
			description:
				"ADM BWF Atmos マスターを 448k DOLBY_ATMOS レンディションへ、HLS_V8 音声バリアントストリームと DASH 付き。",
		},
		"dolby-audio-only-atmos-damf": {
			title: "音声のみ Dolby Atmos(DAMF)→ HLS+DASH",
			description:
				"DAMF Atmos マスターを 448k DOLBY_ATMOS レンディションへ、HLS_V8 音声バリアントストリームと DASH 付き。",
		},
		"dolby-dv-3ladder-profile5-dash-ondemand": {
			title: "DV P5 三重ラダー → DASH OnDemand",
			description:
				"3つの兄弟エンコーディングを単一 MP4 の SegmentBase DASH OnDemand マニフェストへ統合(DVH1 サンプルエントリ、HLS なし)。",
		},
		"dolby-dv-atmos-adm": {
			title: "Dolby Vision + Atmos ADM、fMP4 DASH+HLS",
			description:
				"DV メザニン(埋め込みメタデータ)を DOLBY_VISION H265 レンディションへ、ADM Atmos 音声付き。",
		},
		"dolby-dv-atmos-adm-https": {
			title: "Dolby Vision + Atmos ADM(HTTPS 入力)",
			description:
				"DV+ADM フローを S3 でなく認証不要の HTTPS ホスト入力から供給。",
		},
		"dolby-dv-atmos-damf": {
			title: "Dolby Vision + Atmos DAMF、fMP4 DASH+HLS",
			description:
				"DV メザニン(埋め込みメタデータ)を DOLBY_VISION H265 レンディションへ、DAMF Atmos 音声付き。",
		},
		"dolby-dv-atmos-damf-aac": {
			title: "Dolby Vision + Atmos DAMF + AAC フォールバック",
			description:
				"Atmos グループの隣に AAC ラダーを追加 — グループ毎の media エントリを持つ多音声グループ HLS。",
		},
		"dolby-dv-atmos-damf-https": {
			title: "Dolby Vision + Atmos DAMF(HTTPS 入力)",
			description:
				"DV+DAMF フローを S3 でなく認証不要の HTTPS ホスト入力から供給。",
		},
		"dolby-dv-ddp-multi-audio": {
			title: "Dolby Vision + DD+/DD/AAC 多音声",
			description:
				"DV H265 ラダーに、Atmos 由来の DDPLUS・DD・AAC フォールバックを HLS 音声グループと DASH セットへ展開。",
		},
		"dolby-dv-embedded-ddp": {
			title: "Dolby Vision(埋め込みメタデータ)+ DD+",
			description:
				"コンテナ埋め込みメタデータの DV と DDPLUS 5.1 トラック、fMP4 DASH+HLS。",
		},
		"dolby-dv-hdr10-sdr-2ladder-profile81": {
			title: "DV P8.1 + SDR 二重ラダー・マルチエンコーディング",
			description:
				"2つの兄弟エンコーディング(Dolby Vision Profile 8.1 と SDR)を、共有 DASH adaptation set と音声グループ毎バリアントの HLS マスターへ統合(Atmos+AAC)。",
		},
		"dolby-dv-hdr10-sdr-2ladder-profile81-test": {
			title: "DV P8.1 + SDR 二重ラダー(test 実行系)",
			description:
				"test_ スクリプトが実行する二重ラダーの構造クローン(パスは秘匿化)。",
		},
		"dolby-dv-hdr10-sdr-3ladder-profile5-dv-sdr-inputs": {
			title: "DV P5 / HDR10 / SDR 三重ラダー(DV + SDR 入力)",
			description:
				"別々の DV/SDR メザニンから供給される3つの兄弟エンコーディング、マニフェストは post-encoding で統合。",
		},
		"dolby-dv-hdr10-sdr-3ladder-profile5-dv-sdr-inputs-test": {
			title: "DV P5 / HDR10 / SDR 三重ラダー、DV+SDR 入力(test 実行系)",
			description:
				"test_ スクリプトが実行する DV+SDR 入力三重ラダーの構造クローン(パスは秘匿化)。",
		},
		"dolby-dv-hdr10-sdr-3ladder-profile5-single-input": {
			title: "DV P5 / HDR10 / SDR 三重ラダー(単一入力)",
			description:
				"1つの DV メザニンから導出した3つの兄弟エンコーディングを、post-encoding で1組の DASH+HLS マニフェストへ統合。",
		},
		"dolby-dv-hdr10-sdr-3ladder-profile5-single-input-test": {
			title: "DV P5 / HDR10 / SDR 三重ラダー、単一入力(test 実行系)",
			description:
				"test_ スクリプトが実行する単一入力三重ラダーの構造クローン(パスは秘匿化)。",
		},
		"dolby-dv-separated-metadata-adm": {
			title: "Dolby Vision 分離メタデータ + Atmos ADM",
			description:
				"DV 映像に、第2の S3 入力から読む独立 VISION_METADATA XML サイドカーを併用 — 複数入力シナリオ。",
		},
		"fixed-bitrate-dash-hls-streamcondition-on-aws": {
			title: "固定ビットレート DASH+HLS + 音声ガード(AWS S3)",
			description:
				"ガード付き H264+AAC fMP4 ラダー上の HLS と DASH マニフェスト。",
		},
		"fixed-bitrate-dash-hls-streamcondition-on-azure": {
			title: "固定ビットレート DASH+HLS + 音声ガード(Azure Blob)",
			description: "二重マニフェストのガード付きラダーを Azure Blob 入出力で。",
		},
		"fixed-bitrate-dash-hls-streamcondition-thumbnail-on-aws": {
			title: "固定ビットレート DASH+HLS + サムネイル(AWS S3)",
			description:
				"ガード付き二重マニフェストラダーに、ストリーム毎のサムネイル抽出を追加。",
		},
		"fixed-bitrate-dash-hls-streamcondition-thumbnail-on-azure": {
			title: "固定ビットレート DASH+HLS + サムネイル(Azure Blob)",
			description: "サムネイル版を Azure Blob 入出力で。",
		},
		"fixed-bitrate-hls-on-aws": {
			title: "固定ビットレート H264+AAC → HLS(AWS S3)",
			description:
				"定番のスターター: 2段 H264 ラダー + AAC 2トラック、fMP4 セグメント、S3 上の just-in-time HLS マニフェスト1本。",
		},
		"fixed-bitrate-hls-on-azure": {
			title: "固定ビットレート H264+AAC → HLS(Azure Blob)",
			description: "スターターラダーの入出力を S3 でなく Azure Blob に。",
		},
		"fixed-bitrate-hls-streamcondition-on-aws": {
			title: "固定ビットレート HLS + 音声ガード(AWS S3)",
			description:
				"全音声レンディションに Condition(AUDIOSTREAMCOUNT > 0) を付け、無音ソースでは音声出力をスキップ。",
		},
		"fixed-bitrate-hls-streamcondition-on-azure": {
			title: "固定ビットレート HLS + 音声ガード(Azure Blob)",
			description: "AUDIOSTREAMCOUNT ガード版を Azure Blob 入出力で。",
		},
		"fixed-bitrate-hls-vtt-on-aws": {
			title: "fMP4 HLS 上の WebVTT 字幕(AWS S3)",
			description:
				"サイドカー .vtt ファイルストリーム → WEBVTT レンディション → chunked-text muxing + HLS マスターの subtitles media エントリ。",
		},
		"fixed-bitrate-hls-vtt-on-azure": {
			title: "fMP4 HLS 上の WebVTT 字幕(Azure Blob)",
			description: "WebVTT サイドカーチェーンを Azure Blob 入出力で。",
		},
		"hdr10-pertitle": {
			title: "HDR10 per-title(H265 MAIN10 + PQ)",
			description:
				"MAIN10/PQ/BT.2020 とマスタリングメタデータ(master display、MaxCLL/MaxFALL)、per-title autoRepresentations、HLS_V8 + DASH。",
		},
		"keyframes-segment-aligned": {
			title: "広告キュー・キーフレーム — セグメント整合",
			description:
				"広告ブレーク時刻のエンコーディングレベル・キーフレームをセグメント格子上に配置(クリーンカット、セグメント数不変)。",
		},
		"keyframes-segment-non-aligned": {
			title: "広告キュー・キーフレーム — 非整合",
			description:
				"セグメント格子から外れた広告ブレーク・キーフレームで、セグメントを途中分割。",
		},
		"mp4-fixed-bitrate-hls-on-aws": {
			title: "MP4 byte-range HLS(AWS S3)",
			description:
				"レンディション毎に1つのプログレッシブ MP4 を EXT-X-BYTERANGE で列挙 — 非セグメント HLS 経路。",
		},
		"mp4-fixed-bitrate-hls-on-azure": {
			title: "MP4 byte-range HLS(Azure Blob)",
			description: "byte-range HLS 経路を Azure Blob 入出力で。",
		},
		"mp4-fixed-bitrate-hls-vtt-on-aws": {
			title: "MP4 byte-range HLS 上の WebVTT 字幕(AWS S3)",
			description:
				"WebVTT サイドカーチェーンを単一 MP4 byte-range HLS 版の上で。",
		},
		"mp4-fixed-bitrate-hls-vtt-on-azure": {
			title: "MP4 byte-range HLS 上の WebVTT 字幕(Azure Blob)",
			description: "byte-range WebVTT 版を Azure Blob 入出力で。",
		},
		"nexguard-watermarking": {
			title: "NexGuard フォレンジック・ウォーターマーク(A/B 出力)",
			description:
				"映像ストリーム毎の FileMarker OTT ウォーターマークで A/B バリアント出力を生成。ライセンスは保管庫内に留まる。",
		},
		"pertitle-h264-fmp4-ts-dash-hls-on-aws": {
			title: "Per-Title H264 — fMP4+TS 二重レグ、DASH+HLS",
			description:
				"固定解像度ピン付き per-title テンプレート。全レンディションを fMP4(DASH)と TS(HLS)へ、{height}/{bitrate}/{uuid} プレースホルダーパス配下に多重化。",
		},
		"pertitle-h264-fmp4-ts-drm-on-aws": {
			title: "Per-Title H264 + CENC / FairPlay 二重レグ",
			description:
				"per-title H264 ラダー上で、fMP4 レグ(DASH)に CENC、TS レグ(HLS)に FairPlay。",
		},
		"pertitle-h264-mp4-smooth-drm-on-aws": {
			title: "Per-Title H264 → Smooth Streaming + PlayReady",
			description:
				"SMOOTH タイプ MP4 muxing に PlayReady CENC、.ism/.ismc の SmoothStreaming マニフェスト。",
		},
		"pertitle-h264-openapi": {
			title: "Per-Title H264 — 2 系統の配信出力",
			description:
				"プロバイダーの標準的な参照構成を基に、H264 Per-Title ラダーを 2 系統の配信出力へ書き出します。",
		},
		"pertitle-h264-separate-av-inputs": {
			title: "Per-Title H264 — 映像/音声別ソースファイル",
			description:
				"1つの S3 入力から映像のみ/音声のみのファイルが別々の ingest トラックを供給 — 分離 A/V マルチパスシナリオ。",
		},
		"pertitle-h265-fmp4-dash-hls-on-aws": {
			title: "Per-Title H265 — fMP4 DASH+HLS、3パスエンコード",
			description:
				"自動解像度と固定解像度を組み合わせた 7 段の H265 Per-Title ラダー。x265 の詳細設定と 3パスエンコードを使用します。",
		},
		"pertitle-h265-fmp4-drm-on-aws": {
			title: "Per-Title H265 + CENC / FairPlay(fMP4)",
			description:
				"per-title H265 ラダーに CENC(Widevine+PlayReady)と、同じ fMP4 muxing 上の独立 FairPlay レグ。",
		},
		"pertitle-vp9-webm-cenc-drm-on-aws": {
			title: "Per-Title VP9 WebM + Widevine CENC、DASH",
			description:
				"VP9 per-title WebM muxing を CENC(Widevine)で暗号化し、fMP4 音声と並置 — DASH のみ。",
		},
		"pertitle-vp9-webm-fmp4-dash-on-aws": {
			title: "Per-Title VP9 — WebM 映像 + fMP4 音声、DASH",
			description:
				"VP9 per-title WebM muxing と AAC fMP4 音声を DASH 専用マニフェストに。",
		},
	},
	rateCard: {
		label: "ライブ料金カード(JSON)",
		hint: "契約上のライブエンコーディング料金を出力解像度別に記録します — 実行コスト見積もりに使われます。空にするとカードは削除されます。",
		insertExample: "サンプルを挿入",
		exampleBanner: "サンプル値です — 契約の料金に置き換えてください。",
	},
	estimate: {
		invalidDuration: "見積もりには正の分数を入力してください。",
		title: "実行コスト見積もり",
		wizardExplainer:
			"料金カードに基づく仮の実行時間での試算です — 請求額そのものではありません。",
		minutesLabel: "分",
		line: "≈ {total} {currency}({perHour} {currency}/時、ティア ≤{tier}p)",
		noRateCard:
			"料金カードが未設定です — 設定 → Bitmovin で追加すると見積もりが表示されます。",
		noVideoLadder:
			"高さが確定している映像レンディションがないため試算できません。",
		exceedsTiers:
			"ラダー({ladder}p)が料金カードの全ティア(最大 {max}p)を超えています — 見積もり不可。",
		invalidMinutes: "分数は正の数で入力してください。",
		assumeEncodingOnly:
			"エンコーディング分のみ(エグレス/ストレージ/フィーダー除く)",
		assumeNoIncrements: "最低課金単位は考慮しません",
		assumeNullHeights: "自由スケーリングのレンディションはティア選定から除外",
	},
	schedule: {
		upcomingCaption: "今後 7 日間の予約済みスケジュールアクション",
		/* The three times schedule input delivery, program start and channel stop. Channel provisioning and charges begin immediately after creation. */
		enableAtCreation: "入力送出・番組・停止の予定を設定",
		/* Always distinguish scheduled delivery time from encoder startup time. */
		provisionsNote:
			"チャンネルは作成後すぐに起動準備を開始します（入力送出予定時刻まで待機しません）。",
		/* Use the shared provisioning clause so this hint cannot imply that scheduling delays provisioning. */
		disabledHint: `${PROVISIONS_AT_CREATE} — 予定を設定しても起動は後ろ倒しになりません。予定がない場合は、手動停止(または上限)まで動き続けるだけです。以下の項目は後から詳細ページでも設定できます。`,
		streamUpAt: "入力送出予定時刻",
		/* Share the provisioning clause with the ramp hint to keep both statements consistent. */
		streamUpHint: `${PROVISIONS_AT_CREATE} — ここで設定するのは入力送出・番組・停止の予定であり、チャンネルの起動時刻ではありません。入力送出予定時刻は、スケジュールが基準にするフィード開始の予定時刻です。ここまでに入力エンドポイントへ映像を送ってください。スレートを有効にしている場合はこの時刻に挿入され、番組開始まで続きます。作成後から停止完了までが課金対象です。`,
		programStartAt: "番組開始予定時刻",
		programStartHint:
			"番組の開始時刻です。スレートを有効にした場合、ちょうどここまで挿入します。",
		programEndAt: "チャンネル停止予定時刻",
		programEndHint:
			"この時刻にチャンネルを停止します。停止が実行できない場合に備え、導出された強制停止の上限が後ろに控えます。",
		enableSlate: "番組開始までスレートを挿入",
		slateSource: "スレート素材",
		slateSourceHint:
			"ストレージから選択します。チャンネルが稼働中になった後に登録され、起動準備がどれだけ遅れても番組開始予定時刻ちょうどで番組に切り替わります。",
		slatePickPlaceholder: "参照から素材を選択",
		capPreview:
			"強制停止の上限: 予定の停止が実行できなくても {minutes} 分後に停止します。",
		errIncomplete: "3 つの時刻すべてが必要です。",
		errUpAfterStart: "入力送出予定時刻は番組開始予定時刻より後にできません。",
		errEndBeforeStart:
			"チャンネル停止予定時刻は番組開始より後である必要があります。",
		errNoSlateSource:
			"スレート素材を選択するか、スレートをオフにしてください。",
		errZeroSlateWindow:
			"スレートには入力送出予定時刻が番組開始予定時刻より厳密に前である必要があります — 挿入する時間がありません。",
		/* Describe automatic shutdown in terms of its effect: stopping before the planned end. */
		errStreamTimeoutShorterThanSlot:
			"合計稼働時間の自動停止({minutes} 分)が配信枠({slot} 分)より短いため、予定終了前に停止します — その後に予定された停止・スレート・ファイル入力はすべて停止済みのチャンネルへ実行されます。「自動再起動・自動停止」ステップで時間を延ばすか、配信枠を短くしてください。",
		autoShutdownConditionalNote:
			"自動停止 {knobs} は、それでも実行を早く終わらせることがあります — 入力が途切れた場合や一度も接続されない場合の時刻は確定できないため、配信枠との突き合わせは行いません。",
		timelineIncomplete: "3 つの時刻が揃うとタイムラインが描画されます。",
		timelineUnordered:
			"時刻の順序が不正です — 修正するとタイムラインが表示されます。",
		timelineAria: "配信枠: 入力送出 {up}、番組開始 {start}、停止 {end}",
		slateCover: "スレート挿入",
		preAirNoSlate: "番組開始前(スレートなし)",
		programWindow: "番組",
		nowMarker: "現在",
		streamUpShort: "入力送出",
		onAirShort: "番組開始",
		endShort: "停止",
		reviewLine: "予定: 入力送出 {up} · 番組開始 {start} · 停止 {end}{slate}",
		reviewSlateSuffix: " · スレートあり",
		/* Explain these prerequisites before the operator starts sending the input stream. */
		slateNeedsIngest:
			"予約済みのスレートは入力の接続待ちです — スレートは受信中の入力にしか挿入できません。入力エンドポイントへ映像(またはファイル入力)を接続すれば自動で挿入されます。",
		rampHint: `${PROVISIONS_AT_CREATE}。入力送出予定時刻はスレート・停止・実行上限の基準として使われます。起動準備に数分かかり、その後フィードを受け付けます。`,
		slateIngestHint:
			"スレートは接続中の入力に挿入されます — 空のチャンネルには描画できません。入力送出予定時刻までにフィード(またはファイル入力)を接続してください。未接続のままだとスレートは待機し、窓が閉じた時点で未実行 (MISSED) になります。",
		/* File-fed programs have a dedicated pseudo-live screen; this text directs operators there. */
		feederPointer:
			"外部の入力を接続する代わりに、自分のバケットにあるクリップを番組として流す場合は、ファイル入力(擬似ライブ)の画面から作成します。このステップは外部入力の送出予定とそのスレートを設定する場所です。",
		/* Keep reachable action labels only. Upstream switching has two phases and is distinct from provider input preparation and switching. */
		actionFeederStart: "ファイル入力を開始 — スレートループ (FEEDER_START)",
		actionFeederSwitch: "入力素材を切り替え — 番組 (FEEDER_SWITCH)",
		upcomingTitle: "今後の配信予定",
		upcomingEmpty: "今後 7 日間の予定はありません。",
		upcomingAt: "{at} に {action}",
		cancelFailed: "キャンセルに失敗しました: {error}",
		/* Use operator-facing schedule terms instead of worker implementation vocabulary. */
		title: "スケジュールアクション",
		timelineEvents: "スケジュールイベント",
		explainer:
			"予約した時刻に一度だけ実行されます(±30 秒)。遅れすぎた開始・スレートは、終了済みや進行中の番組へ遅れて実行する代わりに未実行になります。停止はどれだけ遅れても必ず実行されます。",
		action: "動作",
		actionStart: "チャンネルを開始 (START)",
		actionStop: "チャンネルを停止 (STOP)",
		actionSlate: "スレートを挿入 (SLATE_IN)",
		fireAt: "実行時刻",
		airAt: "放送開始時刻（デッドライン警報）",
		autoLead: "自動リード（実行時刻を導出）",
		autoLeadExplainer:
			"実行時刻を「放送開始時刻 − この地域の起動時間の実績(上位 90%) − 余裕」で導出します。実績が不足している場合は既定のリードを使います。手入力の実行時刻がそれより早い場合は手入力が優先されます。",
		autoLeadResolvedP90:
			"導出: {at} に起動開始（この地域の起動実績 {n} 件から算出、上位 90% で {p90} 秒 + 余裕）。",
		autoLeadResolvedDefault:
			"導出: {at} に起動開始（データ不足 — 既定リード {lead} 秒）。",
		deadlineMargin: "デッドライン余裕（秒）",
		invalidAirAt: "有効な放送開始時刻を入力してください",
		airAtLine: "放送開始 {at}",
		airAtExplainer:
			"放送開始時刻は任意で、実行時刻とは別物です。実行時刻は開始コマンドを実行する時刻、放送開始は番組がオンエアであるべき時刻。放送開始のマージン（既定 5 分）前までにチャンネルが稼働中でなければ、まだ間に合ううちに警報イベントを 1 回発行します。",
		content: "挿入コンテンツ",
		contentPlaceholder: "READY のコンテンツを選択…",
		contentNoneReady: "このエンコーディングに READY のコンテンツがありません",
		durationSeconds: "再生時間(秒)",
		slateNeedsAccount:
			"スレートのスケジュールにはチャンネルの Bitmovin アカウントが必要です。",
		slateExplainer:
			"スレートは指定時刻に READY の挿入コンテンツを番組へ被せます。コンテンツは現在のエンコーディング上にあります — 下の「コンテンツ挿入」で登録し、READY になるのを待ってください。",
		armButton: "スケジュールを登録",
		arming: "登録中…",
		armFailed: "スケジュールの登録に失敗しました",
		invalidFireAt: "実行時刻を正しく入力してください",
		fireAtPast: "実行時刻は未来を指定してください",
		cancel: "キャンセル",
		upcoming: "予定",
		noneUpcoming: "登録済みのスケジュールアクションはありません。",
		history: "履歴",
		noneHistory: "まだ実行されたものはありません。",
		/* Submission is not confirmed delivery. Feeder startup and provider acceptance require distinct intermediate messages rather than success wording. */
		outcomePending: "実行要求済み — 結果は未確認",
		outcomePushing: "送出中 — プロバイダ側の受信は未確認",
		outcomeIngestConnected:
			"入力接続を確認 — プロバイダがフィードを受信しています",
		outcomeSlateArmed:
			"スレート受付済み — プロバイダが受け付けましたが放映は未確認",
		outcomeDelivered: "実行されました",
		outcomeLegacyUnverified: "従来データ — 配信確認なし",
		outcomeFailed: "実行を要求しましたが実行されませんでした",
		outcomeUnknown: "実行要求済み — 結果を確認できませんでした",
		/* Skipping a reservation for a different broadcast run is a protective outcome, not a failure. */
		statusSkippedStaleGeneration: "見送り — 別の回向けの予約でした",
		/* Localize primary state labels and keep raw enum values secondary. */
		statusArmed: "予約済み",
		statusFired: "実行要求済み",
		statusCompleted: "完了",
		statusCanceled: "取り消し済み",
		statusMissed: "未実行",
		statusError: "エラー",
		// Japanese does not inflect for number; both arms carry the same
		// sentence, exactly as `stoppedSiblingsOne`/`Other` already do.
		outcomesFailedOne: "実行されなかったスケジュール {count} 件",
		outcomesFailedOther: "実行されなかったスケジュール {count} 件",
		/* Distinguish scheduled feeder switching from prepared readiness. */
		switchScheduled: "予定 — 未準備",
		switchStaging: "ソースを準備中",
		switchReady: "切替準備完了",
		/* An ended or missing prepared session cannot be ready and is missed when its scheduled time arrives. */
		switchStageFailed: "準備失敗 — 切替されません",
		switchSeam: "切替ギャップ {ms} ms",
		slateDurationLine: "スレート {seconds} 秒",
		capTitle: "最大実行時間",
		capExplainer:
			"安全上限です。稼働中がこの分数に達するとチャンネルを自動停止します。稼働開始を確認した時点から計測するため、開始の遅延で枠が減ることはありません。空欄 = 上限なし。",
		capLabel: "分",
		capNonePlaceholder: "上限なし",
		capSave: "上限を保存",
		capSaveFailed: "上限の保存に失敗しました",
		/* Show the timeline and upcoming schedule first; registration and fired history are expandable. */
		armDisclose: "予約を追加",
		armDiscloseClose: "予約フォームを閉じる",
		historyDisclose: "実行済み・取り消し済みを表示",
		historyDiscloseClose: "実行済み・取り消し済みを隠す",
		capSummary: "上限 {minutes} 分",
		capNone: "上限なし",
		capInvalid: "上限は 1〜10080 分で指定してください",
		capActiveNote: "現在の実行にも約 30 秒以内に反映されます。",
		nextFire: "次: {action} {time}",
	},
	watch: {
		deleteConfirm: "監視フォルダー「{name}」を削除しますか？",

		title: "監視フォルダ",
		explainer:
			"ホットフォルダのルールです。お客様のバケットのプレフィックスを一覧し、新しいオブジェクトが安定するのを待ってから、FULL_PLAN プリセットでエンコーディングジョブを自動投入します。",
		noWritesPromise:
			"契約事項: このアプリはバケットを一覧するだけです。オブジェクトの書き込み・移動・マーキングは一切行いません — 処理状態はこのアプリ自身のデータベースに保持されます。",
		name: "ルール名",
		location: "監視場所",
		pickLocation: "バケット / プレフィックスを選択…",
		noLocation: "未選択",
		pickLocationFirst:
			"まず監視するバケットとプレフィックスを選択してください。",
		preset: "ジョブテンプレート(FULL_PLAN プリセット)",
		presetPlaceholder: "プリセットを選択…",
		extensions: "拡張子",
		extensionsHint: "カンマ区切りの許可リスト。空欄 = すべてのオブジェクト。",
		outputTemplate: "出力プレフィックステンプレート",
		outputTemplateHint:
			"トークン(波かっこで記述): basename, ext, date, uuid, rule — 出力はオブジェクトごとのプレフィックス配下に書かれます。",
		createButton: "ルールを作成",
		createFailed: "ルールの作成に失敗しました",
		noRules:
			"監視ルールがまだありません — ルールを作るまで新しいオブジェクトは検知されません。",
		enabled: "有効",
		disabled: "無効",
		errorBadge: "スイープエラー",
		countsLine: "投入 {submitted} · 待機 {pending}",
		countsErrorsOne: "エラー {errors}",
		countsErrorsOther: "エラー {errors}",
		reArmConfirm: "本当に再エンコードしますか?もう一度クリック",
		reArmFailed: "再エンコードに失敗しました: {message}",
		redetectConfirmTitle: "このプレフィックス配下を全再検知しますか？",
		redetectConfirmBody:
			"「{name}」はデータリセットで無効化され、エンコード済みオブジェクトの記憶も削除されています。有効化すると配下の全オブジェクトを新規として再検知し、それぞれ課金対象のエンコードを投入します。",
		redetectConfirmEnable: "有効化して再検知",
		lastSweep: "{time} にスイープ",
		neverSwept: "未スイープ",
		objects: "オブジェクト",
		collapse: "閉じる",
		enable: "有効化",
		disable: "無効化",
		delete: "削除",
		noObjects: "このプレフィックスではまだ何も検知されていません。",
		jobLink: "ジョブ: {status}",
		reArm: "再エンコード",
	},
	alerts: {
		/* Rule editing and resolved alert history belong under diagnostics, separately from open alerts. */
		rulesTitle: "アラートルールと解決済み履歴",
		title: "アラート",
		openBannerLineOne:
			"{count} 件のアラートが発火中です — 下のアラート欄を確認してください。",
		openBannerLineOther:
			"{count} 件のアラートが発火中です — 下のアラート欄を確認してください。",
		fetchFailed: "アラートを読み込めませんでした: {message}",
		resolveButton: "解決にする",
		resolveFailed: "解決に失敗しました: {message}",
		deleteCascadeWarning:
			"ルールを削除すると、そのアラート履歴もすべて削除されます(カスケード)。履歴を残す場合は無効化してください。",
		noneOpen: "発火中のアラートはありません。",
		history: "解決済みの履歴",
		noneHistory: "まだ発火していません。",
		openedAt: "{time} に発火",
		addChannelRule: "このチャンネル専用のルールを追加",
		addRuleButton: "チャンネルルールを追加",
		addGlobalRuleButton: "グローバルルールを追加",
		addFailed: "ルールの追加に失敗しました",
		metric: "メトリクス",
		metricInputDisconnected: "入力切断",
		metricHeartbeatStale: "ハートビート停滞",
		metricBitrateBelow: "ビットレート低下",
		metricFpsBelow: "FPS 低下",
		metricProgramStartNoIngest: "番組開始時刻に入力未接続",
		metricOriginManifestStale: "出力マニフェストの停滞",
		metricOriginEndlistPresent: "ライブプレイリストに ENDLIST",
		metricOriginEdgeDelayAbove: "出力遅延がしきい値を超過",
		metricProviderWarning: "エンコーダの警告/エラーイベント",
		providerMessage: "エンコーダのメッセージ",
		subjectIngest: "入力",
		subjectDelivery: "出力",
		provenanceHelp:
			"エンコーダ由来のシグナルはエンコーダ自身の報告に基づきます。出力由来のシグナルは出力先のプレイリストを直接計測したもので、エンコーダの報告と食い違っても独立に成立します。",
		threshold: "しきい値",
		severity: "重大度",
		windowPolls: "ウィンドウ(ポーリング回数)",
		windowLineOne: "{polls} 回",
		windowLineOther: "{polls} 回",
		settingsTitle: "ライブアラートルール",
		settingsExplainer:
			"30 秒のハートビートスイープ内で評価されます — 検知遅延は最低でもスイープ間隔 × ウィンドウです。グローバルルールは全チャンネルに適用され、チャンネル専用ルールは各チャンネルのページから追加します。ルールを削除するとそのアラート履歴も削除されます。",
		noRules:
			"ルールがまだありません — ルールを作るまでアラートは発火しません。",
		scopeGlobal: "グローバル",
		scopeChannel: "チャンネル",
		disabled: "無効",
		enable: "有効化",
		disable: "無効化",
		delete: "削除",
		confirmDelete: "ルールと履歴を削除しますか?",
	},
	zerr: {
		spekeBasicPair: "Basic認証のユーザー名とパスワードを両方指定してください",
		spekeGatewayRegion: "roleArnにはGatewayリージョンが必要です",
		spekeRoleArn: "AWSロール設定にはroleArnが必要です",
		spekeCustomExternalId: "CUSTOMモードにはexternalIdが必要です",
		spekeGeneratedExternalId: "GENERATEDモードではexternalIdを指定できません",
		diagnosticsSrtInputOnly: "srtInputIdはSRT診断でのみ指定できます",
		diagnosticsHttpsDownload:
			"認証情報を含まないHTTPSダウンロードURLを指定してください",

		ociNamespaceCharset: "OCI ネームスペースは小文字の英数字のみです",
		ociRegionShape: "OCI リージョンは ap-osaka-1 のような形式です",
		hostBareHostname:
			"ホストはホスト名のみで指定してください(スキーム・パス・ポート不可)",
		watchRuleName: "ルール名は小文字の英字・数字・ハイフンのみ使用できます",
		watchTemplateToken:
			"テンプレートには basename または uuid トークンが必要です — ないと出力同士が上書きし合います",
		offsetIso8601:
			"offset は ISO 8601 期間で指定してください(例: PT10S、-PT1.500S)",
		binaryRequired: "binary は必須です",
		binaryBase64:
			"binary は base64 エンコードされた SCTE-35 データである必要があります",
		signalsMin: "signal を 1 件以上指定してください",
		inputPathRequired: "inputPath は必須です",
		inputsMin: "input を 1 件以上指定してください",
		// C36 (WP-A1): the two body shapes of a slate registration / preflight.
		inputsOrSource: "inputs と source のどちらか一方だけを指定してください",
		sourceOrInput: "source と input のどちらか一方だけを指定してください",
		streamKeyMin: "手動ストリームキーは 8 文字以上にしてください",
		streamKeyCharset:
			"手動ストリームキーに使えるのは英数字・ドット・アンダースコア・ダッシュのみです",
		subdomainRequired: "subdomain は必須です",
		subdomainMax: "subdomain は 63 文字以内にしてください",
		subdomainCharset: "subdomain に使えるのは小文字英数字とダッシュのみです",
		encodingTemplateRequired: "encodingTemplate は必須です",
		nameRequired: "name は必須です",
		targetPoolSizeMin: "targetPoolSize は 1 以上にしてください",
		targetPoolSizeMax: "targetPoolSize は 100 以下にしてください",
		accessSecretTogether:
			"accessKey と secretKey は両方まとめて指定してください",
		gcsEitherOr:
			"serviceAccountCredentials か、serviceAccountEmail/privateKey/projectId のどちらか一方だけを指定してください — 両方は指定できません",
		gcsAllOfTriple:
			"serviceAccountCredentials を指定するか、serviceAccountEmail・privateKey・projectId の 3 つ全てを指定してください",
		requiredUnlessJson: "serviceAccountCredentials を指定しない場合は必須です",
		customDataTooLarge:
			"customData が大きすぎます(シリアライズ後 {size} 文字。上限 {max} 文字)",
		apiTokenRequired: "API トークンは必須です",
		awsAccountNumberRequired: "AWS アカウント番号は必須です",
		compartmentOcidRequired: "Compartment OCID は必須です",
		encoderVersionRequired: "エンコーダバージョンは必須です",
		networkRequired: "ネットワークは必須です",
		networkNameRequired: "ネットワーク名は必須です",
		resourceGroupIdRequired: "リソースグループ id は必須です",
		securityGroupIdRequired: "セキュリティグループ id は必須です",
		subnetOcidRequired: "Subnet OCID は必須です",
		subnetIdRequired: "サブネット id は必須です",
		subnetNameRequired: "サブネット名は必須です",
		subscriptionIdRequired: "サブスクリプション id は必須です",
		tenancyOcidRequired: "Tenancy OCID は必須です",
		tenantIdRequired: "テナント id は必須です",
		credKeyHex: "16 バイトのコンテンツキーを 32 文字の hex で指定してください",
		credAccessKeyIdRequired: "アクセスキー id は必須です",
		credAccountKeyRequired: "アカウントキーは必須です",
		credAccountNameRequired: "アカウント名は必須です",
		credBucketNameRequired: "バケット名は必須です",
		credHmacAccessKeyRequired: "HMAC アクセスキーは必須です",
		credHmacSecretRequired: "HMAC シークレットは必須です",
		credHostRequired: "ホストは必須です",
		credMslStreamId: "ストリーム ID は正の整数で入力してください",
		credMslEventName: "イベント名は必須です",
		credLabelRequired: "ラベルは必須です",
		credLoginRequired: "ログイン名は必須です",
		credServiceAccountJson:
			"サービスアカウントキー JSON(client_email、private_key)を指定してください",
		credIamRoleArn:
			"IAM ロール ARN(arn:aws:iam::<account>:role/<name>)を指定してください",
		credValidJson: "有効な JSON を指定してください",
		credNamespaceRequired: "Namespace は必須です",
		credNexguardLicenseRequired: "NexGuard ライセンスは必須です",
		credPasswordRequired: "パスワードは必須です",
		credPasswordOrDecryptionKey:
			"password か decryptionKey の少なくとも一方を指定してください",
		credMslDigestBothOrNeither:
			"Digest のユーザー名とパスワードは両方を指定するか、両方とも空にしてください — 片方だけは provisioning 時に Bitmovin から拒否されます",
		credMslEdgeTooLong: "エッジベース URL は 512 文字以内で入力してください",
		credMslEdgeInvalid:
			"エッジベース URL は絶対 https URL(https://ホスト/パス)で入力してください",
		credMslEdgeScheme:
			"エッジベース URL は https を使用してください — 視聴者は TLS 経由でのみストリームを読み込みます",
		credMslEdgeUserinfo:
			"エッジベース URL に認証情報(user:pass@host)を埋め込まないでください — このリンクは全視聴者に配られます",
		credMslEdgeQuery:
			"エッジベース URL にクエリやフラグメントを含めないでください — 署名付き再生 URL ではなく、イベントのルートを指定します",
		credMslEdgeTrailingSlash:
			"エッジベース URL の末尾にスラッシュを付けないでください — マニフェスト名はアプリが付加します",
		credMslEdgePrivateHost:
			"エッジベース URL には公開ホストを指定してください — localhost やプライベート/リンクローカルアドレスには視聴者が到達できません",
		credRegionRequired: "リージョンは必須です",
		credSecretAccessKeyRequired: "シークレットアクセスキーは必須です",
		credUsernameRequired: "ユーザー名は必須です",
		scheduleFeederDerivedOnly:
			"フィーダー行は番組スケジュールが作成時に導出します — 手動 arm はできません",
		scheduleAirAtStartOnly:
			"放送開始デッドラインは START スケジュールにのみ設定できます",
		scheduleAirAtAfterFireAt: "放送開始時刻は発火時刻より後に設定してください",
		scheduleFireAtRequired: "発火時刻は必須です（自動リード導出時を除く）",
		scheduleAutoLeadStartOnly:
			"自動リードは START スケジュールにのみ設定できます",
		scheduleAutoLeadNeedsAirAt: "自動リードには放送開始時刻が必要です",
		scheduleSlateContent:
			"スレートのスケジュールには挿入コンテンツの指定が必要です",
		scheduleSlateDuration: "スレートのスケジュールには再生時間が必要です",
		scheduleSlateAccount:
			"スレートのスケジュールには Bitmovin アカウントの指定が必要です",
		scheduleContentFieldsSlateOnly:
			"コンテンツ関連の項目は SLATE_IN のみで指定できます",
		alertThresholdRequired: "数値系のアラートルールにはしきい値が必要です",
		alertThresholdNotAllowed:
			"しきい値は BITRATE_BELOW と FPS_BELOW でのみ指定できます",
		zTooSmallItemsOne: "1 件以上必要です",
		zTooSmallItems: "{minimum} 件以上必要です",
		zTooBigItemsOne: "1 件以内にしてください",
		zTooBigItems: "{maximum} 件以内にしてください",
		zRequired: "必須です",
		zTooSmallChars: "{minimum} 文字以上で入力してください",
		zTooBigChars: "{maximum} 文字以内で入力してください",
		zTooSmallNumber: "{minimum} 以上を指定してください",
		zTooBigNumber: "{maximum} 以下を指定してください",
		zInvalidType:
			"入力値の型が正しくありません({expected} が必要です。受け取った値: {received})",
		zInvalidFormat: "{detail}(形式が正しくありません)",
	},
} as const satisfies Messages;
