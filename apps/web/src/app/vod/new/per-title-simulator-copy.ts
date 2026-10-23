const en = {
	title: "Per-Title simulator",
	description: "Get recommended settings for your ladder requirements.",
	strategy: "What should Per-Title choose?",
	strategies: {
		automatic: "Choose all resolutions and bitrates",
		count: "Choose resolutions and bitrates for a desired rendition count",
		"required-resolutions": "Include required resolutions and choose the rest",
		"fixed-resolutions": "Use specified resolutions and choose bitrates",
		"fixed-ranges": "Use specified resolutions and bitrate ranges",
	},
	codec: "Codec",
	codecHint:
		"Switching codecs loads that codec's settings. Edits are kept separately during this session.",
	global: "Overall bitrate limits",
	globalBitrateMinimum:
		"Use overall limits from 10 to 2,147,483.647 kbps, in whole bps.",
	minimum: "Minimum bitrate (kbps)",
	maximum: "Maximum bitrate (kbps)",
	minimumSlider: "Minimum bitrate slider (kbps)",
	maximumSlider: "Maximum bitrate slider (kbps)",
	automaticSteps:
		"Settings start Fixed. Manual edits keep the other values unchanged; use a suggested adjustment explicitly.",
	automaticRanges:
		"Auto is optional. It follows the selected method; Fixed retains the current value.",
	loadRequirements: "Load requirements file",
	testPresets: "Test presets",
	requirementFiles: "Import or export requirements",
	presetLoaded: "Preset loaded.",
	presetError: "This preset cannot be loaded.",
	saveRequirements: "Download requirements",
	fileHint:
		"Save or load a local JSON file. Loading a file does not change the encoding draft.",
	fileError:
		"This requirements file could not be loaded. Check its format, codec and values.",
	fileLoaded: "Requirements loaded.",
	fileLoading: "Loading requirements…",
	referenceHint:
		"This reference includes template and quality settings. It is available for comparison; applying it to the encoding draft is not supported here.",
	referenceCodecError:
		"Load a file for that codec or open the simulator from its encoding settings. A reference file cannot be converted to another codec here.",
	automaticTemplates: "Automatic templates retained",
	countPolicy: "Rendition count",
	countPolicies: {
		unrestricted: "Let Per-Title choose",
		exact: "Aim for an exact count",
		maximum: "Aim for a maximum count",
	},
	count: "Desired count",
	countHint:
		"Counts are requirements checked here. The API has no total-count parameter.",
	rows: "Required renditions",
	rowsHint:
		"Add a row for each requirement. The same resolution can appear more than once.",
	resolutionCounts: "Requirements by resolution",
	requiredCount: "Required count",
	additionalCapacity: "Additional capacity",
	notEvaluated: "Not evaluated per resolution",
	resolutionCountHint:
		"Required rows are counted by height. The model checks extra capacity across the ladder; it does not calculate a maximum count for each resolution.",
	height: "Height (px)",
	rendition: "rendition",
	add: "Add rendition",
	remove: "Remove",
	removeRendition: "Remove rendition",
	calculationDetails: "Comparison and calculation details",
	recommendation: "Simulation",
	chartView: "Chart view",
	outputView: "Simulated output",
	rangesView: "Allowed ranges",
	comparisonOnly: "Comparison only",
	recommendationReady: "Use these values to review the encoding changes.",
	recommendationConflict: "Needs adjustment",
	recommendationUnknown: "Not established",
	recommendedGlobal: "Overall bitrate range (kbps)",
	recommendedModelCount: "Calculated count limit",
	countCheckScope:
		"The count limit is an arithmetic upper bound at the overall maximum, not a predicted output count.",
	requestedRange: "Specified allowable ranges (kbps)",
	requestedRangeHint:
		"Allowed ranges are proposed automatically. Edited bounds stay fixed. These limits do not predict encoding quality.",
	chosenWithinGlobal: "Chosen within the overall limits",
	modeGuidance: {
		automatic: "Per-Title chooses the resolutions and bitrates.",
		count:
			"Per-Title chooses resolutions and bitrates. The requested count is checked in the model.",
		"required-resolutions":
			"Keep the required resolutions and allow Per-Title to add other renditions.",
		"fixed-resolutions":
			"Use the specified resolutions and let Per-Title choose bitrates.",
		"fixed-ranges":
			"Use the specified resolutions and select bitrates within each specified range.",
	},
	apiParameters: "API parameters",
	minimumRatio: "Minimum bitrate ratio",
	maximumRatio: "Maximum bitrate ratio",
	ratioHint:
		"Ratios describe the bitrate multiplier between neighboring rungs.",
	minimumStepRange: "Minimum-step adjustment range",
	minimumStepRangeHint:
		"A calculated range that retains the same integer placement example and maximum ratio. Boundaries are approximate.",
	automaticCount: "Automatic candidate count",
	automaticCountHint:
		"The candidate count is not the output count. Per-Title selects the resulting renditions.",
	countScope: "Final outputs depend on content analysis.",
	internalCheckDifference:
		"Some internal bitrate placements do not meet the requested count or spacing. The overall-maximum check does not establish every possible output.",
	inactiveTemplateSettings:
		"Automatic candidates retain their attached bitrate settings as source data. These settings do not constrain this mode and are omitted from the proposed API settings.",
	comparison: "Compare settings",
	parameter: "Setting",
	baseline: "Loaded settings",
	adjusted: "Edited settings",
	autoRepresentations: "Automatically add representations",
	enabled: "Enabled",
	disabled: "Disabled",
	apiSettings: "Proposed settings",
	apiHint:
		"These settings are a proposal for the encoding form. No API request is sent here.",
	rowReference: "Rendition",
	unknown: "Not determined",
	conflict: "Conflicting conditions",
	diagnostics: "Conditions to check",
	resolution: "Height (px)",
	finitePositive: "Enter a number greater than zero.",
	positiveInteger: "Enter a whole number greater than zero.",
	empty: "No proposal is available for these conditions.",
	cancel: "Cancel",
	apply: "Review changes",
};

