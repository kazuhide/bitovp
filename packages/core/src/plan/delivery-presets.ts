import { deliverySpecMetaSchema } from "./preset-schemas";
import type { QcGate } from "./qc-gate";
import type { EncodingPlan } from "./schema";
import { encodingPlanSchema } from "./schema";

/**
 * Delivery-spec presets .
 *
 * A delivery preset is a plan PLUS a machine-readable spec table: the same
 * constraints render as the gallery's requirements list and drive the
 * conformance checker, so the sentence an operator reads and the check that
 * fires cannot drift apart (one source).
 *
 * The shipped set is deliberately TWO, not four: the design's v1 named four,
 * but two of them (broadcast-ts-mpeg2, audio-master-wav) require codec/muxing
 * surface the plan schema does not carry today (no H.262/MP2/PCM codec
 * configs, no WAV/MOV/MXF muxings — REQUIREMENTS §4.2 lists them as the
 * API-parity TARGET, not the implemented surface, and the design doc's
 * "already in the plan schema" overstated). Per the design's own rule —
 * anything unverifiable ships as a documented example in the authoring guide
 * instead of a preset — those two live in
 * docs/DELIVERY-PRESET-AUTHORING.md, and ledger row 82 records the schema
 * gap as the reopening condition.
 */

export type DeliveryConstraint = {
	/** Human sentence, rendered verbatim in the gallery's spec table. */
	requirement: string;
	/** Dot-path into the plan JSON (array indices as numbers: `renditions.0.bitrate`). */
	path: string;
	/** Exactly one operator per constraint — the grammar is deliberately small. */
	expect: { eq?: unknown; gte?: number; lte?: number; oneOf?: unknown[] };
};

export type DeliverySpec = {
	id: string;
	name: string;
	category: "MEZZANINE" | "BROADCAST_TS" | "AUDIO_MASTER";
	description: string;
	/** Placeholder credentials/buckets — the import path's checklist fills them. */
	plan: EncodingPlan;
	constraints: DeliveryConstraint[];
	/** Advisory QC gate : loaded WITH the plan, editable after. */
	suggestedGate?: QcGate;
	/** Spec-document references, where a public one exists. */
	sources?: string[];
};

export type Deviation = {
	requirement: string;
	path: string;
	expected: DeliveryConstraint["expect"];
	/** The value found at `path`; undefined = the path does not resolve. */
	actual: unknown;
};

/** Resolve a dot-path (numeric segments index arrays). Undefined on any miss. */
function resolvePath(root: unknown, path: string): unknown {
	let node: unknown = root;
	for (const segment of path.split(".")) {
		if (node === null || typeof node !== "object") {
			return undefined;
		}
		// Own keys only (review-205 N8): a JSON "__proto__"/"constructor"
		// segment must miss, not walk the prototype — #61's precedent.
		if (!Object.hasOwn(node, segment)) {
			return undefined;
		}
		node = (node as Record<string, unknown>)[segment];
	}
	return node;
}

function satisfies(
	value: unknown,
	expect: DeliveryConstraint["expect"],
): boolean {
	if ("eq" in expect) {
		// review-205 I4: {eq: undefined} on an unresolved path compares
		// undefined === undefined and PASSES — the exact operator someone
		// reaches for to express "field is absent", inverting the module's
		// headline rule. Absence is not expressible in the v1 grammar
		// ; an undefined bound fails closed.
		if (expect.eq === undefined) {
			return false;
		}
		return JSON.stringify(value) === JSON.stringify(expect.eq);
	}
	if ("oneOf" in expect && expect.oneOf) {
		return expect.oneOf.some(
			(candidate) => JSON.stringify(value) === JSON.stringify(candidate),
		);
	}
	// gte/lte compose (a range is two constraints or one with both bounds).
	// review-205 I4: value < NaN is false, so a non-finite bound fell
	// through every guard and the constraint ALWAYS passed — a spec author's
	// null/quoted-number slip became a green checkmark. Fail closed.
	if (
		(expect.gte !== undefined && !Number.isFinite(expect.gte)) ||
		(expect.lte !== undefined && !Number.isFinite(expect.lte))
	) {
		// A PRESENT bound that is not a finite number (null slips through
		// `?? 0` — measured) fails closed.
		return false;
	}
	if (typeof value !== "number") {
		return false;
	}
	if (expect.gte !== undefined && value < expect.gte) {
		return false;
	}
	if (expect.lte !== undefined && value > expect.lte) {
		return false;
	}
	return expect.gte !== undefined || expect.lte !== undefined;
}

