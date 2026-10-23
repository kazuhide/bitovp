import {
	certifyComplexityIntervals,
	evaluateComplexityRange,
	evaluateForcedRenditions,
	type PerTitleGoal,
	type PerTitleProposal,
	resolvePerTitleAnalysis,
} from "@bitovp/core";
import {
	getPerTitleGoalSetting,
	getPerTitleSetting,
	type PerTitleSettingField,
	perTitleGlobalFields,
	perTitleStreamFields,
} from "./per-title-simulator-tuning";
import { assessPerTitleUpperLimit } from "./per-title-simulator-upper-limit";

type Field = { scope: "global" | "stream"; key: string; rowId?: string };
export type PerTitleValidityFinding = {
	code: string;
	severity: "conflict" | "warning" | "info";
	message: { en: string; ja: string };
	fields?: Field[];
};
type Stream = PerTitleProposal["api"]["streams"][number];
type Global = PerTitleProposal["api"]["global"];
type Add = (
	code: string,
	severity: PerTitleValidityFinding["severity"],
	en: string,
	ja: string,
	fields?: Field[],
) => void;

const RATE_MAX = 2_147_483_647;
const RULE = "fixedResolutionAndBitrateConfiguration.";
const COUNT = "forcedRenditionAboveHighestFixedRepresentation";
const FACTOR = `${COUNT}Factor`;
const MODE = `${COUNT}CalculationMode`;
const LOW = "lowComplexityBoundaryForMaxBitrate";
const HIGH = "highComplexityBoundaryForMaxBitrate";
const CODECS = ["H264", "H265", "H265V2", "VP9", "AV1"] as const;
const FIXED = "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE";
const MODES = new Set([
	"PER_TITLE_TEMPLATE",
	"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
	FIXED,
]);
const globalField = (key: string): Field => ({ scope: "global", key });
const streamField = (rowId: string, key: string): Field => ({
	scope: "stream",
	rowId,
	key,
});
const globals = (...keys: string[]) => keys.map(globalField);
const streams = (rowId: string, ...keys: string[]) =>
	keys.map((key) => streamField(rowId, key));
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number =>
	finite(value) && value > 0;
const rate = (value: unknown): value is number =>
	positive(value) && Number.isSafeInteger(value) && value <= RATE_MAX;

function complexityDomain(global: Global, configured: Stream[]) {
	const api = { global, streams: configured };
	const minimum = resolvePerTitleAnalysis(
		api,
		global.minBitrate,
	).complexityInput;
	const maximum = resolvePerTitleAnalysis(
		api,
		global.maxBitrate,
	).complexityInput;
	return minimum !== null && maximum !== null && minimum <= maximum
		? { minimum, maximum }
		: null;
}

const globalInventory = [
	...new Map(
		CODECS.flatMap((codec) => perTitleGlobalFields(codec)).map((field) => [
			field.key,
			field,
		]),
	).values(),
];
const streamInventory = [
	...new Map(
		CODECS.flatMap((codec) => perTitleStreamFields(codec)).map((field) => [
			field.key,
			field,
		]),
	).values(),
];
const fixedKeys = [
	"minBitrate",
	"maxBitrate",
	"bitrateSelectionMode",
	LOW,
	HIGH,
] as const;

function invalid(field: PerTitleSettingField, value: unknown) {
	if (value === undefined) return false;
	if (field.kind === "toggle") return typeof value !== "boolean";
	if (field.kind === "selection")
		return typeof value !== "string" || !field.options?.includes(value);
	if (!finite(value) || (field.integer && !Number.isSafeInteger(value)))
		return true;
	if (field.key.endsWith("StepSize")) return value <= 0;
	if (field.key === `${RULE}${COUNT}`) return value < 0;
	if (field.key.endsWith("Factor") && field.key !== "resolutionScaleFactor")
		return value <= 0;
	return (
		(field.minimum !== undefined && value < field.minimum) ||
		(field.maximum !== undefined && value > field.maximum)
	);
}

