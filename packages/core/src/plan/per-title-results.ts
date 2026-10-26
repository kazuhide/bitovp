import { z } from "zod";
import { streamPerTitleSettings } from "./per-title-settings";
import {
	isQcMirrorOutputPath,
	QC_MIRROR_MUXING_TYPES,
	qcMirrorFilename,
} from "./qc-mirror";
import {
	type EncodingPlan,
	type PlanRendition,
	perTitleFixedResolutionAndBitrateSettingsSchema,
	type perTitleStreamSettingsSchema,
} from "./schema";

/**
 * Per-Title RESULT capture — the template↔result distinction, persisted.
 *
 * `PER_TITLE_TEMPLATE*` streams carry the operator's INTENT (they are in the
 * plan, so we have always been able to show them); `PER_TITLE_RESULT` streams
 * carry what the encoder actually produced, and they exist only after the run.
 * Bitmovin purges encoding data after ~90 days (C7), so a result the UI does not
 * capture at the end of the run is gone for good — the plan alone can never say
 * what the ladder cost.
 *
 * This module is the shared half of that capture: the snapshot shape, the scan
 * accounting, and the attribution rule. The I/O is a narrow PORT so the same
 * code runs from the orchestrator step (primary) and from the backfill route
 * (jobs that predate the step) — one implementation, two callers.
 *
 * `packages/core` carries no `@bitmovin/api-sdk` dependency on purpose (it is
 * the UI-free, browser-safe domain package), which is why the SDK-facing work —
 * pagination and the polymorphic codec-config get — lives in the adapters. What
 * would otherwise diverge between those two adapters is kept here as DATA:
 * `CODEC_CONFIG_API_PATH` and `SCAN_PAGE_CAP`.
 */

/** Bitmovin's own mode string for an encoder-produced per-title stream. */
export const PER_TITLE_RESULT_MODE = "PER_TITLE_RESULT";

/**
 * A per-title TEMPLATE mode is any mode with this prefix — there are three
 * (plain, FIXED_RESOLUTION, FIXED_RESOLUTION_AND_BITRATE) and Bitmovin may add
 * more. Prefix-matching is what bm-xray's `isTemplateStream` does and it is the
 * only form that survives a new mode being introduced upstream.
 */
export const PER_TITLE_TEMPLATE_MODE_PREFIX = "PER_TITLE_TEMPLATE";

export function isPerTitleTemplateMode(mode: string): boolean {
	return mode.startsWith(PER_TITLE_TEMPLATE_MODE_PREFIX);
}

export function isPerTitleResultMode(mode: string): boolean {
	return mode === PER_TITLE_RESULT_MODE;
}

/**
 * Where the polymorphic codec-config get lives for each codec the plan schema
 * can emit: `api.encoding.configurations[...path].get(id)`.
 *
 * The flow is bm-xray's: `configurations.type.get(id)` returns the codec type,
 * then the TYPED endpoint returns the full parameter set. Bitmovin has no
 * "get any codec config with all its fields" endpoint, so the switch is
 * unavoidable — but it exists once, as data, because two adapters need it and a
 * forked copy is how the audio-codec set went wrong before (the shared contract's
 * "never fork types locally", applied to tables).
 *
 * Keyed by the SDK's `CodecConfigType` values, which are identical strings to
 * the plan schema's `codec` discriminants — `per-title-results.test.ts` reads
 * the discriminants out of `renditionSchema` and fails if one is missing here,
 * so a codec added to the plan cannot silently lose its result parameters.
 */
export const CODEC_CONFIG_API_PATH: Readonly<
	Record<string, readonly [string, string]>
> = Object.freeze({
	H264: ["video", "h264"],
	H265: ["video", "h265"],
	H265V2: ["video", "h265v2"],
	VP9: ["video", "vp9"],
	AV1: ["video", "av1"],
	AAC: ["audio", "aac"],
	OPUS: ["audio", "opus"],
	DOLBY_ATMOS: ["audio", "dolbyAtmos"],
	DDPLUS: ["audio", "dolbyDigitalPlus"],
	DD: ["audio", "dolbyDigital"],
	WEBVTT: ["subtitles", "webvtt"],
	IMSC: ["subtitles", "imsc"],
});

/**
 * Pagination safety cap, shared by both adapters (C6 says limit ≤ 100 and
 * always paginate; it does not say "trust the API to terminate"). Hitting the
 * cap is reported as `scan.complete: false` rather than silently truncating —
 * an operator reading a short ladder must be able to tell "that is all of it"
 * from "that is all we fetched".
 */
export const SCAN_PAGE_CAP = 50;

/** The normalized provider/plan shape used for exact fixed-template identity. */
export const capturedPerTitleSettingsSchema = z.strictObject({
	fixedResolutionAndBitrateSettings:
		perTitleFixedResolutionAndBitrateSettingsSchema.optional(),
	codecMaxBitrateFactor: z.number().positive().optional(),
	codecBufsizeFactor: z.number().positive().optional(),
});
export type CapturedPerTitleSettings = z.infer<
	typeof capturedPerTitleSettingsSchema
>;

/** One stream row as the adapters see it, before any per-title reasoning. */
export type ScannedStream = {
	streamId: string;
	mode: string;
	codecConfigId?: string;
	appliedSettings?: { width?: number; height?: number };
	/** Provider-copied template settings on a generated fixed RESULT. */
	perTitleSettings?: CapturedPerTitleSettings;
};

/** An output a resource writes to: WHICH output, and the path within it. */
export type ScannedOutput = {
	outputId?: string;
	outputPath?: string;
	acl?: unknown;
};

/**
 * One muxing row, kind-agnostic (the `type` discriminant comes back on it),
 * with **every** output it writes and every DRM resource on it.
 *
 * PLURAL, both of them, and that is not defensive style — it is the shape of the
 * API and the shape of the bugs this repo has already had. `Muxing.outputs` and
 * `Drm.outputs` are both arrays, a muxing can be encrypted more than once (CENC to
 * one path AND FairPlay to another), and a DRM'd muxing usually has NO output of
 * its own — the python samples say so in as many words: "Create Fmp4 muxing
 * without specifying output" / "Cenc CBC DRM with output". Reading one output, or
 * skipping the DRM hop, is exactly how `storageSummaries` hid 8 of 16 writes.
 *
 * So the full chain for a per-title result is
 * `stream → muxing → (drm) → output → outputPath`, and the resolved path is the
 * one thing about a result that the plan can never state: C4 requires
 * `{uuid}`/`{bitrate}` placeholders, so where a rung actually landed is only
 * knowable after the run.
 */
