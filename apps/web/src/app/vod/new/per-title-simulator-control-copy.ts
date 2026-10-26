export const perTitleControlCopy = {
	en: {
		auto: "Auto",
		fixed: "Fixed",
		adjustment: "adjustment",
		method: "method",
		unset: "Unset",
		invalid: "Check this setting.",
		inactive: "Not used in this mode",
		stream: "Per-Title settings",
		global: "Per-Title parameters",
		defaults: "Encoder default",
		groups: {
			spacing: "Bitrate spacing",
			analysis: "Analysis and codec factors",
			automatic: "Automatic representations",
			additional: "Additional renditions",
		},
		methods: {
			constraints: "From requirements",
			proportional: "Proportional",
			logarithmic: "Logarithmic",
			default: "Encoder default",
		},
		hints: {
			constraints:
				"Recalculate from the current requirements. Conflicting fixed values are retained.",
			proportional:
				"Scale the loaded value by the change in the overall maximum bitrate.",
			logarithmic:
				"Keep the loaded value's relative position on the logarithmic bitrate scale.",
			default:
				"Leave the optional setting to the encoder. Required bitrate ratios use the documented defaults.",
		},
	},
	ja: {
		auto: "自動",
		fixed: "固定",
		adjustment: "の調整",
		method: "の調整方法",
		unset: "未設定",
		invalid: "設定値を確認してください。",
		inactive: "このモードでは使用しません",
		stream: "Per-Title 設定",
		global: "Per-Title パラメータ",
		defaults: "エンコーダの既定値",
		groups: {
			spacing: "ビットレート間隔",
			analysis: "解析とコーデック係数",
			automatic: "レンディションの自動追加",
			additional: "追加レンディション",
		},
		methods: {
			constraints: "要件から計算",
			proportional: "比例",
			logarithmic: "対数",
			default: "エンコーダの既定値",
		},
		hints: {
			constraints:
				"現在の要件から再計算します。固定値に矛盾があっても勝手に変更しません。",
			proportional:
				"全体の最大ビットレートの変化率を、読み込み時の値に掛けます。",
			logarithmic:
				"読み込み時の値が、対数のビットレート目盛り上で占める位置を保ちます。",
			default:
				"省略できる項目はエンコーダに任せます。必須のビットレート比率には公開された既定値を使います。",
		},
	},
};

const labels = {
	minBitrate: ["Minimum bitrate (kbps)", "最小ビットレート (kbps)"],
	maxBitrate: ["Maximum bitrate (kbps)", "最大ビットレート (kbps)"],
	minBitrateStepSize: ["Minimum bitrate ratio", "ビットレート間隔の下限"],
	maxBitrateStepSize: ["Maximum bitrate ratio", "ビットレート間隔の上限"],
	complexityFactor: ["Complexity factor", "複雑度の係数"],
	resolutionScaleFactor: ["Resolution scale factor", "解像度の調整係数"],
	codecMinBitrateFactor: [
		"Codec minimum bitrate factor",
		"コーデックの最小ビットレート係数",
	],
	codecMaxBitrateFactor: [
		"Codec maximum bitrate factor",
		"コーデックの最大ビットレート係数",
	],
	codecBufsizeFactor: [
		"Codec buffer size factor",
		"コーデックのバッファサイズ係数",
	],
	targetQualityCrf: ["Target quality (CRF)", "目標品質 (CRF)"],
	targetQualityQp: ["Target quality (QP)", "目標品質 (QP)"],
	autoRepresentations: [
		"Automatically add representations",
		"レンディションを自動で追加",
	],
	adoptConfigurationThreshold: [
		"Configuration adoption threshold",
		"設定を採用するしきい値",
	],
	forcedRenditionAboveHighestFixedRepresentation: [
		"Additional rendition count",
		"追加レンディションの本数",
	],
	forcedRenditionAboveHighestFixedRepresentationFactor: [
		"Additional bitrate factor",
		"追加ビットレートの倍率",
	],
	forcedRenditionAboveHighestFixedRepresentationCalculationMode: [
		"Additional bitrate calculation",
		"追加ビットレートの計算方法",
	],
	bitrateSelectionMode: ["Bitrate selection mode", "ビットレートの選択方法"],
	lowComplexityBoundaryForMaxBitrate: [
		"Lower complexity boundary (kbps)",
		"複雑度の下側境界 (kbps)",
	],
	highComplexityBoundaryForMaxBitrate: [
		"Upper complexity boundary (kbps)",
		"複雑度の上側境界 (kbps)",
	],
} as const;

export function perTitleSettingLabel(
	key: string,
	locale: "en" | "ja",
	fallback = key,
) {
	const leaf = key.slice(key.lastIndexOf(".") + 1);
	return leaf in labels
		? labels[leaf as keyof typeof labels][locale === "en" ? 0 : 1]
		: fallback;
}
