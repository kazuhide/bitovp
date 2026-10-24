import {
	type PerTitleCodec,
	type PerTitleGoal,
	type PerTitleProposal,
	perTitleSchema,
	perTitleStreamSettingsSchema,
} from "@bitovp/core";
import {
	videoKeys,
	videoMuxingRelPath,
	type WizardMuxing,
	type WizardPerTitleCodec,
	type WizardState,
	type WizardVideoRendition,
} from "./build-plan";
import {
	addVodVideo,
	updateVodVideoHeight,
	updateVodVideoModePaths,
} from "./rendition-copy";

export class PerTitleWizardError extends Error {
	constructor(
		public readonly code:
			| "INVALID_PROPOSAL"
			| "UNSUPPORTED_STATE"
			| "UNSAFE_RESHAPE",
		message: string,
	) {
		super(message);
		this.name = "PerTitleWizardError";
	}
}
const slotFor = (codec: PerTitleCodec) =>
	codec === "H265V2"
		? "h265"
		: codec === "H264"
			? "h264"
			: codec === "H265"
				? "h265"
				: codec === "VP9"
					? "vp9"
					: "av1";
function required<T>(value: T | undefined | null): T {
	if (value === undefined || value === null)
		throw new PerTitleWizardError(
			"UNSUPPORTED_STATE",
			"A required wizard identity or dimension is missing.",
		);
	return value;
}
const codecOf = (row: WizardVideoRendition) => row.codec ?? "H264";
const parameterKeys = [
	"targetQualityCrf",
	"targetQualityQp",
	"complexityFactor",
	"resolutionScaleFactor",
	"codecMinBitrateFactor",
	"codecMaxBitrateFactor",
	"codecBufsizeFactor",
] as const;
const codecField = (codec: PerTitleCodec) =>
	({
		H264: "h264Configuration",
		H265: "h265Configuration",
		H265V2: "h265V2Configuration",
		VP9: "vp9Configuration",
		AV1: "av1Configuration",
	})[codec];
const parameters = (global: WizardPerTitleCodec | undefined) =>
	Object.fromEntries(
		parameterKeys
			.filter((key) => global?.[key] !== undefined)
			.map((key) => [key, global?.[key]]),
	);
const positive = (value: number | undefined | null): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;
const fixedMode = (row: WizardVideoRendition) =>
	row.extras?.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION" ||
	row.extras?.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE";

