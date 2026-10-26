import type { PerTitleGoal, PerTitleProposal } from "@bitovp/core";
import {
	getPerTitleGoalSetting,
	getPerTitleSetting,
	type PerTitleSettingField,
	type PerTitleSettingValue,
	perTitleGlobalFields,
	perTitleStreamFields,
} from "./per-title-simulator-tuning";

export type PerTitleDependencyAssessment = {
	scope: "global" | "stream";
	key: string;
	rowId?: string;
	value: number | string | boolean | undefined;
	status:
		| "active"
		| "inactive"
		| "no-effect"
		| "media-dependent"
		| "unverified"
		| "unset";
	dependencies: readonly string[];
	explanation: { en: string; ja: string };
	sourceUrl: string;
};

type Detail = Pick<
	PerTitleDependencyAssessment,
	"status" | "dependencies" | "explanation" | "sourceUrl"
>;
type ApiStream = PerTitleProposal["api"]["streams"][number];
const sdk =
	"https://github.com/bitmovin/bitmovin-api-sdk-javascript/blob/v1.285.0/src/models/";
const rule = "fixedResolutionAndBitrateConfiguration.";
const forcedCount = `${rule}forcedRenditionAboveHighestFixedRepresentation`;
const forcedFactor = `${forcedCount}Factor`;
const forcedMode = `${forcedCount}CalculationMode`;
const threshold = "autoRepresentations.adoptConfigurationThreshold";
const globalInventory = [
	...new Set([
		...perTitleGlobalFields("H264").map(({ key }) => key),
		...perTitleGlobalFields("H265V2").map(({ key }) => key),
	]),
];
const streamInventory = perTitleStreamFields("H264").map(({ key }) => key);

const detail = (
	status: Detail["status"],
	dependencies: readonly string[],
	en: string,
	ja: string,
	model = "PerTitleConfiguration",
): Detail => ({
	status,
	dependencies,
	explanation: { en, ja },
	sourceUrl: `${sdk}${model}.ts`,
});
const codecModel = (goal: PerTitleGoal) =>
	`${goal.codec === "VP9" ? "Vp9" : goal.codec === "AV1" ? "Av1" : goal.codec}PerTitleConfiguration`;
const valueStatus = (value: PerTitleSettingValue, status: Detail["status"]) =>
	value === undefined ? "unset" : status;
const fixedMode = (stream: ApiStream | undefined) =>
	stream?.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION" ||
	stream?.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE";

function globalValue(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
	key: string,
) {
	if (key === "autoRepresentations")
		return proposal.api.global.autoRepresentations !== undefined
			? true
			: getPerTitleGoalSetting(goal, "global", key);
	return (
		getPerTitleSetting(proposal, "global", key) ??
		getPerTitleGoalSetting(goal, "global", key)
	);
}

