import { canonicalEditingJson, hashEditingEvidence } from "@bitovp/core";
import { LocalStoryLegacyArtifactSealError } from "@bitovp/core/local-story-flow-server";
import type { AppPrismaClient, LibraryMediaTask } from "@bitovp/db";
import { beforeEach, expect, it, vi } from "vitest";
import { createLocalStoryArtifactStore } from "./local-story-artifacts";
import type { VerifiedMediaTask } from "./media-task-execution";
import { MediaOperationError } from "./process";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), cacheRead: vi.fn() }));
vi.mock("@bitovp/core/local-story-flow-server", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@bitovp/core/local-story-flow-server")
		>();
	mocks.cacheRead.mockImplementation(actual.readLocalStoryArtifactCacheRow);
	return { ...actual, readLocalStoryArtifactCacheRow: mocks.cacheRead };
});
vi.mock("./media-task-execution", () => ({
	verifyMediaTaskEvidence: mocks.verify,
}));
const parse = (value: unknown): { text: string } => {
	if (
		!value ||
		typeof value !== "object" ||
		!("text" in value) ||
		typeof value.text !== "string"
	)
		throw new Error("invalid caller schema");
	return { text: value.text };
};
function fixture() {
	const now = new Date("2026-11-04T12:00:00Z"),
		signal = new AbortController();
	const task = {
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		organizationId: "00000000-0000-4000-8000-000000000001",
		mediaVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		analysisRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		createdBy: "fixture",
		state: "RUNNING",
		leaseToken: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
		leaseUntil: new Date(now.getTime() + 60_000),
		cancelRequestedAt: null as Date | null,
	};
	const media = {
		id: task.mediaVersionId,
		organizationId: task.organizationId,
		sourceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		sha256: "a".repeat(64),
		timeMap: { marker: "fixed-clock" },
	};
	const verified = {
		media,
		binding: { marker: "fixed-binding" },
		envelope: {
			identity: {
				analysisRawHash: "b".repeat(64),
				analysisDocumentHash: "c".repeat(64),
			},
		},
	} as unknown as VerifiedMediaTask;
	const rows: Array<Record<string, unknown>> = [];
	let transaction = false,
		updates = 0;
	const state = {
		afterCreate: undefined as (() => void) | undefined,
		beforeRead: undefined as (() => void) | undefined,
	};
	const prisma = {
		libraryEvidenceReceipt: {
			findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
				state.beforeRead?.();
				return rows.find((r) => r.id === where.id) ?? null;
			}),
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				rows.push(structuredClone(data));
				state.afterCreate?.();
				return data;
			}),
		},
		libraryMediaTask: {
			updateMany: vi.fn(
				async ({ where }: { where: Record<string, unknown> }) => {
					updates++;
					const owned =
						where.id === task.id &&
						where.organizationId === task.organizationId &&
						where.leaseToken === task.leaseToken &&
						task.state === "RUNNING" &&
						!task.cancelRequestedAt &&
						task.leaseUntil > now;
					return { count: owned ? 1 : 0 };
				},
			),
			findUnique: vi.fn(async () => task),
		},
		$executeRaw: vi.fn(async () => 1),
		$transaction: async <T>(fn: (client: AppPrismaClient) => Promise<T>) => {
			const before = structuredClone(rows);
			transaction = true;
			try {
				return await fn(prisma as unknown as AppPrismaClient);
			} catch (error) {
				rows.splice(0, rows.length, ...before);
				throw error;
			} finally {
				transaction = false;
			}
		},
	} as unknown as AppPrismaClient;
	mocks.verify.mockResolvedValue(verified);
	const options = {
		prisma,
		task: task as unknown as LibraryMediaTask,
		verified,
		leaseToken: task.leaseToken,
		signal: signal.signal,
		now: () => now,
	};
	const store = createLocalStoryArtifactStore(options);
	const build = vi.fn(async () => {
		expect(transaction).toBe(false);
		return { text: "grounded fixture" };
	});
	const request = {
		kind: "LOCAL_STORY_LEDGER_V1" as const,
		key: { model: "fixed", promptHash: "d".repeat(64) },
		parse,
		build,
	};
	return {
		task,
		media,
		verified,
		rows,
		store,
		options,
		request,
		build,
		signal,
		state,
		prisma,
		updates: () => updates,
	};
}
beforeEach(() => {
	mocks.verify.mockReset();
	mocks.cacheRead.mockClear();
});
const originalMean = -0.21932977413201898;
const roundedMean = -0.219329774132019;
const floatParse = (value: unknown) => {
	const v = value as { text?: unknown; mean?: unknown };
	if (!v || typeof v.text !== "string" || typeof v.mean !== "number")
		throw Error("invalid float fixture");
	return { text: v.text, mean: v.mean };
};
async function legacyFloat(
	kind: "LOCAL_STORY_TRANSCRIPT_V1" | "LOCAL_STORY_LEDGER_V1",
) {
	const f = fixture();
	const request = {
		...f.request,
		kind,
		parse: floatParse,
		build: vi.fn(async () => ({
			text: "Synthetic speech",
			mean: originalMean,
		})),
	};
	const first = await f.store.load(request),
		row = f.rows[0];
	if (!row) throw Error("missing fixture");
	const cacheHash = (row.proof as { cacheHash: string }).cacheHash;
	row.proof = {
		version: "local-story-cache-v1",
		cacheHash,
		value: structuredClone(first.value),
	};
	row.proofHash = hashEditingEvidence(row.proof);
	(row.proof as { value: { mean: number } }).value.mean = roundedMean;
	return { f, request, row, first };
}
it("seals new floating evidence as canonical JSON text and survives lossy numeric transport", async () => {
	const f = fixture(),
		value = { text: "Synthetic speech", mean: originalMean };
	f.state.afterCreate = () => {
		const row = f.rows[0];
		if (!row) throw Error("missing fixture");
		row.proof = JSON.parse(
			JSON.stringify(row.proof, (_key, v) =>
				typeof v === "number" ? Number(v.toPrecision(16)) : v,
			),
		);
	};
	const request = { ...f.request, parse: floatParse, build: async () => value };
	const first = await f.store.load(request);
	expect(f.rows[0]?.proof).toEqual({
		version: "local-story-cache-v2",
		cacheHash: expect.any(String),
		valueJson: canonicalEditingJson(value),
	});
	await expect(f.store.load(request)).resolves.toEqual({
		...first,
		cached: true,
	});
});
it.each([
	"LOCAL_STORY_LEDGER_V1",
	"LOCAL_STORY_BLUEPRINT_V1",
] as const)("retains strict legacy %s keys and fingerprints without reconstruction", async (kind) => {
	const f = fixture(),
		request = { ...f.request, kind };
	const first = await f.store.load(request),
		row = f.rows[0];
	if (!row) throw Error("missing fixture");
	const id = row.id;
	row.proof = {
		version: "local-story-cache-v1",
		cacheHash: (row.proof as { cacheHash: string }).cacheHash,
		value: first.value,
	};
	row.proofHash = hashEditingEvidence(row.proof);
	const recover = vi.fn(() => first.value);
	await expect(
		f.store.load({ ...request, recoverLegacyTranscriptValue: recover }),
	).resolves.toEqual({ ...first, cached: true });
	expect(row.id).toBe(id);
	expect(recover).not.toHaveBeenCalled();
	expect(f.build).toHaveBeenCalledOnce();
});
it("recovers only a legacy transcript whose whole original proof hash is exactly reconstructed", async () => {
	const { f, request, row, first } = await legacyFloat(
		"LOCAL_STORY_TRANSCRIPT_V1",
	);
	const persisted = structuredClone(row);
	const recover = vi.fn((value: unknown) => ({
		...floatParse(value),
		mean: originalMean,
	}));
	await expect(
		f.store.load({ ...request, recoverLegacyTranscriptValue: recover }),
	).resolves.toEqual({ ...first, cached: true });
	expect(recover).toHaveBeenCalledOnce();
	expect(row).toEqual(persisted);
	expect(request.build).toHaveBeenCalledOnce();
});
it.each([
	"other-kind",
	"other-field",
	"wrong-derived-value",
])("never relaxes legacy integrity for %s", async (change) => {
	const { f, request, row } = await legacyFloat(
		change === "other-kind"
			? "LOCAL_STORY_LEDGER_V1"
			: "LOCAL_STORY_TRANSCRIPT_V1",
	);
	if (change === "other-field")
		(row.proof as { value: { text: string } }).value.text = "Changed speech";
	const original = structuredClone(row);
	const recover = vi.fn((value: unknown) => ({
		...floatParse(value),
		mean: change === "wrong-derived-value" ? 0 : originalMean,
	}));
	await expect(
		f.store.load({ ...request, recoverLegacyTranscriptValue: recover }),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	if (change === "other-kind") expect(recover).not.toHaveBeenCalled();
	expect(row).toEqual(original);
	expect(request.build).toHaveBeenCalledOnce();
});
it("rejects noncanonical v2 text even when the surrounding hash has been replaced", async () => {
	const f = fixture();
	await f.store.load(f.request);
	const row = f.rows[0];
	if (!row) throw Error("missing fixture");
	row.proof = {
		version: "local-story-cache-v2",
		cacheHash: (row.proof as { cacheHash: string }).cacheHash,
		valueJson: '{ "text": "grounded fixture" }',
	};
	row.proofHash = hashEditingEvidence(row.proof);
	await expect(f.store.load(f.request)).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
});
it("never applies legacy reconstruction to a corrupt v2 envelope", async () => {
	const f = fixture(),
		request = { ...f.request, kind: "LOCAL_STORY_TRANSCRIPT_V1" as const };
	const first = await f.store.load(request),
		row = f.rows[0];
	if (!row) throw Error("missing fixture");
	row.proof = {
		...(row.proof as object),
		valueJson: canonicalEditingJson({ text: "changed" }),
	};
	const recover = vi.fn(() => first.value);
	await expect(
		f.store.load({ ...request, recoverLegacyTranscriptValue: recover }),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(recover).not.toHaveBeenCalled();
	expect(f.build).toHaveBeenCalledOnce();
});
it("publishes canonical immutable evidence outside the model transaction and revalidates cache values", async () => {
	const f = fixture(),
		first = await f.store.load(f.request);
	const strictParse = vi.fn(parse);
	const second = await f.store.load({ ...f.request, parse: strictParse });
	expect(second).toEqual({ ...first, cached: true });
	expect(f.build).toHaveBeenCalledOnce();
	expect(strictParse).toHaveBeenCalledOnce();
	expect(first.hash).toBe(hashEditingEvidence(first.value));
	expect(f.rows).toHaveLength(1);
	expect(f.rows[0]).toMatchObject({
		organizationId: f.task.organizationId,
		sourceId: f.media.sourceId,
		mediaVersionId: f.media.id,
		analysisRevisionId: f.task.analysisRevisionId,
		kind: f.request.kind,
		proofHash: hashEditingEvidence(f.rows[0]?.proof),
	});
	expect(f.rows[0]?.id).toMatch(
		/^[a-f\d]{8}-[a-f\d]{4}-5[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/,
	);
	expect(f.updates()).toBe(2);
	expect(mocks.verify).toHaveBeenCalledOnce();
});
it.each([
	"organizationId",
	"sourceId",
	"mediaVersionId",
	"analysisRevisionId",
	"kind",
	"proofHash",
	"extra-proof",
	"caller-schema",
])("rejects cached %s corruption without overwriting it", async (change) => {
	const f = fixture();
	await f.store.load(f.request);
	const row = f.rows[0];
	if (!row) throw Error("fixture missing");
	if (change === "extra-proof") {
		row.proof = { ...(row.proof as object), extra: "not allowed" };
		row.proofHash = hashEditingEvidence(row.proof);
	} else if (change === "caller-schema") {
		row.proof = {
			...(row.proof as object),
			valueJson: canonicalEditingJson({ text: 42 }),
		};
		row.proofHash = hashEditingEvidence(row.proof);
	} else row[change] = "altered";
	await expect(f.store.load(f.request)).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.build).toHaveBeenCalledOnce();
	expect(f.rows).toHaveLength(1);
});
it.each([
	"lease",
	"cancel",
	"expiry",
	"source",
	"clock",
	"abort",
])("does not publish after losing %s during build", async (change) => {
	const f = fixture();
	f.build.mockImplementation(async () => {
		if (change === "lease") f.task.leaseToken = "replacement-owner";
		if (change === "cancel") f.task.cancelRequestedAt = new Date();
		if (change === "expiry") f.task.leaseUntil = new Date(0);
		if (change === "source") f.media.sourceId = "replacement-source";
		if (change === "clock") f.media.timeMap.marker = "changed";
		if (change === "abort") f.signal.abort(new Error("private reason"));
		return { text: "late result" };
	});
	await expect(f.store.load(f.request)).rejects.toBeDefined();
	expect(f.rows).toHaveLength(0);
});
it("rolls back a receipt if the final publication fence loses ownership", async () => {
	const f = fixture();
	f.state.afterCreate = () => {
		f.task.cancelRequestedAt = new Date();
	};
	await expect(f.store.load(f.request)).rejects.toMatchObject({
		code: "CANCELED",
	});
	expect(f.rows).toHaveLength(0);
});
it("verifies and adopts a concurrent winner instead of replacing its evidence", async () => {
	const f = fixture();
	await f.store.load(f.request);
	const winner = structuredClone(f.rows[0]);
	f.rows.length = 0;
	f.build.mockImplementation(async () => {
		if (winner) f.rows.push(winner);
		return { text: "losing proposal" };
	});
	const result = await f.store.load(f.request);
	expect(result).toMatchObject({
		cached: true,
		value: { text: "grounded fixture" },
	});
	expect(f.rows).toHaveLength(1);
});
it("binds transcript caches without an analysis revision while keeping ledger revisions distinct", async () => {
	const f = fixture();
	await f.store.load({ ...f.request, kind: "LOCAL_STORY_TRANSCRIPT_V1" });
	expect(f.rows[0]?.analysisRevisionId).toBe(null);
	await f.store.load(f.request);
	expect(f.rows).toHaveLength(2);
	expect(f.rows[1]?.analysisRevisionId).toBe(f.task.analysisRevisionId);
	const other = createLocalStoryArtifactStore({
		...f.options,
		task: {
			...f.options.task,
			analysisRevisionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
		},
	});
	await other.load(f.request);
	expect(f.rows).toHaveLength(3);
});
it("rejects a key mutated during extraction", async () => {
	const f = fixture();
	f.build.mockImplementation(async () => {
		f.request.key.model = "different";
		return { text: "changed inputs" };
	});
	await expect(f.store.load(f.request)).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.rows).toHaveLength(0);
});

const flowKinds = [
	"LOCAL_FLOW_MANIFEST_V1",
	"LOCAL_FLOW_CONTEXT_V1",
	"LOCAL_FLOW_ROUTE_V1",
	"LOCAL_FLOW_PLAN_V1",
] as const;

it.each([
	{
		kind: "LOCAL_STORY_TRANSCRIPT_V1",
		cacheHash:
			"bfe7f95b5c99c5a86b906dbf6a8d8356bc08558ad11d66a6c89edf3f958d09e5",
		receiptId: "48344daf-133e-5229-90c2-629e3a2b4974",
		proofHash:
			"dc6fadd07a72b375420a930a264d706cb6199253067c7821c2a4f3d6ab4414ef",
	},
	{
		kind: "LOCAL_STORY_LEDGER_V1",
		cacheHash:
			"ca4b6d3ce43cb36f5a36c775e069d6e9950ae7e85986e067be90ec09e2b7100f",
		receiptId: "14f481b1-9208-57d6-92e4-663263430c3c",
		proofHash:
			"c17c363def57e00641b25e0e6a279da304ed8e4bf2892c698754f00b69f3434b",
	},
	{
		kind: "LOCAL_STORY_BLUEPRINT_V1",
		cacheHash:
			"22b59cdd999ac3b61d3de4c0ec81590067e1a5e66ae44b6f3237ce564c9386ec",
		receiptId: "482b50fc-8e17-50c2-9394-fe162d11dea0",
		proofHash:
			"dd6c53de757c674711d8efe16d46c717206557faa540ac71b607e6aaff7385f1",
	},
	{
		kind: "LOCAL_CAPTION_TRANSLATION_V1",
		cacheHash:
			"c03bf5bd92d6b2b9950424e077fa7c902af491cfd8c104e34ed252eb53c0bd1c",
		receiptId: "f21955a5-4bf4-548a-8cdf-57556a251e9e",
		proofHash:
			"cc9272ebc916727c0c44da956f99af35a62967d0ed81b3038072eddcebcf562b",
	},
] as const)("preserves the fixed legacy $kind receipt ID, cache hash and proof hash", async ({
	kind,
	cacheHash,
	receiptId,
	proofHash,
}) => {
	const f = fixture();
	await f.store.load({ ...f.request, kind });
	expect(f.rows[0]).toMatchObject({
		id: receiptId,
		proofHash,
		proof: { version: "local-story-cache-v2", cacheHash },
	});
});
it.each(
	flowKinds,
)("publishes and strictly reloads sealed source-bound %s", async (kind) => {
	const f = fixture(),
		recover = vi.fn();
	const request = { ...f.request, kind, recoverLegacyTranscriptValue: recover };
	const first = await f.store.load(request),
		persisted = structuredClone(f.rows);
	expect(first).toMatchObject({
		cached: false,
		value: { text: "grounded fixture" },
	});
	expect(f.rows[0]).toMatchObject({
		organizationId: f.task.organizationId,
		sourceId: f.media.sourceId,
		mediaVersionId: f.media.id,
		analysisRevisionId: f.task.analysisRevisionId,
		kind,
		proof: {
			version: "local-story-cache-v2",
			valueJson: canonicalEditingJson(first.value),
		},
		proofHash: hashEditingEvidence(f.rows[0]?.proof),
	});
	const strictParse = vi.fn(parse);
	await expect(
		f.store.load({ ...request, parse: strictParse }),
	).resolves.toEqual({
		...first,
		cached: true,
	});
	expect(strictParse).toHaveBeenCalledOnce();
	expect(f.build).toHaveBeenCalledOnce();
	expect(recover).not.toHaveBeenCalled();
	expect(f.rows).toEqual(persisted);
	expect(f.updates()).toBe(2);
	expect(mocks.verify).toHaveBeenCalledOnce();
});
it.each(
	flowKinds.flatMap((kind) =>
		["analysis", "binding"].map((missing) => ({ kind, missing })),
	),
)("rejects $kind without $missing before build or cache access", async ({
	kind,
	missing,
}) => {
	const f = fixture();
	if (missing === "binding") Reflect.set(f.verified, "binding", undefined);
	const store = createLocalStoryArtifactStore({
		...f.options,
		task: {
			...f.options.task,
			analysisRevisionId:
				missing === "analysis" ? null : f.task.analysisRevisionId,
		},
	});
	await expect(store.load({ ...f.request, kind })).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.build).not.toHaveBeenCalled();
	expect(f.prisma.libraryEvidenceReceipt.findUnique).not.toHaveBeenCalled();
	expect(f.rows).toEqual([]);
});
it.each(
	flowKinds,
)("never uses transcript-only reconstruction for corrupt %s", async (kind) => {
	const f = fixture(),
		first = await f.store.load({ ...f.request, kind });
	const row = f.rows[0];
	if (!row) throw Error("missing synthetic receipt");
	row.proof = {
		version: "local-story-cache-v1",
		cacheHash: (row.proof as { cacheHash: string }).cacheHash,
		value: { text: "unsealed mutation" },
	};
	const persisted = structuredClone(row),
		recover = vi.fn(() => first.value);
	await expect(
		f.store.load({
			...f.request,
			kind,
			recoverLegacyTranscriptValue: recover,
		}),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(recover).not.toHaveBeenCalled();
	expect(f.build).toHaveBeenCalledOnce();
	expect(row).toEqual(persisted);
});
it.each(
	flowKinds.flatMap((kind) =>
		["lease", "cancel", "expiry", "source", "clock", "abort"].map((change) => ({
			kind,
			change,
		})),
	),
)("does not publish $kind after losing $change during build", async ({
	kind,
	change,
}) => {
	const f = fixture();
	f.build.mockImplementation(async () => {
		if (change === "lease") f.task.leaseToken = "replacement-owner";
		if (change === "cancel") f.task.cancelRequestedAt = new Date();
		if (change === "expiry") f.task.leaseUntil = new Date(0);
		if (change === "source") f.media.sourceId = "replacement-source";
		if (change === "clock") f.media.timeMap.marker = "changed";
		if (change === "abort") f.signal.abort(new Error("synthetic abort"));
		return { text: "late synthetic result" };
	});
	await expect(f.store.load({ ...f.request, kind })).rejects.toBeDefined();
	expect(f.rows).toHaveLength(0);
});
it.each(
	flowKinds,
)("retains the final lease/cancel fence for %s", async (kind) => {
	const f = fixture();
	f.state.afterCreate = () => {
		f.task.cancelRequestedAt = new Date();
	};
	await expect(f.store.load({ ...f.request, kind })).rejects.toMatchObject({
		code: "CANCELED",
	});
	expect(f.rows).toHaveLength(0);
});
it.each(flowKinds)("adopts an immutable concurrent %s winner", async (kind) => {
	const f = fixture(),
		request = { ...f.request, kind };
	await f.store.load(request);
	const winner = structuredClone(f.rows[0]);
	f.rows.length = 0;
	f.build.mockImplementation(async () => {
		if (winner) f.rows.push(winner);
		return { text: "losing synthetic proposal" };
	});
	await expect(f.store.load(request)).resolves.toMatchObject({
		cached: true,
		value: { text: "grounded fixture" },
	});
	expect(f.rows).toEqual([winner]);
});
it("keeps old and new kind namespaces distinct for the same source and caller key", async () => {
	const f = fixture();
	for (const kind of [
		"LOCAL_STORY_TRANSCRIPT_V1",
		"LOCAL_STORY_LEDGER_V1",
		"LOCAL_STORY_BLUEPRINT_V1",
		"LOCAL_CAPTION_TRANSLATION_V1",
		"LOCAL_STORY_CHOICE_V1",
		...flowKinds,
	] as const)
		await f.store.load({ ...f.request, kind });
	expect(f.rows).toHaveLength(9);
	expect(new Set(f.rows.map((row) => row.id)).size).toBe(9);
	expect(
		new Set(f.rows.map((row) => (row.proof as { cacheHash: string }).cacheHash))
			.size,
	).toBe(9);
	expect(f.build).toHaveBeenCalledTimes(9);
});
it("rejects an unknown runtime kind before cache access or build", async () => {
	const f = fixture();
	await expect(
		Reflect.apply(f.store.load, f.store, [
			{
				...f.request,
				kind: "LOCAL_FLOW_UNKNOWN_V1",
			},
		]),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(f.prisma.libraryEvidenceReceipt.findUnique).not.toHaveBeenCalled();
	expect(f.build).not.toHaveBeenCalled();
});

// Preserve the old cache/callback boundaries while using the shared reader.
it("keeps callback exceptions fixed while preserving abort CANCELED priority", async () => {
	const f = fixture();
	await f.store.load(f.request);
	const thrown = new Error("PRIVATE_CALLBACK_SENTINEL");
	await expect(
		f.store.load({
			...f.request,
			parse: () => {
				throw thrown;
			},
		}),
	).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		message: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	await expect(
		f.store.load({
			...f.request,
			parse: () => {
				f.signal.abort(new Error("PRIVATE_ABORT_REASON"));
				throw thrown;
			},
		}),
	).rejects.toMatchObject({ code: "CANCELED", message: "CANCELED" });
	expect(f.build).toHaveBeenCalledOnce();
});
it("retains the captured key hashes on a cached hit, even if key mutates during SELECT", async () => {
	const f = fixture();
	const first = await f.store.load(f.request);
	f.state.beforeRead = () => {
		f.request.key.model = "changed during cached SELECT";
	};
	await expect(f.store.load(f.request)).resolves.toEqual({
		...first,
		cached: true,
	});
	expect(f.build).toHaveBeenCalledOnce();
	expect(f.rows).toHaveLength(1);
});
it("reads the current parse callback from the same input object after SELECT", async () => {
	const f = fixture();
	const first = await f.store.load(f.request);
	const latest = vi.fn(parse);
	f.state.beforeRead = () => {
		f.request.parse = latest;
	};
	await expect(f.store.load(f.request)).resolves.toEqual({
		...first,
		cached: true,
	});
	expect(latest).toHaveBeenCalledOnce();
	expect(f.build).toHaveBeenCalledOnce();
});
it("retains the live input.kind comparison after SELECT, instead of snapshotting it", async () => {
	const f = fixture();
	await f.store.load(f.request);
	f.state.beforeRead = () => {
		Reflect.set(f.request, "kind", "LOCAL_FLOW_CONTEXT_V1");
	};
	await expect(f.store.load(f.request)).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.build).toHaveBeenCalledOnce();
});

it("maps the shared fixed seal failure back to the existing worker error class", async () => {
	const f = fixture();
	await f.store.load(f.request);
	mocks.cacheRead.mockImplementationOnce(() => {
		throw new LocalStoryLegacyArtifactSealError();
	});
	const result = f.store.load(f.request);
	await expect(result).rejects.toBeInstanceOf(MediaOperationError);
	await expect(result).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		message: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(mocks.cacheRead).toHaveBeenCalledOnce();
	expect(f.build).toHaveBeenCalledOnce();
});