function auditValues(goal: PerTitleGoal, proposal: PerTitleProposal, add: Add) {
	const check = (
		location: { scope: "global" } | { scope: "stream"; rowId: string },
	) => {
		const { scope } = location;
		const rowId = location.scope === "stream" ? location.rowId : undefined;
		const allowed = new Set(
			(scope === "global"
				? perTitleGlobalFields(goal.codec)
				: perTitleStreamFields(goal.codec)
			).map(({ key }) => key),
		);
		for (const field of scope === "global"
			? globalInventory
			: streamInventory) {
			const values = [
				getPerTitleGoalSetting(goal, scope, field.key, rowId),
				getPerTitleSetting(proposal, scope, field.key, rowId),
			];
			const ref =
				location.scope === "global"
					? globalField(field.key)
					: streamField(location.rowId, field.key);
			if (!values.some((value) => value !== undefined)) continue;
			if (!allowed.has(field.key))
				add(
					"unsupported-codec-field",
					"conflict",
					`${field.key} is not a supported Per-Title control for ${goal.codec}. Remove it or choose the matching codec control.`,
					`${field.key}は${goal.codec}のPer-Title設定に対応していません。削除するか、このコーデックに対応する項目を使ってください。`,
					[ref],
				);
			if (values.some((value) => invalid(field, value)))
				add(
					"invalid-value",
					"conflict",
					`${field.key} has an invalid type, enum or numeric range. Correct this value before evaluating a recommendation.`,
					`${field.key}の型・選択値・数値範囲が不正です。調整案を評価する前に修正してください。`,
					[ref],
				);
		}
	};
	check({ scope: "global" });
	const rowIds = new Set([
		...proposal.api.streams.map(({ rowId }) => rowId),
		...(goal.rows ?? []).map(({ id }) => id),
		...(goal.automaticTemplates ?? []).map(({ id }) => id),
	]);
	for (const rowId of rowIds) check({ scope: "stream", rowId });
	for (const value of [
		goal.autoRepresentations,
		proposal.api.global.autoRepresentations,
	]) {
		if (value !== undefined && value !== false && !record(value))
			add(
				"invalid-value",
				"conflict",
				"autoRepresentations must be an object when enabled. Use an empty object to retain provider adoption defaults.",
				"autoRepresentationsを有効にする場合はオブジェクトが必要です。継承条件を既定値にする場合は空のオブジェクトを使います。",
				globals("autoRepresentations"),
			);
	}
	for (const value of [
		goal.fixedResolutionAndBitrateConfiguration,
		proposal.api.global.fixedResolutionAndBitrateConfiguration,
	]) {
		if (value !== undefined && !record(value))
			add(
				"invalid-value",
				"conflict",
				"The forced-rendition configuration must be an object. Correct its structure before evaluating its fields.",
				"強制追加の設定にはオブジェクトが必要です。各項目を評価する前に構造を修正してください。",
				globals(RULE.slice(0, -1)),
			);
	}
	const knownGlobal = new Set(
		globalInventory.map(({ key }) => key.split(".")[0]),
	);
	const knownStream = new Set(streamInventory.map(({ key }) => key));
	for (const key of Object.keys(proposal.api.global))
		if (!knownGlobal.has(key))
			add(
				"unrecognized-api-field",
				"warning",
				`${key} is outside the checked Per-Title contract. It is excluded from configuration proofs.`,
				`${key}は検証対象のPer-Title仕様に含まれません。設定の証明には使いません。`,
				globals(key),
			);
	for (const [parent, keys] of [
		["autoRepresentations", ["adoptConfigurationThreshold"]],
		["fixedResolutionAndBitrateConfiguration", [COUNT, FACTOR, MODE]],
	] as const) {
		const value = proposal.api.global[parent];
		if (record(value))
			for (const key of Object.keys(value))
				if (!(keys as readonly string[]).includes(key))
					add(
						"unrecognized-api-field",
						"warning",
						`${parent}.${key} is outside the checked Per-Title contract. Remove or verify it before relying on a complete configuration proof.`,
						`${parent}.${key}は検証対象のPer-Title仕様に含まれません。設定全体の証明として扱う前に、削除または仕様の確認が必要です。`,
						globals(`${parent}.${key}`),
					);
	}
	for (const stream of proposal.api.streams) {
		if (
			stream.perTitleSettings !== undefined &&
			!record(stream.perTitleSettings)
		)
			add(
				"invalid-value",
				"conflict",
				"Stream Per-Title settings must be an object. Correct the structure before evaluating this template.",
				"ストリームのPer-Title設定にはオブジェクトが必要です。このテンプレートを評価する前に構造を修正してください。",
				streams(stream.rowId, "perTitleSettings"),
			);
		else
			for (const key of Object.keys(stream.perTitleSettings ?? {}))
				if (!knownStream.has(key))
					add(
						"unrecognized-api-field",
						"warning",
						`${key} is outside the checked stream Per-Title contract. It is excluded from configuration proofs.`,
						`${key}は検証対象のストリームPer-Title仕様に含まれません。設定の証明には使いません。`,
						streams(stream.rowId, key),
					);
	}
}