function globalDetail(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
	key: string,
	value: PerTitleSettingValue,
): Detail {
	const status = (active: Detail["status"] = "active") =>
		valueStatus(value, active);
	const qualityKey =
		goal.codec === "H265V2" ? "targetQualityQp" : "targetQualityCrf";
	if (key === "minBitrate" || key === "maxBitrate")
		return detail(
			status(),
			[
				key === "minBitrate" ? "maxBitrate" : "minBitrate",
				"stream.minBitrate",
				"stream.maxBitrate",
				"minBitrateStepSize",
				"maxBitrateStepSize",
			],
			"Sets the ordinary ladder target range. Row bounds and spacing must fit together; a maximum target does not establish measured video bitrate, codec maxrate or quality.",
			"通常ラダーの目標ビットレート範囲です。各行の範囲と段間隔との整合が必要です。目標の上限だけでは実測映像ビットレート、codec maxrate、品質は確定しません。",
		);
	if (key === "minBitrateStepSize" || key === "maxBitrateStepSize")
		return detail(
			status(),
			[
				"minBitrate",
				"maxBitrate",
				key === "minBitrateStepSize"
					? "maxBitrateStepSize"
					: "minBitrateStepSize",
				"stream.minBitrate",
				"stream.maxBitrate",
				forcedCount,
			],
			"Constrains ratios between ordinary neighbouring rungs and affects feasible counts and gap filling. Forced additions have their own factor; spacing is not a provider count guarantee.",
			"通常の隣接段の比率を制約し、配置可能本数と隙間の補完に影響します。強制追加には別の倍率があり、段間隔だけではproviderの出力本数を保証しません。",
		);
	if (key === "targetQualityCrf" || key === "targetQualityQp") {
		const av1Default = goal.codec === "AV1" && value === undefined;
		return detail(
			status("media-dependent"),
			[
				"codec",
				"input.frameRate",
				"input.resolution",
				"input.dynamicRangeFormat",
				"complexityFactor",
				"resolutionScaleFactor",
			],
			av1Default
				? "When omitted, AV1 target CRF depends on frame rate, resolution and dynamic range. Keep it unset to retain that provider default; an optimal quality value requires media analysis."
				: "Controls the quality probe used for content analysis. CRF and QP are different controls; the appropriate value and resulting top target require media analysis and quality measurements. An omitted value retains the provider default.",
			av1Default
				? "未指定時のAV1目標CRFはフレームレート、解像度、ダイナミックレンジに依存します。provider既定値を使う場合は未指定を維持します。最適な品質値には素材分析が必要です。"
				: "素材分析の品質probeを制御します。CRFとQPは異なる制御です。適切な値と最上段の目標値には素材分析と品質測定が必要です。未指定ならprovider既定値を維持します。",
			codecModel(goal),
		);
	}
	if (key === "complexityFactor")
		return detail(
			status("media-dependent"),
			[
				qualityKey,
				"resolutionScaleFactor",
				"input.content",
				"maxBitrate",
				"stream.lowComplexityBoundaryForMaxBitrate",
				"stream.highComplexityBoundaryForMaxBitrate",
			],
			"Scales assumed content complexity. Above 1 favours smaller resolutions at a given bitrate and a higher top target; below 1 reverses that direction. A suitable factor cannot be inferred from the cap or desired count alone.",
			"想定する素材複雑度を調整します。1より大きいと同じビットレートで低い解像度と高い最上段目標を選びやすくなり、1未満は逆方向です。上限や希望本数だけから適切な倍率は求められません。",
		);
	if (key === "resolutionScaleFactor")
		return detail(
			status("media-dependent"),
			[
				qualityKey,
				"complexityFactor",
				"input.content",
				"input.resolution",
				"stream.mode",
			],
			"Biases resolution selection from -15 to +15, with provider default 0. Positive values favour higher resolutions and negative values lower resolutions. Bitrate selection can also change; this is not a direct top-bitrate multiplier or proof of better quality.",
			"解像度選択を-15から+15で調整し、provider既定値は0です。正は高解像度、負は低解像度を選びやすくします。ビットレート選択も変わり得ますが、最上段ビットレートの直接倍率や品質向上の証明ではありません。",
		);
	if (key === "autoRepresentations")
		return detail(
			status(),
			[
				threshold,
				"input.resolution",
				"stream.mode",
				"stream.width",
				"stream.height",
			],
			value === false
				? "Automatic resolution-template generation is disabled. Existing templates and ordinary ladder expansion can still produce multiple outputs; this does not establish an exact count."
				: "Enables automatic resolution-template generation when supplied. Available templates, input dimensions and adoption rules affect the result; an omitted object retains the provider's disabled/default behavior and is not materialized here.",
			value === false
				? "解像度テンプレートの自動生成は無効です。既存テンプレートと通常ラダーの展開から複数出力が生じる場合があり、これだけで本数は確定しません。"
				: "指定すると解像度テンプレートの自動生成を有効にします。テンプレート、入力寸法、設定継承規則が結果に影響します。未指定のprovider動作を維持し、ここでは既定値を補完しません。",
		);
	if (key === threshold)
		return detail(
			globalValue(goal, proposal, "autoRepresentations") === true
				? status()
				: "inactive",
			["autoRepresentations", "stream.width", "stream.height"],
			"Used only while automatic templates are enabled. Values near 0 favour settings from the higher template, near 1 the lower template. It selects inherited configuration, not a bitrate or output count.",
			"テンプレート自動生成が有効なときだけ使います。0寄りは上位、1寄りは下位テンプレートの設定を継承しやすくします。継承設定の選択であり、ビットレートや出力本数の指定ではありません。",
			"AutoRepresentation",
		);
	if (key.startsWith(rule)) {
		const countValue = globalValue(goal, proposal, forcedCount);
		const enabled = typeof countValue === "number" && countValue > 0;
		const possible = proposal.api.streams.some(fixedMode);
		return detail(
			!possible || (key !== forcedCount && !enabled)
				? "inactive"
				: status(enabled ? "media-dependent" : "active"),
			[
				"stream.mode",
				...(key === forcedCount ? [forcedFactor, forcedMode] : [forcedCount]),
				"maxBitrate",
				"stream.minBitrate",
				"stream.maxBitrate",
			],
			"Applies to additions above a highest fixed representation, subject to the provider's calculated result. Count, base-calculation mode, factor and rounding interact; factor and mode are inactive without a positive count. This is not a below-lowest policy or a universal count guarantee.",
			"最上位の固定representationより上への追加に適用し、providerの計算結果が条件になります。本数、基準値計算方式、倍率、丸めが相互作用します。正の追加本数がなければ倍率と方式は無効です。最下段より下の追加規則や常時の本数保証ではありません。",
			"PerTitleFixedResolutionAndBitrateConfiguration",
		);
	}
	if (key === "codecMinBitrateFactor" && goal.codec === "H264")
		return detail(
			status("no-effect"),
			["codec"],
			"The pinned SDK explicitly documents that the H264 minimum-bitrate factor has no impact. It cannot make the ladder reach its upper target or establish a minimum measured bitrate.",
			"固定したSDKはH264の最小ビットレート倍率に効果がないと明記しています。ラダーを上限目標へ到達させたり、実測ビットレートの下限を保証したりする用途には使えません。",
			codecModel(goal),
		);
	if (key === "codecMinBitrateFactor" && goal.codec === "H265V2")
		return detail(
			status("unverified"),
			["codec", "generated.targetBitrate", "encoder.version"],
			"The H265V2 field is exposed by the pinned SDK. Its effect in the selected encoder version has not been verified; do not use it as a ladder-count, upper-target or measured-quality certificate.",
			"固定したSDKにはH265V2のこのフィールドがあります。選択したencoder版での効果は未確認のため、ラダー本数、上限目標への到達、実測品質の証明には使えません。",
			codecModel(goal),
		);
	if (key === "codecMinBitrateFactor")
		return detail(
			status(),
			["codec", "generated.targetBitrate"],
			"Derives the generated codec minimum bitrate from its target bitrate times this factor. This does not change the ladder target interval or guarantee a measured minimum bitrate; the SDK has no corresponding per-stream minimum-factor field.",
			"生成codecの最小ビットレートを目標ビットレート×この倍率で求めます。ラダー目標範囲の変更や実測ビットレート下限の保証ではありません。SDKに対応するstream単位の最小倍率フィールドはありません。",
			codecModel(goal),
		);
	const streamOverrideSupported =
		goal.codec === "H264" || goal.codec === "H265";
	const overrides = streamOverrideSupported
		? proposal.api.streams.filter(
				(stream) =>
					stream.perTitleSettings?.[
						key as "codecMaxBitrateFactor" | "codecBufsizeFactor"
					] !== undefined,
			).length
		: 0;
	const allOverridden =
		proposal.api.streams.length > 0 &&
		overrides === proposal.api.streams.length;
	return detail(
		allOverridden ? "inactive" : status(),
		[
			"codec",
			"generated.targetBitrate",
			...(streamOverrideSupported ? [`stream.${key}`] : []),
		],
		`Calculates generated codec rate-control values as target bitrate times this factor, not a new ladder target or a measured bitrate guarantee. Stream overrides apply to ${overrides} of ${proposal.api.streams.length} configured templates; the global value is a fallback for the others.`,
		`生成codecのレート制御値を目標ビットレート×この倍率で計算します。新しいラダー目標や実測ビットレートの保証ではありません。${proposal.api.streams.length}テンプレート中${overrides}個にstream上書きがあり、global値は残りの既定値になります。`,
		codecModel(goal),
	);
}