export type ScannedMuxing = {
	muxingId: string;
	muxingType: string;
	streamIds: string[];
	/**
	 * The single-file muxing's `filename` (MP4/progressive WebM). For a muxing
	 * whose direct output ends in the compiler-owned `qc/` directory, this is the
	 * correlation key stamped with the plan rendition key (`qcMirrorFilename`,
	 * ). Other delivery muxings — including Smooth MP4 — correlate
	 * through exact fixed settings or a template-specific resolved path marker.
	 * Dropping the filename made attribution abstain on every QC-enabled
	 * same-codec ladder. Absent on segmented
	 * muxings (fMP4/TS name their segments instead).
	 */
	filename?: string;
	/** The muxing's resource name — kept for diagnostics beside `filename`. */
	name?: string;
	avgBitrate?: number;
	maxBitrate?: number;
	segmentsMuxed?: number;
	/** The muxing's own outputs — empty for a fully-DRM'd muxing. */
	outputs: ScannedOutput[];
	/** DRM resources on this muxing, each with the outputs IT writes. */
	drm: Array<{ drmId: string; drmType: string; outputs: ScannedOutput[] }>;
};

/** A paginated list plus whether it reached the end. */
export type ScanPage<T> = { items: T[]; complete: boolean };

/**
 * The I/O the capture needs. Both implementations paginate to exhaustion (or to
 * `SCAN_PAGE_CAP`, reporting `complete: false`).
 *
 * `getCodecConfig` returns `null` only when the config is unreachable; an
 * unmapped codec type comes back as `{codecType, params: {}}` so an unknown
 * codec degrades to "we know what it is, not what it was set to" instead of
 * throwing away the whole capture.
 */
export type PerTitleCapturePort = {
	listStreams(encodingId: string): Promise<ScanPage<ScannedStream>>;
	listMuxings(encodingId: string): Promise<ScanPage<ScannedMuxing>>;
	getCodecConfig(
		configId: string,
	): Promise<{ codecType: string; params: Record<string, unknown> } | null>;
};

const scannedOutputSchema = z.strictObject({
	outputId: z.string().optional(),
	outputPath: z.string().optional(),
	acl: z.unknown().optional(),
});

export const perTitleResultMuxingSchema = z.strictObject({
	muxingId: z.string(),
	muxingType: z.string(),
	/**
	 * The single-file muxing's `filename` — the RESULT↔template correlation key
	 * OPTIONAL so segmented muxings (no filename) and
	 * snapshots written before this field existed still parse; when present it is
	 * persisted verbatim through capture → DB → re-read.
	 */
	filename: z.string().optional(),
	/** The muxing's resource name — diagnostics beside `filename`. */
	name: z.string().optional(),
	avgBitrate: z.number().optional(),
	maxBitrate: z.number().optional(),
	segmentsMuxed: z.number().optional(),
	/** Where this muxing wrote. Empty on a fully-DRM'd muxing — see `drm` below. */
	outputs: z.array(scannedOutputSchema).default([]),
	/** Each DRM on it, with the encrypted outputs it wrote. */
	drm: z
		.array(
			z.strictObject({
				drmId: z.string(),
				drmType: z.string(),
				outputs: z.array(scannedOutputSchema).default([]),
			}),
		)
		.default([]),
});

export const perTitleResultStreamSchema = z.strictObject({
	streamId: z.string(),
	mode: z.literal(PER_TITLE_RESULT_MODE),
	/**
	 * The plan rendition key of the template this result came from, when it can
	 * be attributed. See `attributeResult` — Bitmovin exposes NO link from a
	 * result stream back to its template, so this is our own inference and it is
	 * deliberately optional.
	 */
	templateRendition: z.string().optional(),
	codecConfigId: z.string().optional(),
	codecType: z.string().optional(),
	/** Full typed codec config; `{}` when the codec type has no mapped get. */
	params: z.record(z.string(), z.unknown()),
	appliedSettings: z
		.strictObject({
			width: z.number().optional(),
			height: z.number().optional(),
		})
		.optional(),
	/**
	 * Provider-copied fixed-template identity. Persisted because it is the exact
	 * correlation witness for non-QC, multi-template RESULTs.
	 */
	perTitleSettings: capturedPerTitleSettingsSchema.optional(),
	muxings: z.array(perTitleResultMuxingSchema),
});

/**
 * Scan accounting — the honesty half of the snapshot. Every number here exists
 * so a reader can tell a genuinely short ladder from a short FETCH:
 * `complete: false` means we stopped early, `codecConfigErrors` means some rows
 * carry `params: {}` because the config read failed rather than because the
 * encoder set nothing.
 */
export const perTitleScanSchema = z.strictObject({
	streamsListed: z.number(),
	templatesListed: z.number(),
	/**
	 * How many templates the CALLER declared, versus `templatesListed`, which is
	 * how many the API reported. DEFAULTED, not required: a snapshot written before
	 * this field existed would otherwise fail the strict parse and degrade to
	 * "absent" — rendering a capture that succeeded as "no results", the exact
	 * reading this whole design forbids (review catch). They differ for a reason
	 * worth seeing: the
	 * executor parses the template list out of the persisted op payload, and a
	 * payload written by an older build no longer parses — attribution then
	 * abstains on every row, and without this number the snapshot would look like
	 * "the API told us nothing about templates" instead of "we asked with none".
	 */
	templatesDeclared: z.number().default(0),
	resultsCaptured: z.number(),
	muxingsListed: z.number(),
	complete: z.boolean(),
	codecConfigErrors: z.number(),
	/** Result rows whose template could not be determined (see below). */
	unattributed: z.number(),
});

/**
 * The persisted SHAPE version. Version 1 added muxing `filename`/`name`;
 * version 2 preserves provider-copied fixed per-title settings. Read-side
 * evidence comparison uses it so a fresh snapshot is never shadowed by an
 * older one that lacks its correlation witness.
 * Absent on pre-versioning snapshots, which parse as `schemaVersion: 0`.
 */
export const PER_TITLE_SCHEMA_VERSION = 2;

/**
 * The ATTRIBUTION-algorithm version. 1 = filename-bound; 2 = filename-bound plus
 * exact provider-copied fixed settings; 3 = exact provider-retained output-path
 * markers for flexible results; 4 = QC-directory-qualified filenames with a
 * required provider-codec match. The best-evidence comparison ranks a newer
 * attribution above an older one only AFTER completeness and rung count, so a
 * truncated fresh capture never wins on version alone (§5.4 item 6).
 */