function auditGlobal(goal: PerTitleGoal, global: Global, add: Add) {
	for (const value of [goal, global]) {
		for (const key of ["minBitrate", "maxBitrate"] as const)
			if (rate(value[key]) && value[key] < 10_000)
				add(
					"global-bitrate-below-api-minimum",
					"conflict",
					`Set the global ${key} to at least 10,000 bits/s before creating an encoding.`,
					`全体の${key === "minBitrate" ? "最小" : "最大"}ビットレートは10,000 bit/s以上にしてください。`,
					globals(key),
				);
		if (
			rate(value.minBitrate) &&
			rate(value.maxBitrate) &&
			value.minBitrate > value.maxBitrate
		)
			add(
				"global-range-order",
				"conflict",
				"The global minimum exceeds the maximum. Restore an ordered target envelope before adjusting row settings.",
				"全体の最小値が最大値を超えています。各段を調整する前に全体の範囲を修正してください。",
				globals("minBitrate", "maxBitrate"),
			);
		if (
			positive(value.minBitrateStepSize) &&
			positive(value.maxBitrateStepSize) &&
			value.minBitrateStepSize > value.maxBitrateStepSize
		)
			add(
				"step-range-order",
				"conflict",
				"The minimum bitrate ratio exceeds the maximum ratio. No adjacent ordinary rungs can satisfy both limits.",
				"段間隔の最小比率が最大比率を超えています。通常の隣接段が両方を満たせません。",
				globals("minBitrateStepSize", "maxBitrateStepSize"),
			);
		if (
			(positive(value.minBitrateStepSize) && value.minBitrateStepSize <= 1) ||
			(positive(value.maxBitrateStepSize) && value.maxBitrateStepSize <= 1)
		)
			add(
				"non-increasing-spacing",
				"warning",
				"A spacing ratio at or below one is outside this increasing-rung count model. Choose ratios above one before relying on its spacing or count certificate.",
				"1以下の段間隔は、ビットレートが増える本数モデルの対象外です。間隔・本数の検証には1より大きい比率を使ってください。",
				globals("minBitrateStepSize", "maxBitrateStepSize"),
			);
	}
	if (
		goal.countPolicy.kind !== "unrestricted" &&
		(!Number.isSafeInteger(goal.countPolicy.count) ||
			goal.countPolicy.count < 1)
	)
		add(
			"invalid-count-requirement",
			"conflict",
			"The requested rendition count must be a positive integer. Correct the requirement before comparing candidate counts.",
			"希望するレンディション数には正の整数を指定してください。候補の本数を比較する前に修正が必要です。",
			globals("countPolicy"),
		);
	if (
		global.autoRepresentations !== undefined &&
		goal.countPolicy.kind !== "unrestricted"
	)
		add(
			"automatic-count-unresolved",
			"warning",
			"Automatic resolution templates can change the output structure. A requested count alone does not certify that the native encoder will produce that count; verify the template and gap-filling rules.",
			"解像度テンプレートの自動生成は出力構成を変える場合があります。希望本数だけではエンコーダーの出力本数を証明できません。テンプレートと段の補完規則を確認してください。",
			globals(
				"autoRepresentations",
				"countPolicy",
				"minBitrateStepSize",
				"maxBitrateStepSize",
			),
		);
}

function auditRowBounds(
	rowId: string,
	settings: { minBitrate?: number; maxBitrate?: number },
	envelope: { minBitrate: number; maxBitrate: number },
	add: Add,
) {
	const fields = streams(rowId, "minBitrate", "maxBitrate");
	if (
		rate(settings.minBitrate) &&
		rate(settings.maxBitrate) &&
		settings.minBitrate > settings.maxBitrate
	)
		add(
			"stream-range-order",
			"conflict",
			"The row minimum exceeds its maximum. Restore an ordered row interval before changing spacing or complexity boundaries.",
			"この段の最小値が最大値を超えています。段間隔や複雑度境界を調整する前に範囲を修正してください。",
			fields,
		);
	if (
		[settings.minBitrate, settings.maxBitrate].some(
			(value) =>
				rate(value) &&
				((rate(envelope.minBitrate) && value < envelope.minBitrate) ||
					(rate(envelope.maxBitrate) && value > envelope.maxBitrate)),
		)
	)
		add(
			"stream-outside-envelope",
			"conflict",
			"The fixed-row range extends outside the global target envelope. Reconcile the row and global limits before evaluating cap reach or a fixed count.",
			"固定段の範囲が全体の範囲から外れています。上限への到達や本数を評価する前に、段と全体の制約を揃えてください。",
			[...fields, ...globals("minBitrate", "maxBitrate")],
		);
}