function streamDetail(
	stream: ApiStream | undefined,
	key: string,
	value: PerTitleSettingValue,
): Detail {
	const factor =
		key === "codecMaxBitrateFactor" || key === "codecBufsizeFactor";
	if (factor)
		return detail(
			!stream ||
				(value !== undefined && stream.perTitleSettings?.[key] === undefined)
				? "inactive"
				: valueStatus(value, "active"),
			["codec", "generated.targetBitrate", `global.${key}`],
			"When emitted, this stream value overrides the global factor and derives codec rate-control values from the generated target bitrate. A parked value on an omitted stream/setting is inactive. When unset, global or codec configuration applies; measured bitrate and quality still require media.",
			"送出するとこのstreamの値がglobal倍率を上書きし、生成された目標ビットレートからcodecのレート制御値を求めます。省略したstream・設定の保存値は無効です。未指定ならglobalまたはcodec設定を使います。実測ビットレートと品質には素材が必要です。",
			"StreamPerTitleSettings",
		);
	const fixed =
		stream?.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE";
	const settings = stream?.perTitleSettings;
	const boundary =
		key === "lowComplexityBoundaryForMaxBitrate" ||
		key === "highComplexityBoundaryForMaxBitrate";
	const boundsPresent =
		settings?.minBitrate !== undefined && settings.maxBitrate !== undefined;
	const active =
		fixed &&
		(!boundary ||
			(settings?.bitrateSelectionMode === "COMPLEXITY_RANGE" && boundsPresent));
	const emitted =
		settings?.[key as keyof NonNullable<ApiStream["perTitleSettings"]>];
	return detail(
		!active || (value !== undefined && emitted === undefined)
			? "inactive"
			: valueStatus(
					value,
					key === "minBitrate" || key === "maxBitrate"
						? "active"
						: "media-dependent",
				),
		[
			"stream.mode",
			"global.minBitrate",
			"global.maxBitrate",
			"global.minBitrateStepSize",
			...(boundary
				? [
						"stream.bitrateSelectionMode",
						"stream.minBitrate",
						"stream.maxBitrate",
						"stream.lowComplexityBoundaryForMaxBitrate",
						"stream.highComplexityBoundaryForMaxBitrate",
						"analysis.topBitrate",
					]
				: [
						"stream.minBitrate",
						"stream.maxBitrate",
						"stream.bitrateSelectionMode",
					]),
		],
		boundary
			? "A complexity boundary is effective only in fixed-resolution-and-bitrate mode with COMPLEXITY_RANGE and both emitted bitrate bounds. It maps an analysis-derived top bitrate into the row's target interval; spacing can relax the selected interval. The actual driver requires media analysis."
			: "These row constraints apply only in fixed-resolution-and-bitrate mode. OPTIMIZED chooses within the interval using media analysis; COMPLEXITY_RANGE also uses both complexity boundaries. Values parked outside the emitted mode/settings are inactive.",
		boundary
			? "複雑度境界は固定解像度・ビットレートmodeでCOMPLEXITY_RANGEと送出する両ビットレート境界が揃った場合だけ有効です。分析から得る最上段ビットレートを行の目標範囲へ対応させ、段間隔により範囲を緩和する場合があります。実際の基準値には素材分析が必要です。"
			: "この行の制約は固定解像度・ビットレートmodeでだけ有効です。OPTIMIZEDは素材分析から範囲内の値を選び、COMPLEXITY_RANGEは両複雑度境界も使います。送出mode・設定から外れた保存値は無効です。",
		"StreamPerTitleFixedResolutionAndBitrateSettings",
	);
}