export const PER_TITLE_ATTRIBUTION_VERSION = 4;

export const perTitleResultsSnapshotSchema = z.strictObject({
	capturedAt: z.string(),
	/** Persisted-shape version (see `PER_TITLE_SCHEMA_VERSION`). OPTIONAL so a
	 * snapshot written before versioning still parses; read as 0 when absent. */
	schemaVersion: z.number().optional(),
	/** Attribution-algorithm version (see `PER_TITLE_ATTRIBUTION_VERSION`). */
	attributionVersion: z.number().optional(),
	streams: z.array(perTitleResultStreamSchema),
	scan: perTitleScanSchema,
});

export type PerTitleResultsSnapshot = z.infer<
	typeof perTitleResultsSnapshotSchema
>;
export type PerTitleResultStream = z.infer<typeof perTitleResultStreamSchema>;

/**
 * What the capture step persists as its response. A capture failure is NOT a
 * job failure — the encode succeeded and the snapshot is enrichment — and the
 * step-status enum has no WARN, so the outcome is carried in the response and
 * the step lands DONE either way. The UI reads `captured` and says so; a failed
 * capture must never render as an empty results table.
 */
export const perTitleCaptureOutcomeSchema = z.discriminatedUnion("captured", [
	z.strictObject({
		captured: z.literal(true),
		snapshot: perTitleResultsSnapshotSchema,
	}),
	z.strictObject({ captured: z.literal(false), error: z.string() }),
]);
export type PerTitleCaptureOutcome = z.infer<
	typeof perTitleCaptureOutcomeSchema
>;

/**
 * A per-title template, as ATTRIBUTION needs it: the plan's rendition key and
 * its codec. Pure plan data — no Bitmovin ids.
 *
 * The design sketched a `streamId` here, for a "template streamId join". There
 * is no such join: the API gives a result stream no reference to its template
 * (see `attributeResult`), so a template's stream id could only ever confirm
 * that the template itself exists — which the plan already tells us. Carrying it
 * would have implied a linkage the wire does not have, and would have forced
 * both callers to reconstruct a step→id map for nothing.
 */
export type TemplateStreamRef = {
	/**
	 * The plan rendition key. NAMED `rendition`, not `renditionKey`, because the
	 * step-log redactor masks any property whose name ends in "key" — this value
	 * travels in the capture op's payload and inside the persisted response, and
	 * as `renditionKey` it reached the database as "[REDACTED]", silently
	 * deleting every attribution. `redactSecrets` cannot know our "key" means a
	 * map key rather than a secret, so the field name is the fix.
	 */
	rendition: string;
	/** Effective SDK codec type; internal H265 is H265V2, never family-normalized. */
	codec: string;
	/** Raw template mode. Optional only for payloads written by older builds. */
	mode?:
		| "PER_TITLE_TEMPLATE"
		| "PER_TITLE_TEMPLATE_FIXED_RESOLUTION"
		| "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE";
	/** Plan geometry; `null` means the flexible template does not pin a height. */
	height?: number | null;
	/** Exact fixed settings, in the same normalized shape as provider readback. */
	perTitleSettings?: CapturedPerTitleSettings;
	/**
	 * Full plan output paths, including placeholders. New wizard/preset plans put
	 * the rendition in a static path segment, which survives provider expansion
	 * and identifies flexible RESULTs without inferring from height or bitrate.
	 */
	outputPathPatterns?: string[];
};

type PerTitlePlanRendition = PlanRendition & {
	mode:
		| "PER_TITLE_TEMPLATE"
		| "PER_TITLE_TEMPLATE_FIXED_RESOLUTION"
		| "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE";
	height: number | null;
	perTitleSettings?: z.infer<typeof perTitleStreamSettingsSchema>;
};

/**
 * The plan's per-title template renditions, in plan order. Pure: the compiler
 * calls it to put the list in the capture op's payload, and the backfill route
 * calls it on the job's stored plan. One definition of "what could a result have
 * come from", two callers.
 */
export function perTitleTemplates(plan: EncodingPlan): TemplateStreamRef[] {
	return plan.renditions.filter(isPerTitleRendition).map((rendition) => ({
		rendition: rendition.key,
		codec:
			plan.internal?.hevcV2 && rendition.codec === "H265"
				? "H265V2"
				: rendition.codec,
		mode: rendition.mode,
		height: rendition.height,
		...(rendition.perTitleSettings
			? {
					perTitleSettings: streamPerTitleSettings(rendition.perTitleSettings),
				}
			: {}),
		...(() => {
			const muxings = plan.muxings.filter(
				(muxing) => muxing.streamKey === rendition.key,
			);
			const muxingKeys = new Set(muxings.map((muxing) => muxing.key));
			const paths = [
				...muxings.flatMap((muxing) =>
					muxing.destination ? [muxing.destination.path] : [],
				),
				...plan.drm.flatMap((drm) =>
					muxingKeys.has(drm.muxingKey) ? [drm.destination.path] : [],
				),
			];
			const outputPathPatterns = [...new Set(paths)];
			return outputPathPatterns.length > 0 ? { outputPathPatterns } : {};
		})(),
	}));
}

export const templateStreamRefSchema = z.strictObject({
	rendition: z.string(),
	codec: z.string(),
	mode: z
		.enum([
			"PER_TITLE_TEMPLATE",
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		])
		.optional(),
	height: z.number().nullable().optional(),
	perTitleSettings: capturedPerTitleSettingsSchema.optional(),
	outputPathPatterns: z.array(z.string().min(1)).min(1).optional(),
});

/**
 * Whether the plan enables per-title at all — the compiler's own gate for
 * emitting the capture step, exported so the executor, the route and the tests
 * ask the same question.
 */
export function planHasPerTitle(plan: EncodingPlan): boolean {
	return plan.renditions.some(isPerTitleRendition);
}

/**
 * Shared with the compiler (which used to carry its own equivalent copy): a
 * rendition is a per-title TEMPLATE when it has a `mode` — only the video
 * renditions do — whose value is one of the per-title template modes.
 */
export function isPerTitleRendition(
	rendition: PlanRendition,
): rendition is PerTitlePlanRendition {
	return "mode" in rendition && isPerTitleTemplateMode(rendition.mode);
}