function auditStreams(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
	add: Add,
) {
	const seen = new Set<string>();
	const domain = complexityDomain(proposal.api.global, proposal.api.streams);
	for (const key of ["inputWidth", "inputHeight"] as const)
		if (goal[key] !== undefined && !rate(goal[key]))
			add(
				"invalid-input-dimension",
				"conflict",
				`${key} must be a positive integer before it can constrain resolution selection.`,
				`${key}には正の整数が必要です。解像度選択の条件として使う前に修正してください。`,
				globals(key),
			);
	for (const stream of proposal.api.streams) {
		const ref = (...keys: string[]) => streams(stream.rowId, ...keys);
		if (!stream.rowId || seen.has(stream.rowId))
			add(
				"duplicate-row-id",
				"conflict",
				"Every configured template needs a distinct nonempty row identifier. Resolve duplicate identifiers before applying linked settings.",
				"テンプレートを識別する値が空または重複しています。設定の対応先を確定するため修正してください。",
				ref("rowId"),
			);
		seen.add(stream.rowId);
		if (!MODES.has(stream.mode))
			add(
				"invalid-stream-mode",
				"conflict",
				"This stream mode is outside the Per-Title template modes. Choose the intended template mode before evaluating it.",
				"このモードはPer-Titleテンプレートの対象外です。評価するテンプレートモードを指定してください。",
				ref("mode"),
			);
		for (const key of ["width", "height"] as const)
			if (stream[key] !== undefined && !rate(stream[key]))
				add(
					"invalid-dimension",
					"conflict",
					`${key} must be a positive integer. Correct the template dimension before comparing resolution order.`,
					`${key}には正の整数が必要です。解像度の順序を比較する前に修正してください。`,
					ref(key),
				);
		if (
			stream.mode !== "PER_TITLE_TEMPLATE" &&
			!rate(stream.width) &&
			!rate(stream.height)
		)
			add(
				"fixed-dimensions-missing",
				"conflict",
				"A fixed-resolution template needs at least one explicit dimension. Supply width or height; input dimensions alone do not fix this row.",
				"固定解像度テンプレートには幅か高さの指定が必要です。入力素材の寸法だけではこの段の解像度は固定できません。",
				ref("width", "height", "mode"),
			);
		if (
			(rate(goal.inputHeight) &&
				rate(stream.height) &&
				stream.height > goal.inputHeight) ||
			(rate(goal.inputWidth) &&
				rate(stream.width) &&
				stream.width > goal.inputWidth)
		)
			add(
				"upscale-required",
				"warning",
				"This template dimension exceeds the supplied input dimension. Confirm the intended upscale policy instead of treating it as a guaranteed native output.",
				"このテンプレートは指定された入力寸法を超えています。出力を保証できると判断する前に、拡大を許可する設定を確認してください。",
				ref("width", "height"),
			);
		const settings = stream.perTitleSettings;
		if (!record(settings)) continue;
		if (stream.mode !== FIXED) {
			const ignored = fixedKeys.filter((key) => settings[key] !== undefined);
			if (ignored.length)
				add(
					"inactive-fixed-settings",
					"warning",
					"Fixed bitrate bounds and selection settings are inactive in this template mode. Remove the parked values or use fixed-resolution-and-bitrate mode; stream codec factors are separate controls.",
					"このテンプレートモードでは固定ビットレート範囲・選択条件を使いません。不要な値を削除するか、解像度とビットレートを固定するモードを使ってください。ストリームのコーデック倍率は別の設定です。",
					ref(...ignored),
				);
			continue;
		}
		if (!rate(settings.minBitrate) || !rate(settings.maxBitrate))
			add(
				"fixed-range-unresolved",
				"warning",
				"Both fixed-row bitrate bounds are needed for a checked interval. Supply the missing bounds or verify the provider defaults before claiming a complete evaluation.",
				"固定段の範囲を検証するには最小・最大ビットレートが必要です。不足値を指定するか、既定値を確認してください。",
				ref("minBitrate", "maxBitrate"),
			);
		auditRowBounds(stream.rowId, settings, proposal.api.global, add);
		const saved = [
			...(goal.rows ?? []),
			...(goal.automaticTemplates ?? []),
		].find(({ id }) => id === stream.rowId);
		if (saved) auditRowBounds(stream.rowId, saved, goal, add);
		if (settings.bitrateSelectionMode !== "COMPLEXITY_RANGE") {
			if (settings[LOW] !== undefined || settings[HIGH] !== undefined)
				add(
					"inactive-complexity-boundaries",
					"warning",
					"Complexity boundaries do not control an OPTIMIZED or unspecified selection mode. Select COMPLEXITY_RANGE to use them, or remove the inactive boundaries.",
					"OPTIMIZEDまたは選択方式が未指定の場合、複雑度境界は範囲の制御に使いません。COMPLEXITY_RANGEを選ぶか、不要な境界値を削除してください。",
					ref("bitrateSelectionMode", LOW, HIGH),
				);
			continue;
		}
		if (!rate(settings[LOW]) || !rate(settings[HIGH]))
			add(
				"complexity-boundaries-unresolved",
				"warning",
				"COMPLEXITY_RANGE needs both complexity boundaries for this calculation. Their omitted provider defaults are not guessed by the evaluator.",
				"この計算でCOMPLEXITY_RANGEを評価するには両方の複雑度境界が必要です。未指定時の既定値は推測しません。",
				ref(LOW, HIGH),
			);
		else if (settings[LOW] >= settings[HIGH])
			add(
				"complexity-boundary-order",
				"conflict",
				"The lower complexity boundary must be below the upper boundary. Restore their order before deriving any interpolation or spacing advice.",
				"複雑度の下側境界は上側境界より小さくする必要があります。補間や段間隔の調整案を求める前に順序を修正してください。",
				ref(LOW, HIGH),
			);
		else if (domain) {
			if (settings[LOW] >= domain.maximum)
				add(
					"complexity-always-minimum",
					"warning",
					"After the fixed-stream constraints adjust the assumed analysis range, this row stays at its minimum. Lower the complexity boundaries if the bitrate should vary within that range.",
					"固定段の制約を含めて計算すると、この段は最小ビットレートのままです。値を変化させたい場合は複雑度境界を下げてください。",
					[...ref(LOW, HIGH), ...globals("maxBitrate")],
				);
			if (settings[HIGH] <= domain.minimum)
				add(
					"complexity-always-maximum",
					"warning",
					"After the fixed-stream constraints adjust the assumed analysis range, this row stays at its maximum. Raise the complexity boundaries if simpler content should use a lower bitrate.",
					"固定段の制約を含めて計算すると、この段は最大ビットレートのままです。単純な素材で値を下げたい場合は複雑度境界を上げてください。",
					[...ref(LOW, HIGH), ...globals("minBitrate")],
				);
		}
	}
	for (const row of [
		...(goal.rows ?? []),
		...(goal.automaticTemplates ?? []),
	]) {
		const emitted = proposal.api.streams.find(({ rowId }) => rowId === row.id);
		const parked = fixedKeys.filter(
			(key) =>
				(row as unknown as Record<string, unknown>)[key] !== undefined &&
				(emitted?.perTitleSettings as Record<string, unknown> | undefined)?.[
					key
				] === undefined,
		);
		if (parked.length)
			add(
				"omitted-stream-settings",
				"warning",
				"Some saved fixed-template settings are absent from the emitted API configuration. They cannot constrain the current output; check the selected template mode before relying on them.",
				"保存された固定テンプレート設定の一部がAPI設定に含まれていません。現在の出力を制約しないため、テンプレートモードを確認してください。",
				streams(row.id, ...parked),
			);
	}
	const fixed = proposal.api.streams.filter(
		({ mode }) => mode !== "PER_TITLE_TEMPLATE",
	);
	if (
		goal.countPolicy.kind !== "unrestricted" &&
		Number.isSafeInteger(goal.countPolicy.count) &&
		goal.countPolicy.count <
			fixed.filter(
				({ mode }) =>
					mode === FIXED || mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			).length
	)
		add(
			"required-count-exceeded",
			"conflict",
			"The requested rendition count is smaller than the number of required fixed templates. Increase the count requirement or remove a required template before tuning bitrate spacing.",
			"希望本数が必須の固定テンプレート数を下回っています。段間隔を調整する前に、希望本数を増やすか必須テンプレートを減らしてください。",
			globals("countPolicy"),
		);
	if (
		goal.countPolicy.kind !== "unrestricted" &&
		proposal.api.global.autoRepresentations === undefined &&
		proposal.api.streams.some(({ mode }) => mode === "PER_TITLE_TEMPLATE")
	)
		add(
			"automatic-count-unresolved",
			"warning",
			"Ordinary Per-Title templates can be reused or selected during native analysis. Disabling automatic template generation does not certify a requested output count; include ordinary gap filling in the evaluation.",
			"通常のPer-Titleテンプレートは素材分析で選択・再利用されます。テンプレート自動生成が無効でも希望本数は証明できません。通常段の補完も含めて評価してください。",
			[
				...globals("countPolicy", "minBitrateStepSize", "maxBitrateStepSize"),
				...proposal.api.streams
					.filter(({ mode }) => mode === "PER_TITLE_TEMPLATE")
					.map(({ rowId }) => streamField(rowId, "mode")),
			],
		);
	for (let index = 1; index < fixed.length; index++) {
		const a = fixed[index - 1],
			b = fixed[index];
		if (!a || !b) continue;
		if (
			rate(a.height) &&
			rate(b.height) &&
			rate(a.width) &&
			rate(b.width) &&
			(a.height - b.height) * (a.width - b.width) < 0
		)
			add(
				"dimension-order-ambiguous",
				"warning",
				"Width and height imply different resolution orders. Use consistent aspect ratios or supply the missing input geometry before certifying the highest fixed template.",
				"幅と高さで解像度の順序が逆転しています。縦横比を揃えるか、入力の寸法条件を確認してから最上位の固定テンプレートを判定してください。",
				[
					...streams(a.rowId, "width", "height"),
					...streams(b.rowId, "width", "height"),
				],
			);
	}
}

