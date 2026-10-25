import type {
	PerTitleApiSettings,
	PerTitleCodec,
	PerTitleGoal,
	PerTitleGoalRow,
} from "@bitovp/core";
import {
	buildPerTitleSetup,
	type PerTitleSetupInput,
	type PerTitleSetupIssue,
	type PerTitleSetupResult,
} from "./per-title-guided-setup-model";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

type StreamMode = PerTitleApiSettings["streams"][number]["mode"];
export type PerTitleStreamRequirement = {
	id: string;
	mode: StreamMode;
	height?: number;
	width?: number;
	minBitrate?: number;
	maxBitrate?: number;
};
export type PerTitleStreamSetupInput = Omit<
	PerTitleSetupInput,
	"rows" | "automaticEdges"
> & { streams: readonly PerTitleStreamRequirement[] };

const TEMPLATE = "PER_TITLE_TEMPLATE";
const RESOLUTION = "PER_TITLE_TEMPLATE_FIXED_RESOLUTION";
const RANGE = "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE";
const publicCodecs: readonly PerTitleCodec[] = ["H264", "H265", "VP9", "AV1"];
const dimension = (value: number) => Number.isSafeInteger(value) && value > 0;
const conflict = (issues: PerTitleSetupIssue[]): PerTitleSetupResult => ({
	status: "conflict",
	goal: null,
	proposal: null,
	issues,
	reasoning: [],
});
const common = (input: PerTitleStreamSetupInput) => ({
	codec: input.codec,
	minBitrate: input.minBitrate,
	maxBitrate: input.maxBitrate,
	...(input.targetQualityCrf === undefined
		? {}
		: { targetQualityCrf: input.targetQualityCrf }),
	...(input.inputHeight === undefined
		? {}
		: { inputHeight: input.inputHeight }),
});

function validateStreams(
	input: PerTitleStreamSetupInput,
): PerTitleSetupIssue[] {
	const issues: PerTitleSetupIssue[] = [];
	const add = (field: string, en: string, ja: string, rowId?: string) =>
		issues.push({
			code: "invalid-stream-requirement",
			field,
			rowId,
			message: { en, ja },
		});
	if (
		!Array.isArray(input.streams) ||
		input.streams.length < 1 ||
		input.streams.length > 64
	) {
		add(
			"rows",
			"Use 1 to 64 Stream templates.",
			"Streamテンプレートは1〜64行で指定してください。",
		);
		return issues;
	}
	if (
		![
			"automatic",
			"count",
			"required-resolutions",
			"fixed-resolutions",
			"fixed-ranges",
		].includes(input.strategy)
	)
		add(
			"strategy",
			"Choose a supported setup.",
			"設定方法を選択してください。",
		);
	if (input.strategy === "count" && input.count === undefined)
		add(
			"count",
			"Enter the requested output count.",
			"希望する映像出力数を入力してください。",
		);
	if (
		input.count !== undefined &&
		(!dimension(input.count) || input.count > 64)
	)
		add(
			"count",
			"Enter an output count from 1 to 64.",
			"希望する映像出力数は1〜64の整数で指定してください。",
		);
	const ids = new Set<string>();
	for (const stream of input.streams) {
		if (
			!stream ||
			typeof stream.id !== "string" ||
			!stream.id.trim() ||
			ids.has(stream.id)
		) {
			add(
				"rows",
				"Give each Stream a distinct identity.",
				"各Streamの識別子が重複しています。",
			);
			continue;
		}
		ids.add(stream.id);
		if (![TEMPLATE, RESOLUTION, RANGE].includes(stream.mode))
			add(
				"mode",
				"Choose a Per-Title Stream mode.",
				"Per-TitleのStreamモードを選択してください。",
				stream.id,
			);
		if (stream.mode !== TEMPLATE && stream.height === undefined)
			add(
				"height",
				"Specify a height for this fixed Stream mode.",
				"この固定モードでは高さを指定してください。",
				stream.id,
			);
		for (const key of ["height", "width"] as const)
			if (stream[key] !== undefined && !dimension(stream[key]))
				add(
					key,
					"Use a positive whole dimension.",
					"解像度は正の整数で指定してください。",
					stream.id,
				);
		if (
			stream.height !== undefined &&
			input.inputHeight !== undefined &&
			stream.height > input.inputHeight
		)
			add(
				"height",
				"Keep the height at or below the source height.",
				"高さは入力素材の高さ以下にしてください。",
				stream.id,
			);
		if (
			stream.mode !== RANGE &&
			(stream.minBitrate !== undefined || stream.maxBitrate !== undefined)
		)
			add(
				"mode",
				"Bitrate bands require PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE.",
				"ビットレート幅を指定する場合はPER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATEを選択してください。",
				stream.id,
			);
	}
	return issues;
}

function finish(
	input: PerTitleStreamSetupInput,
	goal: PerTitleGoal,
	reasoning: PerTitleSetupResult["reasoning"],
	issues: PerTitleSetupIssue[] = [],
): PerTitleSetupResult {
	const draft = structuredClone(goal);
	delete draft.settingLocks;
	delete draft.adjustments;
	const tuned = tunePerTitleSettings(draft, draft);
	const proposal = tuned.proposal;
	const preserved =
		proposal.api.streams.length === input.streams.length &&
		input.streams.every((stream) => {
			const actual = proposal.api.streams.find(
				(row) => row.rowId === stream.id,
			);
			return (
				actual?.mode === stream.mode &&
				actual.height === stream.height &&
				actual.width === stream.width &&
				(stream.minBitrate === undefined ||
					actual.perTitleSettings?.minBitrate === stream.minBitrate) &&
				(stream.maxBitrate === undefined ||
					actual.perTitleSettings?.maxBitrate === stream.maxBitrate)
			);
		});
	if (
		!preserved ||
		proposal.diagnostics.some((item) => item.severity === "conflict")
	)
		return conflict([
			{
				code: "stream-configuration-conflict",
				field: "rows",
				message: {
					en: "These Stream modes and limits do not form a valid configuration. Adjust the conflicting ranges or the requested count.",
					ja: "指定したStreamモードと範囲では設定が競合します。帯域幅や希望する本数を確認してください。",
				},
			},
		]);
	return {
		status: issues.length || !proposal.applicable ? "unverified" : "ready",
		goal: draft,
		proposal,
		issues,
		reasoning,
	};
}

