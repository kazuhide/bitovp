import { qcOutputPath, renditionOutputBase } from "./compiler";
import { inputStreamDependencies } from "./input-stream-graph";
import { muxingStreamKeys } from "./muxing-streams";
import type { EncodingPlan, PlanMuxing, PlanRendition } from "./schema";
import { AUDIO_CODECS, renditionSchema } from "./schema";
import { stepNameFor } from "./step-names";
import type { StepLogEntry } from "./steplog";

/**
 * View models for the VOD job detail page, derived from the persisted plan and
 * step log. Pure and UI-free (repo convention: cross-agent contracts live in
 * core, the React components render these shapes).
 *
 * Why derived rather than fetched: the page must keep working after Bitmovin's
 * ~90-day purge (C7) and for DRAFT/QUEUED jobs that have no remote resources at
 * all. So the plan is the truth about INTENT, the step log adds whatever runtime
 * ids exist, and neither is required — every selector renders from the plan
 * alone and treats the log as enrichment. Same tolerance rule `resource-tree.ts`
 * follows: unknown/live/foreign step kinds and missing entries are survivable,
 * never a throw, because a crashed run's page is exactly when someone needs it.
 */

/**
 * Video codecs. `AUDIO_CODECS` is imported from the schema rather than re-listed
 * — the first version forked it character-for-character, which the shared contract forbids
 * for exactly the failure that follows: `renditionFamily` falls through to
 * "subtitle", so a codec added to the schema's set and not to the copy would land
 * silently in the SUBTITLE table (review finding). `codec-families.test.ts`
 * enumerates the schema's own discriminants so adding one fails until it is
 * mapped here.
 */
const VIDEO_CODECS = new Set(["H264", "H265", "VP9", "AV1"]);

export type RenditionFamily = "video" | "audio" | "subtitle";

export function renditionFamily(rendition: PlanRendition): RenditionFamily {
	if (VIDEO_CODECS.has(rendition.codec)) {
		return "video";
	}
	return AUDIO_CODECS.has(rendition.codec) ? "audio" : "subtitle";
}

/** One muxing leg of a rendition, with where it writes. */
export type RenditionMuxing = {
	key: string;
	kind: PlanMuxing["kind"];
	/**
	 * The OTHER renditions travelling in this container , absent
	 * when it carries only this one.
	 *
	 * This view indexed muxings by `streamKey` alone, so a track muxed into the
	 * video's container appeared under NO muxing at all: the detail page told
	 * the operator their audio was packaged nowhere, about a plan that packages
	 * it. Listing the container under every rendition it carries fixes that,
	 * and this field is what keeps the fix from lying in the other direction —
	 * the destination shown on the audio row is the VIDEO's, and the reader has
	 * to be able to see why.
	 */
	sharedWith?: string[];
	/**
	 * The container's OWN rendition, when this row is a passenger in it.
	 *
	 * `sharedWith` alone is symmetric, and the two rows need opposite sentences:
	 * on the video row the destination IS its own, on the audio row it is
	 * somebody else's. Review shipped-and-caught the version where the audio row
	 * showed two containers pointing into `/video/720p` with nothing saying
	 * whose directory that was — which reads as a plausible fact instead of an
	 * obvious gap, and sends an operator looking for an audio artefact among
	 * .ts segments.
	 *
	 * Absent on the primary's own row, so a single-stream container carries
	 * neither field and nothing in the view changes for it.
	 */
	carriedBy?: string;
	/** Segmented muxings: seconds per segment. */
	segmentLength?: number;
	segmentNaming?: string;
	initSegmentName?: string;
	/** Single-file muxings (MP4): the object name. */
	filename?: string;
	/**
	 * Where this muxing writes, or `null` when it writes nothing of its own — a
	 * fully-DRM'd muxing's outputs live on `drm[]` below, one per DRM resource.
	 *
	 * The first version returned bare `null` and documented it as "see the DRM
	 * row". There was no DRM row: nothing in these view models carried a DRM
	 * destination, so five fixtures' write paths were unreachable from anywhere
	 * (review finding).
	 */
	destination: { outputKey: string; path: string; acl?: unknown } | null;
	/**
	 * DRM resources configured on this muxing, each with the output IT writes.
	 *
	 * Plural destinations, because a muxing can be encrypted more than once:
	 * `pertitle-h265-fmp4-drm-on-aws` wraps every FMP4 in CENC → `…/dash/` AND
	 * FairPlay → `…/hls/`, and the compiler emits a `drm:` step with its own
	 * `outputPath` for each. A single-valued destination cannot express that, and
	 * `find`-ing one DRM per muxing hid 8 of that plan's 16 writes — an operator
	 * hunting their FairPlay output found nothing (review finding).
	 */
	drm: Array<{
		key: string;
		kind: string;
		destination: { outputKey: string; path: string; acl?: unknown };
	}>;
};