function auditIntervals(global: Global, configured: Stream[], add: Add) {
	const fixed = configured.filter(({ mode }) => mode === FIXED);
	if (
		!fixed.length ||
		!rate(global.minBitrate) ||
		!rate(global.maxBitrate) ||
		global.minBitrate > global.maxBitrate ||
		!positive(global.minBitrateStepSize) ||
		global.minBitrateStepSize <= 1
	)
		return;
	const heightOrder = fixed.every(({ height }) => rate(height));
	const widthOrder = fixed.every(({ width }) => rate(width));
	const contradictory = fixed.some((a) =>
		fixed.some(
			(b) =>
				rate(a.height) &&
				rate(b.height) &&
				rate(a.width) &&
				rate(b.width) &&
				(a.height - b.height) * (a.width - b.width) < 0,
		),
	);
	if ((!heightOrder && !widthOrder) || contradictory) {
		add(
			"interval-order-unresolved",
			"warning",
			"The fixed rows have no consistent resolution order from the supplied dimensions. Supply comparable height or width values before checking adjacent intervals; array position is not a resolution constraint.",
			"指定された寸法から固定段の解像度順を確定できません。高さまたは幅を比較できる形で指定してください。配列内の順番を解像度の制約とは見なしません。",
			fixed.flatMap(({ rowId }) => streams(rowId, "width", "height")),
		);
		return;
	}
	const axis = heightOrder ? "height" : "width";
	fixed.sort(
		(a, b) =>
			(a[axis] ?? 0) - (b[axis] ?? 0) ||
			(heightOrder && widthOrder ? (a.width ?? 0) - (b.width ?? 0) : 0) ||
			(a.perTitleSettings?.minBitrate ?? 0) -
				(b.perTitleSettings?.minBitrate ?? 0) ||
			a.rowId.localeCompare(b.rowId),
	);
	const rows = fixed.map(({ perTitleSettings: settings }) => ({
		minimum: settings?.minBitrate ?? 0,
		maximum: settings?.maxBitrate ?? 0,
		low: settings?.[LOW] ?? 0,
		high: settings?.[HIGH] ?? 0,
	}));
	if (
		fixed.some(
			({ perTitleSettings }) =>
				perTitleSettings?.bitrateSelectionMode !== "COMPLEXITY_RANGE",
		)
	) {
		add(
			"interval-analysis-unresolved",
			"warning",
			"One or more fixed rows use media-driven selection rather than a fully specified complexity curve. Complete-domain spacing and count checks need media evidence or explicit COMPLEXITY_RANGE settings.",
			"固定段に素材分析で値を選ぶ設定が含まれます。範囲全体の段間隔・本数の検証には素材の結果、または明示したCOMPLEXITY_RANGE設定が必要です。",
			fixed.flatMap(({ rowId }) =>
				streams(rowId, "bitrateSelectionMode", LOW, HIGH),
			),
		);
		return;
	}
	const domain = complexityDomain(global, configured);
	if (!domain) {
		add(
			"interval-analysis-unresolved",
			"warning",
			"Check the fixed-stream dimensions, bitrate ranges and additional-rendition settings. Their analysis floor is unresolved, so the interval spacing cannot be checked.",
			"固定段の寸法・ビットレート範囲・追加段の設定を確認してください。解析値の補正範囲が定まらず、段間隔を判定できません。",
			[
				...globals(
					"minBitrate",
					"maxBitrate",
					"minBitrateStepSize",
					"maxBitrateStepSize",
					`${RULE}${COUNT}`,
					`${RULE}${FACTOR}`,
				),
				...configured.flatMap(({ rowId }) =>
					streams(rowId, "width", "height", "minBitrate", "maxBitrate"),
				),
			],
		);
		return;
	}
	const checked = certifyComplexityIntervals(
		rows,
		domain,
		global.minBitrateStepSize,
	);
	if (!checked) return;
	add(
		"complexity-domain-checked",
		"info",
		`Conditional interval bounds were checked over every integer complexity input from ${domain.minimum} to ${domain.maximum}, after applying the analysis floor to the assumed raw input interval ${global.minBitrate} to ${global.maxBitrate}, including clamp and spacing-relaxation branches. This domain is an explicit hypothesis, not a prediction of the media-derived input.`,
		`解析値の仮定${global.minBitrate}〜${global.maxBitrate}を補正し、${domain.minimum}〜${domain.maximum}の全整数値で上下限と段間隔を確認しました。素材の解析結果を予測するものではありません。`,
		globals("minBitrate", "maxBitrate", "minBitrateStepSize"),
	);
	if (checked.maximumWithinRowRatio >= global.minBitrateStepSize)
		add(
			"within-row-expansion-risk",
			"warning",
			"The full-domain interval bounds cannot exclude multiple ordinary targets inside a fixed row. Increasing the minimum step or tightening the row curve may reduce extra-rendition risk; a native count still needs verification.",
			"範囲全体の境界からは、固定段内に複数の通常段が入る可能性を除外できません。最小段間隔を広げるか各段の曲線を絞ることで、追加段の可能性を減らせます。実際の本数は別途確認が必要です。",
			[
				...globals("minBitrateStepSize"),
				...fixed.flatMap(({ rowId }) =>
					streams(rowId, "minBitrate", "maxBitrate", LOW, HIGH),
				),
			],
		);
	if (
		checked.minimumAdjacentRatio !== undefined &&
		checked.minimumAdjacentRatio < global.minBitrateStepSize
	)
		add(
			"adjacent-spacing-unproved",
			"warning",
			"The full-domain bounds do not certify the minimum spacing between all permitted neighbouring row targets. Adjust row curves or the minimum step together; this conservative bound alone does not prove a native encoding failure.",
			"隣接段で許される値の組み合わせすべてが最小段間隔を満たすとは証明できません。各段の曲線と最小段間隔を合わせて調整してください。この保守的な境界だけでエンコード失敗とは判断しません。",
			[
				...globals("minBitrateStepSize"),
				...fixed.flatMap(({ rowId }) =>
					streams(rowId, "minBitrate", "maxBitrate", LOW, HIGH),
				),
			],
		);
	if (
		positive(global.maxBitrateStepSize) &&
		checked.maximumAdjacentRatio !== undefined &&
		checked.maximumAdjacentRatio > global.maxBitrateStepSize
	)
		add(
			"adjacent-gap-unproved",
			"warning",
			"The full-domain bounds permit a gap beyond the maximum ordinary step. Intermediate targets may be needed; tune row curves and the maximum step together when preserving rendition count.",
			"範囲全体の境界には最大段間隔を超える隙間が含まれます。中間段が必要になる場合があるため、本数を維持する場合は各段の曲線と最大段間隔を合わせて調整してください。",
			[
				...globals("maxBitrateStepSize"),
				...fixed.flatMap(({ rowId }) =>
					streams(rowId, "minBitrate", "maxBitrate", LOW, HIGH),
				),
			],
		);
}