/**
 * Attribute a result stream to the template that produced it — or ABSTAIN.
 *
 * THERE IS NO UPSTREAM LINK in the SDK (a `PER_TITLE_RESULT` stream references
 * no template), so this is our own inference. A QC-enabled result BINDS ON THE
 * QC-MIRROR FILENAME: the compiler stamps every mirror muxing with
 * `qcMirrorFilename(rendition, codec)` = `<renditionKey>.<ext>`,
 * and the provider copies that filename verbatim onto each RESULT's mirror
 * muxing and reads it back. Rendition keys are unique within a plan, so the
 * filename identifies exactly one template — including on the same-codec,
 * many-template ladders where the old codec-only guess abstained on all seven
 * rungs of a real paid run and reported the provider's 6 RESULTs as 0.

 *
 * Fail closed, never guess (§5.4 items 2, 3, 5):
 * - EXACTLY one same-codec template's `qcMirrorFilename` among the result's
 * QC-directory-qualified mirror filenames → that template. Several RESULTs
 * carrying the same filename are fine ("1 template → many results"); this
 * function sees one result at a time and each attributes to the same key.
 * - More than one template matches (two different mirror filenames on one
 * result, or one filename that somehow resolves to two templates) → abstain.
 * - Placeholders (`{height}`/`{width}`/`{bitrate}`) are NEVER consulted: they
 * resolve OBJECT identity, not template identity, and same-height/different-
 * bitrate rungs would mis-file.
 * - Without a filename, a fixed RESULT binds only when codec, fixed mode,
 * applied height, and every normalized copied fixed setting identify exactly
 * one template. A partial/mismatched fixed witness abstains.
 * - A RESULT without copied fixed settings may bind on an exact full output
 * path pattern. The pattern may expand `{…}` within one path segment, but
 * every static byte — including the template-specific segment written by
 * new authoring flows — must match. Shared imported patterns therefore match
 * several templates and abstain; path prefixes and height-only matches do not
 * count.
 *
 * When a flexible result carries neither a mirror filename nor fixed settings,
 * fall back to the one rule that still cannot be wrong: if the plan has exactly
 * one flexible (or legacy mode-less) template of the result's codec, every result
 * of that codec came from it. Fixed templates never use this fallback; a
 * multi-template flexible plan still requires an explicit stable marker.
 *
 * Abstention is visible — `scan.unattributed`, and its own group in the UI —
 * because a rung filed under the wrong template tells an operator a falsehood
 * about their own ladder, which is worse than telling them nothing.
 */