/** Initial values are visible editing seeds, never inferred provider guarantees. */
export function perTitleGoalFromWizard(
	state: WizardState,
	selectedCodec?: PerTitleCodec,
): PerTitleGoal {
	const codec =
		selectedCodec ?? codecOf(state.videos[0] ?? { height: 360, bitrate: null });
	const selected = state.videos.filter((row) => codecOf(row) === codec);
	if (selected.some((row) => row.height === null && fixedMode(row)))
		throw new PerTitleWizardError(
			"UNSUPPORTED_STATE",
			"A freely scaled template has no explicit height to import into the simulator.",
		);
	const keys = videoKeys(state.videos);
	const global = state.startOptions?.perTitle?.[slotFor(codec)];
	const quality = parameters(global);
	if (
		!perTitleSchema.safeParse({ [codecField(codec)]: quality }).success ||
		(codec !== "H264" &&
			codec !== "H265" &&
			selected.some(
				(row) =>
					row.extras?.perTitleSettings?.codecMaxBitrateFactor !== undefined ||
					row.extras?.perTitleSettings?.codecBufsizeFactor !== undefined,
			))
	) {
		throw new PerTitleWizardError(
			"UNSUPPORTED_STATE",
			"The saved Per-Title settings are not supported by this codec.",
		);
	}
	const fixedResolutionAndBitrateConfiguration = {
		...(global?.forcedRenditionAboveHighestFixedRepresentation !== undefined
			? {
					forcedRenditionAboveHighestFixedRepresentation:
						global.forcedRenditionAboveHighestFixedRepresentation,
				}
			: {}),
		...(global?.forcedRenditionAboveHighestFixedRepresentationFactor !==
		undefined
			? {
					forcedRenditionAboveHighestFixedRepresentationFactor:
						global.forcedRenditionAboveHighestFixedRepresentationFactor,
				}
			: {}),
		...(global?.forcedRenditionAboveHighestFixedRepresentationCalculationMode !==
		undefined
			? {
					forcedRenditionAboveHighestFixedRepresentationCalculationMode:
						global.forcedRenditionAboveHighestFixedRepresentationCalculationMode,
				}
			: {}),
	};
	const rates = selected
		.flatMap((row) => [
			row.bitrate,
			...(row.extras?.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE"
				? [
						row.extras.perTitleSettings?.minBitrate,
						row.extras.perTitleSettings?.maxBitrate,
					]
				: []),
		])
		.filter(positive);
	const minBitrate =
		global?.minBitrate ?? (rates.length ? Math.min(...rates) : 100000);
	const maxBitrate =
		global?.maxBitrate ??
		Math.max(
			rates.length ? Math.max(...rates) : 5000000,
			Math.ceil(minBitrate * 1.5),
		);
	const hasRanges = selected.some(
		(row) =>
			row.extras?.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	);
	// Automatic templates have their own collection. A fixed-resolution row would
	// instead become a fixed-bitrate row, which this import cannot preserve.
	if (
		hasRanges &&
		selected.some(
			(row) =>
				row.extras?.mode !==
					"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" &&
				row.extras?.mode !== "PER_TITLE_TEMPLATE",
		)
	) {
		throw new PerTitleWizardError(
			"UNSUPPORTED_STATE",
			"The simulator cannot import this ladder without changing a stream's mode. Use fixed bitrate ranges with automatic templates, or edit the streams directly.",
		);
	}
	const hasFixed = selected.some(fixedMode);
	const strategy = hasRanges
		? "fixed-ranges"
		: hasFixed
			? selected.every(fixedMode)
				? "fixed-resolutions"
				: "required-resolutions"
			: "automatic";
	const automaticTemplates = state.videos.flatMap((row, index) =>
		codecOf(row) !== codec || row.extras?.mode !== "PER_TITLE_TEMPLATE"
			? []
			: [
					{
						id: required(keys[index]),
						...(row.height === null ? {} : { height: row.height }),
						...(row.width === undefined ? {} : { width: row.width }),
						...structuredClone(row.extras.perTitleSettings ?? {}),
					},
				],
	);
	return {
		codec,
		strategy,
		minBitrate,
		maxBitrate,
		...quality,
		autoRepresentations:
			global?.autoRepresentations === true
				? {
						...(global.adoptConfigurationThreshold !== undefined
							? {
									adoptConfigurationThreshold:
										global.adoptConfigurationThreshold,
								}
							: {}),
					}
				: false,
		...(global?.minBitrateStepSize !== undefined
			? { minBitrateStepSize: global.minBitrateStepSize }
			: {}),
		...(global?.maxBitrateStepSize !== undefined
			? { maxBitrateStepSize: global.maxBitrateStepSize }
			: {}),
		...(Object.keys(fixedResolutionAndBitrateConfiguration).length
			? { fixedResolutionAndBitrateConfiguration }
			: {}),
		countPolicy: { kind: "unrestricted" },
		...(automaticTemplates.length ? { automaticTemplates } : {}),
		rows: state.videos.flatMap((row, index) =>
			codecOf(row) !== codec ||
			row.height === null ||
			row.extras?.mode === "PER_TITLE_TEMPLATE" ||
			(strategy === "required-resolutions" && !fixedMode(row))
				? []
				: [
						{
							id: required(keys[index]),
							height: required(row.height),
							...(row.width === undefined ? {} : { width: row.width }),
							...structuredClone(row.extras?.perTitleSettings ?? {}),
						},
					],
		),
	};
}

