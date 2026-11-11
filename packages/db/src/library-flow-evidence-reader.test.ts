import { createHash } from "node:crypto";
import {
	canonicalEditingJson,
	editingAnalysisBindingSchema,
	hashEditingEvidence as hash,
	LOCAL_STORY_FLOW_H1_POLICY,
	localStoryFlowGenerationPolicyFingerprint,
	localStoryStageRegistry,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskIntentHash,
	normalizeSceneAnalysis,
	TRANSCRIPTION_POLICY_FINGERPRINT,
} from "@bitovp/core";
import {
	admitLocalStoryFlowArchiveTranscript,
	LOCAL_STORY_FLOW_CLOSURE_POLICY,
	LOCAL_STORY_FLOW_CONTEXT_POLICY,
	LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY,
	LOCAL_STORY_FLOW_ROUTE_POLICY,
	LOCAL_STORY_FLOW_SCOPE_POLICY,
	type LocalStoryFlowRecordKind,
	localStoryFlowArchiveLedgerRequests,
	localStoryFlowArchiveLedgerStageRequest,
	localStoryFlowArchivePreparationEvidence,
	localStoryFlowArchiveTranscriptEvidence,
	localStoryFlowRecordIdentity,
	localStoryFlowSealedRecordEvidence,
	localStoryFlowSourceArchiveEvidence,
	prepareLocalStoryFlowArchiveSource,
} from "@bitovp/core/local-story-flow-hierarchy";
import {
	createLocalStoryLegacyLedgerCacheRecipe,
	createLocalStoryLegacyLedgerStageRecipe,
	LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY,
	localStoryFlowIdentityForModelPin,
	localStoryIdentityForModelPin,
	localStoryLegacyLedgerPrompt,
} from "@bitovp/core/local-story-flow-server";
import { describe, expect, it, type Mock, vi } from "vitest";
import {
	LOCAL_SEMANTIC_MODEL,
	LOCAL_SEMANTIC_MODEL_DIGEST,
	LOCAL_SEMANTIC_RUNTIME_VERSION,
} from "../../core/src/content-editing/local-semantic-protocol";
import type { AppPrismaClient } from "./client";
import {
	localStoryFlowReadSourceEvidence,
	localStoryFlowTaskLockKey,
	validateLocalStoryFlowReadFence,
	validateLocalStoryFlowSourceArchiveReadFence,
	withLocalStoryFlowReadSnapshot,
	withLocalStoryFlowWorkerSourceSnapshot,
} from "./library-flow-evidence-reader";
import { TENANT_ORGANIZATION } from "./tenant-client";

const mocks = vi.hoisted(() => ({ tenant: vi.fn(), catalog: vi.fn() }));
vi.mock(
	"../../core/src/content-editing/local-story-flow-policy-catalog",
	() => ({
		resolveLocalStoryFlowPolicyCatalogForTaskIdentity: mocks.catalog,
	}),
);
vi.mock("./tenant-client", async (original) => ({
	...(await original<typeof import("./tenant-client")>()),
	getTenantPrisma: mocks.tenant,
}));
function firstSynthetic<T>(values: readonly T[]): T {
	const value = values[0];
	if (value === undefined) throw new Error("Missing authored fixture item");
	return value;
}