const ja: typeof en = {
	title: "Per-Title シミュレーター",
	description: "必要なラダー構成に合わせて、使う設定を提案します。",
	strategy: "Per-Title に任せる範囲",
	strategies: {
		automatic: "解像度とビットレートをすべて任せる",
		count: "希望する本数を指定し、解像度とビットレートを任せる",
		"required-resolutions": "必須の解像度を指定し、残りを任せる",
		"fixed-resolutions": "解像度をすべて指定し、ビットレートを任せる",
		"fixed-ranges": "解像度と各ビットレートの範囲を指定する",
	},
	codec: "コーデック",
	codecHint:
		"切り替えると、そのコーデックの設定案を読み込みます。検討中の編集内容はコーデックごとに保持します。",
	global: "全体のビットレート範囲",
	globalBitrateMinimum:
		"全体の範囲は10〜2,147,483.647 kbpsです。1 bps単位で指定してください。",
	minimum: "最小ビットレート (kbps)",
	maximum: "最大ビットレート (kbps)",
	minimumSlider: "最小ビットレートのスライダー (kbps)",
	maximumSlider: "最大ビットレートのスライダー (kbps)",
	automaticSteps:
		"初期設定はすべて固定です。手動で変更してもほかの値は変えず、必要な調整は採用するまで提案に留めます。",
	automaticRanges:
		"自動調整も選べます。自動は選んだ方法で計算し、固定は現在の値を保持します。",
	loadRequirements: "要件ファイルを読み込む",
	testPresets: "テスト用プリセット",
	requirementFiles: "要件ファイルの読み書き",
	presetLoaded: "プリセットを読み込みました。",
	presetError: "このプリセットを読み込めませんでした。",
	saveRequirements: "要件ファイルを保存",
	fileHint:
		"ローカルの JSON ファイルに保存・読み込みできます。読み込んだ時点では、エンコードの下書きは変更しません。",
	fileError:
		"要件ファイルを読み込めませんでした。形式・コーデック・入力値を確認してください。",
	fileLoaded: "要件ファイルを読み込みました。",
	fileLoading: "要件ファイルを読み込み中…",
	referenceHint:
		"この参照設定には、テンプレートや品質の設定が含まれています。比較用として読み込み、エンコードの下書きへの反映は行いません。",
	referenceCodecError:
		"そのコーデックの要件ファイルを読み込むか、エンコード設定から開いてください。この画面では、参照ファイルを別のコーデックへ変換できません。",
	automaticTemplates: "保持している自動テンプレート",
	countPolicy: "レンディションの本数",
	countPolicies: {
		unrestricted: "Per-Title に任せる",
		exact: "指定した本数を目指す",
		maximum: "指定した本数以下を目指す",
	},
	count: "希望する本数",
	countHint:
		"本数はこの画面で照合する要件です。API に総本数の指定項目はありません。",
	rows: "必須のレンディション",
	rowsHint:
		"必要なレンディションごとに行を追加します。同じ解像度を複数行に指定できます。",
	resolutionCounts: "解像度ごとの必要本数",
	requiredCount: "必要本数",
	additionalCapacity: "追加できる余地",
	notEvaluated: "解像度ごとには未算出",
	resolutionCountHint:
		"必須の行を高さごとに集計しています。追加の余地はラダー全体で確認し、各解像度の上限本数は算出しません。",
	height: "高さ (px)",
	rendition: "レンディション",
	add: "レンディションを追加",
	remove: "削除",
	removeRendition: "レンディションを削除",
	calculationDetails: "比較・計算の詳細",
	recommendation: "シミュレーション",
	chartView: "グラフの表示",
	outputView: "想定出力",
	rangesView: "許容範囲",
	comparisonOnly: "比較専用",
	recommendationReady:
		"この値を使って、エンコード設定への変更内容を確認できます。",
	recommendationConflict: "要調整",
	recommendationUnknown: "未確定",
	recommendedGlobal: "全体のビットレート範囲 (kbps)",
	recommendedModelCount: "計算上の本数上限",
	countCheckScope:
		"全体の上限ビットレートでの、計算上の配置上限です。出力本数の予測値ではありません。",
	requestedRange: "指定した許容範囲 (kbps)",
	requestedRangeHint:
		"許容範囲は自動で提案し、手動で変更した端点は固定します。画質を予測した値ではありません。",
	chosenWithinGlobal: "全体の範囲内で選択",
	modeGuidance: {
		automatic: "解像度とビットレートはPer-Titleが選びます。",
		count:
			"解像度とビットレートはPer-Titleが選び、希望する本数をモデルで照合します。",
		"required-resolutions":
			"必須の解像度を残し、ほかのレンディションの追加をPer-Titleに任せます。",
		"fixed-resolutions":
			"指定した解像度で、ビットレートをPer-Titleに任せます。",
		"fixed-ranges":
			"指定した解像度で、各段の範囲内からビットレートを選びます。",
	},
	apiParameters: "APIパラメータ",
	minimumRatio: "最小ビットレート比率",
	maximumRatio: "最大ビットレート比率",
	ratioHint: "隣り合う段のビットレートを何倍離すかを表します。",
	minimumStepRange: "最小ビットレート間隔の調整範囲",
	minimumStepRangeHint:
		"同じ整数の配置例と最大比率を維持する、計算上の範囲です。境界は概数です。",
	automaticCount: "自動生成の候補数",
	automaticCountHint:
		"候補数は出力本数ではありません。実際のレンディションはPer-Titleが選びます。",
	countScope: "実際の出力は素材解析で決まります。",
	internalCheckDifference:
		"一部の検算では、本数や間隔が希望どおりになりません。全体の上限での確認は、すべての出力条件を満たすことを示すものではありません。",
	inactiveTemplateSettings:
		"自動生成の候補に付いたビットレート設定は元データとして保持します。このモードの制約には使われず、APIへの設定案には含めません。",
	comparison: "読み込み時との比較",
	parameter: "設定項目",
	baseline: "読み込んだ設定",
	adjusted: "変更後の設定",
	autoRepresentations: "レンディションの自動追加",
	enabled: "有効",
	disabled: "無効",
	apiSettings: "提案する設定",
	apiHint:
		"エンコード設定へ反映するための提案です。この画面では API リクエストを送信しません。",
	rowReference: "レンディション",
	unknown: "未確定",
	conflict: "条件が競合しています",
	diagnostics: "確認が必要な条件",
	resolution: "高さ (px)",
	finitePositive: "0 より大きい数値を入力してください。",
	positiveInteger: "1 以上の整数を入力してください。",
	empty: "この条件の設定案はありません。",
	cancel: "キャンセル",
	apply: "差分を確認",
};

export type PerTitleSimulatorCopy = typeof en;
export const perTitleSimulatorCopy = { en, ja };
