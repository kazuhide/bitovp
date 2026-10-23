import {
	certifyComplexityIntervals,
	type PerTitleCodec,
	type PerTitleGoal,
	type PerTitleGoalRow,
	type PerTitleProposal,
	recommendPerTitleSettings,
} from "@bitovp/core";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

export type PerTitleSetupInput = {
	strategy: PerTitleGoal["strategy"];
	codec: PerTitleCodec;
	minBitrate: number;
	maxBitrate: number;
	count?: number;
	inputHeight?: number;
	rows: readonly {
		id: string;
		height: number;
		minBitrate?: number;
		maxBitrate?: number;
	}[];
};

type Localized = { en: string; ja: string };
export type PerTitleSetupIssue = {
	code: string;
	field?: string;
	rowId?: string;
	message: Localized;
};
export type PerTitleSetupResult = {
	status: "ready" | "conflict" | "unverified";
	goal: PerTitleGoal | null;
	proposal: PerTitleProposal | null;
	issues: PerTitleSetupIssue[];
	reasoning: Localized[];
};

const PUBLIC_CODECS: readonly PerTitleCodec[] = ["H264", "H265", "VP9", "AV1"];
const ALL_CODECS: readonly PerTitleCodec[] = [...PUBLIC_CODECS, "H265V2"];
const STRATEGIES: readonly PerTitleGoal["strategy"][] = [
	"automatic",
	"count",
	"required-resolutions",
	"fixed-resolutions",
	"fixed-ranges",
];
const MAX_RATE = 2_147_483_647;
const MAX_ROWS = 64;
const integer = (value: number) => Number.isSafeInteger(value) && value > 0;
const rate = (value: number) => integer(value) && value <= MAX_RATE;
const closed = (strategy: PerTitleGoal["strategy"]) =>
	strategy === "fixed-resolutions" || strategy === "fixed-ranges";