function invalidValue(
	field: PerTitleSettingField,
	value: PerTitleSettingValue,
) {
	if (value === undefined) return false;
	if (field.kind === "number" || field.kind === "bitrate") {
		if (typeof value !== "number" || !Number.isFinite(value)) return true;
		if (field.integer && !Number.isSafeInteger(value)) return true;
		if (field.minimum !== undefined && value < field.minimum) return true;
		if (field.maximum !== undefined && value > field.maximum) return true;
		if (
			(field.key.endsWith("Factor") && field.key !== "resolutionScaleFactor") ||
			field.key.endsWith("StepSize")
		)
			return value <= (field.key.endsWith("StepSize") ? 1 : 0);
	}
	return false;
}

/** Describes current settings and their dependencies without choosing quality settings. */
export function assessPerTitleDependencies(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
): PerTitleDependencyAssessment[] {
	const result: PerTitleDependencyAssessment[] = [];
	const assess = (
		scope: "global" | "stream",
		key: string,
		value: PerTitleSettingValue,
		fields: readonly PerTitleSettingField[],
		stream?: ApiStream,
		rowId?: string,
	) => {
		const field = fields.find((item) => item.key === key);
		let assessment =
			scope === "global"
				? globalDetail(goal, proposal, key, value)
				: streamDetail(stream, key, value);
		if (!field)
			assessment = detail(
				"unverified",
				["codec", "encoder.version"],
				"This supplied field is outside the supported controls for this codec in the pinned SDK contract. Its effect has not been verified and it is excluded from static outcome guarantees.",
				"指定されたフィールドは固定したSDK契約に基づくこのcodecの対応操作範囲外です。効果は未確認であり、静的な結果保証には含めません。",
				scope === "global" ? codecModel(goal) : "StreamPerTitleSettings",
			);
		else if (invalidValue(field, value))
			assessment = {
				...assessment,
				status: "unverified",
				explanation: {
					en: "The supplied value is outside this control's valid type or range. Resolve the input diagnostics before relying on its effect.",
					ja: "指定値がこの操作の有効な型または範囲から外れています。効果を判断する前に入力診断を解消してください。",
				},
			};
		result.push({
			scope,
			key,
			...(rowId === undefined ? {} : { rowId }),
			value,
			...assessment,
		});
	};
	const globals = perTitleGlobalFields(goal.codec);
	for (const key of new Set([
		...globals.map((item) => item.key),
		...globalInventory.filter(
			(key) => globalValue(goal, proposal, key) !== undefined,
		),
	]))
		assess("global", key, globalValue(goal, proposal, key), globals);
	const streams = perTitleStreamFields(goal.codec);
	const rowIds = new Set([
		...proposal.api.streams.map((stream) => stream.rowId),
		...(goal.rows ?? []).map((row) => row.id),
		...(goal.automaticTemplates ?? []).map((row) => row.id),
	]);
	for (const rowId of rowIds) {
		const stream = proposal.api.streams.find((item) => item.rowId === rowId);
		const read = (key: string) =>
			getPerTitleSetting(proposal, "stream", key, rowId) ??
			getPerTitleGoalSetting(goal, "stream", key, rowId);
		for (const key of new Set([
			...streams.map((item) => item.key),
			...streamInventory.filter((key) => read(key) !== undefined),
		]))
			assess("stream", key, read(key), streams, stream, rowId);
	}
	return result;
}