/** Create a requirements-based proposal using the actual Stream definitions. */
export function buildPerTitleStreamSetup(
	input: PerTitleStreamSetupInput,
	allowedCodecs: readonly PerTitleCodec[] = publicCodecs,
): PerTitleSetupResult {
	const issues = validateStreams(input);
	if (issues.length) return conflict(issues);
	const globals = buildPerTitleSetup(
		{ ...common(input), strategy: "automatic", rows: [] },
		allowedCodecs,
	);
	if (!globals.goal) return globals;
	const fixed = input.streams.filter((row) => row.mode !== TEMPLATE);
	const ordinary = input.streams.filter((row) => row.mode === TEMPLATE);
	const ranges = fixed.filter((row) => row.mode === RANGE);
	const resolutions = fixed.filter((row) => row.mode === RESOLUTION);
	const fixedInput = (rows: readonly PerTitleStreamRequirement[]) =>
		rows.map((row) => ({
			id: row.id,
			height: row.height as number,
			...(row.minBitrate === undefined ? {} : { minBitrate: row.minBitrate }),
			...(row.maxBitrate === undefined ? {} : { maxBitrate: row.maxBitrate }),
		}));
	const templates = ordinary.map(({ id, height, width }) => ({
		id,
		...(height === undefined ? {} : { height }),
		...(width === undefined ? {} : { width }),
	}));
	const minimumHeight = Math.min(...fixed.map((row) => row.height as number));
	const maximumHeight = Math.max(...fixed.map((row) => row.height as number));
	const before = ordinary.filter(
		(row) => row.height !== undefined && row.height < minimumHeight,
	);
	const after = ordinary.filter(
		(row) => row.height !== undefined && row.height > maximumHeight,
	);
	const compatibleMixed =
		ranges.length > 0 &&
		resolutions.length === 0 &&
		ordinary.length > 0 &&
		before.length <= 1 &&
		before.length + after.length === ordinary.length &&
		new Set(after.map((row) => row.height)).size === after.length &&
		input.streams.every((row) => row.width === undefined);

	if (compatibleMixed) {
		const result = buildPerTitleSetup(
			{
				...common(input),
				strategy: "fixed-ranges",
				...(input.count === undefined ? {} : { count: input.count }),
				rows: fixedInput(ranges),
				automaticEdges: {
					...(before[0] ? { lowerHeight: before[0].height } : {}),
					...(after.length
						? { upperHeights: after.map((row) => row.height as number) }
						: {}),
				},
			},
			allowedCodecs,
		);
		if (!result.goal) return result;
		return finish(
			input,
			{
				...result.goal,
				rows: result.goal.rows?.map((row) => ({ ...row, mode: RANGE })),
				automaticTemplates: result.goal.automaticTemplates?.map((row) => {
					const original = ordinary.find(
						(stream) => stream.height === row.height,
					);
					return { ...row, id: original?.id ?? row.id };
				}),
			},
			result.reasoning,
			result.issues,
		);
	}

	const seed = fixed.length
		? buildPerTitleSetup(
				{
					...common(input),
					strategy: ranges.length ? "fixed-ranges" : "fixed-resolutions",
					rows: fixedInput(ranges.length ? ranges : resolutions),
				},
				allowedCodecs,
			)
		: buildPerTitleSetup(
				{
					...common(input),
					strategy: input.count === undefined ? "automatic" : "count",
					...(input.count === undefined ? {} : { count: input.count }),
					rows: [],
				},
				allowedCodecs,
			);
	if (!seed.goal) return seed;
	const prepared = seed.goal;
	const rows: PerTitleGoalRow[] = fixed.map((stream) => ({
		...(stream.mode === RANGE
			? prepared.rows?.find((row) => row.id === stream.id)
			: {}),
		id: stream.id,
		height: stream.height as number,
		mode: stream.mode as PerTitleGoalRow["mode"],
		...(stream.width === undefined ? {} : { width: stream.width }),
	}));
	const goal: PerTitleGoal = {
		...prepared,
		strategy: ranges.length
			? "fixed-ranges"
			: fixed.length
				? ordinary.length
					? "required-resolutions"
					: "fixed-resolutions"
				: input.count === undefined
					? "automatic"
					: "count",
		rows,
		automaticTemplates: templates,
		autoRepresentations:
			ordinary.some(
				(row) => row.height === undefined && row.width === undefined,
			) && !ranges.length
				? {}
				: false,
		countPolicy:
			input.count !== undefined
				? { kind: "exact", count: input.count }
				: ordinary.length
					? { kind: "unrestricted" }
					: { kind: "exact", count: fixed.length },
	};
	return finish(input, goal, [
		{
			en: "Each Stream retains its selected mode and dimensions. Only fixed-bitrate streams receive bitrate bands. Ordinary templates are analysis inputs, not a fixed output count.",
			ja: "各Streamのモードと解像度を保ち、ビットレート幅は固定帯域のStreamだけに設定します。通常テンプレートの数は、実際の出力本数ではありません。",
		},
	]);
}