function auditForced(global: Global, configured: Stream[], add: Add) {
	const rule = global.fixedResolutionAndBitrateConfiguration;
	if (!record(rule)) return;
	const count = rule[COUNT],
		factor = rule[FACTOR],
		mode = rule[MODE];
	const fields = globals(
		`${RULE}${COUNT}`,
		`${RULE}${FACTOR}`,
		`${RULE}${MODE}`,
	);
	if (count === undefined || count === 0) {
		if (factor !== undefined || mode !== undefined)
			add(
				"inactive-forced-settings",
				"warning",
				"A factor or calculation mode is set without an explicit positive forced count. Its active effect is not established; set the count or remove the parked values.",
				"正の強制追加本数が未指定のまま倍率や計算方式が設定されています。効果を確定できないため、本数を指定するか不要な値を削除してください。",
				fields,
			);
		return;
	}
	if (!Number.isSafeInteger(count) || count < 0) return;
	if (count > 256)
		add(
			"forced-model-limit",
			"warning",
			"This forced count exceeds the evaluator's 256-step bound. It is a model limit, not a documented provider maximum; reduce it for a checked integer chain.",
			"強制追加本数が検証モデルの上限256を超えています。APIの上限ではありません。整数計算を検証する場合は本数を減らしてください。",
			globals(`${RULE}${COUNT}`),
		);
	if (factor === undefined || mode === undefined) {
		add(
			"forced-defaults-unresolved",
			"warning",
			"A positive forced count has no explicit factor or base-calculation mode. Verify provider defaults or specify both before evaluating cap safety and progression.",
			"正の強制追加本数に対して倍率または基準値の計算方式が未指定です。上限と増加を評価する前に既定値を確認するか、両方を指定してください。",
			fields,
		);
		return;
	}
	if (
		!positive(factor) ||
		!["LAST_CALCULATED_BITRATE", "MINIMUM", "MAXIMUM", "AVERAGE"].includes(
			mode,
		) ||
		count > 256
	)
		return;
	const fixed = configured.filter(
		({ mode }) =>
			mode === FIXED || mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
	);
	const dimensions = fixed.map(({ height }) => height);
	const highest = fixed.reduce<Stream | undefined>(
		(top, row) => (!top || (row.height ?? 0) > (top.height ?? 0) ? row : top),
		undefined,
	);
	const settings = highest?.perTitleSettings;
	if (
		!highest ||
		!dimensions.every(rate) ||
		fixed.filter(({ height }) => height === highest.height).length !== 1 ||
		highest.mode !== FIXED ||
		!rate(settings?.minBitrate) ||
		!rate(settings?.maxBitrate) ||
		settings.minBitrate > settings.maxBitrate
	) {
		add(
			"forced-base-unresolved",
			"warning",
			"The highest fixed base is not uniquely determined with explicit bitrate bounds. Resolve missing dimensions, repeated highest resolutions or fixed-resolution-only analysis before certifying the forced chain.",
			"最上位の固定段とそのビットレート範囲を一意に確定できません。寸法不足、最上位解像度の重複、または固定解像度のみの分析条件を確認してください。",
			fields,
		);
		return;
	}
	const configuredRange = {
		minimum: settings.minBitrate,
		maximum: settings.maxBitrate,
	};
	let bases: Array<{ minimum: number; maximum: number }>;
	if (mode === "MINIMUM")
		bases = [
			{ minimum: configuredRange.minimum, maximum: configuredRange.minimum },
		];
	else if (mode === "MAXIMUM")
		bases = [
			{ minimum: configuredRange.maximum, maximum: configuredRange.maximum },
		];
	else if (mode === "AVERAGE") {
		const mean = Math.trunc(
			(configuredRange.minimum + configuredRange.maximum) / 2,
		);
		bases = [{ minimum: mean, maximum: mean }];
	} else if (
		settings.bitrateSelectionMode === "COMPLEXITY_RANGE" &&
		rate(global.minBitrate) &&
		rate(global.maxBitrate)
	) {
		const row = {
			...configuredRange,
			low: settings[LOW] ?? 0,
			high: settings[HIGH] ?? 0,
			minStep: global.minBitrateStepSize,
		};
		const domain = complexityDomain(global, configured);
		const high = domain
			? evaluateComplexityRange({ ...row, input: domain.maximum })
			: null;
		// The upper affine target is monotone. Keep the configured minimum as
		// a conservative lower bound across interior q-activation jumps.
		bases = high
			? [{ minimum: configuredRange.minimum, maximum: high.maximum }]
			: [];
	} else bases = [configuredRange];
	if (!bases.length) {
		add(
			"forced-base-unresolved",
			"warning",
			"The calculated forced base cannot be bounded with these complexity settings. Correct the boundaries before relying on a forced top target.",
			"この複雑度設定からは強制追加の基準範囲を求められません。最上段の目標値を判断する前に境界を修正してください。",
			[...fields, ...streams(highest.rowId, LOW, HIGH)],
		);
		return;
	}
	for (const base of bases) {
		const chain = evaluateForcedRenditions({
			base,
			count,
			factor,
		});
		if (!chain) {
			add(
				"forced-integer-overflow",
				"conflict",
				"The repeated forced-rendition calculation leaves the safe positive integer domain. Reduce the factor or count before using this configuration.",
				"強制追加の繰り返し計算が安全な正の整数範囲から外れます。倍率または本数を減らしてください。",
				fields,
			);
			continue;
		}
		let previous = base;
		for (const point of chain) {
			if (
				point.minimum <= previous.minimum ||
				point.maximum <= previous.maximum
			)
				add(
					"forced-nonprogress",
					"warning",
					"At least one rounded forced step does not increase its base. A positive factor, even just above one, is insufficient; choose a factor that increases the actual integer targets.",
					"丸め後に基準値から増加しない強制追加段があります。倍率が正、または1をわずかに超えるだけでは不十分です。実際の整数値が増加する倍率を指定してください。",
					fields,
				);
			if (rate(global.maxBitrate) && point.maximum > global.maxBitrate)
				add(
					"forced-cap-exceeded",
					"conflict",
					"A permitted forced target exceeds the global maximum. Reduce the factor/count or reconcile the row range with the cap; this audit does not assume that the provider silently clamps it.",
					"許される強制追加値が全体の最大値を超えています。倍率・本数を減らすか、段の範囲を上限に合わせてください。エンコーダーが自動で上限に収めるとは仮定しません。",
					[...fields, ...globals("maxBitrate")],
				);
			previous = point;
		}
		if (
			mode !== "LAST_CALCULATED_BITRATE" &&
			chain[0] &&
			chain[0].minimum <= configuredRange.maximum
		)
			add(
				"forced-not-above-fixed-range",
				"warning",
				"The first forced target is not above the entire configured highest fixed interval. Reconcile the selected base mode and factor before treating it as an extra upper rendition.",
				"最初の強制追加値が、最上位固定段の設定範囲全体を上回っていません。上位の追加段と見なす前に基準値の方式と倍率を調整してください。",
				[...fields, ...streams(highest.rowId, "minBitrate", "maxBitrate")],
			);
	}
}