function validate(
	input: PerTitleSetupInput,
	allowedCodecs: readonly PerTitleCodec[],
): PerTitleSetupIssue[] {
	const issues: PerTitleSetupIssue[] = [];
	const add = (
		code: string,
		field: string,
		en: string,
		ja: string,
		rowId?: string,
	) =>
		issues.push({
			code,
			field,
			...(rowId ? { rowId } : {}),
			message: { en, ja },
		});
	if (!STRATEGIES.includes(input.strategy))
		add(
			"invalid-strategy",
			"strategy",
			"Choose a supported ladder requirement.",
			"ラダーの要件を選択してください。",
		);
	if (!ALL_CODECS.includes(input.codec) || !allowedCodecs.includes(input.codec))
		add(
			"unsupported-codec",
			"codec",
			"Choose a codec available for this account.",
			"このアカウントで利用できるコーデックを選択してください。",
		);
	for (const key of ["minBitrate", "maxBitrate"] as const)
		if (!rate(input[key]))
			add(
				"invalid-bitrate",
				key,
				"Enter a whole bitrate from 1 to 2,147,483,647 bits/s.",
				"ビットレートは1〜2,147,483,647 bit/sの整数で入力してください。",
			);
	if (
		rate(input.minBitrate) &&
		rate(input.maxBitrate) &&
		input.minBitrate > input.maxBitrate
	)
		add(
			"reversed-range",
			"maxBitrate",
			"Set the overall maximum at or above the minimum.",
			"全体の最大ビットレートを最小値以上にしてください。",
		);
	if (input.inputHeight !== undefined && !integer(input.inputHeight))
		add(
			"invalid-input-height",
			"inputHeight",
			"Enter a positive whole input height, or leave it empty.",
			"入力素材の高さを正の整数で入力するか、空欄にしてください。",
		);
	if (
		input.count !== undefined &&
		(!integer(input.count) || input.count > MAX_ROWS)
	)
		add(
			"invalid-count",
			"count",
			"Enter a rendition count from 1 to 64.",
			"レンディション数は1〜64の整数で入力してください。",
		);
	if (input.strategy === "count" && input.count === undefined)
		add(
			"count-required",
			"count",
			"Enter the requested rendition count.",
			"必要なレンディション数を入力してください。",
		);
	if (!Array.isArray(input.rows) || input.rows.length > MAX_ROWS) {
		add(
			"invalid-rows",
			"rows",
			"Use no more than 64 rendition rows.",
			"レンディションは64行以内で指定してください。",
		);
		return issues;
	}
	if (
		(input.strategy === "automatic" || input.strategy === "count") &&
		input.rows.length
	)
		add(
			"unused-rows",
			"rows",
			"Remove the required resolutions or choose a resolution-based requirement.",
			"必須の解像度を削除するか、解像度を指定する要件を選択してください。",
		);
	if (input.strategy === "automatic" && input.count !== undefined)
		add(
			"unused-count",
			"count",
			"Choose the rendition-count requirement to specify a count.",
			"本数を指定する場合は、レンディション数を指定する要件を選択してください。",
		);
	if (!["automatic", "count"].includes(input.strategy) && !input.rows.length)
		add(
			"rows-required",
			"rows",
			"Add at least one required resolution.",
			"必須の解像度を1行以上追加してください。",
		);
	if (input.count !== undefined && integer(input.count)) {
		if (closed(input.strategy) && input.count !== input.rows.length)
			add(
				"closed-count",
				"count",
				"For a closed ladder, set the count to the number of required rows or add the missing rows.",
				"すべての段を指定する場合は、本数を必須行の数に合わせるか、足りない行を追加してください。",
			);
		else if (input.count < input.rows.length)
			add(
				"required-count-exceeded",
				"count",
				"Increase the requested count or remove required rows.",
				"必要な本数を増やすか、必須行を減らしてください。",
			);
		if (
			rate(input.minBitrate) &&
			rate(input.maxBitrate) &&
			input.maxBitrate - input.minBitrate + 1 < input.count
		)
			add(
				"integer-count-impossible",
				"count",
				"Widen the overall bitrate range or request fewer distinct renditions.",
				"異なるビットレートを確保できるよう、全体の範囲を広げるか本数を減らしてください。",
			);
	}
	const ids = new Set<string>();
	for (const row of input.rows) {
		if (
			!row ||
			typeof row.id !== "string" ||
			!row.id.trim() ||
			ids.has(row.id)
		) {
			add(
				"invalid-row-id",
				"rows",
				"Give every rendition a distinct nonempty identity.",
				"各レンディションに重複しない識別子を指定してください。",
			);
			continue;
		}
		ids.add(row.id);
		if (!integer(row.height))
			add(
				"invalid-height",
				"height",
				"Enter a positive whole rendition height.",
				"解像度の高さを正の整数で入力してください。",
				row.id,
			);
		else if (
			integer(input.inputHeight as number) &&
			row.height > (input.inputHeight as number)
		)
			add(
				"upscale-required",
				"height",
				"Lower this height to the input height or provide a larger source.",
				"この解像度を入力素材の高さ以下にするか、より大きい素材を指定してください。",
				row.id,
			);
		for (const key of ["minBitrate", "maxBitrate"] as const) {
			if (row[key] === undefined) continue;
			if (input.strategy !== "fixed-ranges")
				add(
					"unused-row-range",
					key,
					"Choose fixed resolutions with bitrate ranges to constrain a row's bitrate.",
					"段ごとのビットレートを指定する場合は、解像度と範囲を指定する要件を選択してください。",
					row.id,
				);
			else if (!rate(row[key] as number))
				add(
					"invalid-row-bitrate",
					key,
					"Enter a whole bitrate from 1 to 2,147,483,647 bits/s.",
					"ビットレートは1〜2,147,483,647 bit/sの整数で入力してください。",
					row.id,
				);
			else if (
				(row[key] as number) < input.minBitrate ||
				(row[key] as number) > input.maxBitrate
			)
				add(
					"row-outside-global-range",
					key,
					"Keep the row's bitrate inside the overall minimum and maximum.",
					"段のビットレートを全体の最小値と最大値の範囲内にしてください。",
					row.id,
				);
		}
		if (
			row.minBitrate !== undefined &&
			row.maxBitrate !== undefined &&
			row.minBitrate > row.maxBitrate
		)
			add(
				"reversed-row-range",
				"maxBitrate",
				"Set this row's maximum at or above its minimum.",
				"この段の最大ビットレートを最小値以上にしてください。",
				row.id,
			);
	}
	if (
		closed(input.strategy) &&
		input.rows.length > input.maxBitrate - input.minBitrate + 1
	)
		add(
			"integer-count-impossible",
			"rows",
			"Widen the overall bitrate range or remove a rendition row.",
			"異なるビットレートを確保できるよう、全体の範囲を広げるか行を減らしてください。",
		);
	return issues;
}

