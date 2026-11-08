import { createHash } from "node:crypto";
import {
	compilePlan,
	encodingPlanSchema,
	hashEditingEvidence,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import { matchesWhere } from "@bitovp/core/testing";
import type { AppPrismaClient, AppTransactionClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import plan from "../../../../packages/core/src/plan/__fixtures__/ai-scene-analysis-passthrough.plan.json";
import { buildNormalizationRecipe } from "../library-editing/normalization";
import {
	reconcileCapturedBindings,
	recordAuthoritativeAnalysisCapture,
} from "./captured-bindings";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
function required<T>(value: T | null | undefined): T {
	if (value === null || value === undefined)
		throw new Error("Missing test fixture");
	return value;
}
function fixture() {
	const source = {
		id: id(2),
		organizationId: id(1),
		sourceKind: "VOD_JOB",
		originalJobId: id(3),
		jobId: id(3),
		encodingId: id(4),
		accountId: id(5),
		locales: ["ja", "en"],
	};
	const op = compilePlan(encodingPlanSchema.parse(plan)).find(
		(item) => item.kind === "CREATE_INGEST_INPUT_STREAM",
	);
	if (!op) throw new Error("Missing ingest");
	const witness = {
		...op,
		status: "DONE",
		resourceId: id(6),
		request: { ...op.payload, refs: { encodingId: id(4) } },
		response: { id: id(6), providerInputId: id(7), inputReceiptId: id(8) },
	};
	const job = {
		id: id(3),
		organizationId: id(1),
		status: "FINISHED",
		bitmovinEncodingId: id(4),
		bitmovinAccountId: id(5),
		plan: structuredClone(plan),
		stepLog: [witness],
	};
	const sourceFacts = {
		width: 320,
		height: 180,
		codec: "h264" as const,
		fps: { num: 25, den: 1 },
		timeBase: { num: 1, den: 12800 },
		frameCount: 50,
		durationUs: 2_000_000,
		videoPtsHash: "b".repeat(64),
		colorProfile: "BT709_8BIT_LIMITED" as const,
		audio: null,
	};
	const inputProof = {
		schemaVersion: 1,
		profile: "PINNED_HTTP_INPUT_V1",
		organizationId: id(1),
		jobId: id(3),
		encodingId: id(4),
		expiresAt: 1_900_000_000,
		storage: {
			credentialId: plan.inputs[0]?.credentialId,
			bucket: "sample-input-bucket",
			key: "big_buck_bunny_1080p_h264.mov",
			size: 200,
			expect: { versionId: "version-one" },
		},
		sha256: "a".repeat(64),
		sourceFacts,
		ingestKey: "video",
		planHash: hashEditingEvidence(job.plan),
	};
	const receipt = (n: number, kind: string, proof: unknown, extra = {}) => ({
		id: id(n),
		organizationId: id(1),
		sourceId: kind === "INPUT_CAPTURE" ? null : id(2),
		mediaVersionId: null as string | null,
		analysisRevisionId: null as string | null,
		jobId: id(3),
		encodingId: id(4),
		kind,
		proof,
		proofHash: hashEditingEvidence(proof),
		...extra,
	});
	const receipts: ReturnType<typeof receipt>[] = [
		receipt(8, "INPUT_CAPTURE", inputProof),
	];
	const raw = { metadata: { version: "1.79.0" }, duration: 2, scenes: [] };
	const analyses: Record<string, unknown>[] = [];
	const media: Record<string, unknown>[] = [];
	const bindings: Record<string, unknown>[] = [];
	const db = {
		librarySource: { findUnique: vi.fn(async () => source) },
		encodingJob: { findUnique: vi.fn(async () => job) },
		libraryEvidenceReceipt: {
			findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
				receipts.filter((row) => matchesWhere(row, where)),
			),
			findFirst: vi.fn(
				async ({ where }: { where: Record<string, unknown> }) =>
					receipts.find((row) => matchesWhere(row, where)) ?? null,
			),
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				const result = { id: id(20 + receipts.length), ...data } as ReturnType<
					typeof receipt
				>;
				receipts.push(result);
				return result;
			}),
		},
		sceneAnalysisRevision: {
			findMany: vi.fn(async () => analyses),
			findUnique: vi.fn(
				async ({
					where,
				}: {
					where: {
						id?: string;
						sourceId_locale_rawHash?: {
							sourceId: string;
							locale: string;
							rawHash: string;
						};
					};
				}) =>
					analyses.find((row) =>
						where.id
							? row.id === where.id
							: matchesWhere(row, where.sourceId_locale_rawHash ?? {}),
					) ?? null,
			),
			upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
				const prior = analyses.find(
					(row) =>
						row.sourceId === create.sourceId &&
						row.locale === create.locale &&
						row.rawHash === create.rawHash,
				);
				if (prior) return prior;
				const result = {
					id: id(10 + analyses.length),
					organizationId: id(1),
					...structuredClone(create),
				};
				analyses.push(result);
				return result;
			}),
		},
		libraryMediaVersion: { findMany: vi.fn(async () => media) },
		libraryAnalysisBinding: {
			findFirst: vi.fn(
				async ({ where }: { where: Record<string, unknown> }) =>
					bindings.find((row) => matchesWhere(row, where)) ?? null,
			),
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				const result = { id: id(70 + bindings.length), ...data };
				bindings.push(result);
				return result;
			}),
		},
		$queryRaw: vi.fn(async () => [{ id: source.id }]),
		$transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
	};
	const params = {
		prisma: db as unknown as AppPrismaClient,
		organizationId: id(1),
		sourceId: id(2),
	};
	const capture = {
		tx: db as unknown as AppTransactionClient,
		organizationId: id(1),
		sourceId: id(2),
		response: {
			accountId: id(5),
			encodingId: id(4),
			locale: "ja",
			providerResponseSha256: "c".repeat(64),
			raw,
		},
	};
	function ready() {
		const timeMap = {
			id: id(30),
			mediaVersionId: id(30),
			kind: "CFR",
			sourceStartUs: 0,
			sourceEndUs: 2_000_000,
			editingStartFrame: 0,
			editingEndFrame: 60,
			fps: { num: 30, den: 1 },
		};
		media.push({
			id: id(30),
			organizationId: id(1),
			sourceId: id(2),
			state: "READY",
			sha256: "d".repeat(64),
			width: 320,
			height: 180,
			durationUs: 2_000_000n,
			fpsNum: 30,
			fpsDen: 1,
			timeMap,
			storage: { source: structuredClone(inputProof.storage) },
		});
		const recipe = buildNormalizationRecipe(sourceFacts);
		const proof = {
			schemaVersion: 1,
			profile: "SDR_CFR30_INDEXED_V1",
			mode: "NORMALIZE",
			originalSha256: inputProof.sha256,
			preparedSha256: "d".repeat(64),
			originalBytes: 200,
			preparedBytes: 400,
			source: structuredClone(sourceFacts),
			output: {
				width: 320,
				height: 180,
				frameCount: 60,
				durationUs: 2_000_000,
				fps: { num: 30, den: 1 },
				hasAudio: false,
			},
			sourceStartUs: 0,
			sourceEndUs: 2_000_000,
			sourceFrameIndex: recipe.sourceFrameIndex,
			indexMapHash: hashEditingEvidence(recipe.sourceFrameIndex),
			recipeHash: hashEditingEvidence({
				profile: "SDR_CFR30_INDEXED_V1",
				mode: "NORMALIZE",
				source: sourceFacts,
				videoFilter: recipe.videoFilter,
				audioFilter: recipe.audioFilter,
			}),
			organizationId: id(1),
			sourceId: id(2),
			mediaVersionId: id(30),
			timeMapId: id(30),
		};
		receipts.push(
			receipt(31, "NORMALIZATION_CAPTURE", proof, { mediaVersionId: id(30) }),
		);
		return proof;
	}
	return {
		source,
		job,
		witness,
		inputProof,
		sourceFacts,
		raw,
		analyses,
		media,
		receipts,
		bindings,
		db,
		params,
		capture,
		ready,
	};
}