function assertProposal(proposal: PerTitleProposal, codec: PerTitleCodec) {
	const api = proposal.api;
	const global = api.global;
	const streams = api.streams;
	const automatic = global.autoRepresentations;
	const validAutomatic =
		automatic === undefined ||
		(automatic !== null &&
			typeof automatic === "object" &&
			!Array.isArray(automatic) &&
			Object.keys(automatic).every(
				(key) => key === "adoptConfigurationThreshold",
			) &&
			(automatic.adoptConfigurationThreshold === undefined ||
				(Number.isFinite(automatic.adoptConfigurationThreshold) &&
					automatic.adoptConfigurationThreshold >= 0 &&
					automatic.adoptConfigurationThreshold <= 1)));
	const validInteger = (n: number | undefined): n is number =>
		typeof n === "number" && Number.isSafeInteger(n) && n > 0;
	const validSettings = (row: PerTitleProposal["api"]["streams"][number]) => {
		const settings = row.perTitleSettings;
		if (settings === undefined) return true;
		if (!perTitleStreamSettingsSchema.safeParse(settings).success) return false;
		if (
			(settings.codecMaxBitrateFactor !== undefined ||
				settings.codecBufsizeFactor !== undefined) &&
			codec !== "H264" &&
			codec !== "H265"
		)
			return false;
		const {
			codecMaxBitrateFactor: _max,
			codecBufsizeFactor: _buf,
			...fixed
		} = settings;
		return (
			row.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" ||
			Object.keys(fixed).length === 0
		);
	};
	if (
		proposal.codec !== codec ||
		!validAutomatic ||
		!perTitleSchema.safeParse({ [codecField(codec)]: global }).success ||
		!proposal.applicable ||
		proposal.status !== "candidate" ||
		streams.length === 0 ||
		streams.length > 64 ||
		new Set(streams.map((row) => row.rowId)).size !== streams.length ||
		!validInteger(global.minBitrate) ||
		!validInteger(global.maxBitrate) ||
		global.minBitrate > global.maxBitrate ||
		!Number.isFinite(global.minBitrateStepSize) ||
		global.minBitrateStepSize <= 1 ||
		!Number.isFinite(global.maxBitrateStepSize) ||
		global.maxBitrateStepSize < global.minBitrateStepSize ||
		streams.some(
			(row) =>
				!row.rowId ||
				(row.height === undefined
					? row.mode !== "PER_TITLE_TEMPLATE"
					: !validInteger(row.height)) ||
				(row.width !== undefined && !validInteger(row.width)) ||
				![
					"PER_TITLE_TEMPLATE",
					"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
					"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
				].includes(row.mode) ||
				!validSettings(row) ||
				(row.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" &&
					(!row.perTitleSettings ||
						!validInteger(row.perTitleSettings.minBitrate) ||
						!validInteger(row.perTitleSettings.maxBitrate) ||
						row.perTitleSettings.minBitrate > row.perTitleSettings.maxBitrate ||
						(row.perTitleSettings.bitrateSelectionMode !== undefined &&
							!["OPTIMIZED", "COMPLEXITY_RANGE"].includes(
								row.perTitleSettings.bitrateSelectionMode,
							)) ||
						(row.perTitleSettings.bitrateSelectionMode === "COMPLEXITY_RANGE" &&
							(!positive(
								row.perTitleSettings.lowComplexityBoundaryForMaxBitrate,
							) ||
								!positive(
									row.perTitleSettings.highComplexityBoundaryForMaxBitrate,
								) ||
								row.perTitleSettings.lowComplexityBoundaryForMaxBitrate >=
									row.perTitleSettings.highComplexityBoundaryForMaxBitrate)))),
		)
	) {
		throw new PerTitleWizardError(
			"INVALID_PROPOSAL",
			"The proposal is not an applicable candidate for this codec.",
		);
	}
}