export type RenditionSummary = {
	key: string;
	family: RenditionFamily;
	codec: PlanRendition["codec"];
	/** Multi-encoding (Dolby ladder) plans; absent = the implicit encoding. */
	encodingKey?: string;
	/** Video: pixel height. Null on per-title templates that let the algorithm choose. */
	height?: number | null;
	/** Null on per-title templates (the algorithm picks the bitrate). */
	bitrate?: number | null;
	profile?: string;
	level?: string | null;
	/** Audio: sample rate (Hz) / channel layout. */
	sampleRate?: number;
	channelLayout?: string;
	mode?: string;
	perTitleSettings?: Record<string, unknown>;
	/** Filter attachments in application order. */
	filters: Array<{ filterKey: string; position: number; kind?: string }>;
	muxings: RenditionMuxing[];
	/** The input-stream key this rendition consumes. */
	ingestKey: string;
	/** Ids from the step log, when the job has run. */
	runtime: {
		streamId?: string;
		codecConfigId?: string;
	};
};

export type RenditionSummaries = {
	video: RenditionSummary[];
	audio: RenditionSummary[];
	subtitle: RenditionSummary[];
};

/**
 * One hop from a rendition to its source file. `kind` selects the copy; the rest
 * are API tokens (`AUTO`, `TIME_BASED`, `VISION`) rendered verbatim.
 */
export type ChainSegment =
	| { kind: "ingest"; selectionMode: string; position: number }
	| { kind: "file"; type: string }
	| { kind: "dolby"; dolbyKind: string; detail?: string }
	| { kind: "trim"; trimKind: string }
	| { kind: "concat"; position: number; isMain: boolean };

/** A source file, and every rendition that consumes it. */
export type InputFileSummary = {
	inputKey: string;
	inputPath: string;
	/** Plan input kind (S3 / HTTPS / AZURE / …). */
	kind: string;
	/** Bucket, container or host — whichever this input kind addresses by. */
	location: string;
	/** Absent for HTTPS, the one credential-less input kind. */
	credentialId?: string;
	consumers: Array<{
		renditionKeys: string[];
		/**
		 * How the rendition reaches this file, outermost wrapper first —
		 * `[concat, trim, ingest]` for a concatenated trimmed ingest.
		 *
		 * STRUCTURED, not a formatted string. The first version returned
		 * `"concat(pos 1) → trim(TIME_BASED) → ingest(AUTO pos 0)"`, which is
		 * user-visible English prose assembled in core — and core is UI-free, with
		 * every string going through the i18n catalogue (design §5, the shared contract). Those
		 * two cannot both hold (review finding). The enum values are API tokens and
		 * stay verbatim; the wrappers and `pos`/`main` are prose, so the web layer
		 * formats them and chooses the reading direction.
		 */
		chain: ChainSegment[];
	}>;
};

export type StorageEndpointPath = {
	path: string;
	/** What writes here. */
	role: "muxing" | "drm" | "manifest" | "qc" | "thumbnail" | "sprite";
	/** The plan key of the writer. */
	key: string;
	acl?: unknown;
	/** True when the path carries a C4 per-title placeholder. */
	templated: boolean;
};

export type StorageEndpoint = {
	key: string;
	kind: string;
	location: string;
	credentialId?: string;
	/** Outputs only: every declared write targeting this endpoint. */
	paths: StorageEndpointPath[];
};

export type StorageSummaries = {
	inputs: StorageEndpoint[];
	outputs: StorageEndpoint[];
};

/** Where a rendition field's value came from. */
export type ParamSource = "set" | "schema-default";

export type ClassifiedParam = {
	name: string;
	value: unknown;
	source: ParamSource;
};

/** Indexes a step log by step id, tolerating duplicates (last wins). */
function indexByStep(entries: StepLogEntry[]): Map<string, StepLogEntry> {
	const out = new Map<string, StepLogEntry>();
	for (const entry of entries) {
		out.set(entry.step, entry);
	}
	return out;
}