describe("authoritative capture binding producer", () => {
	it.each([
		"analysis-first",
		"media-first",
	])("seals only the completed exact evidence chain (%s)", async (order) => {
		const f = fixture();
		if (order === "media-first") {
			f.ready();
			expect(await reconcileCapturedBindings(f.params)).toMatchObject({
				created: 0,
			});
		}
		await recordAuthoritativeAnalysisCapture(f.capture);
		if (order === "analysis-first") {
			expect(await reconcileCapturedBindings(f.params)).toMatchObject({
				created: 0,
			});
			f.ready();
		}
		expect(await reconcileCapturedBindings(f.params)).toEqual({
			created: 1,
			preserved: 0,
		});
		expect(f.bindings[0]?.proof).toMatchObject({
			kind: "CAPTURED_INPUT",
			organizationId: id(1),
			sourceId: id(2),
			locale: "ja",
			analysisRevisionId: id(10),
			analysisRawHash: sha(f.raw),
			analysisDocumentHash: hashEditingEvidence(normalizeSceneAnalysis(f.raw)),
			mediaVersionId: id(30),
			mediaSha256: "d".repeat(64),
		});
		expect(await reconcileCapturedBindings(f.params)).toEqual({
			created: 0,
			preserved: 1,
		});
		expect(f.db.$queryRaw).toHaveBeenCalled();
	});
	it.each([
		[
			"tenant",
			(f: ReturnType<typeof fixture>) => {
				f.source.organizationId = id(99);
			},
		],
		[
			"account",
			(f: ReturnType<typeof fixture>) => {
				f.capture.response.accountId = id(99);
			},
		],
		[
			"encoding",
			(f: ReturnType<typeof fixture>) => {
				f.capture.response.encodingId = id(99);
			},
		],
		[
			"locale",
			(f: ReturnType<typeof fixture>) => {
				f.capture.response.locale = "fr";
			},
		],
		[
			"transform",
			(f: ReturnType<typeof fixture>) => {
				required(f.job.plan.ingest[0]).inputPath = "other.mov";
			},
		],
	])("does not capture an unrelated %s response", async (_label, change) => {
		const f = fixture();
		change(f);
		await expect(recordAuthoritativeAnalysisCapture(f.capture)).rejects.toThrow(
			"ANALYSIS_CAPTURE_UNVERIFIED",
		);
		expect(f.analyses).toHaveLength(0);
		expect(f.receipts).toHaveLength(1);
	});
	it.each([
		[
			"original digest",
			(proof: Record<string, unknown>) => {
				proof.originalSha256 = "e".repeat(64);
			},
		],
		[
			"source geometry",
			(proof: Record<string, unknown>) => {
				(proof.source as Record<string, unknown>).width = 640;
				(proof.output as Record<string, unknown>).width = 640;
			},
		],
		[
			"index digest",
			(proof: Record<string, unknown>) => {
				proof.indexMapHash = "e".repeat(64);
			},
		],
		[
			"recipe digest",
			(proof: Record<string, unknown>) => {
				proof.recipeHash = "e".repeat(64);
			},
		],
		[
			"time map",
			(proof: Record<string, unknown>) => {
				proof.timeMapId = id(99);
			},
		],
	])("rejects a resealed but inconsistent normalization %s", async (_label, change) => {
		const f = fixture();
		await recordAuthoritativeAnalysisCapture(f.capture);
		const proof = f.ready();
		change(proof);
		required(f.receipts.at(-1)).proofHash = hashEditingEvidence(proof);
		await expect(reconcileCapturedBindings(f.params)).rejects.toThrow(
			"CAPTURED_BINDING_UNVERIFIED",
		);
		expect(f.bindings).toHaveLength(0);
	});
	it("does not promote metadata imported without authoritative provider capture", async () => {
		const f = fixture();
		f.ready();
		f.analyses.push({
			id: id(10),
			organizationId: id(1),
			sourceId: id(2),
			locale: "ja",
			rawHash: sha(f.raw),
			raw: f.raw,
			document: normalizeSceneAnalysis(f.raw),
		});
		expect(await reconcileCapturedBindings(f.params)).toMatchObject({
			created: 0,
		});
		expect(f.bindings).toHaveLength(0);
	});
	it("does not mint from an input receipt deleted before the lock was acquired", async () => {
		const f = fixture();
		await recordAuthoritativeAnalysisCapture(f.capture);
		f.ready();
		let calls = 0;
		f.db.$queryRaw.mockImplementation(async () => {
			calls++;
			if (calls === 2)
				f.receipts.splice(
					f.receipts.findIndex((row) => row.kind === "INPUT_CAPTURE"),
					1,
				);
			return [{ id: f.source.id }];
		});
		await expect(reconcileCapturedBindings(f.params)).rejects.toThrow(
			"CAPTURED_BINDING_UNVERIFIED",
		);
		expect(f.bindings).toHaveLength(0);
	});
	it("does not inherit source proof onto a different encoded-output storage variant", async () => {
		const f = fixture();
		await recordAuthoritativeAnalysisCapture(f.capture);
		f.ready();
		required(f.media[0]).storage = {
			source: { ...f.inputProof.storage, key: "encoded-output.mp4" },
		};
		expect(await reconcileCapturedBindings(f.params)).toEqual({
			created: 0,
			preserved: 0,
		});
		expect(f.bindings).toHaveLength(0);
	});
	it("pins actual stored JSON on its own authoritative insert and preserves it on retry", async () => {
		const f = fixture();
		f.db.sceneAnalysisRevision.upsert.mockImplementationOnce(
			async ({ create }) => {
				const row = {
					id: id(10),
					organizationId: id(1),
					...create,
					raw: { ...f.raw, stored: "server-json-representation" },
				};
				f.analyses.push(row);
				return row;
			},
		);
		await recordAuthoritativeAnalysisCapture(f.capture);
		const receipt = f.receipts.find((row) => row.kind === "ANALYSIS_CAPTURE");
		expect(receipt?.proof).toMatchObject({
			storedRawHash: hashEditingEvidence(f.analyses[0]?.raw),
			ingestionRawHash: sha(f.raw),
		});
		await recordAuthoritativeAnalysisCapture(f.capture);
		expect(
			f.receipts.filter((row) => row.kind === "ANALYSIS_CAPTURE"),
		).toHaveLength(1);
	});
	it("does not attest an already present altered revision using rawHash alone", async () => {
		const f = fixture();
		f.analyses.push({
			id: id(10),
			organizationId: id(1),
			sourceId: id(2),
			locale: "ja",
			rawHash: sha(f.raw),
			raw: { ...f.raw, duration: 99 },
			document: normalizeSceneAnalysis(f.raw),
		});
		await expect(recordAuthoritativeAnalysisCapture(f.capture)).rejects.toThrow(
			"ANALYSIS_CAPTURE_UNVERIFIED",
		);
		expect(f.receipts).toHaveLength(1);
	});
	it("preserves an exact manual attestation instead of relabeling it as provider capture", async () => {
		const f = fixture();
		await recordAuthoritativeAnalysisCapture(f.capture);
		f.ready();
		await reconcileCapturedBindings(f.params);
		const proof = f.bindings[0]?.proof as Record<string, unknown>;
		proof.kind = "EDITOR_ATTESTED";
		proof.attestation = {
			receiptId: id(88),
			actor: "editor",
			confirmedAt: "2026-11-02T00:00:00.000Z",
			scope: ["TIME", "GEOMETRY", "CONTENT"],
		};
		expect(await reconcileCapturedBindings(f.params)).toEqual({
			created: 0,
			preserved: 1,
		});
		expect(proof.kind).toBe("EDITOR_ATTESTED");
	});
	it("never overwrites a different existing sealed tuple", async () => {
		const f = fixture();
		await recordAuthoritativeAnalysisCapture(f.capture);
		f.ready();
		await reconcileCapturedBindings(f.params);
		(required(f.bindings[0]).proof as Record<string, unknown>).mediaSha256 =
			"e".repeat(64);
		await expect(reconcileCapturedBindings(f.params)).rejects.toThrow(
			"CAPTURED_BINDING_UNVERIFIED",
		);
		expect(f.bindings).toHaveLength(1);
	});
});

describe("HLS preparation keeps original-input evidence separate", () => {
	it("skips an HLS variant with an identical original-input locator", async () => {
		const f = fixture();
		await recordAuthoritativeAnalysisCapture(f.capture);
		f.ready();
		required(f.media[0]).storage = {
			source: structuredClone(f.inputProof.storage),
			sourceFormat: "HLS",
			hlsRootPrefix: "",
		};
		const before = structuredClone({
			media: f.media,
			receipts: f.receipts,
			analyses: f.analyses,
		});
		expect(await reconcileCapturedBindings(f.params)).toEqual({
			created: 0,
			preserved: 0,
		});
		expect(f.bindings).toEqual([]);
		expect(f.db.libraryAnalysisBinding.create).not.toHaveBeenCalled();
		expect({
			media: f.media,
			receipts: f.receipts,
			analyses: f.analyses,
		}).toEqual(before);
	});
});