export function attributeResult(
	result: {
		codecType?: string;
		appliedSettings?: { width?: number; height?: number };
		perTitleSettings?: CapturedPerTitleSettings;
		muxings?: readonly {
			muxingType: string;
			filename?: string;
			outputs?: readonly { outputPath?: string }[];
			drm?: readonly { outputs?: readonly { outputPath?: string }[] }[];
		}[];
	},
	templates: readonly TemplateStreamRef[],
): string | undefined {
	// PARSED, not trusted. `templates` reaches here from a persisted op payload, so
	// a corrupt single-element list used to make this return whatever that element's
	// `rendition` was — a NUMBER, for `[{rendition: 7}]` — which then failed the
	// snapshot schema at persistence time, after the capture had already run
	// (review finding: the executor's `.catch([])` did not cover a list that parses
	// as an array of objects).
	const parsed = templateStreamRefSchema.array().safeParse(templates);
	if (!parsed.success) {
		return undefined;
	}
	const safe = parsed.data;

	// The filenames the provider actually wrote on this result's QC-mirror
	// muxings. Smooth/progressive delivery muxings are also single-file and carry
	// filenames, so kind alone is not a QC discriminator: the compiler-owned
	// mirror always writes to an exact trailing `qc/` directory, the same rule the
	// release verifier uses when it derives the QC population.
	const mirrorFilenames = new Set(
		(result.muxings ?? [])
			.filter(
				(m) =>
					QC_MIRROR_MUXING_TYPES.has(m.muxingType.toUpperCase()) &&
					typeof m.filename === "string" &&
					m.filename.length > 0 &&
					(m.outputs ?? []).some(
						(output) =>
							typeof output.outputPath === "string" &&
							isQcMirrorOutputPath(output.outputPath),
					),
			)
			.map((m) => m.filename as string),
	);
	if (mirrorFilenames.size > 0) {
		if (result.codecType === undefined) {
			return undefined;
		}
		const matched = safe.filter((t) =>
			mirrorFilenames.has(qcMirrorFilename(t.rendition, t.codec)),
		);
		// EXACTLY one filename match AND the provider codec, or nothing. Codec may
		// confirm the unique witness, but it must not turn a filename collision into
		// a guess — duplicate rendition keys across codecs remain fail-closed.
		return matched.length === 1 && matched[0]?.codec === result.codecType
			? matched[0].rendition
			: undefined;
	}

	// Non-QC fixed RESULTs still carry the fixed template block the provider
	// copied onto the generated stream. Match the WHOLE identity: codec, fixed
	// mode, plan/result height, and every normalized setting. Height alone is
	// deliberately insufficient (paid H.264 and H.265 both had two fixed rungs
	// at one height), and a partially missing/mismatched fixed witness abstains
	// rather than falling through to a looser rule.
	const resultFixed =
		result.perTitleSettings?.fixedResolutionAndBitrateSettings;
	if (resultFixed !== undefined) {
		const resultHeight = result.appliedSettings?.height;
		if (result.codecType === undefined || resultHeight === undefined) {
			return undefined;
		}
		const fields = [
			"minBitrate",
			"maxBitrate",
			"bitrateSelectionMode",
			"lowComplexityBoundaryForMaxBitrate",
			"highComplexityBoundaryForMaxBitrate",
		] as const;
		const outerFields = [
			"codecMaxBitrateFactor",
			"codecBufsizeFactor",
		] as const;
		if (!fields.some((field) => resultFixed[field] !== undefined)) {
			return undefined;
		}
		const matched = safe.filter((template) => {
			const templateFixed =
				template.perTitleSettings?.fixedResolutionAndBitrateSettings;
			return (
				template.codec === result.codecType &&
				template.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" &&
				template.height === resultHeight &&
				templateFixed !== undefined &&
				fields.every((field) => templateFixed[field] === resultFixed[field]) &&
				outerFields.every(
					(field) =>
						template.perTitleSettings?.[field] ===
						result.perTitleSettings?.[field],
				)
			);
		});
		return matched.length === 1 ? matched[0]?.rendition : undefined;
	}

	// Flexible and fixed-resolution RESULTs do not carry the fixed-bitrate
	// settings witness. New plans give each template a static output-path
	// segment; Bitmovin retains it while resolving the dynamic placeholders.
	// Match the WHOLE path and require one template; fixed-resolution also
	// requires the pinned height. Older shared-path plans stay unattributed.
	const normalizePath = (path: string) => path.replace(/^\/+|\/+$/g, "");
	const escapeRegex = (literal: string) =>
		literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const patternRegex = (pattern: string): RegExp => {
		const normalized = normalizePath(pattern);
		let source = "";
		let cursor = 0;
		for (const placeholder of normalized.matchAll(/\{[^/{}]+\}/g)) {
			const index = placeholder.index ?? 0;
			source += escapeRegex(normalized.slice(cursor, index));
			source += "[^/]+";
			cursor = index + placeholder[0].length;
		}
		source += escapeRegex(normalized.slice(cursor));
		return new RegExp(`^${source}$`);
	};
	const resultPaths = new Set(
		(result.muxings ?? []).flatMap((muxing) => [
			...(muxing.outputs ?? []).flatMap((output) =>
				output.outputPath ? [normalizePath(output.outputPath)] : [],
			),
			...(muxing.drm ?? []).flatMap((drm) =>
				(drm.outputs ?? []).flatMap((output) =>
					output.outputPath ? [normalizePath(output.outputPath)] : [],
				),
			),
		]),
	);
	if (
		result.codecType !== undefined &&
		resultPaths.size > 0 &&
		safe.some((t) => t.outputPathPatterns)
	) {
		const matched = safe.filter(
			(template) =>
				(template.mode === "PER_TITLE_TEMPLATE" ||
					template.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION") &&
				template.codec === result.codecType &&
				(template.outputPathPatterns ?? []).some((pattern) => {
					const matcher = patternRegex(pattern);
					return [...resultPaths].some((path) => matcher.test(path));
				}),
		);
		const template = matched.length === 1 ? matched[0] : undefined;
		if (
			template?.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION" &&
			(typeof template.height !== "number" ||
				template.height !== result.appliedSettings?.height)
		) {
			return undefined;
		}
		return template?.rendition;
	}

	// No mirror filename to bind on. The sole-template-of-codec rule is safe only
	// for flexible (or legacy mode-less) templates. Establish uniqueness before
	// checking mode: a fixed template without its required witness remains a
	// possible origin and must not make a flexible sibling appear unique.
	const codecCandidates =
		result.codecType === undefined
			? safe
			: safe.filter((t) => t.codec === result.codecType);
	const template =
		codecCandidates.length === 1 ? codecCandidates[0] : undefined;
	return template?.mode === "PER_TITLE_TEMPLATE" || template?.mode === undefined
		? template?.rendition
		: undefined;
}

/**
 * Fetch, filter and join the per-title results of one encoding.
 *
 * Reads only — safe to repeat, which is what makes the step idempotent under
 * crash-resume and the backfill route safe to double-click.
 */
export async function capturePerTitleResults(
	port: PerTitleCapturePort,
	options: {
		encodingId: string;
		/** Injected clock: core never calls Date.now (golden/replay determinism). */
		capturedAt: string;
		templates: readonly TemplateStreamRef[];
	},
): Promise<PerTitleResultsSnapshot> {
	const streamPage = await port.listStreams(options.encodingId);
	const templatesListed = streamPage.items.filter((s) =>
		isPerTitleTemplateMode(s.mode),
	).length;
	const results = streamPage.items.filter((s) => isPerTitleResultMode(s.mode));

	// One muxing list for the whole encoding, indexed by stream — N result
	// streams would otherwise mean N list calls of the same page.
	const muxingPage =
		results.length > 0
			? await port.listMuxings(options.encodingId)
			: { items: [], complete: true };
	const muxingsByStream = new Map<string, ScannedMuxing[]>();
	for (const muxing of muxingPage.items) {
		for (const streamId of muxing.streamIds) {
			const list = muxingsByStream.get(streamId);
			if (list) {
				list.push(muxing);
			} else {
				muxingsByStream.set(streamId, [muxing]);
			}
		}
	}

	// One config read per DISTINCT config id: per-title results each get their
	// own generated config, but a shared one must not be fetched twice.
	const configs = new Map<
		string,
		{ codecType: string; params: Record<string, unknown> } | null
	>();
	for (const result of results) {
		const configId = result.codecConfigId;
		if (configId === undefined || configs.has(configId)) {
			continue;
		}
		try {
			configs.set(configId, await port.getCodecConfig(configId));
		} catch {
			// A single unreadable config must not cost the whole ladder: the row
			// still carries its stream id, muxings and applied settings.
			configs.set(configId, null);
		}
	}

	let unattributed = 0;
	/**
	 * Counted per ROW, not per distinct config id.
	 *
	 * The first version incremented once per failed id and skipped rows with no
	 * `codecConfigId` at all, so three result rows sharing one failing config
	 * reported ONE error — an operator seeing three blank rungs and one reported
	 * failure cannot tell "the read failed" from "the encoder set nothing", which
	 * is the entire reason this field exists (review finding).
	 */
	let paramsMissing = 0;
	const streams: PerTitleResultStream[] = results.map((result) => {
		const config =
			result.codecConfigId === undefined
				? null
				: (configs.get(result.codecConfigId) ?? null);
		const codecType = config?.codecType;
		// The persisted muxing rows, built BEFORE attribution because attribution
		// reads both the QC mirror `filename` and segmented output paths. `name` is
		// kept beside them for diagnostics.
		const muxings = (muxingsByStream.get(result.streamId) ?? []).map(
			(muxing) => ({
				muxingId: muxing.muxingId,
				muxingType: muxing.muxingType,
				...(muxing.filename !== undefined ? { filename: muxing.filename } : {}),
				...(muxing.name !== undefined ? { name: muxing.name } : {}),
				...(muxing.avgBitrate !== undefined
					? { avgBitrate: muxing.avgBitrate }
					: {}),
				...(muxing.maxBitrate !== undefined
					? { maxBitrate: muxing.maxBitrate }
					: {}),
				...(muxing.segmentsMuxed !== undefined
					? { segmentsMuxed: muxing.segmentsMuxed }
					: {}),
				outputs: muxing.outputs,
				drm: muxing.drm,
			}),
		);
		const templateRendition = attributeResult(
			{
				...(codecType !== undefined ? { codecType } : {}),
				...(result.appliedSettings !== undefined
					? { appliedSettings: result.appliedSettings }
					: {}),
				...(result.perTitleSettings !== undefined
					? { perTitleSettings: result.perTitleSettings }
					: {}),
				muxings,
			},
			options.templates,
		);
		if (templateRendition === undefined) {
			unattributed += 1;
		}
		if (Object.keys(config?.params ?? {}).length === 0) {
			paramsMissing += 1;
		}
		return {
			streamId: result.streamId,
			mode: PER_TITLE_RESULT_MODE,
			...(templateRendition !== undefined ? { templateRendition } : {}),
			...(result.codecConfigId !== undefined
				? { codecConfigId: result.codecConfigId }
				: {}),
			...(codecType !== undefined ? { codecType } : {}),
			params: config?.params ?? {},
			...(result.appliedSettings !== undefined
				? { appliedSettings: result.appliedSettings }
				: {}),
			...(result.perTitleSettings !== undefined
				? { perTitleSettings: result.perTitleSettings }
				: {}),
			muxings,
		};
	});

	return {
		capturedAt: options.capturedAt,
		schemaVersion: PER_TITLE_SCHEMA_VERSION,
		attributionVersion: PER_TITLE_ATTRIBUTION_VERSION,
		streams,
		scan: {
			streamsListed: streamPage.items.length,
			templatesListed,
			templatesDeclared: options.templates.length,
			resultsCaptured: streams.length,
			muxingsListed: muxingPage.items.length,
			complete: streamPage.complete && muxingPage.complete,
			codecConfigErrors: paramsMissing,
			unattributed,
		},
	};
}

/**
 * ————————————————————————————————————————————————————————————————————————————
 * The READ side: what a job's per-title results are, from what has been stored.
 * ————————————————————————————————————————————————————————————————————————————
 */

/**
 * Where a rendered snapshot came from, so the UI can be honest about it:
 *
 *  - `step`     the capture step's own response — the primary path;
 *  - `snapshot` the `snapshots.perTitleResults` column, written by the backfill
 *               route for jobs that predate the step;
 *  - `failed`   a capture step that ran and could not read the results. NOT the
 *               same as "no results": an empty table here would tell an operator
 *               their per-title encode produced nothing;
 *  - `absent`   no capture has happened (an older job, or one still running).
 */
export type PerTitleResultsOrigin = "step" | "snapshot" | "failed" | "absent";

export type PerTitleResultsView =
	| { origin: "step" | "snapshot"; snapshot: PerTitleResultsSnapshot }
	| { origin: "failed"; error: string }
	| { origin: "absent" };

/** The step id the compiler gives the capture op. */
export const PER_TITLE_CAPTURE_STEP = "per-title-results";

/**
 * Resolve the results to render, newest evidence first: the capture step, then
 * the backfilled column, then nothing.
 *
 * Everything is PARSED, never trusted. Both inputs are JSON columns that may
 * have been written by an older version of this code, so a shape that no longer
 * matches degrades to `absent` rather than throwing inside a render.
 */
export function perTitleResultsView(inputs: {
	stepLog?: unknown;
	snapshots?: unknown;
}): PerTitleResultsView {
	const fromStep = captureStepOutcome(inputs.stepLog);
	const stepSnapshot =
		fromStep?.captured === true ? fromStep.snapshot : undefined;
	const backfilled = perTitleResultsSnapshotSchema.safeParse(
		(inputs.snapshots as { perTitleResults?: unknown } | null | undefined)
			?.perTitleResults,
	);
	// BEST EVIDENCE WINS, scored the same way on both sides. A backfill still beats a
	// FAILED step (the route exists to fix that, and it writes only on success), but
	// it no longer beats a better step just by parsing.
	if (backfilled.success && stepSnapshot !== undefined) {
		return isBetter(backfilled.data, stepSnapshot)
			? { origin: "snapshot", snapshot: backfilled.data }
			: { origin: "step", snapshot: stepSnapshot };
	}
	if (backfilled.success) {
		return { origin: "snapshot", snapshot: backfilled.data };
	}
	if (stepSnapshot !== undefined) {
		// No backfill to compare against — still the best evidence there is, and the
		// panel warns about `complete`/`codecConfigErrors` on its own.
		return { origin: "step", snapshot: stepSnapshot };
	}
	if (fromStep?.captured === false) {
		return { origin: "failed", error: fromStep.error };
	}
	return { origin: "absent" };
}

/**
 * How good a snapshot is, as a comparable score — NOT a boolean.
 *
 * The first version of this asked only "is the step complete?", applied the answer
 * to the step and let the backfill win on parse success alone. That fixed one
 * direction and opened its mirror (review finding, High): a 12-rung capture with one
 * failed codec-config read scored "incomplete", so pressing "Capture now" to fix
 * exactly that could write a 2-rung truncated snapshot which then shadowed the
 * 12-rung one permanently. The button pressed to improve the data destroyed the view
 * of it.
 *
 * So both candidates are scored the same way and the better one wins, by this
 * ordered vector (earlier wins first):
 * - reaching the end of every list, then reading every rung's parameters (tier);
 * - MORE RUNGS captured — which saves the 12-vs-2 case, and is ALSO why a fresh
 * but 2-rung-truncated capture must not beat a good old 6 even though the fresh
 * one attributes better;
 * - MORE RUNGS ATTRIBUTED among an equal capture — which is what lets a NEW,
 * filename-attributed 6 finally beat an OLD, codec-abstained 6 that used to
 * TIE it and win by being the incumbent step (the shadow §5.4 names);
 * - and, all else equal, the NEWER attribution version — a migration nicety,
 * below rung count so it can never resurrect the truncation shadow.
 */
function captureQuality(
	snapshot: PerTitleResultsSnapshot,
): [number, number, number, number] {
	const tier =
		(snapshot.scan.complete ? 2 : 0) +
		(snapshot.scan.codecConfigErrors === 0 ? 1 : 0);
	const attributed = snapshot.scan.resultsCaptured - snapshot.scan.unattributed;
	return [
		tier,
		snapshot.scan.resultsCaptured,
		attributed,
		snapshot.attributionVersion ?? 0,
	];
}

/** Strictly better, by the ordered `captureQuality` vector (lexicographic). */
function isBetter(
	candidate: PerTitleResultsSnapshot,
	incumbent: PerTitleResultsSnapshot,
): boolean {
	const c = captureQuality(candidate);
	const i = captureQuality(incumbent);
	for (let k = 0; k < c.length; k += 1) {
		const ck = c[k] as number;
		const ik = i[k] as number;
		if (ck !== ik) {
			return ck > ik;
		}
	}
	return false;
}

/** The capture step's outcome, if the step ran at all. */
function captureStepOutcome(stepLog: unknown): PerTitleCaptureOutcome | null {
	if (!Array.isArray(stepLog)) {
		return null;
	}
	const entry = stepLog.find(
		(e): e is { step?: unknown; response?: unknown } =>
			typeof e === "object" &&
			e !== null &&
			(e as { step?: unknown }).step === PER_TITLE_CAPTURE_STEP,
	);
	if (!entry) {
		return null;
	}
	const parsed = perTitleCaptureOutcomeSchema.safeParse(entry.response);
	return parsed.success ? parsed.data : null;
}

/** One RESULT row grouped under the template it was attributed to, or apart. */
export type PerTitleResultGroup = {
	/** The plan rendition key, or null for the unattributed group. */
	rendition: string | null;
	results: PerTitleResultStream[];
};

/**
 * Group result rows for display: one group per template that has results, in
 * PLAN order, then a final `rendition: null` group for everything unattributed.
 *
 * Templates with no results are omitted rather than shown empty — with
 * attribution abstaining as often as it does, an empty group per rung would
 * imply the encoder produced nothing for it, which is the opposite of the truth.
 */
export function groupPerTitleResults(
	snapshot: PerTitleResultsSnapshot,
	templateOrder: readonly string[],
): PerTitleResultGroup[] {
	const byTemplate = new Map<string, PerTitleResultStream[]>();
	const unattributed: PerTitleResultStream[] = [];
	for (const result of snapshot.streams) {
		const key = result.templateRendition;
		if (key === undefined) {
			unattributed.push(result);
			continue;
		}
		const list = byTemplate.get(key);
		if (list) {
			list.push(result);
		} else {
			byTemplate.set(key, [result]);
		}
	}
	const groups: PerTitleResultGroup[] = [];
	for (const rendition of templateOrder) {
		const results = byTemplate.get(rendition);
		if (results) {
			groups.push({ rendition, results });
			byTemplate.delete(rendition);
		}
	}
	// Attributed to a rendition the caller did not list (a plan edited after the
	// run). Rendered under its own key rather than dropped — the row exists.
	for (const [rendition, results] of byTemplate) {
		groups.push({ rendition, results });
	}
	if (unattributed.length > 0) {
		groups.push({ rendition: null, results: unattributed });
	}
	return groups;
}

/**
 * ————————————————————————————————————————————————————————————————————————————
 * The ADAPTER, once.
 * ————————————————————————————————————————————————————————————————————————————
 *
 * The pagination and the polymorphic codec-config read are the same work
 * wherever they run, and they were written twice — once in the worker's SDK-ops
 * facade, once in the backfill route — which is two chances for the C6 accounting
 * or the `complete` flag to drift apart, in a feature whose whole point is
 * knowing whether you saw the whole ladder.
 *
 * So it lives here, once. Core still imports NOTHING from `@bitmovin/api-sdk`:
 * the parameter is a STRUCTURAL type describing only the four calls used, which a
 * real `BitmovinApi` satisfies by shape. If the SDK ever moves those endpoints,
 * both call sites fail to typecheck — which is the failure we want.
 */
export type EncodingApiSubset = {
	encoding: {
		encodings: {
			streams: {
				list(
					encodingId: string,
					query: { offset: number; limit: number },
				): Promise<{ items?: unknown[] }>;
			};
			muxings: {
				list(
					encodingId: string,
					query: { offset: number; limit: number },
				): Promise<{ items?: unknown[] }>;
			};
		};
		configurations: {
			type: { get(configId: string): Promise<{ type?: unknown }> };
		};
	};
};

/** C6: `limit ≤ 100`, always paginate. */
const PAGE_LIMIT = 100;

/**
 * Walk one page-based list to exhaustion, or to `SCAN_PAGE_CAP`, reporting which
 * happened. `read` returns null for a row that cannot be used, which ends the
 * scan as INCOMPLETE rather than silently shortening the ladder.
 */
async function scanPages<T>(
	list: (query: { offset: number; limit: number }) => Promise<{
		items?: unknown[];
	}>,
	read: (row: unknown) => T | null,
): Promise<ScanPage<T>> {
	const items: T[] = [];
	for (let page = 0; page < SCAN_PAGE_CAP; page += 1) {
		const response = await list({
			offset: page * PAGE_LIMIT,
			limit: PAGE_LIMIT,
		});
		const rows = response.items ?? [];
		for (const row of rows) {
			const parsed = read(row);
			if (parsed === null) {
				return { items, complete: false };
			}
			items.push(parsed);
		}
		if (rows.length < PAGE_LIMIT) {
			return { items, complete: true };
		}
	}
	return { items, complete: false };
}

/** A usable id: present, a string, and not empty. */
function isNonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function readStreamRow(row: unknown): ScannedStream | null {
	const stream = row as {
		id?: unknown;
		mode?: unknown;
		name?: unknown;
		codecConfigId?: unknown;
		appliedSettings?: { width?: unknown; height?: unknown };
		perTitleSettings?: {
			fixedResolutionAndBitrateSettings?: unknown;
			codecMaxBitrateFactor?: unknown;
			codecBufsizeFactor?: unknown;
		};
	};
	// NON-EMPTY, not merely a string. The hand-written version this replaced used
	// `!stream.id`, which rejects "" — switching to a `typeof` check quietly
	// accepted an empty id and would have pushed a row that joins to nothing (found
	// by diffing the two implementations, not by a test). Same for the config id
	// below: an empty one would send `getCodecConfig("")` at the API.
	if (!isNonEmpty(stream.id) || !stream.mode) {
		// No id or no mode ⇒ it can be joined to nothing. Counted as an incomplete
		// scan, because dropping it would understate the ladder invisibly.
		return null;
	}
	const applied = stream.appliedSettings;
	const settings = capturedPerTitleSettingsSchema.safeParse(
		stream.perTitleSettings,
	);
	return {
		streamId: stream.id,
		mode: String(stream.mode),
		...(isNonEmpty(stream.codecConfigId)
			? { codecConfigId: stream.codecConfigId }
			: {}),
		...(applied
			? {
					appliedSettings: {
						...(typeof applied.width === "number"
							? { width: applied.width }
							: {}),
						...(typeof applied.height === "number"
							? { height: applied.height }
							: {}),
					},
				}
			: {}),
		...(settings.success
			? {
					perTitleSettings: settings.data,
				}
			: {}),
	};
}

/** `EncodingOutput[]` as we store it — every entry, ids and paths kept apart. */
function readOutputs(raw: unknown): ScannedOutput[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.map((entry) => {
		const output = entry as {
			outputId?: unknown;
			outputPath?: unknown;
			acl?: unknown;
		};
		return {
			...(typeof output.outputId === "string"
				? { outputId: output.outputId }
				: {}),
			...(typeof output.outputPath === "string"
				? { outputPath: output.outputPath }
				: {}),
			...(output.acl !== undefined ? { acl: output.acl } : {}),
		};
	});
}

function readMuxingRow(row: unknown): ScannedMuxing | null {
	const muxing = row as {
		id?: unknown;
		type?: unknown;
		name?: unknown;
		filename?: unknown;
		outputs?: unknown;
		streams?: Array<{ streamId?: unknown }>;
		avgBitrate?: unknown;
		maxBitrate?: unknown;
		segmentsMuxed?: unknown;
	};
	if (!isNonEmpty(muxing.id)) {
		return null;
	}
	return {
		muxingId: muxing.id,
		// The SDK's discriminator on the polymorphic list. Labelled, never guessed.
		muxingType: muxing.type ? String(muxing.type) : "UNKNOWN",
		// `Mp4Muxing`/`ProgressiveWebmMuxing` carry `filename`; the base `Muxing`
		// carries `name`. The mirror filename is the QC RESULT↔template correlation
		// key; segmented non-QC legs correlate through their outputs below.
		...(isNonEmpty(muxing.filename) ? { filename: muxing.filename } : {}),
		...(isNonEmpty(muxing.name) ? { name: muxing.name } : {}),
		// EVERY output, not the first: `Muxing.outputs` is an array and a muxing can
		// legitimately write more than one place.
		outputs: readOutputs(muxing.outputs),
		// Filled by the port, which has to make one call per muxing to get them.
		drm: [],
		streamIds: (muxing.streams ?? []).map((s) => s.streamId).filter(isNonEmpty),
		...(typeof muxing.avgBitrate === "number"
			? { avgBitrate: muxing.avgBitrate }
			: {}),
		...(typeof muxing.maxBitrate === "number"
			? { maxBitrate: muxing.maxBitrate }
			: {}),
		...(typeof muxing.segmentsMuxed === "number"
			? { segmentsMuxed: muxing.segmentsMuxed }
			: {}),
	};
}

/** Muxing kind → the SDK property holding its DRM list. */
const MUXING_KIND_PROPERTY: Readonly<Record<string, string>> = Object.freeze({
	FMP4: "fmp4",
	TS: "ts",
	MP4: "mp4",
	WEBM: "webm",
	PROGRESSIVE_TS: "progressiveTs",
	PACKED_AUDIO: "packedAudio",
	PROGRESSIVE_WEBM: "progressiveWebm",
	// CMAF is NOT here on purpose: `CmafApi` exposes only `customdata`, no `drm`, so
	// mapping it advertised coverage that could never resolve — the entry always took
	// the silent early return (review catch, enumerated against the pinned SDK).
	// `packedAudio` and `progressiveWebm` DO expose `drm` and were missing.
});

export function bitmovinCapturePort(
	api: EncodingApiSubset,
): PerTitleCapturePort {
	const encodings = api.encoding.encodings;

	/**
	 * Every DRM on one muxing, with the outputs each writes.
	 *
	 * There is no kind-agnostic DRM list: `Drm` is polymorphic, so ONE call returns
	 * every DRM on a muxing (CENC, FairPlay, Widevine…), but the route to it goes
	 * through the muxing's own kind — which the kind-agnostic muxing list hands us as
	 * `type`. A kind absent from the map has no encryptable DRM path and its results
	 * carry `drm: []`.
	 *
	 * Skipping this hop loses the ONLY path to an encrypted rung, because a DRM'd
	 * muxing usually has no output of its own. That is the bug `storageSummaries`
	 * shipped twice; the chain is `stream → muxing → drm → output → outputPath`.
	 */
	const listMuxingDrm = async (
		encodingId: string,
		muxingId: string,
		muxingType: string,
	): Promise<ScannedMuxing["drm"]> => {
		const property = MUXING_KIND_PROPERTY[muxingType];
		if (property === undefined) {
			return [];
		}
		const kindApi = (
			encodings.muxings as unknown as Record<
				string,
				{
					drm?: {
						list(
							encodingId: string,
							muxingId: string,
						): Promise<{ items?: unknown[] }>;
					};
				}
			>
		)[property];
		if (typeof kindApi?.drm?.list !== "function") {
			return [];
		}
		const page = await kindApi.drm.list(encodingId, muxingId);
		return (page.items ?? []).flatMap((row) => {
			const drm = row as { id?: unknown; type?: unknown; outputs?: unknown };
			if (typeof drm.id !== "string") {
				return [];
			}
			return [
				{
					drmId: drm.id,
					drmType: drm.type ? String(drm.type) : "UNKNOWN",
					outputs: readOutputs(drm.outputs),
				},
			];
		});
	};

	return {
		listStreams: (encodingId) =>
			scanPages(
				(query) => encodings.streams.list(encodingId, query),
				readStreamRow,
			),
		listMuxings: async (encodingId) => {
			const page = await scanPages(
				(query) => encodings.muxings.list(encodingId, query),
				readMuxingRow,
			);
			// One DRM call per muxing, sequential like the codec reads and for the same
			// reason: post-encode enrichment, not a hot path.
			for (const muxing of page.items) {
				muxing.drm = await listMuxingDrm(
					encodingId,
					muxing.muxingId,
					muxing.muxingType,
				);
			}
			return page;
		},
		getCodecConfig: async (configId) => {
			// bm-xray's flow: the type first, then the endpoint that knows the fields.
			const typed = await api.encoding.configurations.type.get(configId);
			const codecType = typed.type ? String(typed.type) : undefined;
			if (codecType === undefined) {
				return null;
			}
			const path = CODEC_CONFIG_API_PATH[codecType];
			if (!path) {
				// Known type, unmapped endpoint: record WHAT it is even though we
				// cannot say what it was set to. One exotic rung must not cost the
				// whole snapshot.
				return { codecType, params: {} };
			}
			const [group, codec] = path;
			const endpoint = (
				api.encoding.configurations as unknown as Record<
					string,
					Record<
						string,
						{ get?: (id: string) => Promise<Record<string, unknown>> }
					>
				>
			)[group]?.[codec];
			if (typeof endpoint?.get !== "function") {
				return { codecType, params: {} };
			}
			return { codecType, params: await endpoint.get(configId) };
		},
	};
}