/**
 * Pure conformance check: every constraint evaluated against the plan; a
 * deviation row per miss. An UNRESOLVED path is a deviation, never a pass —
 * a spec whose field the plan dropped must say so (the gate's unmeasured
 * lesson, same shape). Reused by the gallery detail, the wizard drift
 * banner, and preset-file import.
 */
export function checkDeliverySpec(
	plan: unknown,
	spec: Pick<DeliverySpec, "constraints">,
): Deviation[] {
	const deviations: Deviation[] = [];
	for (const constraint of spec.constraints) {
		const actual = resolvePath(plan, constraint.path);
		if (!satisfies(actual, constraint.expect)) {
			deviations.push({
				requirement: constraint.requirement,
				path: constraint.path,
				expected: constraint.expect,
				actual,
			});
		}
	}
	return deviations;
}

/** Placeholder ids matching the fixture corpus' conventions. */
const IN_CRED = "00000000-0000-4000-8000-000000000001";
const OUT_CRED = "00000000-0000-4000-8000-000000000002";

/**
 * H.264 1080p high-bitrate mezzanine: one progressive MP4, High profile,
 * 50 Mbps video + 320k AAC, faststart for storage-side probing. The classic
 * "house mezzanine" shape file-delivery shops standardize on.
 */
const MEZZ_H264: DeliverySpec = {
	id: "mezz-h264-1080p-50m",
	name: "Mezzanine — H.264 1080p 50 Mbps MP4",
	category: "MEZZANINE",
	// : this sentence renders verbatim on the customer presets page,
	// so it says what the spec delivers and not where the limit is recorded
	// (the combined-AV MP4 gap stays ledgered under #82; see line 83 above).
	description:
		"Progressive MP4 mezzanine: H.264 High profile 1080p at 50 Mbps plus a 320 kbps AAC audio master, delivered as separate progressive files (one stream per MP4). Export and adapt to your platform's delivery spec.",
	plan: encodingPlanSchema.parse({
		planVersion: 1,
		name: "mezz-h264-1080p-50m",
		bitmovin: {},
		inputs: [
			{
				key: "main",
				kind: "S3",
				credentialId: IN_CRED,
				bucket: "sample-input-bucket",
				name: "Mezzanine source",
			},
		],
		outputs: [
			{
				key: "origin",
				kind: "S3",
				credentialId: OUT_CRED,
				bucket: "sample-output-bucket",
				name: "Delivery output",
			},
		],
		ingest: [
			{
				key: "video",
				inputKey: "main",
				inputPath: "sources/master.mov",
				selectionMode: "VIDEO_RELATIVE",
				position: 0,
			},
			{
				key: "audio",
				inputKey: "main",
				inputPath: "sources/master.mov",
				selectionMode: "AUDIO_RELATIVE",
				position: 0,
			},
		],
		renditions: [
			{
				key: "v1080",
				ingestKey: "video",
				codec: "H264",
				height: 1080,
				bitrate: 50_000_000,
				profile: "HIGH",
			},
			{
				key: "a320",
				ingestKey: "audio",
				codec: "AAC",
				bitrate: 320_000,
				rate: 48_000,
			},
		],
		muxings: [
			{
				key: "mezzV",
				kind: "MP4",
				streamKey: "v1080",
				filename: "mezzanine-1080p-video.mp4",
				destination: { outputKey: "origin", path: "./delivery/h264-1080" },
			},
			{
				key: "mezzA",
				kind: "MP4",
				streamKey: "a320",
				filename: "mezzanine-1080p-audio.mp4",
				destination: { outputKey: "origin", path: "./delivery/h264-1080" },
			},
		],
		manifests: [],
		generation: { timing: "POST_ENCODING" },
	}),
	constraints: [
		{
			requirement: "Video codec H.264",
			path: "renditions.0.codec",
			expect: { eq: "H264" },
		},
		{
			requirement: "H.264 High profile",
			path: "renditions.0.profile",
			expect: { eq: "HIGH" },
		},
		{
			requirement: "1080-line frame",
			path: "renditions.0.height",
			expect: { eq: 1080 },
		},
		{
			requirement: "Video bitrate 45–55 Mbps",
			path: "renditions.0.bitrate",
			expect: { gte: 45_000_000, lte: 55_000_000 },
		},
		{
			requirement: "Audio AAC",
			path: "renditions.1.codec",
			expect: { eq: "AAC" },
		},
		{
			requirement: "Audio bitrate ≥ 320 kbps",
			path: "renditions.1.bitrate",
			expect: { gte: 320_000 },
		},
		{
			requirement: "48 kHz audio",
			path: "renditions.1.rate",
			expect: { eq: 48_000 },
		},
		{
			// review-205 I2: the old sentence claimed "no fragmentation
			// fields" but the row asserts only kind === MP4 — the v1 grammar
			// cannot express "field is absent" ,
			// so the sentence now claims exactly what the row checks.
			requirement: "MP4 container video file",
			path: "muxings.0.kind",
			expect: { eq: "MP4" },
		},
		{
			requirement: "MP4 container audio file",
			path: "muxings.1.kind",
			expect: { eq: "MP4" },
		},
	],
	suggestedGate: {
		rules: [{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 95 }],
		onFail: "MARK_ONLY",
	},
};