/** Equal log positions are an initial allocation, not a content-quality optimum. */
function allocateRanges(input: PerTitleSetupInput): PerTitleGoalRow[] {
	const ordered = [...input.rows].sort((a, b) => a.height - b.height);
	const size = ordered.length;
	const ratio =
		size > 1 ? (input.maxBitrate / input.minBitrate) ** (1 / (size - 1)) : 1;
	// One third of each log step supplies band width; the remaining two thirds
	// leave a gap for a strictly larger minimum step, subject to integer recheck.
	const width = ratio ** (1 / 3);
	const quantum =
		input.minBitrate >= 1000 &&
		(size === 1 || input.minBitrate * (ratio - 1) >= 1000)
			? 1000
			: 1;
	const assigned = input.rows.map((row) => {
		const index = ordered.indexOf(row);
		const maximum =
			size === 1 || index === size - 1
				? input.maxBitrate
				: index === 0
					? input.minBitrate
					: Math.min(
							input.maxBitrate,
							Math.max(
								input.minBitrate,
								Math.round((input.minBitrate * ratio ** index) / quantum) *
									quantum,
							),
						);
		let minBitrate =
			row.minBitrate ??
			(size === 1
				? input.minBitrate
				: Math.max(
						input.minBitrate,
						Math.ceil(maximum / width / quantum) * quantum,
					));
		let maxBitrate = row.maxBitrate ?? maximum;
		if (row.minBitrate === undefined)
			minBitrate = Math.min(minBitrate, maxBitrate);
		if (row.maxBitrate === undefined)
			maxBitrate = Math.max(maxBitrate, minBitrate);
		return {
			id: row.id,
			height: row.height,
			minBitrate,
			maxBitrate,
		};
	});
	const highestHeight = Math.max(...assigned.map((row) => row.height));
	const floor = Math.max(
		...assigned
			.filter((row) => row.height === highestHeight)
			.map((row) => row.minBitrate),
	);
	// Without additional renditions, the highest fixed minimum raises the input
	// floor. Calibrating below it would make the advertised minima unreachable.
	const low = floor < input.maxBitrate ? floor : Math.max(1, floor - 1);
	const high = low < input.maxBitrate ? input.maxBitrate : low + 1;
	return assigned.map((row) => ({
		...row,
		bitrateSelectionMode: "COMPLEXITY_RANGE",
		lowComplexityBoundaryForMaxBitrate: low,
		highComplexityBoundaryForMaxBitrate: high,
	}));
}

function materialize(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
): PerTitleGoal {
	const streams = new Map(
		proposal.api.streams.map((stream) => [stream.rowId, stream]),
	);
	return {
		...goal,
		minBitrateStepSize: proposal.api.global.minBitrateStepSize,
		maxBitrateStepSize: proposal.api.global.maxBitrateStepSize,
		autoRepresentations: proposal.api.global.autoRepresentations ?? false,
		rows: (goal.rows ?? []).map((row) => ({
			...row,
			...streams.get(row.id)?.perTitleSettings,
		})),
		automaticTemplates: proposal.api.streams
			.filter((stream) => stream.mode === "PER_TITLE_TEMPLATE")
			.map((stream) => ({
				id: stream.rowId,
				...(stream.height === undefined ? {} : { height: stream.height }),
			})),
	};
}

function apiKey(api: PerTitleProposal["api"]): string {
	return JSON.stringify(api, (_key, value: unknown) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(
					Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
				)
			: value,
	);
}