/**
 * `runtime.perTitleCreated` used to live here and was removed: it read the
 * `stream:<key>` step's response looking for a count, and `CREATE_STREAM`
 * responses are `{id}` and nothing else — so no field it looked for could ever
 * appear and the column read "no data" forever (review finding). The expansion
 * counts do exist, on `hls-pertitle:<manifestKey>` / `manifest:<key>`, but those
 * are keyed by MANIFEST, so a per-rendition count is not derivable from today's
 * log at all. Design §4a captures the actual RESULT streams; until then the
 * honest display is the template intent plus nothing invented.
 */

/**
 * Bitrate descending within each family (bm-xray convention — the top rung is
 * what an operator looks at first).
 *
 * Per-title templates carry a null bitrate because the algorithm picks it; they
 * sort ABOVE the fixed rungs rather than below, because a template is the
 * ladder's definition and burying it under its own outputs reads as an
 * afterthought. Ties break on key so the order is stable across renders — an
 * unstable sort would make React reconcile rows on every poll.
 */
function byBitrateDesc(a: RenditionSummary, b: RenditionSummary): number {
	const av = a.bitrate ?? Number.POSITIVE_INFINITY;
	const bv = b.bitrate ?? Number.POSITIVE_INFINITY;
	if (av !== bv) {
		return bv - av;
	}
	return a.key.localeCompare(b.key);
}

export function renditionSummaries(
	plan: EncodingPlan,
	entries?: StepLogEntry[],
): RenditionSummaries {
	const steps = indexByStep(entries ?? []);
	const filterKinds = new Map(plan.filters.map((f) => [f.key, f.kind]));

	// muxings by the rendition (stream) they carry, and DRM by muxing.
	const muxingsByStream = new Map<string, PlanMuxing[]>();
	for (const muxing of plan.muxings) {
		// Indexed under EVERY rendition it packages, not just the primary.
		//
		// An `additionalStreamKeys` entry naming NO rendition would index under
		// a ghost key (never read) and surface in the real rendition's
		// `sharedWith`. Left unguarded on purpose: `renditionSummaries` has one
		// caller — the JOB detail page — which renders plans that already
		// passed `PLAN_UNRESOLVED_REF` at the submit boundary, so no input can
		// reach it. A guard nothing can trip is a coverage claim that is not
		// true. If a DRAFT/preview surface ever calls this, show the ghost key
		// rather than hiding it: concealing a broken reference from the view an
		// operator debugs drafts in is the wrong direction.
		for (const streamKey of muxingStreamKeys(muxing)) {
			const list = muxingsByStream.get(streamKey) ?? [];
			list.push(muxing);
			muxingsByStream.set(streamKey, list);
		}
	}
	const drmByMuxing = new Map<string, RenditionMuxing["drm"]>();
	for (const drm of plan.drm) {
		const list = drmByMuxing.get(drm.muxingKey) ?? [];
		list.push({
			key: drm.key,
			kind: drm.kind,
			destination: {
				outputKey: drm.destination.outputKey,
				path: drm.destination.path,
				...(drm.destination.acl !== undefined
					? { acl: drm.destination.acl }
					: {}),
			},
		});
		drmByMuxing.set(drm.muxingKey, list);
	}

	const out: RenditionSummaries = { video: [], audio: [], subtitle: [] };
	for (const rendition of plan.renditions) {
		const family = renditionFamily(rendition);
		const r = rendition as PlanRendition & Record<string, unknown>;
		const muxings: RenditionMuxing[] = (
			muxingsByStream.get(rendition.key) ?? []
		).map((muxing) => {
			const m = muxing as PlanMuxing & Record<string, unknown>;
			const others = muxingStreamKeys(muxing).filter(
				(k) => k !== rendition.key,
			);
			return {
				key: muxing.key,
				kind: muxing.kind,
				...(others.length > 0 ? { sharedWith: others } : {}),
				...(muxing.streamKey !== rendition.key
					? { carriedBy: muxing.streamKey }
					: {}),
				...(typeof m.segmentLength === "number"
					? { segmentLength: m.segmentLength }
					: {}),
				...(typeof m.segmentNaming === "string"
					? { segmentNaming: m.segmentNaming }
					: {}),
				...(typeof m.initSegmentName === "string"
					? { initSegmentName: m.initSegmentName }
					: {}),
				...(typeof m.filename === "string" ? { filename: m.filename } : {}),
				// `null` when the muxing writes nothing of its own — the encrypted
				// outputs are on `drm[]` below, ONE PER DRM RESOURCE. A single
				// `destination` cannot express a twice-encrypted muxing, and standing
				// in the first `find`-ed DRM here is what hid the second (review
				// finding: 8 of 16 writes on the h265 DRM fixture).
				destination: muxing.destination ?? null,
				drm: drmByMuxing.get(muxing.key) ?? [],
			};
		});

		const streamStep = steps.get(stepNameFor("stream", rendition.key));
		const codecStep = steps.get(stepNameFor("codec", rendition.key));
		const summary: RenditionSummary = {
			key: rendition.key,
			family,
			codec: rendition.codec,
			...(rendition.encodingKey !== undefined
				? { encodingKey: rendition.encodingKey }
				: {}),
			...("height" in r ? { height: r.height as number | null } : {}),
			...("bitrate" in r ? { bitrate: r.bitrate as number | null } : {}),
			...(typeof r.profile === "string" ? { profile: r.profile } : {}),
			...("level" in r ? { level: r.level as string | null } : {}),
			...(family === "audio" && typeof r.rate === "number"
				? { sampleRate: r.rate }
				: {}),
			...(typeof r.channelLayout === "string"
				? { channelLayout: r.channelLayout }
				: {}),
			...(typeof r.mode === "string" ? { mode: r.mode } : {}),
			...(r.perTitleSettings !== undefined && r.perTitleSettings !== null
				? { perTitleSettings: r.perTitleSettings as Record<string, unknown> }
				: {}),
			filters: (rendition.filters ?? [])
				.map((f) => ({
					filterKey: f.filterKey,
					position: f.position,
					...(filterKinds.has(f.filterKey)
						? { kind: filterKinds.get(f.filterKey) as string }
						: {}),
				}))
				.sort((a, b) => a.position - b.position),
			muxings,
			ingestKey: rendition.ingestKey,
			runtime: {
				...(streamStep?.resourceId !== undefined
					? { streamId: streamStep.resourceId }
					: {}),
				...(codecStep?.resourceId !== undefined
					? { codecConfigId: codecStep.resourceId }
					: {}),
			},
		};
		out[family].push(summary);
	}
	out.video.sort(byBitrateDesc);
	out.audio.sort(byBitrateDesc);
	out.subtitle.sort(byBitrateDesc);
	return out;
}