/**
 * H.265 UHD mezzanine: Main10 2160p high-bitrate progressive MP4 — the
 * archive/interchange shape for UHD masters.
 */
const MEZZ_H265: DeliverySpec = {
	id: "mezz-h265-2160p",
	name: "Mezzanine — H.265 UHD Main10 MP4",
	category: "MEZZANINE",
	description:
		"Progressive MP4 UHD mezzanine: H.265 Main10 2160p at 80 Mbps with 320 kbps AAC. Main10 keeps 10-bit sources 10-bit end to end.",
	plan: encodingPlanSchema.parse({
		planVersion: 1,
		name: "mezz-h265-2160p",
		bitmovin: {},
		inputs: [
			{
				key: "main",
				kind: "S3",
				credentialId: IN_CRED,
				bucket: "sample-input-bucket",
				name: "UHD source",
			},
		],
		outputs: [
			{
				key: "origin",
				kind: "S3",
				credentialId: OUT_CRED,
				bucket: "sample-output-bucket",
				name: "Delivery output",
			},
		],
		ingest: [
			{
				key: "video",
				inputKey: "main",
				inputPath: "sources/master-uhd.mov",
				selectionMode: "VIDEO_RELATIVE",
				position: 0,
			},
			{
				key: "audio",
				inputKey: "main",
				inputPath: "sources/master-uhd.mov",
				selectionMode: "AUDIO_RELATIVE",
				position: 0,
			},
		],
		renditions: [
			{
				key: "v2160",
				ingestKey: "video",
				codec: "H265",
				height: 2160,
				bitrate: 80_000_000,
				profile: "MAIN10",
				// C25's live half caught this (2026-08-14, real run): Bitmovin
				// rejects MAIN10 without an explicit pixel format — "Pixel
				// format has to be set if main10 profile is specified"
				// (400 code 1000). 10-bit 4:2:0 is the mezzanine intent.
				pixelFormat: "YUV420P10LE",
			},
			{
				key: "a320",
				ingestKey: "audio",
				codec: "AAC",
				bitrate: 320_000,
				rate: 48_000,
			},
		],
		muxings: [
			{
				key: "mezzV",
				kind: "MP4",
				streamKey: "v2160",
				filename: "mezzanine-2160p-video.mp4",
				destination: { outputKey: "origin", path: "./delivery/h265-2160" },
			},
			{
				key: "mezzA",
				kind: "MP4",
				streamKey: "a320",
				filename: "mezzanine-2160p-audio.mp4",
				destination: { outputKey: "origin", path: "./delivery/h265-2160" },
			},
		],
		manifests: [],
		generation: { timing: "POST_ENCODING" },
	}),
	constraints: [
		{
			requirement: "Video codec H.265",
			path: "renditions.0.codec",
			expect: { eq: "H265" },
		},
		{
			requirement: "Main10 profile (10-bit)",
			path: "renditions.0.profile",
			expect: { eq: "MAIN10" },
		},
		{
			requirement: "2160-line frame",
			path: "renditions.0.height",
			expect: { eq: 2160 },
		},
		{
			requirement: "Video bitrate ≥ 60 Mbps",
			path: "renditions.0.bitrate",
			expect: { gte: 60_000_000 },
		},
		{
			// review-205 I1: the sentence promised AAC but the row checked
			// only the rate — a DDPLUS master shipped as a "conformant AAC
			// delivery" with zero deviations.
			requirement: "Audio AAC",
			path: "renditions.1.codec",
			expect: { eq: "AAC" },
		},
		{
			requirement: "Audio at 48 kHz",
			path: "renditions.1.rate",
			expect: { eq: 48_000 },
		},
		{
			requirement: "MP4 container video file",
			path: "muxings.0.kind",
			expect: { eq: "MP4" },
		},
	],
	suggestedGate: {
		rules: [{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 95 }],
		onFail: "MARK_ONLY",
	},
};