/** Apply only to a captured wizard snapshot; the caller must present the full plan diff. */
export function applyPerTitleProposal(
	state: WizardState,
	proposal: PerTitleProposal,
	codec: PerTitleCodec,
): WizardState {
	assertProposal(proposal, codec);
	const keys = videoKeys(state.videos);
	if (new Set(keys).size !== keys.length)
		throw new PerTitleWizardError(
			"UNSUPPORTED_STATE",
			"Existing rendition identities are ambiguous.",
		);
	const selected = state.videos.flatMap((row, index) =>
		codecOf(row) === codec ? [index] : [],
	);
	const explicitlyRequested = new Set(
		proposal.api.streams
			.filter((stream) => stream.mode !== "PER_TITLE_TEMPLATE")
			.map((stream) => stream.rowId),
	);
	const automaticRows = selected.filter(
		(index) =>
			state.videos[index]?.extras?.mode === "PER_TITLE_TEMPLATE" &&
			!explicitlyRequested.has(required(keys[index])),
	);
	const automaticIndex =
		automaticRows.length === 1
			? automaticRows[0]
			: proposal.api.streams.length === 1 && selected.length === 1
				? selected[0]
				: undefined;
	const automaticStreams = proposal.api.streams.filter(
		(stream) => stream.mode === "PER_TITLE_TEMPLATE",
	);
	const streams = proposal.api.streams.map((stream) =>
		automaticStreams.length === 1 &&
		stream.mode === "PER_TITLE_TEMPLATE" &&
		automaticIndex !== undefined &&
		!keys.includes(stream.rowId)
			? { ...stream, rowId: required(keys[automaticIndex]) }
			: stream,
	);

	const selectedKeys = new Set(selected.map((index) => required(keys[index])));
	const requested = new Set(streams.map((row) => row.rowId));
	if (
		streams.some(
			(row) => keys.includes(row.rowId) && !selectedKeys.has(row.rowId),
		)
	)
		throw new PerTitleWizardError(
			"INVALID_PROPOSAL",
			"A proposal cannot replace a different codec's rendition.",
		);
	const removed = new Set(
		[...selectedKeys].filter((key) => !requested.has(key)),
	);
	const added = streams.filter((row) => !selectedKeys.has(row.rowId));
	const muxingKeys = new Set(
		selected.flatMap((index) => [
			required(keys[index]),
			...[
				required(state.videos[index]).muxing,
				...(required(state.videos[index]).extraMuxings ?? []),
			].flatMap((leg) => (leg?.key ? [leg.key] : [])),
		]),
	);
	if (state.drm?.some((row) => muxingKeys.has(row.muxingKey)))
		throw new PerTitleWizardError(
			"UNSAFE_RESHAPE",
			"DRM-bound renditions cannot be changed by the simulator.",
		);
	if (
		(added.length > 0 && selected.length > 1) ||
		state.thumbnails?.some((row) => removed.has(row.streamKey)) ||
		state.sprites?.some((row) => removed.has(row.streamKey)) ||
		state.qc?.gate?.rules.some((rule) =>
			rule.renditions?.some((key) => removed.has(key)),
		)
	)
		throw new PerTitleWizardError(
			"UNSAFE_RESHAPE",
			"This ladder reshape needs explicit editing of its rendition bindings.",
		);
	if (
		selected.some((index) => {
			const row = required(state.videos[index]);
			return (
				!!row.extras?.hlsVariantUri ||
				[row.muxing, ...(row.extraMuxings ?? [])].some(
					(leg) => (leg?.muxedAudioKeys?.length ?? 0) > 0,
				)
			);
		})
	)
		throw new PerTitleWizardError(
			"UNSUPPORTED_STATE",
			"Per-Title requires separate audio containers and generated video playlist names.",
		);

	let next = structuredClone(state);
	const originalPaths = new Map(
		state.videos.map((row, index) => [
			required(keys[index]),
			videoMuxingRelPath(row, required(keys[index])),
		]),
	);
	if (next.drm)
		next.drm = next.drm.map((row) =>
			row.path === undefined && originalPaths.has(row.muxingKey)
				? { ...row, path: required(originalPaths.get(row.muxingKey)) }
				: row,
		);
	// Pin destinations before explicit identities change the default path derivation.
	// A DRM-owned leg without a clear output must retain that omission.
	next.videos = next.videos.map((row, index) => {
		const key = required(keys[index]);
		const path = videoMuxingRelPath(row, key);
		const pinLeg = (leg: WizardMuxing | undefined) => {
			if (
				leg?.path !== undefined ||
				state.drm?.some((drm) => drm.muxingKey === (leg?.key ?? key))
			)
				return leg;
			return { ...leg, path, autoPath: path };
		};
		return {
			...row,
			extras: { ...row.extras, key },
			muxing: pinLeg(row.muxing),
			...(row.extraMuxings
				? { extraMuxings: row.extraMuxings.map((leg) => required(pinLeg(leg))) }
				: {}),
		};
	});
	const indices = new Map(keys.map((key, index) => [key, index]));
	for (const stream of added) {
		const sourceIndex = selected[0];
		const patch = addVodVideo(next, sourceIndex);
		next.videos = patch.videos;
		const index = next.videos.length - 1;
		next.videos[index] = { ...required(next.videos[index]), codec };
		if (stream.height !== undefined)
			next = { ...next, ...updateVodVideoHeight(next, index, stream.height) };
		else if (sourceIndex === undefined)
			next.videos[index] = { ...required(next.videos[index]), height: null };
		indices.set(stream.rowId, index);
	}
	const beforeModes = structuredClone(next);
	const byIndex = new Map(
		streams.map((stream) => [required(indices.get(stream.rowId)), stream]),
	);
	next.videos = next.videos.map((row, index) => {
		const stream = byIndex.get(index);
		if (!stream) return row;
		const { perTitleSettings: _old, ...extras } = row.extras ?? {};
		return {
			...row,
			width: stream.width,
			height: stream.height ?? null,
			bitrate: null,
			extras: {
				...extras,
				mode: stream.mode,
				...(stream.perTitleSettings
					? { perTitleSettings: structuredClone(stream.perTitleSettings) }
					: {}),
			},
		};
	});
	next = { ...next, ...updateVodVideoModePaths(beforeModes, next.videos) };
	next.videos = next.videos.filter(
		(_row, index) => !removed.has(keys[index] ?? ""),
	);
	const finalKeys = videoKeys(next.videos);
	if (
		next.videos.some(
			(row, index) =>
				codecOf(row) === codec &&
				[row.muxing, ...(row.extraMuxings ?? [])].some(
					(leg) =>
						!/\{(?:uuid|bitrate)\}/.test(
							leg?.path ?? videoMuxingRelPath(row, required(finalKeys[index])),
						),
				),
		)
	)
		throw new PerTitleWizardError(
			"UNSUPPORTED_STATE",
			"A manual output path needs a {uuid} or {bitrate} placeholder before applying Per-Title.",
		);
	const slot = slotFor(codec);
	const previous = next.startOptions?.perTitle?.[slot];
	const {
		forcedRenditionAboveHighestFixedRepresentation: _count,
		forcedRenditionAboveHighestFixedRepresentationFactor: _factor,
		forcedRenditionAboveHighestFixedRepresentationCalculationMode: _mode,
		adoptConfigurationThreshold: _threshold,
		...quality
	} = previous ?? {};
	const {
		fixedResolutionAndBitrateConfiguration,
		autoRepresentations,
		...settings
	} = proposal.api.global;
	const global: WizardPerTitleCodec = {
		...Object.fromEntries(
			Object.entries(quality).filter(
				([key]) => !proposal.managedGlobalSettings?.includes(key),
			),
		),
		...settings,
		...fixedResolutionAndBitrateConfiguration,
		autoRepresentations: autoRepresentations !== undefined,
		...(autoRepresentations?.adoptConfigurationThreshold !== undefined
			? {
					adoptConfigurationThreshold:
						autoRepresentations.adoptConfigurationThreshold,
				}
			: {}),
	};
	next.startOptions = {
		...next.startOptions,
		perTitle: { ...next.startOptions?.perTitle, [slot]: global },
	};
	next.timing = "POST_ENCODING";
	return next;
}