function initialSpacing(goal: PerTitleGoal): PerTitleGoal {
	if (
		goal.strategy === "required-resolutions" &&
		goal.countPolicy.kind === "exact"
	) {
		const countOnly = recommendPerTitleSettings({
			...goal,
			strategy: "count",
			rows: [],
		});
		if (!countOnly.applicable) return goal;
		return {
			...goal,
			minBitrateStepSize: countOnly.api.global.minBitrateStepSize,
			maxBitrateStepSize: countOnly.api.global.maxBitrateStepSize,
		};
	}
	if (goal.strategy !== "fixed-ranges") return goal;
	const rows = [...(goal.rows ?? [])].sort(
		(a, b) => a.height - b.height || (a.minBitrate ?? 0) - (b.minBitrate ?? 0),
	);
	const curves = rows.map((row) => ({
		minimum: row.minBitrate as number,
		maximum: row.maxBitrate as number,
		low: row.lowComplexityBoundaryForMaxBitrate as number,
		high: row.highComplexityBoundaryForMaxBitrate as number,
	}));
	let minimumStep =
		rows.length > 1
			? (goal.maxBitrate / goal.minBitrate) ** (1 / (2 * (rows.length - 1)))
			: 1.5;
	for (let attempt = 0; attempt < 32; attempt++) {
		const proof = certifyComplexityIntervals(
			curves,
			{ minimum: goal.minBitrate, maximum: goal.maxBitrate },
			minimumStep,
		);
		if (!proof) return goal;
		const lower = Math.max(
			1.01,
			proof.maximumWithinRowRatio + 0.01,
			1 + 0.5 / goal.minBitrate,
		);
		const upper = proof.minimumAdjacentRatio;
		if (minimumStep > lower && (upper === undefined || minimumStep <= upper)) {
			return {
				...goal,
				minBitrateStepSize: minimumStep,
				maxBitrateStepSize: Math.max(
					minimumStep,
					proof.maximumAdjacentRatio ?? minimumStep,
				),
			};
		}
		if (upper !== undefined && upper <= lower) return goal;
		const next =
			upper === undefined
				? lower + 1 / goal.minBitrate
				: Math.sqrt(lower * upper);
		if (!Number.isFinite(next) || next <= 1 || next === minimumStep)
			return goal;
		minimumStep = next;
	}
	return goal;
}