export const DELIVERY_SPECS: readonly DeliverySpec[] = [MEZZ_H264, MEZZ_H265];

export function deliverySpec(id: string): DeliverySpec | undefined {
	return DELIVERY_SPECS.find((spec) => spec.id === id);
}

/**
 * Import/export container (design §3): secret-free by construction — plans
 * never carry secrets, only credential ids the import checklist re-binds.
 */
export const DELIVERY_PRESET_FORMAT_VERSION = 1;
export type DeliveryPresetFile = {
	formatVersion: typeof DELIVERY_PRESET_FORMAT_VERSION;
	spec: DeliverySpec;
};

export function exportDeliveryPreset(spec: DeliverySpec): string {
	const file: DeliveryPresetFile = {
		formatVersion: DELIVERY_PRESET_FORMAT_VERSION,
		spec,
	};
	return JSON.stringify(file, null, 2);
}

export type DeliveryPresetImport =
	| { ok: true; spec: DeliverySpec; selfDeviations: Deviation[] }
	| { ok: false; error: string };

/**
 * Strict import: parse the container, schema-parse the plan, and run the
 * spec against its OWN plan. Self-deviations do not REJECT the import (an
 * org may ship a spec its example plan deliberately under-fills) — they are
 * returned so the UI shows them before saving; silence about them is the
 * only failure mode this guards against.
 */
export function importDeliveryPreset(raw: string): DeliveryPresetImport {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, error: "Not valid JSON" };
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		(parsed as { formatVersion?: unknown }).formatVersion !==
			DELIVERY_PRESET_FORMAT_VERSION
	) {
		return { ok: false, error: "Not a formatVersion-1 delivery preset file" };
	}
	const spec = (parsed as { spec?: unknown }).spec;
	if (typeof spec !== "object" || spec === null) {
		return { ok: false, error: "Missing spec object" };
	}
	const record = spec as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		typeof record.name !== "string" ||
		typeof record.description !== "string" ||
		!["MEZZANINE", "BROADCAST_TS", "AUDIO_MASTER"].includes(
			record.category as string,
		) ||
		!Array.isArray(record.constraints)
	) {
		return { ok: false, error: "Spec is missing required fields" };
	}
	// review-205 I3: the hand-rolled checks validated "expect is an object"
	// and nothing else — a scalar oneOf THREW out of satisfies (the async
	// caller swallowed it: a silent no-op import), and a quoted-number gte
	// imported "fine" then always-passed (I4's shape). The schema that
	// already models exactly this metadata is the validator now.
	const meta = deliverySpecMetaSchema.safeParse({
		constraints: record.constraints,
		...(record.suggestedGate !== undefined
			? { suggestedGate: record.suggestedGate }
			: {}),
		...(record.sources !== undefined ? { sources: record.sources } : {}),
	});
	if (!meta.success) {
		const first = meta.error.issues[0];
		return {
			ok: false,
			error:
				`Spec invalid: ${first?.path.join(".") ?? ""} ${first?.message ?? ""}`.trim(),
		};
	}
	const plan = encodingPlanSchema.safeParse(record.plan);
	if (!plan.success) {
		return {
			ok: false,
			error: `Plan invalid: ${plan.error.issues[0]?.message}`,
		};
	}
	const full: DeliverySpec = {
		id: record.id,
		name: record.name,
		category: record.category as DeliverySpec["category"],
		description: record.description,
		plan: plan.data,
		constraints: meta.data.constraints as DeliveryConstraint[],
		...(meta.data.suggestedGate
			? { suggestedGate: meta.data.suggestedGate }
			: {}),
		...(meta.data.sources ? { sources: meta.data.sources } : {}),
	};
	return {
		ok: true,
		spec: full,
		selfDeviations: checkDeliverySpec(full.plan, full),
	};
}
