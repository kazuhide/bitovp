import { randomUUID } from "node:crypto";
import {
	AutomaticBindingError,
	editingAnalysisBindingSchema,
	hashEditingEvidence as hash,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskIntentHash,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import { expect, it } from "vitest";
import type {
	LibraryMediaTask,
	LibraryMediaVersion,
	Prisma,
	SceneAnalysisRevision,
} from "../generated/client";
import { LibraryMediaTaskEvidenceError as LegacyEvidenceError } from "./library-media-task-evidence";
import {
	acceptLibraryMediaTaskEvidenceAnalysis,
	acceptLibraryMediaTaskEvidenceBindings,
	acceptLibraryMediaTaskEvidenceMedia,
	finishLibraryMediaTaskEvidenceRows,
	LibraryMediaTaskEvidenceError,
	prepareLibraryMediaTaskEvidenceRows,
	rethrowLibraryMediaTaskNormalizationError,
	validateLibraryMediaTaskEvidenceRowBundle,
} from "./library-media-task-evidence-rows";
import {
	LibraryNormalizationClockError,
	prepareLibraryNormalizationClockRead,
	verifyLibraryNormalizationClockRows,
} from "./library-normalization-clock";

// Complete synthetic row facts only; no transaction/provider callback enters the pure APIs.
function transcribeFixture() {
	const organizationId = randomUUID(),
		mediaId = randomUUID(),
		now = new Date("2026-11-07T00:00:00Z");
	const map = {
		id: randomUUID(),
		mediaVersionId: mediaId,
		kind: "CFR" as const,
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		editingStartFrame: 0,
		editingEndFrame: 60,
		fps: { num: 30, den: 1 },
	};
	const media: LibraryMediaVersion = {
		id: mediaId,
		organizationId,
		sourceId: randomUUID(),
		credentialId: randomUUID(),
		outputCredentialId: randomUUID(),
		storage: {},
		state: "READY",
		sha256: "a".repeat(64),
		durationUs: 2_000_000n,
		width: 640,
		height: 360,
		fpsNum: 30,
		fpsDen: 1,
		timeMap: map,
		probe: {},
		attempts: 0,
		availableAt: now,
		leaseToken: null,
		leaseUntil: null,
		error: null,
		createdAt: now,
		updatedAt: now,
	};
	const input = mediaTaskCreateSchema.parse({
		kind: "TRANSCRIBE",
		mediaVersionId: mediaId,
		requestKey: randomUUID(),
		parameters: { language: "ja", sourceStartUs: 0, durationUs: 2_000_000 },
	});
	const identity = {
		organizationId,
		mediaSha256: media.sha256,
		modelSha256: null,
		analysisDocumentHash: null,
		analysisRawHash: null,
		timeMapHash: hash(map),
		bindingHash: null,
	};
	const task: LibraryMediaTask = {
		id: randomUUID(),
		organizationId,
		mediaVersionId: mediaId,
		analysisRevisionId: null,
		parentTaskId: null,
		kind: "TRANSCRIBE",
		requestKey: input.requestKey,
		requestHash: mediaTaskIntentHash(input),
		cacheKey: mediaTaskCacheKey(input, identity),
		parameters: {
			schemaVersion: 1,
			input,
			identity,
		} as unknown as Prisma.JsonValue,
		state: "SUCCEEDED",
		phase: "COMPLETE",
		progress: null,
		result: null,
		attempts: 0,
		availableAt: now,
		leaseToken: null,
		leaseUntil: null,
		cancelRequestedAt: null,
		error: null,
		startedAt: now,
		finishedAt: now,
		createdBy: null,
		createdAt: now,
		updatedAt: now,
	};
	return { task, input, identity, media, map };
}
function sourceFixture(kind: "GENERATE" | "TRACK" = "GENERATE") {
	const f = transcribeFixture(),
		raw = {
			metadata: { version: "pure-row-fake" },
			duration: 2,
			scenes: [
				{
					id: randomUUID(),
					type: "MAIN_CONTENT",
					title: "Key",
					startInSeconds: 0,
					endInSeconds: 2,
					shots: [{ startInSeconds: 0, endInSeconds: 2 }],
				},
			],
		};
	const analysis: SceneAnalysisRevision = {
		id: randomUUID(),
		organizationId: f.task.organizationId,
		sourceId: f.media.sourceId,
		locale: "ja",
		rawHash: hash(raw),
		providerVersion: "synthetic",
		raw,
		document: normalizeSceneAnalysis(raw) as unknown as Prisma.JsonValue,
		createdAt: f.task.createdAt,
	};
	const binding = editingAnalysisBindingSchema.parse({
		schemaVersion: 1,
		kind: "FIXTURE_AUTHORED",
		organizationId: f.task.organizationId,
		sourceId: f.media.sourceId,
		locale: "ja",
		analysisRevisionId: analysis.id,
		analysisRawHash: analysis.rawHash,
		analysisDocumentHash: hash(analysis.document),
		mediaVersionId: f.media.id,
		mediaSha256: f.media.sha256,
		timeMapId: f.map.id,
		timeMapHash: hash(f.map),
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		width: 640,
		height: 360,
	});
	const input = mediaTaskCreateSchema.parse({
		kind,
		mediaVersionId: f.media.id,
		analysisRevisionId: analysis.id,
		requestKey: randomUUID(),
		parameters:
			kind === "TRACK"
				? {}
				: {
						contentId: randomUUID(),
						targetDurationFrames: 60,
						policy: "DURATION",
						captions: "OFF",
						tracking: false,
						language: "ja",
					},
	});
	const identity = {
		...f.identity,
		analysisDocumentHash: binding.analysisDocumentHash,
		analysisRawHash: analysis.rawHash,
		bindingHash: hash(binding),
		bindingSnapshot: binding,
	};
	const refresh = () =>
		Object.assign(f.task, {
			kind,
			analysisRevisionId: analysis.id,
			requestKey: input.requestKey,
			requestHash: mediaTaskIntentHash(input),
			cacheKey: mediaTaskCacheKey(input, identity),
			parameters: { schemaVersion: 1, input, identity },
		});
	refresh();
	const bindings = [{ proof: binding as unknown as Prisma.JsonValue }];
	const checked = () => {
		const result = acceptLibraryMediaTaskEvidenceMedia(
			prepareLibraryMediaTaskEvidenceRows(f.task),
			f.media,
		);
		if (result.kind !== "ANALYSIS_REQUIRED")
			throw Error("Expected analysis stage");
		return result.state;
	};
	return {
		...f,
		input,
		identity,
		analysis,
		binding,
		bindings,
		refresh,
		checked,
	};
}

function normalization(f: ReturnType<typeof sourceFixture>) {
	const source = {
		width: 640,
		height: 360,
		codec: "h264",
		fps: { num: 24, den: 1 },
		timeBase: { num: 1, den: 12288 },
		frameCount: 48,
		durationUs: 2_000_000,
		videoPtsHash: "b".repeat(64),
		colorProfile: "BT709_8BIT_LIMITED",
		audio: null,
	};
	const sourceFrameIndex = Array.from({ length: 60 }, (_, i) =>
		Math.floor((i * 24) / 30),
	);
	const proof = {
		schemaVersion: 1,
		profile: "SDR_CFR30_INDEXED_V1",
		mode: "NORMALIZE",
		originalSha256: "c".repeat(64),
		preparedSha256: f.media.sha256,
		originalBytes: 100,
		preparedBytes: 120,
		source,
		output: {
			width: 640,
			height: 360,
			frameCount: 60,
			durationUs: 2_000_000,
			fps: { num: 30, den: 1 },
			hasAudio: false,
		},
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		sourceFrameIndex,
		indexMapHash: hash(sourceFrameIndex),
		recipeHash: hash({
			profile: "SDR_CFR30_INDEXED_V1",
			mode: "NORMALIZE",
			source,
			videoFilter:
				"fps=fps=30:start_time=0:round=up:eof_action=pass,trim=end_frame=60,setpts=N/(30*TB),setsar=1/1",
			audioFilter: null,
		}),
		organizationId: f.task.organizationId,
		sourceId: f.media.sourceId,
		mediaVersionId: f.media.id,
		timeMapId: f.map.id,
	};
	const row = {
		organizationId: f.task.organizationId,
		sourceId: f.media.sourceId,
		mediaVersionId: f.media.id,
		analysisRevisionId: null,
		kind: "NORMALIZATION_CAPTURE",
		proof: proof as unknown as Prisma.JsonValue,
		proofHash: hash(proof),
	};
	Reflect.set(f.identity, "preparedShotClock", {
		version: "aisa-prepared-clock-v3",
		normalizationReceiptHash: row.proofHash,
	});
	f.refresh();
	return { row, proof };
}
function bundle(f: ReturnType<typeof sourceFixture>) {
	return {
		task: f.task,
		media: f.media,
		analysis: f.analysis,
		bindings: f.bindings,
		normalization: { queried: false as const },
	};
}

it("retains the one legacy error constructor without adding a cause", () => {
	expect(LibraryMediaTaskEvidenceError).toBe(LegacyEvidenceError);
	const error = new LibraryMediaTaskEvidenceError("TASK_INTENT_INVALID");
	expect(error).toMatchObject({
		name: "LibraryMediaTaskEvidenceError",
		message: "TASK_INTENT_INVALID",
		code: "TASK_INTENT_INVALID",
	});
	expect(error).not.toHaveProperty("cause");
});
it("keeps envelope schema failure ahead of task/row checks", () => {
	expect(() =>
		prepareLibraryMediaTaskEvidenceRows({ parameters: {} } as LibraryMediaTask),
	).toThrowError(expect.objectContaining({ name: "ZodError" }));
});
it("keeps all TRANSCRIBE fields and the original media row reference", () => {
	const f = transcribeFixture(),
		prepared = prepareLibraryMediaTaskEvidenceRows(f.task);
	expect(prepared.task).toBe(f.task);
	const result = acceptLibraryMediaTaskEvidenceMedia(prepared, f.media);
	if (result.kind !== "TRANSCRIBE") throw Error("Expected early return");
	expect(result.evidence).toEqual({
		envelope: prepared.envelope,
		media: f.media,
		map: f.map,
		analysisDocument: undefined,
		binding: undefined,
		preparedNormalization: undefined,
	});
	expect(result.evidence.media).toBe(f.media);
});
it.each([
	"absent",
	"tenant",
	"state",
	"sha",
	"map",
	"pinned",
] as const)("rejects %s media before the TRANSCRIBE early return", (change) => {
	const f = transcribeFixture(),
		prepared = prepareLibraryMediaTaskEvidenceRows(f.task);
	if (change === "tenant") f.media.organizationId = randomUUID();
	if (change === "state") f.media.state = "PENDING";
	if (change === "sha") f.media.sha256 = "";
	if (change === "map") f.media.timeMap = {};
	if (change === "pinned") f.media.sha256 = "b".repeat(64);
	expect(() =>
		acceptLibraryMediaTaskEvidenceMedia(
			prepared,
			change === "absent" ? null : f.media,
		),
	).toThrowError(
		expect.objectContaining(
			change === "map"
				? { name: "ZodError" }
				: {
						code: change === "pinned" ? "SOURCE_CHANGED" : "MEDIA_NOT_READY",
					},
		),
	);
});
it.each([
	"GENERATE",
	"TRACK",
] as const)("retains all %s phase results without substituting rows", (kind) => {
	const f = sourceFixture(kind),
		media = f.checked(),
		analysis = acceptLibraryMediaTaskEvidenceAnalysis(media, f.analysis),
		bindings = acceptLibraryMediaTaskEvidenceBindings(analysis, f.bindings),
		result = finishLibraryMediaTaskEvidenceRows(bindings, undefined);
	expect(analysis.analysis).toBe(f.analysis);
	expect(result).toEqual({
		envelope: media.envelope,
		media: f.media,
		map: f.map,
		analysisDocument: f.analysis.document,
		binding: f.binding,
		preparedNormalization: undefined,
	});
	expect(result.media).toBe(f.media);
});
it.each([
	"absent",
	"tenant",
	"source",
	"raw",
	"document",
] as const)("keeps analysis %s rejection as AutomaticBindingError", (change) => {
	const f = sourceFixture(),
		media = f.checked();
	if (change === "tenant") f.analysis.organizationId = randomUUID();
	if (change === "source") f.analysis.sourceId = randomUUID();
	if (change === "raw") f.analysis.rawHash = "f".repeat(64);
	if (change === "document") f.analysis.document = {};
	expect(() =>
		acceptLibraryMediaTaskEvidenceAnalysis(
			media,
			change === "absent" ? null : f.analysis,
		),
	).toThrow(AutomaticBindingError);
});
it("keeps binding table proofs and explicit requested binding independently required", () => {
	const f = sourceFixture(),
		a = acceptLibraryMediaTaskEvidenceAnalysis(f.checked(), f.analysis);
	expect(() => acceptLibraryMediaTaskEvidenceBindings(a, [])).toThrow(
		AutomaticBindingError,
	);
	expect(() =>
		acceptLibraryMediaTaskEvidenceBindings(a, f.bindings, {
			...f.binding,
			width: 642,
		}),
	).toThrow(AutomaticBindingError);
});
it.each([
	"GENERATE",
	"TRACK",
] as const)("composes the %s full bundle using the same phase evidence", (kind) => {
	const f = sourceFixture(kind),
		b = bundle(f),
		a = acceptLibraryMediaTaskEvidenceAnalysis(f.checked(), f.analysis),
		state = acceptLibraryMediaTaskEvidenceBindings(a, f.bindings);
	expect(validateLibraryMediaTaskEvidenceRowBundle(b)).toEqual(
		finishLibraryMediaTaskEvidenceRows(state, undefined),
	);
	expect(validateLibraryMediaTaskEvidenceRowBundle(b).media).toBe(f.media);
});
it("never reads unused analysis/bindings/normalization during TRANSCRIBE", () => {
	const f = transcribeFixture(),
		unused = () => {
			throw Error("UNREAD_UNUSED_ROWS");
		};
	expect(
		validateLibraryMediaTaskEvidenceRowBundle({
			task: f.task,
			media: f.media,
			get analysis() {
				return unused();
			},
			get bindings() {
				return unused();
			},
			get normalization() {
				return unused();
			},
		}).analysisDocument,
	).toBeUndefined();
});
it.each([
	"analysis",
	"bindings",
] as const)("rejects unqueried %s rather than manufacturing empty rows", (part) => {
	const f = sourceFixture(),
		b = bundle(f);
	Reflect.deleteProperty(b, part);
	expect(() => validateLibraryMediaTaskEvidenceRowBundle(b)).toThrow(
		AutomaticBindingError,
	);
});
it("validates the complete normalization proof, with no invented receiptId", () => {
	const f = sourceFixture(),
		n = normalization(f);
	const result = validateLibraryMediaTaskEvidenceRowBundle({
		...bundle(f),
		normalization: { queried: true, rows: [n.row] },
	});
	expect(result.preparedNormalization).toEqual({
		proof: n.proof,
		proofHash: n.row.proofHash,
	});
	expect(result.preparedNormalization).not.toHaveProperty("id");
});
it.each([
	"unread",
	"absent",
	"duplicate",
	"scope",
	"proof",
] as const)("rejects %s required normalization", (kind) => {
	const f = sourceFixture(),
		n = normalization(f),
		rows =
			kind === "absent" ? [] : kind === "duplicate" ? [n.row, n.row] : [n.row];
	if (kind === "scope") n.row.sourceId = randomUUID();
	if (kind === "proof") n.row.proofHash = "f".repeat(64);
	expect(() =>
		validateLibraryMediaTaskEvidenceRowBundle({
			...bundle(f),
			normalization:
				kind === "unread" ? { queried: false } : { queried: true, rows },
		}),
	).toThrowError(
		expect.objectContaining({ code: "NORMALIZATION_EVIDENCE_UNVERIFIED" }),
	);
});
it("maps only the normalization clock error and preserves arbitrary exception identity", () => {
	expect(() =>
		rethrowLibraryMediaTaskNormalizationError(
			new LibraryNormalizationClockError(),
		),
	).toThrow(LibraryMediaTaskEvidenceError);
	const failure = new Error("SYNTHETIC_DRIVER_ERROR");
	let actual: unknown;
	try {
		rethrowLibraryMediaTaskNormalizationError(failure);
	} catch (error) {
		actual = error;
	}
	expect(actual).toBe(failure);
});
it("does not consume later rows after an earlier task/media/analysis failure", () => {
	const f = sourceFixture(),
		unused = () => {
			throw Error("LATER_ROWS_MUST_NOT_BE_READ");
		};
	f.task.requestHash = "f".repeat(64);
	expect(() =>
		validateLibraryMediaTaskEvidenceRowBundle({
			task: f.task,
			get media() {
				return unused();
			},
			normalization: { queried: false },
		}),
	).toThrowError(expect.objectContaining({ code: "TASK_INTENT_INVALID" }));
	f.refresh();
	f.media.state = "PENDING";
	expect(() =>
		validateLibraryMediaTaskEvidenceRowBundle({
			...bundle(f),
			get analysis() {
				return unused();
			},
		}),
	).toThrowError(expect.objectContaining({ code: "MEDIA_NOT_READY" }));
	f.media.state = "READY";
	f.analysis.rawHash = "f".repeat(64);
	expect(() =>
		validateLibraryMediaTaskEvidenceRowBundle({
			...bundle(f),
			get bindings() {
				return unused();
			},
		}),
	).toThrow(AutomaticBindingError);
});
it("does not turn another source's media row into evidence for this task", () => {
	const f = sourceFixture(),
		other = sourceFixture();
	expect(() =>
		validateLibraryMediaTaskEvidenceRowBundle({
			...bundle(f),
			media: other.media,
		}),
	).toThrowError(expect.objectContaining({ code: "MEDIA_NOT_READY" }));
});
it("retains bindingHash after matching table proofs", () => {
	const f = sourceFixture();
	f.identity.bindingHash = "f".repeat(64);
	f.refresh();
	expect(() => validateLibraryMediaTaskEvidenceRowBundle(bundle(f))).toThrow(
		AutomaticBindingError,
	);
});
it("ignores normalization rows unless GENERATE actually requested the old clock", () => {
	const f = sourceFixture("TRACK");
	normalization(f);
	const unused = () => {
		throw Error("UNREQUESTED_NORMALIZATION");
	};
	expect(
		validateLibraryMediaTaskEvidenceRowBundle({
			...bundle(f),
			get normalization() {
				return unused();
			},
		}).preparedNormalization,
	).toBeUndefined();
});
it("keeps pinned normalization failure ahead of the final live document parse", () => {
	const f = sourceFixture(),
		n = normalization(f),
		a = acceptLibraryMediaTaskEvidenceAnalysis(f.checked(), f.analysis),
		state = acceptLibraryMediaTaskEvidenceBindings(a, f.bindings);
	const normalized = verifyLibraryNormalizationClockRows(
		prepareLibraryNormalizationClockRead({
			organizationId: f.task.organizationId,
			media: f.media,
		}),
		[n.row],
	);
	Reflect.set(
		f.analysis.document as object,
		"duration",
		"invalid after binding",
	);
	expect(() =>
		finishLibraryMediaTaskEvidenceRows(state, undefined),
	).toThrowError(
		expect.objectContaining({ code: "NORMALIZATION_EVIDENCE_UNVERIFIED" }),
	);
	expect(() =>
		finishLibraryMediaTaskEvidenceRows(state, normalized),
	).toThrowError(expect.objectContaining({ name: "ZodError" }));
});