/** Build a fresh requirements-based draft without requesting an encoding. */
export function buildPerTitleSetup(
	input: PerTitleSetupInput,
	allowedCodecs: readonly PerTitleCodec[] = PUBLIC_CODECS,
): PerTitleSetupResult {
	const issues = validate(input, allowedCodecs);
	if (issues.length)
		return {
			status: "conflict",
			goal: null,
			proposal: null,
			issues,
			reasoning: [],
		};
	const isClosed = closed(input.strategy);
	const goal: PerTitleGoal = {
		strategy: input.strategy,
		codec: input.codec,
		minBitrate: input.minBitrate,
		maxBitrate: input.maxBitrate,
		countPolicy: isClosed
			? { kind: "exact", count: input.rows.length }
			: input.count === undefined
				? { kind: "unrestricted" }
				: { kind: "exact", count: input.count },
		rows:
			input.strategy === "fixed-ranges"
				? allocateRanges(input)
				: input.rows.map((row) => ({ id: row.id, height: row.height })),
		autoRepresentations: isClosed ? false : {},
		...(isClosed ? { automaticTemplates: [] } : {}),
		...(input.inputHeight === undefined
			? {}
			: { inputHeight: input.inputHeight }),
	};
	if (goal.strategy === "fixed-ranges") {
		const rows = goal.rows ?? [];
		const highestHeight = Math.max(...rows.map((row) => row.height));
		const floor = Math.max(
			...rows
				.filter((row) => row.height === highestHeight)
				.map((row) => row.minBitrate ?? NaN),
		);
		if (
			floor >= goal.maxBitrate &&
			rows.some((row) => row.minBitrate !== row.maxBitrate)
		)
			return {
				status: "conflict",
				goal: null,
				proposal: null,
				issues: [
					{
						code: "unreachable-minimum",
						field: "rows",
						message: {
							en: "Lower the highest fixed rendition's minimum below the overall maximum, or make every range constant. Its current minimum leaves no analysis interval for the other ranges to vary.",
							ja: "最高固定段の最小ビットレートを全体の上限より下げるか、すべての段を一定値にしてください。現在の最小値では、ほかの段が変動する解析範囲を確保できません。",
						},
					},
				],
				reasoning: [],
			};
	}
	const prepared = initialSpacing(goal);
	const recommendation =
		prepared.minBitrateStepSize === undefined
			? recommendPerTitleSettings(prepared)
			: tunePerTitleSettings(prepared, prepared).proposal;
	const loaded = materialize(goal, recommendation);
	const tuned = tunePerTitleSettings(loaded, loaded);
	const proposal = tuned.proposal;
	const fixedRows = proposal.api.streams.filter(
		(stream) => stream.mode !== "PER_TITLE_TEMPLATE",
	);
	const preserved =
		input.minBitrate === proposal.api.global.minBitrate &&
		input.maxBitrate === proposal.api.global.maxBitrate &&
		fixedRows.length === input.rows.length &&
		input.rows.every((row) => {
			const stream = fixedRows.find((item) => item.rowId === row.id);
			return (
				stream?.height === row.height &&
				(row.minBitrate === undefined ||
					stream.perTitleSettings?.minBitrate === row.minBitrate) &&
				(row.maxBitrate === undefined ||
					stream.perTitleSettings?.maxBitrate === row.maxBitrate)
			);
		}) &&
		(!isClosed ||
			(proposal.api.streams.length === input.rows.length &&
				proposal.api.global.autoRepresentations === undefined &&
				proposal.api.global.fixedResolutionAndBitrateConfiguration ===
					undefined));
	const conflicts = proposal.diagnostics.filter(
		(item) => item.severity === "conflict",
	);
	if (!preserved || apiKey(recommendation.api) !== apiKey(proposal.api)) {
		return {
			status: conflicts.length ? "conflict" : "unverified",
			goal: null,
			proposal: null,
			issues: [
				{
					code: "unstable-settings",
					message: {
						en: "The settings could not be kept unchanged on loading. Review the requirements before using this draft.",
						ja: "読み込み時に設定が変わるため、この案は確認できていません。要件を見直してください。",
					},
				},
			],
			reasoning: [],
		};
	}
	if (conflicts.length)
		return {
			status: "conflict",
			goal: null,
			proposal: null,
			issues: [
				{
					code: "spacing-conflict",
					field: "rows",
					message: {
						en: "The proposed ranges cannot satisfy this draft's spacing and count checks. Narrow overlapping ranges, widen the overall range, or request fewer rows.",
						ja: "この案では段間隔と本数の条件を満たせません。重なる範囲を狭めるか、全体の範囲を広げるか、本数を減らしてください。",
					},
				},
			],
			reasoning: [],
		};
	if (!proposal.applicable) {
		if (
			goal.strategy === "required-resolutions" &&
			goal.countPolicy.kind === "exact" &&
			goal.countPolicy.count > (goal.rows?.length ?? 0)
		)
			issues.push({
				code: "automatic-count-unverified",
				field: "count",
				message: {
					en: "The requested count is still conditional because some renditions are automatic. Inspect this draft in the simulator, or specify every resolution to close the ladder.",
					ja: "自動生成する段があるため、指定した本数は未確定です。シミュレーターで確認するか、すべての解像度を指定してください。",
				},
			});
		else if (
			proposal.diagnostics.some((item) => item.code === "row-order-unknown")
		)
			issues.push({
				code: "row-order-unverified",
				field: "rows",
				message: {
					en: "The order of equal-resolution probes needs an encoding check. Keep this draft for inspection, or use distinct resolutions.",
					ja: "同じ解像度の段の順序は、エンコードで確認が必要です。この案をシミュレーターで確認するか、異なる解像度を指定してください。",
				},
			});
		else
			issues.push({
				code: "spacing-unverified",
				field: "rows",
				message: {
					en: "These ranges and rendition requirements have no verified spacing candidate. Narrow overlapping ranges, widen the overall range, or request fewer rows.",
					ja: "この範囲と本数では、段間隔を満たす設定を確認できません。重なる範囲を狭めるか、全体の範囲を広げるか、本数を減らしてください。",
				},
			});
	}
	const reasoning: Localized[] = [
		{
			en: "The overall bitrate limits and requested resolutions are retained. Content analysis and encoded quality still require an actual encoding.",
			ja: "全体のビットレート範囲と指定した解像度を維持しています。素材の解析結果と画質は、実際のエンコードで確認してください。",
		},
	];
	if (input.strategy === "fixed-ranges")
		reasoning.push({
			en: "Missing bands start at equal logarithmic positions. The highest fixed minimum anchors the shared complexity scale so the analysis floor reaches each minimum and the overall ceiling reaches each maximum. Spacing is rechecked after rounding; this is a starting allocation, not a measured quality optimum.",
			ja: "未指定の範囲は対数上で等間隔に配分します。最高固定段の最小値を共通の複雑度境界の下側に合わせ、解析範囲の下端で各段の最小値、全体上限で各段の最大値に達するようにしています。丸め後に段間隔を再確認した初期案で、画質を実測した最適値ではありません。",
		});
	if (!isClosed || input.count !== undefined)
		reasoning.push({
			en: "The count is a requirements check, not an Encoding API count parameter or a native output guarantee. Automatic templates may produce a content-dependent ladder.",
			ja: "本数は要件の確認に使う値で、Encoding APIの本数指定や実出力の保証ではありません。自動生成する段は素材によって変わります。",
		});
	return {
		status: issues.length ? "unverified" : "ready",
		goal: loaded,
		proposal,
		issues,
		reasoning,
	};
}
