import { randomUUID } from "node:crypto";
import {
	AutomaticBindingError,
	editingAnalysisBindingSchema,
	hashEditingEvidence,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskIntentHash,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import type { LibraryMediaTask } from "../generated/client";
import type { AppTransactionClient } from "./client";
import {
	getLibraryMediaTaskEvidenceReadOnly,
	LibraryMediaTaskEvidenceError,
	verifyLibraryMediaTaskEvidence,
} from "./library-media-task-evidence";
import {
	type LibraryMediaTaskEvidenceRowBundle,
	validateLibraryMediaTaskEvidenceRowBundle,
} from "./library-media-task-evidence-rows";

// Authored metadata and fake SELECTs only. No database or media operations.
function fixture(kind: "GENERATE" | "TRACK" | "TRANSCRIBE" = "GENERATE") {
	const organizationId = randomUUID(),
		sourceId = randomUUID(),
		mediaId = randomUUID(),
		analysisId = randomUUID();
	const timeMap = {
		id: randomUUID(),
		mediaVersionId: mediaId,
		kind: "CFR" as const,
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		editingStartFrame: 0,
		editingEndFrame: 60,
		fps: { num: 30 as const, den: 1 as const },
	};
	const media = {
		id: mediaId,
		organizationId,
		sourceId,
		state: "READY",
		sha256: "a".repeat(64),
		width: 640,
		height: 360,
		timeMap,
	};
	const raw = {
		metadata: { version: "synthetic-shared-source-test" },
		duration: 2,
		scenes: [
			{
				id: randomUUID(),
				type: "MAIN_CONTENT",
				title: "Synthetic scene",
				startInSeconds: 0,
				endInSeconds: 2,
				shots: [{ startInSeconds: 0, endInSeconds: 2 }],
			},
		],
	};
	const analysis = {
		id: analysisId,
		organizationId,
		sourceId,
		locale: "ja",
		rawHash: hashEditingEvidence(raw),
		document: normalizeSceneAnalysis(raw),
	};
	const binding = editingAnalysisBindingSchema.parse({
		schemaVersion: 1,
		kind: "FIXTURE_AUTHORED",
		organizationId,
		sourceId,
		locale: "ja",
		analysisRevisionId: analysisId,
		analysisRawHash: analysis.rawHash,
		analysisDocumentHash: hashEditingEvidence(analysis.document),
		mediaVersionId: mediaId,
		mediaSha256: media.sha256,
		timeMapId: timeMap.id,
		timeMapHash: hashEditingEvidence(timeMap),
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		width: 640,
		height: 360,
	});
	const input = mediaTaskCreateSchema.parse({
		kind,
		mediaVersionId: mediaId,
		requestKey: randomUUID(),
		...(kind === "TRANSCRIBE" ? {} : { analysisRevisionId: analysisId }),
		parameters:
			kind === "TRANSCRIBE"
				? { language: "ja", sourceStartUs: 0, durationUs: 2_000_000 }
				: kind === "TRACK"
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
		organizationId,
		mediaSha256: media.sha256,
		modelSha256: null,
		analysisDocumentHash:
			kind === "TRANSCRIBE" ? null : binding.analysisDocumentHash,
		analysisRawHash: kind === "TRANSCRIBE" ? null : analysis.rawHash,
		timeMapHash: binding.timeMapHash,
		bindingHash: kind === "TRANSCRIBE" ? null : hashEditingEvidence(binding),
		...(kind === "TRANSCRIBE" ? {} : { bindingSnapshot: binding }),
	};
	const task = {
		id: randomUUID(),
		organizationId,
		mediaVersionId: mediaId,
		analysisRevisionId: kind === "TRANSCRIBE" ? null : analysisId,
		kind,
		requestKey: input.requestKey,
		parentTaskId: null,
		requestHash: mediaTaskIntentHash(input),
		cacheKey: mediaTaskCacheKey(input, identity),
		parameters: { schemaVersion: 1, input, identity },
		state: "RUNNING",
		leaseToken: randomUUID(),
	} as unknown as LibraryMediaTask;
	const events: string[] = [];
	const findMedia = vi.fn(async (): Promise<typeof media | null> => {
		events.push("media");
		return media;
	});
	const findAnalysis = vi.fn(async (): Promise<typeof analysis | null> => {
		events.push("analysis");
		return analysis;
	});
	const rows: Array<{ proof: unknown }> = [{ proof: binding }];
	const query = vi.fn(
		async (_sql: TemplateStringsArray, ..._values: unknown[]) => {
			events.push("binding");
			return rows;
		},
	);
	const receipts: Array<Record<string, unknown>> = [];
	const findReceipts = vi.fn(async () => {
		events.push("normalization");
		return receipts;
	});
	const tx = {
		libraryMediaVersion: { findUnique: findMedia },
		sceneAnalysisRevision: { findUnique: findAnalysis },
		libraryEvidenceReceipt: { findMany: findReceipts },
		$queryRaw: query,
	} as unknown as AppTransactionClient;
	const refresh = () => {
		task.requestHash = mediaTaskIntentHash(input, task.parentTaskId);
		task.cacheKey = mediaTaskCacheKey(input, identity);
	};
	return {
		task,
		input,
		identity,
		media,
		analysis,
		binding,
		tx,
		events,
		findMedia,
		findAnalysis,
		query,
		rows,
		receipts,
		findReceipts,
		refresh,
	};
}

function prepared(f: ReturnType<typeof fixture>) {
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
		indexMapHash: hashEditingEvidence(sourceFrameIndex),
		recipeHash: hashEditingEvidence({
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
		timeMapId: f.media.timeMap.id,
	};
	const row = {
		id: randomUUID(),
		organizationId: f.task.organizationId,
		sourceId: f.media.sourceId,
		mediaVersionId: f.media.id,
		analysisRevisionId: null,
		kind: "NORMALIZATION_CAPTURE",
		proof,
		proofHash: hashEditingEvidence(proof),
	};
	f.receipts.push(row);
	Object.assign(f.identity, {
		preparedShotClock: {
			version: "aisa-prepared-clock-v3",
			normalizationReceiptHash: row.proofHash,
		},
	});
	f.refresh();
	return row;
}

for (const [name, read, locked] of [
	["read-only", getLibraryMediaTaskEvidenceReadOnly, false],
	["worker", verifyLibraryMediaTaskEvidence, true],
] as const)
	describe(name + " shared source evidence", () => {
		it.each([
			"TRANSCRIBE",
			"TRACK",
			"GENERATE",
		] as const)("matches the pure %s bundle on the same rows without substituting media", async (kind) => {
			const f = fixture(kind),
				actual = await read(f.tx, f.task);
			const bundle: LibraryMediaTaskEvidenceRowBundle = {
				task: f.task,
				media: f.media as unknown as LibraryMediaTaskEvidenceRowBundle["media"],
				analysis:
					f.analysis as unknown as LibraryMediaTaskEvidenceRowBundle["analysis"],
				bindings:
					f.rows as unknown as LibraryMediaTaskEvidenceRowBundle["bindings"],
				normalization: { queried: false },
			};
			const pure = validateLibraryMediaTaskEvidenceRowBundle(bundle);
			expect(pure).toEqual(actual);
			expect(pure.media).toBe(f.media);
		});
		it("matches the complete normalization result on the same actual fake rows", async () => {
			const f = fixture();
			prepared(f);
			const actual = await read(f.tx, f.task);
			const pure = validateLibraryMediaTaskEvidenceRowBundle({
				task: f.task,
				media: f.media as unknown as LibraryMediaTaskEvidenceRowBundle["media"],
				analysis:
					f.analysis as unknown as LibraryMediaTaskEvidenceRowBundle["analysis"],
				bindings:
					f.rows as unknown as LibraryMediaTaskEvidenceRowBundle["bindings"],
				normalization: {
					queried: true,
					rows: f.receipts as unknown as Extract<
						LibraryMediaTaskEvidenceRowBundle["normalization"],
						{ queried: true }
					>["rows"],
				},
			});
			expect(pure).toEqual(actual);
			expect(pure.preparedNormalization).not.toHaveProperty("id");
		});
		it("keeps the original task reference across the media await", async () => {
			const f = fixture();
			f.findMedia.mockImplementationOnce(async () => {
				f.task.organizationId = randomUUID();
				return f.media;
			});
			await expect(read(f.tx, f.task)).rejects.toMatchObject({
				code: "MEDIA_NOT_READY",
			});
			expect(f.query).not.toHaveBeenCalled();
		});
		it("keeps the original media reference across the analysis await", async () => {
			const f = fixture();
			f.findAnalysis.mockImplementationOnce(async () => {
				f.media.sourceId = randomUUID();
				return f.analysis;
			});
			await expect(read(f.tx, f.task)).rejects.toBeInstanceOf(
				AutomaticBindingError,
			);
			expect(f.query).not.toHaveBeenCalled();
		});
		it("does not reparse task parameters after the media await", async () => {
			const f = fixture();
			f.findMedia.mockImplementationOnce(async () => {
				f.task.parameters = {};
				return f.media;
			});
			await expect(read(f.tx, f.task)).resolves.toMatchObject({
				binding: f.binding,
			});
		});
		it.each([
			"valid",
			"invalid",
		] as const)("retains the last document parse after normalization (%s alias)", async (change) => {
			const f = fixture();
			prepared(f);
			f.findReceipts.mockImplementationOnce(async () => {
				if (change === "valid")
					f.analysis.document.title = "Changed during normalization";
				else Reflect.set(f.analysis.document, "duration", "invalid duration");
				return f.receipts;
			});
			const result = read(f.tx, f.task);
			if (change === "invalid")
				await expect(result).rejects.toMatchObject({ name: "ZodError" });
			else
				expect((await result).analysisDocument?.title).toBe(
					"Changed during normalization",
				);
		});
		it.each([
			"analysis",
			"binding",
		] as const)("preserves the same %s driver error object", async (phase) => {
			const f = fixture(),
				failure = new Error("SYNTHETIC_DRIVER_ERROR");
			if (phase === "analysis") f.findAnalysis.mockRejectedValueOnce(failure);
			else f.query.mockRejectedValueOnce(failure);
			await expect(read(f.tx, f.task)).rejects.toBe(failure);
		});
		it.each([
			"TRANSCRIBE",
			"TRACK",
			"GENERATE",
		] as const)("keeps the complete %s result and original SELECT order", async (kind) => {
			const f = fixture(kind),
				result = await read(f.tx, f.task);
			expect(result.media).toBe(f.media);
			expect(result.map).toEqual(f.media.timeMap);
			expect(result.envelope).toEqual(f.task.parameters);
			expect(result.analysisDocument).toEqual(
				kind === "TRANSCRIBE" ? undefined : f.analysis.document,
			);
			expect(result.binding).toEqual(
				kind === "TRANSCRIBE" ? undefined : f.binding,
			);
			expect(result.preparedNormalization).toBeUndefined();
			expect(f.events).toEqual(
				kind === "TRANSCRIBE" ? ["media"] : ["media", "analysis", "binding"],
			);
			if (kind !== "TRANSCRIBE") {
				const call = f.query.mock.calls[0];
				expect(call?.slice(1)).toEqual([
					f.task.organizationId,
					f.media.id,
					f.analysis.id,
				]);
				const sql = call?.[0].join("?").replace(/\s+/g, " ").trim();
				expect(sql?.endsWith("FOR KEY SHARE")).toBe(locked);
				expect(sql?.replace(/ FOR KEY SHARE$/, "")).toBe(
					'SELECT "proof" FROM "LibraryAnalysisBinding" WHERE "organizationId" = ?::uuid AND "mediaVersionId" = ?::uuid AND "analysisRevisionId" = ?::uuid',
				);
			}
		});
		it("allows terminal source revalidation without adding a RUNNING lease requirement", async () => {
			const f = fixture();
			f.task.state = "SUCCEEDED";
			f.task.leaseToken = null;
			await expect(read(f.tx, f.task)).resolves.toMatchObject({
				binding: f.binding,
			});
		});
		it.each([
			"organizationId",
			"mediaVersionId",
			"analysisRevisionId",
			"requestKey",
			"requestHash",
			"cacheKey",
		] as const)("rejects changed task %s before any SELECT", async (field) => {
			const f = fixture();
			Reflect.set(
				f.task,
				field,
				field.endsWith("Hash") || field === "cacheKey"
					? "f".repeat(64)
					: randomUUID(),
			);
			await expect(read(f.tx, f.task)).rejects.toMatchObject({
				code: "TASK_INTENT_INVALID",
			});
			expect(f.events).toEqual([]);
		});
		it("retains schema failure precedence over task/media checks", async () => {
			const f = fixture();
			f.task.parameters = {};
			await expect(read(f.tx, f.task)).rejects.toMatchObject({
				name: "ZodError",
			});
			expect(f.events).toEqual([]);
		});
		it.each([
			"absent",
			"tenant",
			"state",
			"sha",
		] as const)("rejects %s media before reading analysis", async (change) => {
			const f = fixture();
			if (change === "absent") f.findMedia.mockResolvedValue(null);
			if (change === "tenant") f.media.organizationId = randomUUID();
			if (change === "state") f.media.state = "PENDING";
			if (change === "sha") f.media.sha256 = "";
			await expect(read(f.tx, f.task)).rejects.toMatchObject({
				code: "MEDIA_NOT_READY",
			});
			expect(f.findAnalysis).not.toHaveBeenCalled();
			expect(f.query).not.toHaveBeenCalled();
		});
		it("rejects changed pinned media before TRANSCRIBE can return early", async () => {
			const f = fixture("TRANSCRIBE");
			f.media.sha256 = "f".repeat(64);
			await expect(read(f.tx, f.task)).rejects.toMatchObject({
				code: "SOURCE_CHANGED",
			});
			expect(f.findAnalysis).not.toHaveBeenCalled();
		});
		it.each([
			"mapOwner",
			"mapHash",
		] as const)("keeps %s source-clock binding before analysis", async (change) => {
			const f = fixture();
			if (change === "mapOwner") f.media.timeMap.mediaVersionId = randomUUID();
			else f.media.timeMap.id = randomUUID();
			await expect(read(f.tx, f.task)).rejects.toMatchObject({
				code: "SOURCE_CHANGED",
			});
			expect(f.findAnalysis).not.toHaveBeenCalled();
		});
		it.each([
			"absent",
			"tenant",
			"source",
			"raw",
			"document",
		] as const)("keeps invalid analysis %s as AutomaticBindingError before binding SELECT", async (change) => {
			const f = fixture();
			if (change === "absent") f.findAnalysis.mockResolvedValue(null);
			if (change === "tenant") f.analysis.organizationId = randomUUID();
			if (change === "source") f.analysis.sourceId = randomUUID();
			if (change === "raw") f.analysis.rawHash = "f".repeat(64);
			if (change === "document")
				f.analysis.document.title = "Changed synthetic title";
			await expect(read(f.tx, f.task)).rejects.toBeInstanceOf(
				AutomaticBindingError,
			);
			expect(f.query).not.toHaveBeenCalled();
		});
		it("keeps table proofs, expectedBinding and identity.bindingHash independently bound", async () => {
			const f = fixture();
			await expect(read(f.tx, f.task, f.binding)).resolves.toMatchObject({
				binding: f.binding,
			});
			await expect(
				read(f.tx, f.task, { ...f.binding, mediaSha256: "f".repeat(64) }),
			).rejects.toBeInstanceOf(AutomaticBindingError);
			f.identity.bindingHash = "e".repeat(64);
			f.refresh();
			await expect(read(f.tx, f.task)).rejects.toBeInstanceOf(
				AutomaticBindingError,
			);
			f.identity.bindingHash = hashEditingEvidence(f.binding);
			f.refresh();
			f.rows.length = 0;
			await expect(read(f.tx, f.task)).rejects.toBeInstanceOf(
				AutomaticBindingError,
			);
		});
		it("retains a valid prepared normalization receipt and the original query scope", async () => {
			const f = fixture(),
				row = prepared(f),
				value = await read(f.tx, f.task);
			expect(value.preparedNormalization).toEqual({
				proof: row.proof,
				proofHash: row.proofHash,
			});
			expect(f.events).toEqual([
				"media",
				"analysis",
				"binding",
				"normalization",
			]);
			expect(f.findReceipts).toHaveBeenCalledWith({
				where: {
					organizationId: f.task.organizationId,
					mediaVersionId: f.media.id,
					kind: "NORMALIZATION_CAPTURE",
				},
				take: 2,
			});
		});
		it.each([
			"absent",
			"altered",
			"pinnedHash",
			"duplicate",
		] as const)("retains normalization %s failure and its fixed code", async (change) => {
			const f = fixture(),
				row = prepared(f);
			if (change === "absent") f.receipts.length = 0;
			if (change === "altered") row.proof.sourceFrameIndex[1] = 8;
			if (change === "duplicate") f.receipts.push({ ...row, id: randomUUID() });
			if (change === "pinnedHash") {
				Reflect.set(f.identity, "preparedShotClock", {
					version: "aisa-prepared-clock-v3",
					normalizationReceiptHash: "f".repeat(64),
				});
				f.refresh();
			}
			let error: unknown;
			try {
				await read(f.tx, f.task);
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(LibraryMediaTaskEvidenceError);
			expect(error).toMatchObject({
				code: "NORMALIZATION_EVIDENCE_UNVERIFIED",
				message: "NORMALIZATION_EVIDENCE_UNVERIFIED",
			});
			expect(error).not.toHaveProperty("cause");
		});
		it("keeps normalization conditional on GENERATE plus the old prepared clock pin", async () => {
			const f = fixture("TRACK");
			prepared(f);
			await read(f.tx, f.task);
			expect(f.findReceipts).not.toHaveBeenCalled();
		});
		it("does not remap arbitrary driver errors, including the normalization query", async () => {
			const f = fixture(),
				failure = new Error("SYNTHETIC_DRIVER_ERROR");
			f.findMedia.mockRejectedValueOnce(failure);
			await expect(read(f.tx, f.task)).rejects.toBe(failure);
			prepared(f);
			f.findReceipts.mockRejectedValueOnce(failure);
			await expect(read(f.tx, f.task)).rejects.toBe(failure);
		});
	});