const org = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const options = { authorizedOrganizationId: org, generationTaskId: taskId };
const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Row = Record<string, unknown>;
function sourceFixture() {
	const mediaId = id(3),
		sourceId = id(4),
		analysisId = id(5),
		contentId = id(6);
	const map = {
		id: id(7),
		mediaVersionId: mediaId,
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		editingStartFrame: 0,
		editingEndFrame: 60,
		fps: { num: 30, den: 1 },
	};
	const media = {
		id: mediaId,
		organizationId: org,
		sourceId,
		state: "READY",
		sha256: hash("authored fixture media; no bytes"),
		width: 640,
		height: 360,
		timeMap: map,
		durationUs: 2_000_000n,
		storage: {},
		probe: { hasAudio: false },
	};
	const raw = {
		metadata: { version: "authored-reader-fixture" },
		duration: 2,
		scenes: [
			{
				id: id(14),
				type: "MAIN_CONTENT",
				title: "Authored scene",
				startInSeconds: 0,
				endInSeconds: 2,
				shots: [{ startInSeconds: 0, endInSeconds: 2 }],
			},
		],
	};
	const analysis = {
		id: analysisId,
		organizationId: org,
		sourceId,
		locale: "ja",
		raw,
		rawHash: hash(raw),
		document: normalizeSceneAnalysis(raw),
	};
	const binding = editingAnalysisBindingSchema.parse({
		schemaVersion: 1,
		kind: "FIXTURE_AUTHORED",
		organizationId: org,
		sourceId,
		locale: "ja",
		analysisRevisionId: analysisId,
		analysisRawHash: analysis.rawHash,
		analysisDocumentHash: hash(analysis.document),
		mediaVersionId: mediaId,
		mediaSha256: media.sha256,
		timeMapId: map.id,
		timeMapHash: hash(map),
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		width: 640,
		height: 360,
	});
	const modelPin = { profile: "nvidia" as const, configId: id(8) };
	const input = mediaTaskCreateSchema.parse({
		kind: "GENERATE",
		mediaVersionId: mediaId,
		analysisRevisionId: analysisId,
		requestKey: id(9),
		parameters: {
			contentId,
			targetDurationFrames: 60,
			policy: "LOCAL_STORY",
			storyMode: "FLOW",
			renderMode: "DRAFT",
			storyWorkflowVersion: "hierarchical-flow-v1",
			captions: "OFF",
			tracking: false,
			language: "ja",
		},
	});
	// Authored persisted input, never compiled readiness or an enabled runtime.
	const identity = {
		organizationId: org,
		mediaSha256: media.sha256,
		modelSha256: null,
		analysisDocumentHash: binding.analysisDocumentHash,
		analysisRawHash: analysis.rawHash,
		timeMapHash: hash(map),
		bindingHash: hash(binding),
		bindingSnapshot: binding,
		localStoryModel: localStoryIdentityForModelPin(modelPin),
		localStoryWorkflow: localStoryFlowIdentityForModelPin(modelPin, "FLOW"),
		generationPolicyFingerprint: hash(
			"authored DB input, compiled8 not attested",
		),
	};
	const task = {
		id: taskId,
		organizationId: org,
		kind: "GENERATE",
		mediaVersionId: mediaId,
		analysisRevisionId: analysisId,
		requestKey: input.requestKey,
		parentTaskId: null,
		requestHash: mediaTaskIntentHash(input),
		cacheKey: mediaTaskCacheKey(input, identity),
		parameters: { schemaVersion: 1, input, identity },
		state: "SUCCEEDED",
		createdBy: "fixture-user",
		startedAt: new Date("2026-11-07T00:00:00Z"),
		result: {
			projectId: id(10),
			projectIds: [id(10)],
			presetIds: ["portrait-clean"],
			renderMode: "DRAFT",
		},
	};
	const project = {
		id: id(10),
		organizationId: org,
		contentId,
		mediaVersionId: mediaId,
		variant: "PORTRAIT",
		createdBy: task.createdBy,
		currentRevisionId: id(12),
		draft: { manuallyEdited: true },
	};
	const revision = {
		id: id(11),
		organizationId: org,
		projectId: project.id,
		revision: 1,
		createdBy: task.createdBy,
		document: {
			mediaVersionId: mediaId,
			timeMapId: map.id,
			analysisRevisionId: analysisId,
			autoGeneration: { renderMode: "DRAFT", binding },
		},
	};
	const bindingRow = {
		id: id(13),
		organizationId: org,
		mediaVersionId: mediaId,
		analysisRevisionId: analysisId,
		proof: binding,
		attestationReceiptId: null,
	};
	const data: Record<string, Row[]> = {
		libraryMediaTask: [task],
		libraryMediaVersion: [media],
		librarySource: [
			{ id: sourceId, organizationId: org, state: "READY", snapshot: raw },
		],
		sceneAnalysisRevision: [analysis],
		libraryAnalysisBinding: [bindingRow],
		editProject: [project],
		editRevision: [revision],
		libraryEvidenceReceipt: [],
		libraryFlowEvidencePin: [],
	};
	const events: Array<{ table: string; args: unknown }> = [];
	const locks: string[] = [];
	const matches = (row: Row, where: Row = {}): boolean =>
		Object.entries(where).every(([key, value]) => {
			if (value && typeof value === "object") {
				if ("in" in value) return (value.in as unknown[]).includes(row[key]);
				return matches(row, value as Row);
			}
			return row[key] === value;
		});
	const tx = Object.fromEntries(
		Object.keys(data).map((table) => [
			table,
			{
				findMany: vi.fn(
					async (args: { where?: Row; select?: Row; take?: number } = {}) => {
						events.push({ table, args });
						return (data[table] ?? [])
							.filter((r) => matches(r, args.where))
							.slice(0, args.take ?? Infinity)
							.map((row) =>
								structuredClone(
									args.select
										? Object.fromEntries(
												Object.keys(args.select).map((k) => [k, row[k]]),
											)
										: row,
								),
							);
					},
				),
				findUnique: vi.fn(async (args: { where: Row; select?: Row }) => {
					events.push({ table, args });
					const row = (data[table] ?? []).find((r) => matches(r, args.where));
					return row
						? structuredClone(
								args.select
									? Object.fromEntries(
											Object.keys(args.select).map((k) => [k, row[k]]),
										)
									: row,
							)
						: null;
				}),
			},
		]),
	) as Record<string | symbol, unknown>;
	tx[TENANT_ORGANIZATION] = org;
	tx.$queryRaw = vi.fn(async () => [{ proof: binding }]);
	tx.$executeRaw = vi.fn(async () => {
		locks.push("advisory");
		return 1;
	});
	tx.$queryRawUnsafe = vi.fn(
		async (sql: string, _org: string, rowId: string, receiptId?: string) => {
			locks.push(sql);
			const table = sql.match(/FROM "(\w+)"/)?.[1] ?? "";
			const delegate = table.charAt(0).toLowerCase() + table.slice(1);
			const found = (data[delegate] ?? []).find((row) =>
				table === "LibraryFlowEvidencePin"
					? row.taskId === rowId && row.receiptId === receiptId
					: row.id === rowId,
			);
			return found
				? [
						{
							id:
								table === "LibraryFlowEvidencePin" ? found.receiptId : found.id,
						},
					]
				: [];
		},
	);
	const transaction = vi.fn(
		async (read: (tx: unknown) => Promise<unknown>, _options?: unknown) =>
			read(tx),
	);
	mocks.tenant.mockReturnValue({
		[TENANT_ORGANIZATION]: org,
		$transaction: transaction,
	});
	return {
		task,
		media,
		analysis,
		binding,
		bindingRow,
		project,
		revision,
		data,
		events,
		locks,
		tx,
		transaction,
	};
}
function addStart(f: ReturnType<typeof sourceFixture>) {
	const sourceTuple = {
		version: "local-story-flow-source-tuple-v1",
		organizationId: org,
		sourceId: f.media.sourceId,
		mediaVersionId: f.media.id,
		mediaSha256: f.media.sha256,
		timeMapHash: hash(f.media.timeMap),
		analysisRevisionId: f.analysis.id,
		analysisRawHash: f.analysis.rawHash,
		analysisDocumentHash: hash(f.analysis.document),
		bindingHash: hash(f.binding),
		preparedShotClockHash: null,
		normalizationReceiptHash: null,
	};
	const kind = "LOCAL_FLOW_PLAN_V1" as const;
	const key = {
		version: "local-story-flow-record-key-v1",
		purpose: "START",
		keyBody: { taskId },
	};
	const identity = localStoryFlowRecordIdentity({ sourceTuple, kind, key });
	const payload = {
		version: "local-story-flow-runtime-start-v1",
		purpose: "START",
		fixture: "Outer-seal fixture only, no compiled/native admission",
	};
	const proof = {
		version: "local-story-cache-v2",
		cacheHash: identity.cacheHash,
		valueJson: canonicalEditingJson(payload),
	};
	const ref = { kind, ...identity, proofHash: hash(proof) };
	const row = {
		id: identity.receiptId,
		organizationId: org,
		sourceId: f.media.sourceId,
		mediaVersionId: f.media.id,
		analysisRevisionId: f.analysis.id,
		kind,
		proof,
		proofHash: ref.proofHash,
		createdBy: "not part of the fixed sealed projection",
	};
	f.data.libraryEvidenceReceipt?.push(row);
	f.data.libraryFlowEvidencePin?.push({
		organizationId: org,
		taskId,
		receiptId: row.id,
	});
	return { kind, key, ref, row, payload, sourceTuple };
}
function addFinalArtifacts(
	f: ReturnType<typeof sourceFixture>,
	start: ReturnType<typeof addStart>,
) {
	const make = (
		purpose: string,
		kind: LocalStoryFlowRecordKind,
		version: string,
	) => {
		const key = {
			version: "local-story-flow-record-key-v1",
			purpose,
			keyBody: { taskId },
		};
		const identity = localStoryFlowRecordIdentity({
			sourceTuple: start.sourceTuple,
			kind,
			key,
		});
		const proof = {
			version: "local-story-cache-v2",
			cacheHash: identity.cacheHash,
			valueJson: canonicalEditingJson({
				version,
				purpose,
				fixture: "outer seal only",
			}),
		};
		const ref = { kind, ...identity, proofHash: hash(proof) };
		f.data.libraryEvidenceReceipt?.push({
			id: ref.receiptId,
			organizationId: org,
			sourceId: f.media.sourceId,
			mediaVersionId: f.media.id,
			analysisRevisionId: f.analysis.id,
			kind,
			proof,
			proofHash: ref.proofHash,
		});
		f.data.libraryFlowEvidencePin?.push({
			organizationId: org,
			taskId,
			receiptId: ref.receiptId,
		});
		return { key, ref };
	};
	return {
		sourceArchive: make(
			"SOURCE_ARCHIVE",
			"LOCAL_FLOW_MANIFEST_V1",
			"local-story-flow-source-archive-v1",
		),
		tree: make(
			"TREE",
			"LOCAL_FLOW_CONTEXT_V1",
			"local-story-flow-tree-artifact-v1",
		),
		plan: make(
			"PLAN",
			"LOCAL_FLOW_PLAN_V1",
			"local-story-flow-plan-artifact-v1",
		),
	};
}
function addOrigin(
	f: ReturnType<typeof sourceFixture>,
	slot = 7,
	template = addStart(f),
) {
	const originTaskId = id(30);
	const task = structuredClone(f.task);
	task.id = originTaskId;
	task.state = "ERROR";
	task.parameters.input.requestKey = id(31);
	task.requestKey = id(31);
	task.requestHash = mediaTaskIntentHash(task.parameters.input);
	task.cacheKey = mediaTaskCacheKey(
		task.parameters.input,
		task.parameters.identity,
	);
	if (!f.data.libraryMediaTask?.some((r) => r.id === task.id))
		f.data.libraryMediaTask?.push(task);
	const observationRef = {
		...template.ref,
		receiptId: id(1000 + slot),
		cacheHash: hash({ cache: slot }),
		inputKeyHash: hash({ input: slot }),
		proofHash: hash({ proof: slot }),
	};
	const make = (purpose: "START" | "ATTEMPT" | "OUTCOME", extra: Row) => {
		const kind = "LOCAL_FLOW_PLAN_V1" as const;
		const key = {
			version: "local-story-flow-record-key-v1",
			purpose,
			keyBody: {
				taskId: originTaskId,
				...(purpose === "START" ? {} : { slot }),
			},
		};
		const identity = localStoryFlowRecordIdentity({
			sourceTuple: template.sourceTuple,
			kind,
			key,
		});
		const payload: Row = {
			version: `local-story-flow-runtime-${purpose.toLowerCase()}-v1`,
			purpose,
			taskId: originTaskId,
			...(purpose === "START" ? {} : { slot }),
			...extra,
		};
		const proof = {
			version: "local-story-cache-v2",
			cacheHash: identity.cacheHash,
			valueJson: canonicalEditingJson(payload),
		};
		const ref = { kind, ...identity, proofHash: hash(proof) };
		const row = {
			id: ref.receiptId,
			organizationId: org,
			sourceId: f.media.sourceId,
			mediaVersionId: f.media.id,
			analysisRevisionId: f.analysis.id,
			kind,
			proof,
			proofHash: ref.proofHash,
		};
		if (!f.data.libraryEvidenceReceipt?.some((r) => r.id === row.id))
			f.data.libraryEvidenceReceipt?.push(row);
		if (
			!f.data.libraryFlowEvidencePin?.some(
				(p) => p.taskId === taskId && p.receiptId === row.id,
			)
		)
			f.data.libraryFlowEvidencePin?.push({
				organizationId: org,
				taskId,
				receiptId: row.id,
			});
		return { ref, row, payload };
	};
	const start = make("START", {}),
		attempt = make("ATTEMPT", { startRef: start.ref });
	const outcome = make("OUTCOME", {
		startRef: start.ref,
		attemptRef: attempt.ref,
		status: "ACCEPTED",
		observationRef,
	});
	if (
		!f.data.libraryFlowEvidencePin?.some(
			(p) => p.taskId === originTaskId && p.receiptId === start.row.id,
		)
	)
		f.data.libraryFlowEvidencePin?.push({
			organizationId: org,
			taskId: originTaskId,
			receiptId: start.row.id,
		});
	return {
		task,
		start,
		attempt,
		outcome,
		observationRef,
		origin: {
			organizationId: org,
			originTaskId,
			slot,
			startRef: start.ref,
			attemptRef: attempt.ref,
		},
	};
}
function transactionFixture() {
	const tx = { [TENANT_ORGANIZATION]: org };
	const transaction = vi.fn(async (read: (tx: unknown) => Promise<unknown>) =>
		read(tx),
	);
	mocks.tenant.mockReturnValue({
		[TENANT_ORGANIZATION]: org,
		$transaction: transaction,
	} as unknown as AppPrismaClient);
	return { tx, transaction };
}
describe("FLOW authorized read snapshot", () => {
	it("shares the exact signed64 runtime task lock namespace", () => {
		expect(localStoryFlowTaskLockKey(taskId)).toBe(-7729866101415729106n);
		expect(() => localStoryFlowTaskLockKey("not-a-task")).toThrow(
			"LOCAL_STORY_ARTIFACT_UNVERIFIED",
		);
	});
	it("owns a read-only repeatable-read transaction and exposes no raw transaction", async () => {
		const f = sourceFixture();
		const result = await withLocalStoryFlowReadSnapshot(
			options,
			async (reader) => {
				expect(reader).not.toBe(f.tx);
				expect(reader).not.toHaveProperty("$transaction");
				await reader.source();
				return "RAM value";
			},
		);
		expect(result.value).toBe("RAM value");
		expect(mocks.tenant).toHaveBeenLastCalledWith(org, { readOnly: true });
		expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: "RepeatableRead",
			timeout: 15_000,
			statementTimeoutMs: 5_000,
		});
	});
	it("rejects a mismatched tenant before invoking the callback", async () => {
		const f = transactionFixture();
		f.tx[TENANT_ORGANIZATION] = taskId;
		const read = vi.fn();
		await expect(
			withLocalStoryFlowReadSnapshot(options, read),
		).rejects.toMatchObject({
			code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		});
		expect(read).not.toHaveBeenCalled();
	});
	it("uses the shared source validator and original immutable revision, leaving manual draft alone", async () => {
		const f = sourceFixture();
		const result = await withLocalStoryFlowReadSnapshot(
			options,
			async (reader) => {
				const source = await reader.source();
				const evidence = localStoryFlowReadSourceEvidence(source);
				expect(evidence.sourceTuple.mediaSha256).toBe(f.media.sha256);
				expect(evidence.ownerLinks[0]?.revision.id).toBe(f.revision.id);
				return source;
			},
		);
		expect(
			localStoryFlowReadSourceEvidence(result.value).ownerLinks,
		).toHaveLength(1);
		expect(f.project.draft).toEqual({ manuallyEdited: true });
	});
	it.each([
		[
			"task not terminal",
			(f: ReturnType<typeof sourceFixture>) => {
				f.task.state = "RUNNING";
			},
		],
		[
			"wrong content",
			(f: ReturnType<typeof sourceFixture>) => {
				f.project.contentId = id(99);
			},
		],
		[
			"wrong media",
			(f: ReturnType<typeof sourceFixture>) => {
				f.project.mediaVersionId = id(99);
			},
		],
		[
			"wrong preset",
			(f: ReturnType<typeof sourceFixture>) => {
				f.task.result.presetIds = ["other-preset"];
			},
		],
		[
			"wrong clock",
			(f: ReturnType<typeof sourceFixture>) => {
				f.revision.document.timeMapId = id(99);
			},
		],
		[
			"wrong original binding",
			(f: ReturnType<typeof sourceFixture>) => {
				f.revision.document.autoGeneration.binding = {
					...f.binding,
					mediaSha256: hash("foreign"),
				};
			},
		],
	] as const)("rejects %s without returning a source", async (_name, mutate) => {
		const f = sourceFixture();
		mutate(f);
		await expect(
			withLocalStoryFlowReadSnapshot(options, (r) => r.source()),
		).rejects.toMatchObject({
			code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		});
	});
	it("returns detached source data and rejects escaped or failed-callback readers", async () => {
		sourceFixture();
		const result = await withLocalStoryFlowReadSnapshot(
			options,
			async (reader) => {
				const source = await reader.source();
				localStoryFlowReadSourceEvidence(source).sourceTuple.mediaSha256 =
					hash("changed copy");
				return { reader, source };
			},
		);
		expect(
			localStoryFlowReadSourceEvidence(result.value.source).sourceTuple
				.mediaSha256,
		).not.toBe(hash("changed copy"));
		await expect(result.value.reader.source()).rejects.toMatchObject({
			code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		});
		await expect(
			withLocalStoryFlowReadSnapshot(options, async (reader) => {
				throw Object.assign(new Error("owned callback failure"), { reader });
			}),
		).rejects.toMatchObject({ message: "owned callback failure" });
	});
	it("reads a fixed sealed projection and its current-task retention pin without a build path", async () => {
		const f = sourceFixture(),
			start = addStart(f);
		const result = await withLocalStoryFlowReadSnapshot(
			options,
			async (reader) => {
				const source = await reader.source();
				return reader.getSealed({
					source,
					kind: start.kind,
					key: start.key,
					ref: start.ref,
				});
			},
		);
		expect(localStoryFlowSealedRecordEvidence(result.value).payload).toEqual(
			start.payload,
		);
		expect(
			f.events.find((e) => e.table === "libraryEvidenceReceipt")?.args,
		).toMatchObject({
			select: {
				id: true,
				organizationId: true,
				sourceId: true,
				mediaVersionId: true,
				analysisRevisionId: true,
				kind: true,
				proof: true,
				proofHash: true,
			},
		});
	});
	it.each([
		"missing",
		"pin",
		"corrupt",
	])("rejects %s sealed dependency with no fallback", async (bad) => {
		const f = sourceFixture(),
			start = addStart(f);
		if (bad === "missing") f.data.libraryEvidenceReceipt = [];
		if (bad === "pin") f.data.libraryFlowEvidencePin = [];
		if (bad === "corrupt") start.row.proofHash = hash("corrupt");
		await expect(
			withLocalStoryFlowReadSnapshot(options, async (reader) =>
				reader.getSealed({
					source: await reader.source(),
					kind: start.kind,
					key: start.key,
					ref: start.ref,
				}),
			),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	});
	it("requires the independent source row and every known binding proof pin", async () => {
		const f = sourceFixture();
		f.data.librarySource = [];
		await expect(
			withLocalStoryFlowReadSnapshot(options, (r) => r.source()),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
		const next = sourceFixture();
		Object.assign(next.bindingRow, { attestationReceiptId: id(20) });
		next.data.libraryEvidenceReceipt?.push({
			id: id(20),
			organizationId: org,
			sourceId: next.media.sourceId,
			mediaVersionId: next.media.id,
			analysisRevisionId: next.analysis.id,
			kind: "EXPLICIT_BINDING",
			proof: {},
			proofHash: hash("authored binding proof"),
		});
		await expect(
			withLocalStoryFlowReadSnapshot(options, (r) => r.source()),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	});
	it("does not accept a mixed fake snapshot or reuse a source from another snapshot", async () => {
		const f = sourceFixture();
		const prior = await withLocalStoryFlowReadSnapshot(options, (r) =>
			r.source(),
		);
		const start = addStart(f);
		await expect(
			withLocalStoryFlowReadSnapshot(options, (r) =>
				r.getSealed({
					source: prior.value,
					kind: start.kind,
					key: start.key,
					ref: start.ref,
				}),
			),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
		await expect(
			withLocalStoryFlowReadSnapshot(options, async (reader) => {
				await reader.source();
				f.task.result.projectIds = [id(99)];
				return reader.source();
			}),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	});
	it("returns an owned read-set fence that reacquires source SHARE and immutable KEY SHARE locks", async () => {
		const f = sourceFixture(),
			start = addStart(f);
		const result = await withLocalStoryFlowReadSnapshot(
			options,
			async (reader) => {
				const source = await reader.source();
				await reader.getSealed({
					source,
					kind: start.kind,
					key: start.key,
					ref: start.ref,
				});
				return source;
			},
		);
		await validateLocalStoryFlowReadFence(f.tx as never, result.readFence);
		expect(f.locks[0]).toBe("advisory");
		expect(f.locks[1]).toContain('"LibraryMediaTask"');
		expect(f.locks[1]).toContain("FOR UPDATE");
		for (const table of [
			"LibrarySource",
			"LibraryMediaVersion",
			"SceneAnalysisRevision",
			"LibraryAnalysisBinding",
			"EditProject",
		])
			expect(f.locks.find((sql) => sql.includes(`FROM "${table}"`))).toContain(
				"FOR SHARE",
			);
		for (const table of [
			"EditRevision",
			"LibraryEvidenceReceipt",
			"LibraryFlowEvidencePin",
		])
			expect(f.locks.find((sql) => sql.includes(`FROM "${table}"`))).toContain(
				"FOR KEY SHARE",
			);
		await expect(
			validateLocalStoryFlowReadFence(f.tx as never, {}),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	});
	it.each([
		"source",
		"owner",
		"receipt",
		"pin",
	])("rejects changed %s after pure RAM processing", async (bad) => {
		const f = sourceFixture(),
			start = addStart(f);
		const result = await withLocalStoryFlowReadSnapshot(
			options,
			async (reader) => {
				await reader.getSealed({
					source: await reader.source(),
					kind: start.kind,
					key: start.key,
					ref: start.ref,
				});
				return "pure reconstruction would happen outside the transaction";
			},
		);
		if (bad === "source") f.media.width = 642;
		if (bad === "owner") f.project.contentId = id(99);
		if (bad === "receipt") start.row.proofHash = hash("changed");
		if (bad === "pin") f.data.libraryFlowEvidencePin = [];
		await expect(
			validateLocalStoryFlowReadFence(f.tx as never, result.readFence),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	});
	it("scans exactly 382 known task keys plus archive/tree/plan, without table or prefix discovery", async () => {
		const f = sourceFixture(),
			start = addStart(f),
			finals = addFinalArtifacts(f, start);
		const result = await withLocalStoryFlowReadSnapshot(options, async (r) =>
			r.scanRuntime({ source: await r.source(), ...finals }),
		);
		expect(result.value.runtime).toHaveLength(382);
		expect(result.value.runtime.filter((r) => r.record !== null)).toHaveLength(
			1,
		);
		const scan = f.events
			.filter((e) => e.table === "libraryEvidenceReceipt")
			.find(
				(e) =>
					(e.args as { where: { id?: { in?: unknown[] } } }).where.id?.in
						?.length === 382,
			);
		expect(scan?.args).toMatchObject({
			take: 383,
			where: { organizationId: org },
		});
		expect(result.value).not.toHaveProperty("deliveryEvidence");
	});
	it("does not turn a corrupt runtime record or a missing START into unused budget", async () => {
		for (const bad of ["corrupt", "missing"] as const) {
			const f = sourceFixture(),
				start = addStart(f),
				finals = addFinalArtifacts(f, start);
			if (bad === "corrupt") start.row.proofHash = hash("corrupt");
			else
				f.data.libraryEvidenceReceipt =
					f.data.libraryEvidenceReceipt?.filter((r) => r.id !== start.row.id) ??
					[];
			await expect(
				withLocalStoryFlowReadSnapshot(options, async (r) =>
					r.scanRuntime({ source: await r.source(), ...finals }),
				),
			).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
		}
	});
	it("resolves only an origin task and its exact START/ATTEMPT/ACCEPTED OUTCOME even if the whole task failed", async () => {
		const f = sourceFixture(),
			old = addOrigin(f);
		const result = await withLocalStoryFlowReadSnapshot(
			options,
			async (reader) =>
				reader.readOrigin({
					source: await reader.source(),
					origin: old.origin,
					outcomeRef: old.outcome.ref,
					observationRef: old.observationRef,
				}),
		);
		expect(result.value.task.id).toBe(old.task.id);
		expect(
			localStoryFlowSealedRecordEvidence(result.value.outcome).payload.status,
		).toBe("ACCEPTED");
		expect(f.events.filter((e) => e.table === "libraryMediaTask")).toHaveLength(
			2,
		);
	});
	it.each([
		"failed outcome",
		"wrong observation",
		"foreign organization",
		"missing origin START pin",
	])("rejects %s origin evidence", async (bad) => {
		const f = sourceFixture(),
			old = addOrigin(f);
		if (bad === "failed outcome") {
			old.outcome.payload.status = "FAILED";
			old.outcome.row.proof.valueJson = canonicalEditingJson(
				old.outcome.payload,
			);
			old.outcome.row.proofHash = old.outcome.ref.proofHash = hash(
				old.outcome.row.proof,
			);
		}
		if (bad === "wrong observation")
			old.observationRef.proofHash = hash("different observation");
		if (bad === "foreign organization") old.origin.organizationId = id(99);
		if (bad === "missing origin START pin")
			f.data.libraryFlowEvidencePin =
				f.data.libraryFlowEvidencePin?.filter(
					(p) => p.taskId !== old.task.id,
				) ?? [];
		await expect(
			withLocalStoryFlowReadSnapshot(options, async (r) =>
				r.readOrigin({
					source: await r.source(),
					origin: old.origin,
					outcomeRef: old.outcome.ref,
					observationRef: old.observationRef,
				}),
			),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	});
	it("snapshots sealed hints before awaiting a SELECT rather than accepting a changed ref", async () => {
		const f = sourceFixture(),
			start = addStart(f);
		const initialRef = { ...start.ref, proofHash: hash("initially wrong") };
		const delegate = f.tx.libraryEvidenceReceipt as {
			findMany: Mock<(args: unknown) => Promise<Row[]>>;
		};
		const original = delegate.findMany;
		let release: () => void = () => {};
		const gate = new Promise<void>((done) => {
			release = done;
		});
		delegate.findMany = vi.fn(async (args) => {
			await gate;
			return original(args);
		});
		await withLocalStoryFlowReadSnapshot(options, async (r) => {
			const source = await r.source();
			const pending = r.getSealed({
				source,
				kind: start.kind,
				key: start.key,
				ref: initialRef,
			});
			initialRef.proofHash = start.ref.proofHash;
			release();
			await expect(pending).rejects.toMatchObject({
				code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
			});
			return source;
		});
	});
	it("rejects unknown descriptors without executing getters or coercion", async () => {
		const getter = vi.fn(() => {
			throw new Error("PRIVATE_SENTINEL");
		});
		const bad = Object.defineProperty(
			{ authorizedOrganizationId: org },
			"generationTaskId",
			{ enumerable: true, get: getter },
		);
		await expect(
			withLocalStoryFlowReadSnapshot(bad as never, async () => null),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
		const f = sourceFixture(),
			old = addOrigin(f);
		const kind = { toString: getter };
		await expect(
			withLocalStoryFlowReadSnapshot(options, async (r) =>
				r.readOrigin({
					source: await r.source(),
					origin: old.origin,
					outcomeRef: old.outcome.ref,
					observationRef: { ...old.observationRef, kind },
				}),
			),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
		expect(getter).not.toHaveBeenCalled();
	});
	it("bounds origin resolution at 127 distinct native origins and never starts an arbitrary 128th lookup", async () => {
		const f = sourceFixture(),
			start = addStart(f);
		const origins = Array.from({ length: 127 }, (_, i) =>
			addOrigin(f, i + 1, start),
		);
		await withLocalStoryFlowReadSnapshot(options, async (r) => {
			const source = await r.source();
			for (const old of origins)
				await r.readOrigin({
					source,
					origin: old.origin,
					outcomeRef: old.outcome.ref,
					observationRef: old.observationRef,
				});
			const old = origins[126];
			expect(old).toBeDefined();
			if (!old) throw new Error("fixture requires 127 origins");
			await r.readOrigin({
				source,
				origin: old.origin,
				outcomeRef: old.outcome.ref,
				observationRef: old.observationRef,
			});
			const before = f.events.length;
			await expect(
				r.readOrigin({
					source,
					origin: { ...old.origin, originTaskId: id(90) },
					outcomeRef: old.outcome.ref,
					observationRef: old.observationRef,
				}),
			).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
			expect(f.events).toHaveLength(before);
			return source;
		});
	});
	it("does not bind the read fence to later manual draft/current-revision edits", async () => {
		const f = sourceFixture();
		const snapshot = await withLocalStoryFlowReadSnapshot(options, (r) =>
			r.source(),
		);
		f.project.draft = { manuallyEdited: false };
		f.project.currentRevisionId = id(50);
		await expect(
			validateLocalStoryFlowReadFence(f.tx as never, snapshot.readFence),
		).resolves.toBeUndefined();
	});
});

describe("worker source-only snapshot authority", () => {
	function workerFixture() {
		const f = sourceFixture(),
			leaseToken = id(50);
		const nowMs = Date.parse("2026-11-07T00:01:00Z");
		Object.assign(f.task, {
			state: "RUNNING",
			result: null,
			leaseToken,
			leaseUntil: new Date(nowMs + 60_000),
			cancelRequestedAt: null,
		});
		f.data.editProject = [];
		f.data.editRevision = [];
		(f.tx.$queryRaw as Mock).mockImplementation(
			async (sql: TemplateStringsArray) =>
				sql.join("").includes("clock_timestamp")
					? [{ nowMs: BigInt(nowMs) }]
					: [{ proof: f.binding }],
		);
		return { ...f, leaseToken, nowMs, controller: new AbortController() };
	}
	it("reads an unpublished RUNNING source without FLOW artifacts or owner links", async () => {
		const f = workerFixture();
		const result = await withLocalStoryFlowWorkerSourceSnapshot(
			{ ...options, leaseToken: f.leaseToken, signal: f.controller.signal },
			async (reader) => localStoryFlowReadSourceEvidence(await reader.source()),
		);
		expect(result.value.ownerLinks).toEqual([]);
		expect(
			f.events.some((e) => ["editProject", "editRevision"].includes(e.table)),
		).toBe(false);
		expect(f.data.libraryEvidenceReceipt).toEqual([]);
		expect(f.data.libraryFlowEvidencePin).toEqual([]);
		expect(f.transaction.mock.calls[0]?.[1]).toEqual({
			isolationLevel: "RepeatableRead",
			timeout: 15_000,
			statementTimeoutMs: 5_000,
		});
	});
	it.each([
		"lease",
		"state",
		"cancel",
		"deadline",
	] as const)("rejects worker %s without weakening terminal authority", async (reason) => {
		const f = workerFixture();
		if (reason === "lease") Reflect.set(f.task, "leaseToken", id(51));
		if (reason === "state") f.task.state = "SUCCEEDED";
		if (reason === "cancel")
			Reflect.set(f.task, "cancelRequestedAt", new Date());
		if (reason === "deadline") f.task.startedAt = new Date(f.nowMs - 5_400_001);
		await expect(
			withLocalStoryFlowWorkerSourceSnapshot(
				{ ...options, leaseToken: f.leaseToken, signal: f.controller.signal },
				async (reader) => reader.source(),
			),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	});

	it.each([
		"lease",
		"cancel",
		"deadline",
	] as const)("rechecks fresh worker %s at the write fence", async (reason) => {
		const f = workerFixture(),
			read = await withLocalStoryFlowWorkerSourceSnapshot(
				{ ...options, leaseToken: f.leaseToken, signal: f.controller.signal },
				async (r) => r.source(),
			);
		if (reason === "lease") Reflect.set(f.task, "leaseToken", id(999));
		if (reason === "cancel")
			Reflect.set(f.task, "cancelRequestedAt", new Date());
		if (reason === "deadline")
			(f.tx.$queryRaw as Mock).mockImplementation(
				async (sql: TemplateStringsArray) =>
					sql.join("").includes("clock_timestamp")
						? [{ nowMs: BigInt(f.nowMs + 5_400_000) }]
						: [{ proof: f.binding }],
			);
		await expect(
			validateLocalStoryFlowReadFence(f.tx as never, read.readFence),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	});
	function addAttestation(f: ReturnType<typeof workerFixture>) {
		Reflect.set(f.binding, "kind", "EDITOR_ATTESTED");
		Reflect.set(f.binding, "attestation", {
			receiptId: id(20),
			actor: "fixture-operator",
			confirmedAt: "2026-11-07T00:00:00Z",
			scope: ["TIME", "GEOMETRY", "CONTENT"],
		});
		f.task.parameters.identity.bindingHash = hash(f.binding);
		f.task.cacheKey = mediaTaskCacheKey(
			f.task.parameters.input,
			f.task.parameters.identity,
		);
		Reflect.set(f.bindingRow, "attestationReceiptId", id(20));
		const proof = {
			schemaVersion: 1,
			intentHash: hash({
				mediaVersionId: f.media.id,
				analysisRevisionId: f.analysis.id,
				confirmation: { time: true, geometry: true, content: true },
			}),
			binding: structuredClone(f.binding),
		};
		const row = {
			id: id(20),
			organizationId: org,
			sourceId: f.media.sourceId,
			mediaVersionId: f.media.id,
			analysisRevisionId: f.analysis.id,
			kind: "EDITOR_ATTESTATION",
			proof,
			proofHash: hash(proof),
		};
		f.data.libraryEvidenceReceipt?.push(row);
		return row;
	}
	it("reads actual verified unpinned binding material without claiming retention", async () => {
		const f = workerFixture();
		addAttestation(f);
		const read = await withLocalStoryFlowWorkerSourceSnapshot(
			{ ...options, leaseToken: f.leaseToken, signal: f.controller.signal },
			async (r) => r.source(),
		);
		expect(localStoryFlowReadSourceEvidence(read.value).ownerLinks).toEqual([]);
		expect(f.data.libraryFlowEvidencePin).toEqual([]);
		await expect(
			validateLocalStoryFlowReadFence(f.tx as never, read.readFence),
		).resolves.toBeUndefined();
	});
	it.each([
		"binding",
		"hash",
		"kind",
		"intent",
		"missing",
		"extra",
	] as const)("rejects actual attestation %s before unpinned use", async (reason) => {
		const f = workerFixture(),
			row = addAttestation(f);
		if (reason === "binding") Reflect.set(row.proof.binding, "width", 999);
		if (reason === "intent") row.proof.intentHash = hash("wrong intent");
		if (reason === "kind") row.kind = "EXPLICIT_BINDING";
		if (reason === "missing") f.data.libraryEvidenceReceipt = [];
		if (reason === "extra")
			Object.defineProperty(row.proof, "__proto__", {
				enumerable: true,
				value: { unrecognized: true },
			});
		if (reason !== "hash") row.proofHash = hash(row.proof);
		else row.proofHash = "0".repeat(64);
		await expect(
			withLocalStoryFlowWorkerSourceSnapshot(
				{ ...options, leaseToken: f.leaseToken, signal: f.controller.signal },
				async (r) => r.source(),
			),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	});

	it("preserves an original worker abort during source validation", async () => {
		const f = workerFixture(),
			reason = new Error("AUTHORED_ABORT");
		(f.tx.$queryRaw as Mock).mockImplementation(
			async (sql: TemplateStringsArray) => {
				if (sql.join("").includes("clock_timestamp"))
					return [{ nowMs: BigInt(f.nowMs) }];
				f.controller.abort(reason);
				return [{ proof: f.binding }];
			},
		);
		await expect(
			withLocalStoryFlowWorkerSourceSnapshot(
				{ ...options, leaseToken: f.leaseToken, signal: f.controller.signal },
				(r) => r.source(),
			),
		).rejects.toBe(reason);
	});
	it("accounts for DB-clock response time inside the worker source budget", async () => {
		vi.useFakeTimers();
		try {
			const f = workerFixture();
			f.task.startedAt = new Date(f.nowMs - 5_399_000);
			(f.tx.$queryRaw as Mock).mockImplementation(
				async (sql: TemplateStringsArray) => {
					if (sql.join("").includes("clock_timestamp")) {
						vi.advanceTimersByTime(1001);
						return [{ nowMs: BigInt(f.nowMs) }];
					}
					return [{ proof: f.binding }];
				},
			);
			await expect(
				withLocalStoryFlowWorkerSourceSnapshot(
					{ ...options, leaseToken: f.leaseToken, signal: f.controller.signal },
					(r) => r.source(),
				),
			).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("source-only archive connection", () => {
	it("checks the original identity through the catalog without reading FLOW artifacts", async () => {
		const f = sourceFixture();
		mocks.catalog.mockReturnValue({
			status: "UNAVAILABLE",
			missing: ["engineValidationPolicyHash", "deliveryPolicyHash"],
		});
		await expect(
			withLocalStoryFlowReadSnapshot(options, async (r) =>
				r.resolveSourceArchive(),
			),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
		expect(mocks.catalog).toHaveBeenCalledWith(f.task.parameters.identity);
		expect(f.events.some((e) => e.table === "libraryEvidenceReceipt")).toBe(
			false,
		);
	});
	it("returns actual already-validated closed runtime pins as detached evidence", async () => {
		const f = sourceFixture(),
			start = addStart(f),
			final = addFinalArtifacts(f, start);
		const read = await withLocalStoryFlowReadSnapshot(options, async (r) => {
			const source = await r.source();
			return r.scanRuntime({ source, ...final });
		});
		expect(read.value.pins).toEqual([
			{ organizationId: org, taskId, receiptId: start.ref.receiptId },
		]);
		expect(
			f.events.filter((e) => e.table === "libraryFlowEvidencePin"),
		).toHaveLength(4);
		firstSynthetic(read.value.pins).taskId = id(999);
		expect(f.data.libraryFlowEvidencePin?.[0]?.taskId).toBe(taskId);
		await expect(
			validateLocalStoryFlowReadFence(f.tx as never, read.readFence),
		).resolves.toBeUndefined();
	});
});

function completeLegacySourceFixture(audio = false) {
	const f = sourceFixture(),
		raw = f.analysis.raw;
	Reflect.set(
		firstSynthetic(firstSynthetic(raw.scenes).shots),
		"detailedDescription",
		"A person holds key.",
	);
	f.analysis.document = normalizeSceneAnalysis(raw);
	f.analysis.rawHash = hash(raw);
	Object.assign(f.binding, {
		analysisRawHash: f.analysis.rawHash,
		analysisDocumentHash: hash(f.analysis.document),
	});
	Object.assign(f.task.parameters.identity, {
		analysisRawHash: f.analysis.rawHash,
		analysisDocumentHash: hash(f.analysis.document),
		bindingHash: hash(f.binding),
		transcriptionPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
	});
	Object.assign(f.media, {
		fpsNum: 30,
		fpsDen: 1,
		probe: {
			streams: [
				{ codec_type: "video" },
				...(audio ? [{ codec_type: "audio" }] : []),
			],
		},
	});
	if (audio)
		Reflect.set(
			f.task.parameters.identity,
			"modelSha256",
			hash("SYNTHETIC_ASR_MODEL"),
		);
	Reflect.set(f.analysis, "providerVersion", "synthetic-reader");
	const policies = {
		version: "local-story-flow-task-policies-v1" as const,
		workflowPolicyHash: hash(LOCAL_STORY_FLOW_H1_POLICY),
		contextPolicyHash: hash(LOCAL_STORY_FLOW_CONTEXT_POLICY),
		closurePolicyHash: hash(LOCAL_STORY_FLOW_CLOSURE_POLICY),
		routePolicyHash: hash(LOCAL_STORY_FLOW_ROUTE_POLICY),
		scopePolicyHash: hash(LOCAL_STORY_FLOW_SCOPE_POLICY),
		promptPolicyHash: hash(LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY),
		engineValidationPolicyHash: hash("SYNTHETIC_ENGINE_NOT_READY"),
		deliveryPolicyHash: hash("SYNTHETIC_DELIVERY_NOT_READY"),
	};
	f.task.parameters.identity.generationPolicyFingerprint =
		localStoryFlowGenerationPolicyFingerprint(policies);
	f.task.cacheKey = mediaTaskCacheKey(
		f.task.parameters.input,
		f.task.parameters.identity,
	);
	mocks.catalog.mockReturnValue({
		status: "SUPPORTED",
		catalogVersion: "local-story-flow-policy-catalog-v1",
		policies,
		generationPolicyFingerprint:
			f.task.parameters.identity.generationPolicyFingerprint,
	});
	const keys = [
		"id",
		"organizationId",
		"kind",
		"mediaVersionId",
		"analysisRevisionId",
		"requestKey",
		"parentTaskId",
		"requestHash",
		"cacheKey",
		"parameters",
	];
	const p = prepareLocalStoryFlowArchiveSource(
		{
			task: Object.fromEntries(keys.map((k) => [k, Reflect.get(f.task, k)])),
			mediaSnapshot: { ...f.media, durationUs: f.media.durationUs.toString() },
			analysisSnapshot: f.analysis,
			bindingSnapshot: f.binding,
			normalizationSnapshot: null,
		},
		policies,
	);
	function pair(
		q: ReturnType<
			typeof localStoryFlowArchivePreparationEvidence
		>["transcript"],
		value: unknown,
	) {
		const proof = {
			version: "local-story-cache-v2",
			cacheHash: q.cacheHash,
			valueJson: canonicalEditingJson(value),
		};
		const row = {
			id: q.receiptId,
			organizationId: org,
			sourceId: f.media.sourceId,
			mediaVersionId: f.media.id,
			analysisRevisionId:
				q.kind === "LOCAL_STORY_TRANSCRIPT_V1" ? null : f.analysis.id,
			kind: q.kind,
			proof,
			proofHash: hash(proof),
		};
		f.data.libraryEvidenceReceipt?.push(row);
		f.data.libraryFlowEvidencePin?.push({
			organizationId: org,
			taskId,
			receiptId: row.id,
		});
		return {
			ref: {
				kind: q.kind,
				receiptId: q.receiptId,
				cacheHash: q.cacheHash,
				inputKeyHash: q.inputKeyHash,
				proofHash: row.proofHash,
			},
			row,
		};
	}
	const transcript = audio
		? pair(localStoryFlowArchivePreparationEvidence(p).transcript, {
				version: "local-story-transcript-v3",
				retryPolicyVersion: "strict-invalid-30s-10s-v1",
				engineVersion: "1.9.5",
				mediaSha256: f.media.sha256,
				modelSha256: Reflect.get(f.task.parameters.identity, "modelSha256"),
				timeMapHash: hash(f.media.timeMap),
				language: "ja",
				sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
				segments: [],
				rawSegments: [],
				speechIntervals: [],
				warnings: [],
				qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
				mediaWindows: [{ fromUs: 0, toUs: 2_000_000, language: "ja" }],
			})
		: null;
	const t = admitLocalStoryFlowArchiveTranscript(p, transcript),
		e = localStoryFlowArchiveTranscriptEvidence(t);
	const chunk = e.chunks[0];
	if (!chunk || e.chunks.length !== 1)
		throw new Error("Expected one synthetic chunk");
	const common = {
		identity: f.task.parameters.identity.localStoryModel,
		input: e.fullInput,
		chunk,
		transcriptFingerprint: e.transcriptFingerprint,
		definition: localStoryStageRegistry().stages.LOCAL_LEDGER_V1,
	};
	const cache = createLocalStoryLegacyLedgerCacheRecipe({
		...common,
		version: "V4",
		validationPolicyVersion:
			LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY.validationPolicyVersions.V4,
	});
	const prompt = localStoryLegacyLedgerPrompt({ kind: "BASE", chunk });
	if (!prompt) throw new Error("Expected authored prompt");
	const q = firstSynthetic(localStoryFlowArchiveLedgerRequests(t, 0));
	const pointer = pair(q, cache.pointer(prompt));
	const stage = createLocalStoryLegacyLedgerStageRecipe({
		...common,
		organizationId: org,
		prompt,
	});
	const sq = localStoryFlowArchiveLedgerStageRequest(t, 0, pointer),
		requestKey = id(800),
		body = stage.bodyFor(requestKey);
	const output = {
		summary: "The key is held.",
		events: [
			{
				id: "e0",
				label: "Key",
				role: "ACTION",
				refs: [chunk.refs[0]],
				quotes: [{ ref: chunk.refs[0], quote: "A person holds key." }],
				subjects: ["person"],
				uncertainty: "",
			},
		],
	};
	const receipt = {
		version: "bitovp-semantic-receipt-v1",
		profile: body.profile,
		model: LOCAL_SEMANTIC_MODEL,
		modelDigest: LOCAL_SEMANTIC_MODEL_DIGEST,
		runtimeVersion: LOCAL_SEMANTIC_RUNTIME_VERSION,
		inputHash: body.inputHash,
		promptHash: createHash("sha256").update(prompt).digest("hex"),
		schemaHash: body.schemaHash,
		promptVersion: body.promptVersion,
		requestHash: hash(body),
		context: 8192,
		maxOutputTokens: 1024,
		thinking: false,
		elapsedMs: 1,
		apiStats: {
			promptEvalCount: 1,
			evalCount: 1,
			doneReason: "stop",
			loadDurationNs: 1,
			promptEvalDurationNs: 1,
			evalDurationNs: 1,
		},
		placement: [
			{ name: LOCAL_SEMANTIC_MODEL, size: 2, sizeVram: 1, contextLength: 8192 },
		],
		cleanupConfirmed: true,
		schemaVerified: false,
	};
	pair(
		sq,
		stage.parse({
			version: "local-semantic-stage-result-v1",
			requestKey,
			output,
			receipt,
		}),
	);
	return f;
}
it("hydrates old cache through the terminal snapshot without any new FLOW records", async () => {
	const f = completeLegacySourceFixture();
	const read = await withLocalStoryFlowReadSnapshot(options, async (r) => {
		const a = await r.resolveSourceArchive();
		expect(await r.resolveSourceArchive()).toBe(a);
		return a;
	});
	expect(
		localStoryFlowSourceArchiveEvidence(read.value).requiredLegacyRefs,
	).toHaveLength(2);
	expect(
		f.events.filter((e) => e.table === "libraryEvidenceReceipt"),
	).toHaveLength(2);
	expect(
		f.data.libraryEvidenceReceipt?.every(
			(r) => r.kind === "LOCAL_STORY_LEDGER_V1",
		),
	).toBe(true);
	await expect(
		validateLocalStoryFlowReadFence(f.tx as never, read.readFence),
	).resolves.toBeUndefined();
});
it("hydrates old unpinned cache in an unpublished worker snapshot without claiming retained delivery", async () => {
	const f = completeLegacySourceFixture(),
		controller = new AbortController(),
		leaseToken = id(50);
	Object.assign(f.task, {
		state: "RUNNING",
		result: null,
		leaseToken,
		leaseUntil: new Date("2026-11-07T01:00:00Z"),
		cancelRequestedAt: null,
	});
	f.data.editProject = [];
	f.data.editRevision = [];
	f.data.libraryFlowEvidencePin = [];
	(f.tx.$queryRaw as Mock).mockImplementation(
		async (sql: TemplateStringsArray) =>
			sql.join("").includes("clock_timestamp")
				? [{ nowMs: BigInt(Date.parse("2026-11-07T00:01:00Z")) }]
				: [{ proof: f.binding }],
	);
	const read = await withLocalStoryFlowWorkerSourceSnapshot(
		{ ...options, leaseToken, signal: controller.signal },
		(r) => r.resolveSourceArchive(),
	);
	expect(
		localStoryFlowSourceArchiveEvidence(read.value).requiredLegacyRefs,
	).toHaveLength(2);
	expect(f.data.libraryFlowEvidencePin).toEqual([]);
	expect(
		f.events.some((e) => ["editProject", "editRevision"].includes(e.table)),
	).toBe(false);
	await expect(
		validateLocalStoryFlowReadFence(f.tx as never, read.readFence),
	).resolves.toBeUndefined();
});

it("keeps terminal selected-ref pins mandatory", async () => {
	const f = completeLegacySourceFixture();
	f.data.libraryFlowEvidencePin = [];
	await expect(
		withLocalStoryFlowReadSnapshot(options, (r) => r.resolveSourceArchive()),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
});
it("rejects an escaped source-archive method after its snapshot closes", async () => {
	sourceFixture();
	const read = await withLocalStoryFlowReadSnapshot(options, async (r) => {
		await r.source();
		return r.resolveSourceArchive;
	});
	await expect(read.value()).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
});
it("rejects a catalog fingerprint mirror different from the original task", async () => {
	const f = completeLegacySourceFixture(),
		current = mocks.catalog.getMockImplementation();
	const resolution = mocks.catalog.getMockImplementation()?.(
		f.task.parameters.identity,
	);
	if (!resolution) throw new Error("Expected synthetic catalog mock");
	mocks.catalog.mockReturnValue({
		...resolution,
		generationPolicyFingerprint: hash("different catalog fingerprint"),
	});
	await expect(
		withLocalStoryFlowReadSnapshot(options, (r) => r.resolveSourceArchive()),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(f.events.some((e) => e.table === "libraryEvidenceReceipt")).toBe(
		false,
	);
	if (current) mocks.catalog.mockImplementation(current);
});

describe("source archive and read-fence association", () => {
	it("validates only the actual resolved archive and preserves the full lock order", async () => {
		const f = completeLegacySourceFixture();
		const read = await withLocalStoryFlowReadSnapshot(options, (r) =>
			r.resolveSourceArchive(),
		);
		await expect(
			validateLocalStoryFlowSourceArchiveReadFence(
				f.tx as never,
				read.readFence,
				read.value,
			),
		).resolves.toBeUndefined();
		expect(f.locks[0]).toBe("advisory");
		expect(f.locks[1]).toContain('FROM "LibraryMediaTask"');
		expect(f.locks[1]).toContain("FOR UPDATE");
		const tables = [
			"LibrarySource",
			"LibraryMediaVersion",
			"SceneAnalysisRevision",
			"LibraryAnalysisBinding",
			"EditProject",
			"EditRevision",
			"LibraryEvidenceReceipt",
			"LibraryFlowEvidencePin",
		];
		const first = tables.map((t) =>
			f.locks.findIndex((sql) => sql.includes(`FROM "${t}"`)),
		);
		expect(first.every((position) => position >= 2)).toBe(true);
		expect(first).toEqual([...first].sort((a, b) => a - b));
	});
	it("rejects an unresolved snapshot even when given another valid archive", async () => {
		const f = completeLegacySourceFixture();
		const resolved = await withLocalStoryFlowReadSnapshot(options, (r) =>
			r.resolveSourceArchive(),
		);
		const unresolved = await withLocalStoryFlowReadSnapshot(options, (r) =>
			r.source(),
		);
		await expect(
			validateLocalStoryFlowSourceArchiveReadFence(
				f.tx as never,
				unresolved.readFence,
				resolved.value,
			),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	});
	it("rejects an equivalent owned archive from a different snapshot", async () => {
		const f = completeLegacySourceFixture();
		const first = await withLocalStoryFlowReadSnapshot(options, (r) =>
			r.resolveSourceArchive(),
		);
		const second = await withLocalStoryFlowReadSnapshot(options, (r) =>
			r.resolveSourceArchive(),
		);
		expect(first.value).not.toBe(second.value);
		expect(localStoryFlowSourceArchiveEvidence(first.value)).toEqual(
			localStoryFlowSourceArchiveEvidence(second.value),
		);
		await expect(
			validateLocalStoryFlowSourceArchiveReadFence(
				f.tx as never,
				first.readFence,
				second.value,
			),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	});
	it("rejects copied, getter-bearing, and unknown handles without reading them", async () => {
		const f = completeLegacySourceFixture();
		const read = await withLocalStoryFlowReadSnapshot(options, (r) =>
			r.resolveSourceArchive(),
		);
		const getter = vi.fn();
		const fake = Object.defineProperty({}, "sourceTuple", { get: getter });
		for (const [fence, archive] of [
			[{}, read.value],
			[structuredClone(read.readFence), read.value],
			[read.readFence, structuredClone(read.value)],
			[read.readFence, fake],
		])
			await expect(
				validateLocalStoryFlowSourceArchiveReadFence(
					f.tx as never,
					fence as never,
					archive as never,
				),
			).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
		expect(getter).not.toHaveBeenCalled();
		expect(f.locks).toEqual([]);
	});
	it("retains organization authorization for the write transaction", async () => {
		const f = completeLegacySourceFixture();
		const read = await withLocalStoryFlowReadSnapshot(options, (r) =>
			r.resolveSourceArchive(),
		);
		f.tx[TENANT_ORGANIZATION] = id(999);
		await expect(
			validateLocalStoryFlowSourceArchiveReadFence(
				f.tx as never,
				read.readFence,
				read.value,
			),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
		expect(f.locks).toEqual([]);
	});
	it.each([
		"probe",
		"storage",
		"duration",
		"raw",
		"binding",
		"legacy",
		"pin",
	] as const)("retains the full-row %s fence after archive resolution", async (field) => {
		const f = completeLegacySourceFixture();
		const read = await withLocalStoryFlowReadSnapshot(options, (r) =>
			r.resolveSourceArchive(),
		);
		if (field === "probe") Reflect.set(f.media.probe, "changed", true);
		if (field === "storage") Reflect.set(f.media.storage, "changed", true);
		if (field === "duration") f.media.durationUs += 1n;
		if (field === "raw") Reflect.set(f.analysis.raw.metadata, "changed", true);
		if (field === "binding") Reflect.set(f.bindingRow.proof, "changed", true);
		if (field === "legacy")
			firstSynthetic(f.data.libraryEvidenceReceipt ?? []).proofHash = hash(
				"different selected legacy row",
			);
		if (field === "pin") f.data.libraryFlowEvidencePin = [];
		await expect(
			validateLocalStoryFlowSourceArchiveReadFence(
				f.tx as never,
				read.readFence,
				read.value,
			),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	});
	it.each([
		"active",
		"lease",
		"cancel",
		"deadline",
		"abort",
	] as const)("retains worker %s authority for the associated archive", async (status) => {
		const f = completeLegacySourceFixture();
		const controller = new AbortController(),
			leaseToken = id(50),
			nowMs = Date.parse("2026-11-07T00:01:00Z"),
			reason = new Error("AUTHORED_WORKER_ABORT");
		Object.assign(f.task, {
			state: "RUNNING",
			result: null,
			leaseToken,
			leaseUntil: new Date(nowMs + 60_000),
			cancelRequestedAt: null,
		});
		f.data.editProject = [];
		f.data.editRevision = [];
		f.data.libraryFlowEvidencePin = [];
		(f.tx.$queryRaw as Mock).mockImplementation(
			async (sql: TemplateStringsArray) =>
				sql.join("").includes("clock_timestamp")
					? [{ nowMs: BigInt(nowMs) }]
					: [{ proof: f.binding }],
		);
		const read = await withLocalStoryFlowWorkerSourceSnapshot(
			{ ...options, leaseToken, signal: controller.signal },
			(r) => r.resolveSourceArchive(),
		);
		if (status === "lease") Reflect.set(f.task, "leaseToken", id(999));
		if (status === "cancel")
			Reflect.set(f.task, "cancelRequestedAt", new Date(nowMs));
		if (status === "deadline")
			(f.tx.$queryRaw as Mock).mockResolvedValue([
				{ nowMs: BigInt(nowMs + 5_400_000) },
			]);
		if (status === "abort") controller.abort(reason);
		const validation = validateLocalStoryFlowSourceArchiveReadFence(
			f.tx as never,
			read.readFence,
			read.value,
		);
		if (status === "active") await expect(validation).resolves.toBeUndefined();
		else if (status === "abort") await expect(validation).rejects.toBe(reason);
		else
			await expect(validation).rejects.toMatchObject({
				code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
			});
		expect(f.data.libraryFlowEvidencePin).toEqual([]);
	});
});

function unpublishedMaterialFixture(
	audio = false,
	f = completeLegacySourceFixture(audio),
) {
	const controller = new AbortController(),
		leaseToken = id(50),
		nowMs = Date.parse("2026-11-07T00:01:00Z");
	Object.assign(f.task, {
		state: "RUNNING",
		result: null,
		leaseToken,
		leaseUntil: new Date(nowMs + 60_000),
		cancelRequestedAt: null,
	});
	f.data.editProject = [];
	f.data.editRevision = [];
	f.data.libraryFlowEvidencePin = [];
	(f.tx.$queryRaw as Mock).mockImplementation(
		async (sql: TemplateStringsArray) =>
			sql.join("").includes("clock_timestamp")
				? [{ nowMs: BigInt(nowMs) }]
				: [{ proof: f.binding }],
	);
	return { ...f, controller, leaseToken, nowMs };
}
function addSourceMaterial(
	f: ReturnType<typeof unpublishedMaterialFixture>,
	kind: "EDITOR_ATTESTATION" | "NORMALIZATION_CAPTURE",
) {
	const receiptId = id(880);
	let proof: unknown;
	if (kind === "EDITOR_ATTESTATION") {
		Reflect.set(f.binding, "kind", "EDITOR_ATTESTED");
		Reflect.set(f.binding, "attestation", {
			receiptId,
			actor: "authored-operator",
			confirmedAt: "2026-11-07T00:00:00Z",
			scope: ["TIME", "GEOMETRY", "CONTENT"],
		});
		Reflect.set(f.bindingRow, "attestationReceiptId", receiptId);
		proof = {
			schemaVersion: 1,
			intentHash: hash({
				mediaVersionId: f.media.id,
				analysisRevisionId: f.analysis.id,
				confirmation: { time: true, geometry: true, content: true },
			}),
			binding: f.binding,
		};
		f.task.parameters.identity.bindingHash = hash(f.binding);
	} else {
		const map = f.media.timeMap,
			count = map.editingEndFrame,
			durationUs = map.sourceEndUs;
		const source = {
			width: 640,
			height: 360,
			codec: "h264",
			fps: { num: 24, den: 1 },
			timeBase: { num: 1, den: 12288 },
			frameCount: 48,
			durationUs,
			videoPtsHash: "b".repeat(64),
			colorProfile: "BT709_8BIT_LIMITED",
			audio: null,
		};
		const sourceFrameIndex = Array.from({ length: count }, (_, i) =>
			Math.floor((i * 24) / 30),
		);
		proof = {
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
				frameCount: count,
				durationUs,
				fps: { num: 30, den: 1 },
				hasAudio: false,
			},
			sourceStartUs: 0,
			sourceEndUs: durationUs,
			sourceFrameIndex,
			indexMapHash: hash(sourceFrameIndex),
			recipeHash: hash({
				profile: "SDR_CFR30_INDEXED_V1",
				mode: "NORMALIZE",
				source,
				videoFilter: `fps=fps=30:start_time=0:round=up:eof_action=pass,trim=end_frame=${count},setpts=N/(30*TB),setsar=1/1`,
				audioFilter: null,
			}),
			organizationId: org,
			sourceId: f.media.sourceId,
			mediaVersionId: f.media.id,
			timeMapId: map.id,
		};
		Reflect.set(f.task.parameters.identity, "preparedShotClock", {
			version: "aisa-prepared-clock-v3",
			normalizationReceiptHash: hash(proof),
		});
	}
	f.task.cacheKey = mediaTaskCacheKey(
		f.task.parameters.input,
		f.task.parameters.identity,
	);
	const row = {
		id: receiptId,
		organizationId: org,
		sourceId: f.media.sourceId,
		mediaVersionId: f.media.id,
		analysisRevisionId: kind === "NORMALIZATION_CAPTURE" ? null : f.analysis.id,
		kind,
		proof,
		proofHash: hash(proof),
	};
	f.data.libraryEvidenceReceipt?.push(row);
	return row;
}
describe("worker source-material own pin growth", () => {
	it.each([
		"EDITOR_ATTESTATION",
		"NORMALIZATION_CAPTURE",
	] as const)("allows only the real validated %s material pin and keeps its full proof strict", async (kind) => {
		const f = unpublishedMaterialFixture(false, sourceFixture());
		const row = addSourceMaterial(f, kind);
		const read = await withLocalStoryFlowWorkerSourceSnapshot(
			{ ...options, leaseToken: f.leaseToken, signal: f.controller.signal },
			(r) => r.source(),
		);
		const validate = () =>
			validateLocalStoryFlowReadFence(f.tx as never, read.readFence);
		await expect(validate()).resolves.toBeUndefined();
		f.data.libraryFlowEvidencePin = [
			{ organizationId: org, taskId, receiptId: row.id },
		];
		await expect(validate()).resolves.toBeUndefined();
		row.proofHash = hash("tampered source material");
		await expect(validate()).rejects.toMatchObject({
			code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		});
	});
	it.each([
		"source",
		"receipt",
		"receiptMissing",
		"binding",
		"raw",
		"storage",
	] as const)("keeps full %s evidence strict while valid own pins grow", async (changed) => {
		const f = unpublishedMaterialFixture();
		const read = await withLocalStoryFlowWorkerSourceSnapshot(
			{ ...options, leaseToken: f.leaseToken, signal: f.controller.signal },
			(r) => r.resolveSourceArchive(),
		);
		f.data.libraryFlowEvidencePin = localStoryFlowSourceArchiveEvidence(
			read.value,
		).requiredLegacyRefs.map((r) => ({
			organizationId: org,
			taskId,
			receiptId: r.receiptId,
		}));
		if (changed === "source") f.media.width += 2;
		if (changed === "receipt")
			firstSynthetic(f.data.libraryEvidenceReceipt ?? []).proofHash =
				hash("changed body");
		if (changed === "receiptMissing") f.data.libraryEvidenceReceipt = [];
		if (changed === "binding") Reflect.set(f.bindingRow.proof, "width", 999);
		if (changed === "raw")
			Reflect.set(f.analysis.raw.metadata, "version", "changed raw");
		if (changed === "storage")
			Reflect.set(f.media.storage, "key", "changed output");
		await expect(
			validateLocalStoryFlowSourceArchiveReadFence(
				f.tx as never,
				read.readFence,
				read.value,
			),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	});
	it("keeps terminal new FLOW pin queries strict and missing pins mandatory", async () => {
		const f = sourceFixture(),
			start = addStart(f);
		const read = await withLocalStoryFlowReadSnapshot(options, async (r) =>
			r.getSealed({
				source: await r.source(),
				kind: start.kind,
				key: start.key,
				ref: start.ref,
			}),
		);
		const delegate = (f.tx.libraryFlowEvidencePin as { findMany: Mock })
			.findMany;
		const original = delegate.getMockImplementation();
		if (!original) throw Error("Missing pin fake");
		delegate.mockImplementation(async (args) => [
			...(await original(args)),
			{ organizationId: org, taskId, receiptId: id(999) },
		]);
		await expect(
			validateLocalStoryFlowReadFence(f.tx as never, read.readFence),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
		delegate.mockImplementation(original);
		f.data.libraryFlowEvidencePin = [];
		await expect(
			withLocalStoryFlowReadSnapshot(options, async (r) =>
				r.getSealed({
					source: await r.source(),
					kind: start.kind,
					key: start.key,
					ref: start.ref,
				}),
			),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	});
	it("keeps every snapshot-captured pin even when another eligible pin replaces its count", async () => {
		const f = unpublishedMaterialFixture();
		const original = firstSynthetic(f.data.libraryEvidenceReceipt ?? []);
		f.data.libraryFlowEvidencePin = [
			{ organizationId: org, taskId, receiptId: original.id },
		];
		const read = await withLocalStoryFlowWorkerSourceSnapshot(
			{ ...options, leaseToken: f.leaseToken, signal: f.controller.signal },
			(r) => r.resolveSourceArchive(),
		);
		const other = localStoryFlowSourceArchiveEvidence(
			read.value,
		).requiredLegacyRefs.find((r) => r.receiptId !== original.id);
		if (!other) throw Error("Expected another selected material");
		f.data.libraryFlowEvidencePin = [
			{ organizationId: org, taskId, receiptId: other.receiptId },
		];
		await expect(
			validateLocalStoryFlowSourceArchiveReadFence(
				f.tx as never,
				read.readFence,
				read.value,
			),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	});
	it("does not ratchet snapshot expectations after a validation whose writes may be rolled back", async () => {
		const f = unpublishedMaterialFixture();
		const read = await withLocalStoryFlowWorkerSourceSnapshot(
			{ ...options, leaseToken: f.leaseToken, signal: f.controller.signal },
			(r) => r.resolveSourceArchive(),
		);
		const validate = () =>
			validateLocalStoryFlowSourceArchiveReadFence(
				f.tx as never,
				read.readFence,
				read.value,
			);
		f.data.libraryFlowEvidencePin = localStoryFlowSourceArchiveEvidence(
			read.value,
		).requiredLegacyRefs.map((r) => ({
			organizationId: org,
			taskId,
			receiptId: r.receiptId,
		}));
		await expect(validate()).resolves.toBeUndefined();
		// A fake state reset is not a real database rollback; it checks private expected-state immutability only.
		f.data.libraryFlowEvidencePin = [];
		await expect(validate()).resolves.toBeUndefined();
	});
	it.each([
		"organization",
		"task",
		"outside",
		"duplicate",
		"extra",
		"missing",
	] as const)("rejects %s pin tuples returned outside the fixed material query contract", async (kind) => {
		const f = unpublishedMaterialFixture();
		const read = await withLocalStoryFlowWorkerSourceSnapshot(
			{ ...options, leaseToken: f.leaseToken, signal: f.controller.signal },
			(r) => r.resolveSourceArchive(),
		);
		const ref = firstSynthetic(
			localStoryFlowSourceArchiveEvidence(read.value).requiredLegacyRefs,
		);
		const pin: Row = { organizationId: org, taskId, receiptId: ref.receiptId };
		if (kind === "organization") pin.organizationId = id(999);
		if (kind === "task") pin.taskId = id(999);
		if (kind === "outside") pin.receiptId = id(999);
		if (kind === "extra") pin.unexpected = "not a selected column";
		if (kind === "missing") Reflect.deleteProperty(pin, "receiptId");
		const result = kind === "duplicate" ? [pin, pin] : [pin];
		f.data.libraryFlowEvidencePin = result;
		// A corrupt driver fake deliberately bypasses WHERE/select so exact tuple checks remain observable.
		(
			f.tx.libraryFlowEvidencePin as { findMany: Mock }
		).findMany.mockResolvedValue(result);
		await expect(
			validateLocalStoryFlowSourceArchiveReadFence(
				f.tx as never,
				read.readFence,
				read.value,
			),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	});
	it("rejects new pin growth during the same validation instead of chasing it", async () => {
		const f = unpublishedMaterialFixture();
		const read = await withLocalStoryFlowWorkerSourceSnapshot(
			{ ...options, leaseToken: f.leaseToken, signal: f.controller.signal },
			(r) => r.resolveSourceArchive(),
		);
		const pins = localStoryFlowSourceArchiveEvidence(
			read.value,
		).requiredLegacyRefs.map((r) => ({
			organizationId: org,
			taskId,
			receiptId: r.receiptId,
		}));
		f.data.libraryFlowEvidencePin = [firstSynthetic(pins)];
		const delegate = (f.tx.libraryFlowEvidencePin as { findMany: Mock })
			.findMany;
		const original = delegate.getMockImplementation();
		if (!original) throw Error("Missing fake query");
		let reads = 0;
		delegate.mockImplementation(async (args) => {
			const result = await original(args);
			if (++reads === 1) f.data.libraryFlowEvidencePin = pins;
			return result;
		});
		await expect(
			validateLocalStoryFlowSourceArchiveReadFence(
				f.tx as never,
				read.readFence,
				read.value,
			),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
		expect(reads).toBe(2);
	});
	it.each([
		false,
		true,
	])("revalidates the same actual bridge after correct own material pins are published (audio=%s)", async (audio) => {
		const f = unpublishedMaterialFixture(audio);
		const read = await withLocalStoryFlowWorkerSourceSnapshot(
			{ ...options, leaseToken: f.leaseToken, signal: f.controller.signal },
			(r) => r.resolveSourceArchive(),
		);
		const validate = () =>
			validateLocalStoryFlowSourceArchiveReadFence(
				f.tx as never,
				read.readFence,
				read.value,
			);
		await expect(validate()).resolves.toBeUndefined();
		const pins = localStoryFlowSourceArchiveEvidence(
			read.value,
		).requiredLegacyRefs.map((ref) => ({
			organizationId: org,
			taskId,
			receiptId: ref.receiptId,
		}));
		expect(pins).toHaveLength(audio ? 3 : 2);
		f.data.libraryFlowEvidencePin = [firstSynthetic(pins)];
		await expect(validate()).resolves.toBeUndefined();
		f.data.libraryFlowEvidencePin = pins;
		await expect(validate()).resolves.toBeUndefined();
		const locks = (f.tx.$queryRawUnsafe as Mock).mock.calls.filter((c) =>
			String(c[0]).includes('FROM "LibraryFlowEvidencePin"'),
		);
		for (const pin of pins)
			expect(
				locks.some(
					(c) =>
						c[3] === pin.receiptId && String(c[0]).includes("FOR KEY SHARE"),
				),
			).toBe(true);
	});
});