function auditCodec(
	goal: PerTitleGoal,
	global: Global,
	configured: Stream[],
	add: Add,
) {
	if (goal.codec === "H264" && global.codecMinBitrateFactor !== undefined)
		add(
			"ineffective-codec-minimum",
			"info",
			"The H.264 codec minimum-bitrate factor has no effect in the documented contract. Do not use it to repair ladder bounds, count or measured minimum bitrate.",
			"H.264のコーデック最小ビットレート倍率は仕様上効果がありません。ラダーの範囲・本数・実測下限の調整には使えません。",
			globals("codecMinBitrateFactor"),
		);
	const supported = goal.codec === "H264" || goal.codec === "H265";
	for (const stream of configured)
		for (const key of [
			"codecMaxBitrateFactor",
			"codecBufsizeFactor",
		] as const) {
			const override = stream.perTitleSettings?.[key];
			if (supported && override !== undefined)
				add(
					"stream-factor-override",
					"info",
					`The stream ${key} overrides the global factor for this template. Compare the effective stream value when checking codec limits; this does not change the ladder target.`,
					`この段では${key}が全体の倍率を上書きします。コーデック制限は段の値で確認してください。ラダーの目標値を変更する設定ではありません。`,
					[...streams(stream.rowId, key), ...globals(key)],
				);
		}
	if (
		goal.codec !== "H264" &&
		["H265", "H265V2"].includes(goal.codec) &&
		positive(global.codecMinBitrateFactor)
	)
		for (const stream of configured) {
			const maximum = supported
				? (stream.perTitleSettings?.codecMaxBitrateFactor ??
					global.codecMaxBitrateFactor)
				: global.codecMaxBitrateFactor;
			if (positive(maximum) && global.codecMinBitrateFactor > maximum)
				add(
					"codec-factor-order",
					"conflict",
					"The effective codec minimum-rate factor exceeds its maximum-rate factor. Reconcile the global minimum and stream/global maximum overrides before generating codec settings.",
					"有効なコーデック最小レート倍率が最大レート倍率を超えています。全体の最小倍率と、段・全体の最大倍率を揃えてください。",
					[
						...globals("codecMinBitrateFactor", "codecMaxBitrateFactor"),
						...streams(stream.rowId, "codecMaxBitrateFactor"),
					],
				);
		}
	if (
		positive(global.codecMaxBitrateFactor) &&
		global.codecMaxBitrateFactor < 1
	)
		add(
			"codec-maximum-below-target",
			"warning",
			"The global codec maximum-rate factor is below one, so its derived maximum can be below the ladder target where no stream override applies. Confirm that this rate-control tradeoff is intentional.",
			"全体のコーデック最大レート倍率が1未満のため、段の上書きがなければ最大レートがラダー目標値を下回る場合があります。意図したレート制御か確認してください。",
			globals("codecMaxBitrateFactor"),
		);
	add(
		"quality-requires-media",
		"info",
		"CRF/QP, complexity and resolution factors jointly affect the analysis-derived ladder. Configuration checks cannot establish the greatest bitrate saving at preserved quality; compare representative media with fixed quality measurements before adopting those changes.",
		"CRF・QP、複雑度、解像度の倍率は素材分析とラダーに相互に影響します。設定だけでは画質を維持した最大のビットレート削減は確定できません。これらを変更する場合は代表素材で品質を比較してください。",
		globals(
			goal.codec === "H265V2" ? "targetQualityQp" : "targetQualityCrf",
			"complexityFactor",
			"resolutionScaleFactor",
		),
	);
}

/** Audits emitted constraints and saved values without claiming native media outcomes. */
export function assessPerTitleValidity(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
): PerTitleValidityFinding[] {
	const result: PerTitleValidityFinding[] = [],
		seen = new Set<string>();
	const add: Add = (code, severity, en, ja, fields) => {
		const key = `${code}:${JSON.stringify(fields ?? [])}`;
		if (seen.has(key)) return;
		seen.add(key);
		result.push({
			code,
			severity,
			message: { en, ja },
			...(fields ? { fields } : {}),
		});
	};
	auditValues(goal, proposal, add);
	auditGlobal(goal, proposal.api.global, add);
	auditStreams(goal, proposal, add);
	auditIntervals(proposal.api.global, proposal.api.streams, add);
	auditForced(proposal.api.global, proposal.api.streams, add);
	auditCodec(goal, proposal.api.global, proposal.api.streams, add);
	const upperLimit = assessPerTitleUpperLimit(goal, proposal);
	if (upperLimit.finding) {
		const { code, severity, message } = upperLimit.finding;
		add(code, severity, message.en, message.ja);
	}
	return result;
}