/** The addressable location of a plan input or output, by kind. */
function locationOf(endpoint: Record<string, unknown>): string {
	for (const field of ["bucket", "container", "host"]) {
		const value = endpoint[field];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	return "";
}

/**
 * Resolves an input-stream key to the source file(s) it ultimately reads, and
 * describes the chain that gets there.
 *
 * Trimming wraps another input stream and concatenation wraps several, so this
 * walks transitively — a concatenated, trimmed ingest resolves to the ingest's
 * file with `concat(pos 1) → trim(TIME_BASED) → ingest(AUTO pos 0)`. Cycles
 * cannot occur in a valid plan but are guarded anyway: a hand-edited plan must
 * render a page, not hang it.
 */
function resolveSources(
	plan: EncodingPlan,
	key: string,
	seen: Set<string> = new Set(),
): Array<{ inputKey: string; inputPath: string; chain: ChainSegment[] }> {
	if (seen.has(key)) {
		return [];
	}
	seen.add(key);

	const ingest = plan.ingest.find((i) => i.key === key);
	if (ingest) {
		return [
			{
				inputKey: ingest.inputKey,
				inputPath: ingest.inputPath,
				chain: [
					{
						kind: "ingest",
						selectionMode: ingest.selectionMode,
						position: ingest.position,
					},
				],
			},
		];
	}
	const file = plan.fileStreams.find((f) => f.key === key);
	if (file) {
		const f = file as typeof file & { type?: string };
		return [
			{
				inputKey: file.inputKey,
				inputPath: file.inputPath,
				chain: [{ kind: "file", type: f.type ?? "FILE" }],
			},
		];
	}
	const dolby = plan.dolbyStreams.find((d) => d.key === key);
	if (dolby) {
		/**
		 * A Dolby VISION stream reads TWO files — the video and (optionally) a
		 * sidecar metadata XML — under `videoInputPath`/`metadataInputPath` rather
		 * than the `inputPath` the other kinds use. Both are returned, because the
		 * question this panel answers is "which files did we read", and dropping the
		 * sidecar would answer it wrongly for exactly the plans where the sidecar is
		 * the interesting part.
		 */
		if (dolby.kind === "VISION") {
			const sources: Array<{
				inputKey: string;
				inputPath: string;
				chain: ChainSegment[];
			}> = [
				{
					inputKey: dolby.inputKey,
					inputPath: dolby.videoInputPath,
					chain: [{ kind: "dolby", dolbyKind: "VISION", detail: "video" }],
				},
			];
			if (dolby.metadataInputPath !== undefined) {
				sources.push({
					inputKey: dolby.inputKey,
					inputPath: dolby.metadataInputPath,
					chain: [{ kind: "dolby", dolbyKind: "VISION", detail: "metadata" }],
				});
			}
			return sources;
		}
		return [
			{
				inputKey: dolby.inputKey,
				inputPath: dolby.inputPath,
				chain: [
					{
						kind: "dolby",
						dolbyKind: dolby.kind,
						...(dolby.kind === "ATMOS" ? { detail: dolby.inputFormat } : {}),
					},
				],
			},
		];
	}
	const trimming = plan.trimmingStreams.find((t) => t.key === key);
	if (trimming) {
		return resolveSources(plan, trimming.sourceKey, seen).map((s) => ({
			...s,
			chain: [{ kind: "trim", trimKind: trimming.kind }, ...s.chain],
		}));
	}
	const concat = plan.concatenationStreams.find((c) => c.key === key);
	if (concat) {
		/**
		 * A COPY of `seen` per branch, not the shared set.
		 *
		 * Sharing it made this a global visited-set rather than a cycle guard, so any
		 * DAG where two branches converge on one node lost the second: a concat of
		 * two trims of the SAME file resolved to one chain, and a concat using one
		 * ingest at both pos 0 and pos 1 silently dropped pos 1. Not in the corpus,
		 * but "concatenate two segments of one master" is an ordinary ask (review
		 * finding).
		 */
		return concat.sources.flatMap((source) =>
			resolveSources(plan, source.sourceKey, new Set(seen)).map((s) => ({
				...s,
				chain: [
					{
						kind: "concat",
						position: source.position ?? 0,
						isMain: source.isMain === true,
					},
					...s.chain,
				],
			})),
		);
	}
	const mix = plan.audioMixStreams.find((s) => s.key === key);
	if (mix)
		return [...new Set(inputStreamDependencies(plan, key))].flatMap((source) =>
			resolveSources(plan, source, new Set(seen)),
		);

	return [];
}

/**
 * Every `(inputKey, inputPath)` the plan DECLARES a read of, with the stream that
 * declares it.
 *
 * Enumerated from the input-stream collections rather than from renditions,
 * because not every declared read is reachable from a rendition: a Dolby Vision
 * metadata sidecar (`VISION_METADATA`) and an Atmos track can be their own
 * streams that no rendition names as its `ingestKey`, and the compiler creates an
 * input stream for each regardless. Enumerating from renditions alone dropped
 * exactly those — including, self-refutingly, the sidecar in the fixture named
 * `dolby-dv-separated-metadata-adm`, which reads from a different bucket (review
 * finding).
 */
function declaredReads(
	plan: EncodingPlan,
): Array<{ inputKey: string; inputPath: string; chain: ChainSegment[] }> {
	const out: Array<{
		inputKey: string;
		inputPath: string;
		chain: ChainSegment[];
	}> = [];
	for (const stream of [
		...plan.ingest,
		...plan.fileStreams,
		...plan.dolbyStreams,
	]) {
		out.push(...resolveSources(plan, stream.key));
	}
	return out;
}

export function inputFileSummaries(plan: EncodingPlan): InputFileSummary[] {
	const inputsByKey = new Map(
		plan.inputs.map((i) => [i.key, i as Record<string, unknown>]),
	);
	// (inputKey, inputPath) → via → rendition keys.
	const grouped = new Map<
		string,
		{
			inputKey: string;
			inputPath: string;
			consumers: Map<string, { chain: ChainSegment[]; keys: string[] }>;
		}
	>();

	/** Ensures a file is listed even when no rendition names it. */
	const ensure = (source: {
		inputKey: string;
		inputPath: string;
		chain: ChainSegment[];
	}) => {
		const id = `${source.inputKey}\0${source.inputPath}`;
		const bucket = grouped.get(id) ?? {
			inputKey: source.inputKey,
			inputPath: source.inputPath,
			consumers: new Map<string, { chain: ChainSegment[]; keys: string[] }>(),
		};
		// Grouped by the chain's SHAPE. The key is a serialization, not display
		// copy — the segments themselves are what the UI renders.
		const chainId = JSON.stringify(source.chain);
		if (!bucket.consumers.has(chainId)) {
			bucket.consumers.set(chainId, { chain: source.chain, keys: [] });
		}
		grouped.set(id, bucket);
		return bucket;
	};

	for (const rendition of plan.renditions) {
		for (const source of resolveSources(plan, rendition.ingestKey)) {
			// `\0`, escaped: it cannot occur in an S3 key or a path, so two files
			// differing only by a separator character cannot collide - and unlike a
			// RAW NUL (which this file carried for one commit) it stays visible to
			// grep. The repo has a tree-wide guard for exactly that, and it caught this.
			const bucket = ensure(source);
			const entry = bucket.consumers.get(JSON.stringify(source.chain));
			if (entry && !entry.keys.includes(rendition.key)) {
				entry.keys.push(rendition.key);
			}
		}
	}

	/**
	 * Declared reads NO rendition reaches, added after — as a fallback, not a first
	 * pass.
	 *
	 * Ordering matters: a trimmed ingest is declared as an ingest AND reached by a
	 * rendition through `trim(…) → ingest(…)`. Adding declared reads first listed
	 * both chains for one file, the bare one with no consumers, which is noise. So
	 * only files that are otherwise absent get an entry, and it carries the stream
	 * that declares the read with an empty consumer list — the honest answer for a
	 * DV metadata sidecar or an Atmos track: the encoding reads it, no single
	 * rendition does.
	 */
	for (const source of declaredReads(plan)) {
		const id = `${source.inputKey}\0${source.inputPath}`;
		if (!grouped.has(id)) {
			ensure(source);
		}
	}

	return [...grouped.values()]
		.map((entry) => {
			const input = inputsByKey.get(entry.inputKey);
			return {
				inputKey: entry.inputKey,
				inputPath: entry.inputPath,
				kind: typeof input?.kind === "string" ? input.kind : "UNKNOWN",
				location: input ? locationOf(input) : "",
				...(typeof input?.credentialId === "string"
					? { credentialId: input.credentialId }
					: {}),
				consumers: [...entry.consumers.values()]
					.map(({ chain, keys }) => ({ chain, renditionKeys: keys }))
					// By the outermost segment's numeric position where it has one, so
					// `concat` position 2 precedes position 10 — sorting the old
					// formatted string lexically put 10 first. Structured segments make
					// this a number comparison instead of a regex over prose.
					.sort((a, b) => {
						const pos = (chain: ChainSegment[]) => {
							const head = chain[0];
							return head && "position" in head
								? head.position
								: Number.POSITIVE_INFINITY;
						};
						return (
							pos(a.chain) - pos(b.chain) ||
							JSON.stringify(a.chain).localeCompare(JSON.stringify(b.chain))
						);
					}),
			};
		})
		.sort(
			(a, b) =>
				a.inputKey.localeCompare(b.inputKey) ||
				a.inputPath.localeCompare(b.inputPath),
		);
}

/** C4 placeholders — a templated path is shown verbatim, never resolved. */
function isTemplated(path: string): boolean {
	// `{height}` counts: the corpus's DRM paths use `{height}p_{bitrate}_{uuid}` so
	// they were already caught by the other two, but a `{height}`-only path would
	// have read as a literal directory (review suggestion).
	return (
		path.includes("{uuid}") ||
		path.includes("{bitrate}") ||
		path.includes("{height}")
	);
}

export function storageSummaries(plan: EncodingPlan): StorageSummaries {
	const writes = new Map<string, StorageEndpointPath[]>();
	const push = (
		outputKey: string,
		entry: Omit<StorageEndpointPath, "templated">,
	) => {
		const list = writes.get(outputKey) ?? [];
		list.push({ ...entry, templated: isTemplated(entry.path) });
		writes.set(outputKey, list);
	};

	/**
	 * Delivery writes, unless this is a VMAF-only encode.
	 *
	 * `qc.only` plans still carry `muxings` — the compiler reads their destinations
	 * to derive each qc mirror's path — but emit none of them, so listing those
	 * paths would claim a directory that does not exist.
	 *
	 * A DRM'd muxing writes through the DRM resource's destination, which the first
	 * version dropped entirely: five fixtures, 54 paths, and the storage panel was
	 * blank for every DRM plan (review finding). `renditionOutputBase` in the
	 * compiler resolves exactly this fallback and is now shared.
	 */
	const qcOnly = plan.qc?.only === true;
	if (!qcOnly) {
		for (const muxing of plan.muxings) {
			if (muxing.destination) {
				push(muxing.destination.outputKey, {
					path: muxing.destination.path,
					role: "muxing",
					key: muxing.key,
					...(muxing.destination.acl !== undefined
						? { acl: muxing.destination.acl }
						: {}),
				});
				// NO `continue`. The write set is the UNION of a muxing's own
				// destination and its DRM resources' — which is what this repo's own
				// validator models (`validate.ts`: "its own destination plus any DRM
				// destinations (encrypted outputs feed the manifest too)", filtering
				// `plan.drm` unconditionally, and erroring only when a muxing has
				// NEITHER). Skipping the DRM rows here made the selector model
				// either/or, so a muxing carrying both would have shown the plaintext
				// path and none of the encrypted ones (review finding). No fixture has
				// that shape today; the point is that the validator says it is legal.
			}
			/**
			 * EVERY DRM resource encrypting this muxing, not the first.
			 *
			 * `find` gives one row per muxing, which is right only when a muxing is
			 * encrypted once. `pertitle-h265-fmp4-drm-on-aws` encrypts each FMP4
			 * twice — CENC to `…/dash/`, FairPlay to `…/hls/` — so 8 of its 16 writes
			 * were absent (review finding). Keyed by the DRM resource, since that is
			 * what performs the write.
			 */
			for (const drm of plan.drm.filter((d) => d.muxingKey === muxing.key)) {
				push(drm.destination.outputKey, {
					path: drm.destination.path,
					role: "drm",
					key: drm.key,
					...(drm.destination.acl !== undefined
						? { acl: drm.destination.acl }
						: {}),
				});
			}
		}
	}

	/**
	 * QC mirrors, derived the way the COMPILER derives them.
	 *
	 * Two corrections, both review findings. (1) The gate is
	 * `qc.vmaf || qc.psnr`, not `qc.only` — the compiler writes a mirror whenever
	 * either is set, so a plan with `qc: {vmaf: true}` and normal delivery outputs
	 * had its mirrors omitted; that is invisible in the corpus because
	 * `vmaf-only-h264` is the only fixture with any qc block at all. (2) It is
	 * per RENDITION, taking the first muxing that carries a destination (else the
	 * encrypting DRM's) — walking muxings instead produced two qc paths for a
	 * rendition with two muxings, where the compiler writes one, i.e. the panel
	 * invented a directory. Shared with the compiler via `renditionOutputBase`, so
	 * the two cannot drift again.
	 */
	if (plan.qc?.vmaf === true || plan.qc?.psnr === true) {
		for (const rendition of plan.renditions) {
			if (!VIDEO_CODECS.has(rendition.codec)) {
				continue; // the compiler mirrors video only
			}
			const base = renditionOutputBase(plan, rendition.key);
			if (!base) {
				continue;
			}
			push(base.outputKey, {
				path: qcOutputPath(base.path),
				role: "qc",
				// The WRITER is the rendition, not a muxing: the compiler names the
				// step `qc-muxing:<renditionKey>`. Those coincided only by accident in
				// the one fixture that exercises this.
				key: rendition.key,
				...(base.acl !== undefined ? { acl: base.acl } : {}),
			});
		}
	}
	for (const manifest of plan.manifests) {
		push(manifest.destination.outputKey, {
			path: manifest.destination.path,
			role: "manifest",
			key: manifest.key,
			...(manifest.destination.acl !== undefined
				? { acl: manifest.destination.acl }
				: {}),
		});
	}
	for (const group of [
		{ items: plan.thumbnails, role: "thumbnail" as const },
		{ items: plan.sprites, role: "sprite" as const },
	]) {
		for (const item of group.items) {
			const destination = (
				item as {
					destination?: { outputKey: string; path: string; acl?: unknown };
				}
			).destination;
			if (destination) {
				push(destination.outputKey, {
					path: destination.path,
					role: group.role,
					key: item.key,
					...(destination.acl !== undefined ? { acl: destination.acl } : {}),
				});
			}
		}
	}

	const endpoint = (
		e: Record<string, unknown>,
		paths: StorageEndpointPath[],
	): StorageEndpoint => ({
		key: e.key as string,
		kind: typeof e.kind === "string" ? e.kind : "UNKNOWN",
		location: locationOf(e),
		...(typeof e.credentialId === "string"
			? { credentialId: e.credentialId }
			: {}),
		paths,
	});

	return {
		inputs: plan.inputs.map((i) => endpoint(i as Record<string, unknown>, [])),
		outputs: plan.outputs.map((o) =>
			endpoint(
				o as Record<string, unknown>,
				(writes.get(o.key) ?? []).sort(
					(a, b) =>
						a.role.localeCompare(b.role) || a.path.localeCompare(b.path),
				),
			),
		),
	};
}

/**
 * Splits a rendition's fields into what the plan SET and what the schema
 * defaulted.
 *
 * The schema is the registry: re-parsing a minimal object for the same codec
 * discriminant materializes exactly the defaults zod would have applied, so
 * diffing that against the stored rendition needs no rules table and cannot
 * drift from the schema it describes. bm-xray's three-way
 * explicit/default/inferred taxonomy classifies *API responses* against a rules
 * registry; this is the honest two-way equivalent for *plan intent*, and the
 * Bitmovin-side inferred half stays bm-xray's job (design §1).
 *
 * A field the schema cannot default (required, or absent from the minimal
 * parse) reads as `set`.
 *
 * **What `schema-default` can and cannot mean.** The persisted plan is the
 * PARSED plan — `POST /api/encoding-jobs` stores
 * `applyAccountDefaultsToPlan(encodingPlanSchema.parse(body), …)` — so zod's
 * defaults are materialized at store time and the "was this key in the submitted
 * JSON" distinction is gone for good. Value equality is therefore the only
 * signal available, and `schema-default` means precisely *indistinguishable from
 * the schema default*, not *provably not chosen*: an operator who explicitly
 * types `mode: "STANDARD"` gets the same badge as one who omitted it. Recorded
 * as a limitation rather than papered over, because the badge otherwise implies
 * knowledge the data does not contain. (The corpus is exactly this case — its
 * fixtures set nearly every field explicitly, since they mirror encoding examples
 * scripts.)
 */
export function classifyRenditionParams(
	rendition: PlanRendition,
): ClassifiedParam[] {
	let defaults: Record<string, unknown> = {};
	/**
	 * The names COPIED INTO the minimal object, which therefore cannot be
	 * classified by comparing against it.
	 *
	 * This is the fix for a wrong answer on every rendition row. The minimal parse
	 * seeds the schema's required fields from the rendition itself — it has to, or
	 * the parse fails — and the comparison below then found the seeded value equal
	 * to the stored value *because it was copied in*, labelling `height`, `bitrate`
	 * and `rate` as "schema default" on 100% of the corpus: 644 of 1234 labels were
	 * false, and a rendition written `{"height": 360, "bitrate": 300000}` verbatim
	 * in the plan JSON had both badged as defaults (review finding). They are
	 * required fields; they can never BE defaults. Tracked as a set rather than a
	 * second hardcoded list so the exclusion cannot drift from the seeding.
	 */
	const seeded = new Set(["key", "ingestKey", "codec"]);
	try {
		// The minimal object for this codec: the discriminant plus the fields the
		// schema cannot default. Parsing it yields the materialized defaults.
		const minimal: Record<string, unknown> = {
			key: rendition.key,
			ingestKey: rendition.ingestKey,
			codec: rendition.codec,
		};
		const r = rendition as PlanRendition & Record<string, unknown>;
		// `filename` was in this list and is dead weight: no rendition variant
		// declares it and every variant is a `strictObject`, so `in` can never be
		// true (review finding).
		for (const required of ["height", "bitrate", "rate"]) {
			if (required in r) {
				minimal[required] = r[required];
				seeded.add(required);
			}
		}
		const parsed = renditionSchema.safeParse(minimal);
		if (parsed.success) {
			defaults = parsed.data as unknown as Record<string, unknown>;
		}
	} catch {
		// A schema shape this function cannot minimally re-parse: everything reads
		// as `set`, which is the honest direction.
	}

	const out: ClassifiedParam[] = [];
	for (const [name, value] of Object.entries(
		rendition as unknown as Record<string, unknown>,
	)) {
		const defaulted =
			name in defaults &&
			JSON.stringify(defaults[name]) === JSON.stringify(value) &&
			!seeded.has(name);
		out.push({ name, value, source: defaulted ? "schema-default" : "set" });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}
