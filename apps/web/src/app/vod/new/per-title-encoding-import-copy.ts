export const encodingImportCopy = {
	en: {
		title: "Load from Encoding ID",
		saved: "Use a saved account",
		temporary: "Use a temporary API key",
		account: "Bitmovin account",
		chooseAccount: "Select an account",
		loadingAccounts: "Loading accounts…",
		accountsError:
			"Accounts could not be loaded. Try again or use a temporary API key.",
		noAccounts: "No saved accounts. You can use a temporary API key.",
		key: "API key",
		tenant: "Tenant Organization ID (optional)",
		encoding: "Encoding ID",
		fetch: "Fetch settings",
		fetching: "Fetching settings…",
		load: "Load selected settings",
		cancel: "Cancel",
		invalidInput:
			"Enter an Encoding ID and select an account or enter an API key.",
		failed:
			"Settings could not be fetched. Check the Encoding ID and access permissions, then try again.",
		forbidden:
			"An administrator must load these settings. Sign in with an administrator account.",
		changed:
			"The editing context changed. Fetch the settings again before loading them.",
		invalidResponse:
			"The returned settings cannot be loaded. No changes were made.",
		empty: "No settings can be loaded from this encoding.",
		select: "Select codecs to load",
		count:
			"Output count remains unspecified. Loading does not change the encoding draft.",
		streams: (count: number) => `${count} Stream templates`,
		stepInitialValues: (values: string) =>
			`Simulator initial values for unspecified settings: ${values}. This does not identify the API defaults or the source job's effective values.`,
		issues: {
			NO_PER_TITLE_CONFIGURATION: "No Per-Title configuration was found.",
			UNSUPPORTED_CODEC: "This codec is unavailable in this simulator session.",
			UNSUPPORTED_GLOBAL_SETTINGS:
				"Some encoding-level settings are unsupported.",
			UNSUPPORTED_STREAM_SETTINGS: "Some Stream settings are unsupported.",
			MISSING_BITRATE_LIMITS: "Required bitrate limits are missing.",
			INVALID_CONFIGURATION: "These settings cannot be loaded faithfully.",
			TOO_MANY_TEMPLATES:
				"The number of templates exceeds the simulator limit.",
			MISSING_CODEC_CONFIGURATION: "The codec configuration is unavailable.",
		},
	},
	ja: {
		title: "Encoding IDから読み込む",
		saved: "登録済みアカウントを使う",
		temporary: "一時APIキーを使う",
		account: "Bitmovinアカウント",
		chooseAccount: "アカウントを選択",
		loadingAccounts: "アカウントを読み込み中…",
		accountsError:
			"アカウントを読み込めませんでした。やり直すか、一時APIキーを使ってください。",
		noAccounts: "登録済みアカウントはありません。一時APIキーを使えます。",
		key: "APIキー",
		tenant: "Tenant Organization ID（任意）",
		encoding: "Encoding ID",
		fetch: "設定を取得",
		fetching: "設定を取得中…",
		load: "選択した設定を読み込む",
		cancel: "キャンセル",
		invalidInput: "Encoding IDと、アカウントまたはAPIキーを指定してください。",
		failed:
			"設定を取得できませんでした。Encoding IDとアクセス権限を確認して、やり直してください。",
		forbidden:
			"設定の読み込みには管理者権限が必要です。管理者のアカウントで実行してください。",
		changed:
			"編集中の設定が変わりました。もう一度取得してから読み込んでください。",
		invalidResponse:
			"取得した設定を読み込めません。編集中の値は変更していません。",
		empty: "このエンコードから読み込める設定はありません。",
		select: "読み込むコーデック",
		count: "出力本数は未指定で読み込みます。元のジョブ下書きは変更しません。",
		streams: (count: number) => `Streamテンプレート ${count}件`,
		stepInitialValues: (values: string) =>
			`未指定の項目はシミュレーターの初期値（${values}）で開きます。API既定値や元ジョブの実効値を示すものではありません。`,
		issues: {
			NO_PER_TITLE_CONFIGURATION: "Per-Title設定が見つかりません。",
			UNSUPPORTED_CODEC:
				"このコーデックは、現在のシミュレーターでは使えません。",
			UNSUPPORTED_GLOBAL_SETTINGS:
				"エンコード全体に未対応の設定項目があります。",
			UNSUPPORTED_STREAM_SETTINGS: "Streamに未対応の設定項目があります。",
			MISSING_BITRATE_LIMITS: "必要なビットレートの上下限がありません。",
			INVALID_CONFIGURATION: "元の値を保ったまま読み込めない設定です。",
			TOO_MANY_TEMPLATES:
				"テンプレート数がシミュレーターの上限を超えています。",
			MISSING_CODEC_CONFIGURATION: "コーデック設定を取得できません。",
		},
	},
};
