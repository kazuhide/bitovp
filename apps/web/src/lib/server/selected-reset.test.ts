import { randomBytes } from "node:crypto";
import { AesGcmCipher } from "@bitovp/core";
import type { AppPrismaClient, ResetCleanupPayload } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	RESET_CATALOG,
	RESET_CATEGORIES,
	requiredResetCategories,
} from "@/lib/reset-selection";
import { collectEncoderPointers, ENCODER_POINTER_RECORD_LIMIT } from "./reset";
import {
	countResetCategories,
	deleteSelectedData,
	SelectedResetBlocked,
} from "./selected-reset";

const state = vi.hoisted(() => ({ active: false }));
vi.mock("./reset", async (original) => ({
	...(await original<typeof import("./reset")>()),
	findActiveWork: async () => ({
		encodingJobs: state.active ? [{ id: "racing" }] : [],
		liveChannels: [],
		feederSessions: [],
		vmafJobs: [],
		verificationIntents: [],
		unstoppedEncoders: [],
	}),
}));

function fixture() {
	const events: string[] = [];
	const tables = Object.fromEntries(
		[...new Set(RESET_CATALOG.flatMap((entry) => [...entry.models]))].map(
			(model) => [
				model,
				{
					count: vi.fn(async () => 0),
					findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
					findUnique: vi.fn(async () => null),
					deleteMany: vi.fn(async (_args?: unknown) => {
						events.push(`delete:${model}`);
						return { count: 1 };
					}),
					updateMany: vi.fn(async (_args?: unknown) => {
						events.push(`update:${model}`);
						return { count: 1 };
					}),
				},
			],
		),
	);
	const prisma = {
		...tables,
		resetCleanupTask: {
			create: vi.fn(
				async ({
					data,
				}: {
					data: { id: string; encryptedPayload: string };
				}) => {
					events.push("receipt");
					return data;
				},
			),
		},
		$queryRaw: vi.fn(async (query: TemplateStringsArray) => {
			events.push(query[0] ?? "lock");
			return [];
		}),
		$transaction: vi.fn(
			async (callback: (tx: unknown) => Promise<unknown>, _options?: unknown) =>
				callback(prisma),
		),
	};
	return {
		client: prisma as unknown as AppPrismaClient,
		tables,
		events,
		transaction: prisma.$transaction,
		receipt: prisma.resetCleanupTask.create,
	};
}

beforeEach(() => {
	state.active = false;
});

describe("selected reset", () => {
	it("protects retained verification-key, canonical-key and direct provider references when adoption never recorded localId", async () => {
		const f = fixture();
		const cipher = new AesGcmCipher(randomBytes(32));
		f.tables.encodingJob?.findMany.mockResolvedValue([
			{
				id: "by-key",
				verificationKey: "verify:retained",
				bitmovinAccountId: "account",
				bitmovinEncodingId: null,
				stepLog: [],
			},
			{
				id: "by-canonical",
				verificationKey: null,
				bitmovinAccountId: "account",
				bitmovinEncodingId: null,
				stepLog: [],
			},
			{
				id: "by-step",
				verificationKey: null,
				bitmovinAccountId: "account",
				bitmovinEncodingId: "direct",
				stepLog: [{ kind: "CREATE_ENCODING", resourceId: "sibling" }],
			},
		]);
		const intent = (id: string, providerIds: string[], extra = {}) => ({
			id,
			kind: "VOD_JOB",
			localId: null,
			providerId: null,
			providerIds,
			possiblyCreatedKeys: [],
			verificationKey: `verify:${id}`,
			verificationRun: { bitmovinAccountId: "account" },
			...extra,
		});
		f.tables.verificationResourceIntent?.findMany.mockResolvedValue([
			intent("retained", ["key-owned"]),
			intent("canonical", ["canonical-owned"], {
				possiblyCreatedKeys: ["local:VOD_JOB:by-canonical"],
			}),
			intent("direct", ["direct", "sibling"]),
			intent("orphan", [], {
				possiblyCreatedKeys: ["provider:BITMOVIN_ENCODING:orphan-canonical"],
			}),
		]);
		await deleteSelectedData(f.client, ["verificationHistory"], cipher);
		const data = f.receipt.mock.calls[0]?.[0].data;
		if (!data) throw new Error("Missing receipt");
		const saved = JSON.parse(
			await cipher.decrypt(data.encryptedPayload, `reset-cleanup:${data.id}`),
		) as ResetCleanupPayload;
		expect(saved.encodings).toEqual([
			{
				entityKey: "encodingJob:verification-intent:orphan",
				accountId: "account",
				encodingId: "orphan-canonical",
			},
		]);
		expect(saved.verificationIntents).toHaveLength(4);
	});
	it("recovers verification provider IDs for erased or orphan parents while leaving retained parents alone", async () => {
		const f = fixture();
		const cipher = new AesGcmCipher(randomBytes(32));
		f.tables.encodingJob?.findMany.mockResolvedValue([{ id: "retained" }]);
		f.tables.verificationResourceIntent?.findMany.mockResolvedValue([
			{
				id: "intent-retained",
				kind: "VOD_JOB",
				localId: "retained",
				providerId: "retained-provider",
				providerIds: [],
				verificationRun: { bitmovinAccountId: "account" },
			},
			{
				id: "intent-orphan",
				kind: "VOD_JOB",
				localId: "orphan",
				providerId: "orphan-provider",
				providerIds: ["orphan-sibling"],
				verificationRun: { bitmovinAccountId: "account" },
			},
			{
				id: "intent-ambiguous",
				kind: "VOD_JOB",
				localId: null,
				providerId: "unbound-provider",
				providerIds: [],
				verificationRun: { bitmovinAccountId: "account" },
			},
		]);
		await deleteSelectedData(f.client, ["verificationHistory"], cipher);
		const data = f.receipt.mock.calls[0]?.[0].data;
		if (!data) throw new Error("Missing receipt");
		const saved = JSON.parse(
			await cipher.decrypt(data.encryptedPayload, `reset-cleanup:${data.id}`),
		) as ResetCleanupPayload;
		expect(saved.encodings.map((row) => row.encodingId).sort()).toEqual([
			"orphan-provider",
			"orphan-sibling",
			"unbound-provider",
		]);
		expect(saved.verificationIntents).toHaveLength(3);
	});
	it("preserves dispatched restart ownership and a claimed DELETED webhook until their exact owners acknowledge", async () => {
		const f = fixture();
		const cipher = new AesGcmCipher(randomBytes(32));
		const claimedUntil = new Date();
		f.tables.liveEffectClaim?.findMany.mockResolvedValue([
			{
				id: "restart",
				token: "effect-token",
				state: "DISPATCHING",
				providerEncodingId: "encoding",
				liveChannel: { bitmovinAccountId: "account" },
			},
		]);
		f.tables.webhookRegistration?.findMany.mockResolvedValue([
			{
				id: "hook",
				scope: "j",
				encodingId: "encoding",
				bitmovinAccountId: "account",
				kind: "finished",
				status: "DELETED",
				providerWebhookId: null,
				url: null,
				tokenHash: null,
				configuration: {},
				claimedUntil,
			},
		]);
		await deleteSelectedData(
			f.client,
			requiredResetCategories(["liveChannels", "webhookRegistrations"]),
			cipher,
		);
		const data = f.receipt.mock.calls[0]?.[0].data;
		if (!data) throw new Error("Missing receipt");
		const saved = JSON.parse(
			await cipher.decrypt(data.encryptedPayload, `reset-cleanup:${data.id}`),
		) as ResetCleanupPayload;
		expect(saved.pendingEntities).toEqual(
			expect.arrayContaining([
				{
					entityKey: "liveEffectClaim:restart",
					ownerToken: "effect-token",
					status: "DISPATCHING",
					accountId: "account",
				},
				{
					entityKey: "webhookRegistration:hook",
					ownerToken: claimedUntil.toISOString(),
					status: "DELETED",
					accountId: "account",
				},
			]),
		);
		expect(f.tables.webhookRegistration?.findMany).toHaveBeenCalledWith({
			where: {
				OR: [{ status: { not: "DELETED" } }, { claimedUntil: { not: null } }],
			},
		});
	});
	it("saves every provider identity before deletion, beyond the customer report cap", async () => {
		const f = fixture();
		const cipher = new AesGcmCipher(randomBytes(32));
		f.tables.encodingJob?.findMany.mockResolvedValue(
			Array.from({ length: ENCODER_POINTER_RECORD_LIMIT + 1 }, (_, i) => ({
				id: `job-${i}`,
				name: "job",
				status: "RUNNING",
				bitmovinEncodingId: `encoder-${i}`,
				bitmovinAccountId: "account",
				attemptClaimedAt: i === 0 ? new Date() : null,
				stepLog: [{ kind: "CREATE_ENCODING", resourceId: `sibling-${i}` }],
			})),
		);
		f.tables.bitmovinAccount?.findMany.mockResolvedValue([
			{
				id: "account",
				encryptedApiKey: await cipher.encrypt(
					"private-key",
					"bitmovin-account:account",
				),
				tenantOrgId: null,
			},
		]);
		const result = await deleteSelectedData(f.client, ["vodJobs"], cipher);
		const data = f.receipt.mock.calls[0]?.[0].data;
		if (!data) throw new Error("Cleanup receipt missing");
		const saved = JSON.parse(
			await cipher.decrypt(data.encryptedPayload, `reset-cleanup:${data.id}`),
		) as ResetCleanupPayload;
		expect(saved.encodings).toHaveLength(
			(ENCODER_POINTER_RECORD_LIMIT + 1) * 2,
		);
		expect(saved.accounts).toHaveLength(1);
		expect(saved.pendingEntities).toHaveLength(2);
		expect(saved.pendingEntities).toContainEqual({
			entityKey: "encodingJob:job-0",
			accountId: "account",
			status: "UNCONFIRMED_PRIOR_OWNER",
			ownerToken: "unconfirmed-prior-owner",
		});
		expect(result.encoders.truncated).toBe(true);
		expect(f.events.indexOf("receipt")).toBeLessThan(
			f.events.indexOf("delete:encodingJob"),
		);
	});
	it.each([
		{ code: "P2034" },
		{ code: "P2010", meta: { code: "40001" } },
	])("automatically retries a serializable conflict %j", async (error) => {
		const f = fixture();
		f.transaction.mockRejectedValueOnce(error);
		await deleteSelectedData(f.client, ["auditHistory"]);
		expect(f.transaction).toHaveBeenCalledTimes(2);
		expect(f.tables.auditLog?.deleteMany).toHaveBeenCalledTimes(1);
	});
	it("deletes only the requested library, suppressing automatic recreation before deletion under locks", async () => {
		const f = fixture();
		const result = await deleteSelectedData(f.client, ["contentLibrary"]);
		expect(f.events.slice(0, 3)).toEqual([
			'SELECT id FROM "EncodingJob" ORDER BY id FOR UPDATE',
			'SELECT id FROM "LibrarySource" ORDER BY id FOR UPDATE',
			"update:encodingJob",
		]);
		expect(f.events.filter((event) => event.startsWith("delete:"))).toEqual([
			"delete:contentRevision",
			"delete:content",
			"delete:sceneAnalysisRevision",
			"delete:librarySource",
		]);
		expect(f.tables.encodingJob?.updateMany).toHaveBeenCalledWith({
			where: {},
			data: { libraryCaptureSuppressed: true },
		});
		expect(result.deletedCounts).toEqual([
			{ category: "contentLibrary", count: 4 },
		]);
		expect(result.disarmed).toEqual([]);
		expect(result.encoders.pointers).toEqual([]);
		expect(f.transaction).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ isolationLevel: "Serializable" }),
		);
	});
	it("deletes every organization category child-first, including disjoint rule halves", async () => {
		const f = fixture();
		const result = await deleteSelectedData(f.client, RESET_CATEGORIES);
		expect(f.events.filter((event) => event.startsWith("delete:"))).toEqual([
			"delete:appSetting", // Import ownership is canceled before any snapshot delete.
			...RESET_CATALOG.flatMap((entry) =>
				entry.models
					.filter(
						(model) =>
							model !== "vmafComputeCredential" &&
							model !== "vmafExecutionProfile",
					)
					.map((model) => `delete:${model}`),
			),
		]);
		expect(f.tables.alertRule?.deleteMany.mock.calls).toEqual([
			[{ where: { liveChannelId: { not: null } } }],
			[{ where: { liveChannelId: null } }],
		]);
		expect(result.deletedCounts).toHaveLength(25);
		expect(result.requiresSetup).toBe(false);
		expect(f.tables.encodingJob?.updateMany).not.toHaveBeenCalled();
		expect(f.tables.watchRule?.updateMany).not.toHaveBeenCalled();
	});
	it("removes selected cloud profiles and retires credentials without losing cleanup material", async () => {
		const f = fixture();
		let visible = 2;
		let visibleProfiles = 1;
		f.tables.vmafExecutionProfile?.count.mockImplementation(
			async (args?: unknown) => {
				expect(args).toEqual({ where: { resetAt: null } });
				return visibleProfiles;
			},
		);
		f.tables.vmafExecutionProfile?.updateMany.mockImplementation(
			async (args?: unknown) => {
				expect(args).toEqual({
					where: { resetAt: null },
					data: {
						enabled: false,
						resetAt: expect.any(Date),
						version: { increment: 1 },
					},
				});
				const count = visibleProfiles;
				visibleProfiles = 0;
				return { count };
			},
		);
		f.tables.vmafComputeCredential?.count.mockImplementation(
			async (args?: unknown) => {
				expect(args).toEqual({ where: { disabledAt: null } });
				return visible;
			},
		);
		f.tables.vmafComputeCredential?.updateMany.mockImplementation(
			async (args?: unknown) => {
				expect(args).toEqual({
					where: { disabledAt: null },
					data: { disabledAt: expect.any(Date) },
				});
				const count = visible;
				visible = 0;
				return { count };
			},
		);
		const before = await countResetCategories(f.client);
		expect(
			before.find((entry) => entry.category === "credentials")?.count,
		).toBe(2);
		const result = await deleteSelectedData(
			f.client,
			requiredResetCategories(["credentials", "applicationSettings"]),
		);
		expect(f.tables.vmafExecutionProfile?.deleteMany).not.toHaveBeenCalled();
		expect(result.counts.vmafExecutionProfile).toBe(1);
		expect(f.tables.vmafComputeCredential?.deleteMany).not.toHaveBeenCalled();
		expect(result.counts.vmafComputeCredential).toBe(2);
		const after = await countResetCategories(f.client);
		expect(after.find((entry) => entry.category === "credentials")?.count).toBe(
			0,
		);
		expect(
			after.find((entry) => entry.category === "applicationSettings")?.count,
		).toBe(0);
	});
	it("rejects missing dependent selections before opening a transaction", async () => {
		const f = fixture();
		await expect(
			deleteSelectedData(f.client, ["credentials"]),
		).rejects.toBeInstanceOf(SelectedResetBlocked);
		expect(f.transaction).not.toHaveBeenCalled();
	});
	it("deletes selected rows despite active work and uncaptured AISA", async () => {
		const f = fixture();
		state.active = true;
		await expect(
			deleteSelectedData(f.client, ["vodJobs"]),
		).resolves.toMatchObject({ requiresSetup: false });
		expect(f.tables.encodingJob?.deleteMany).toHaveBeenCalled();
	});
	it.each([
		["contentLibrary", "librarySource"],
		["webhookRegistrations", "webhookRegistration"],
		["verificationHistory", "verificationRun"],
		["storageChecks", "storageInspection"],
		["liveSchedules", "slateNormalization"],
		["liveSchedules", "liveEffectClaim"],
	] as const)("deletes selected %s even when work remains", async (category, model) => {
		const f = fixture();
		f.tables[model]?.count.mockResolvedValue(1);
		await deleteSelectedData(f.client, [category]);
		expect(f.tables[model]?.deleteMany).toHaveBeenCalled();
	});
	it("only disarms retained watch folders when their detection history is erased", async () => {
		const f = fixture();
		f.tables.watchRule?.findMany.mockResolvedValue([
			{ id: "watch", name: "Source" },
		]);
		const result = await deleteSelectedData(f.client, ["watchFolderHistory"]);
		expect(result.disarmed).toEqual([{ id: "watch", name: "Source" }]);
		expect(f.events.indexOf("update:watchRule")).toBeLessThan(
			f.events.indexOf("delete:watchedObject"),
		);
		const removed = fixture();
		await deleteSelectedData(
			removed.client,
			requiredResetCategories(["watchFolders"]),
		);
		expect(removed.tables.watchRule?.updateMany).not.toHaveBeenCalled();
	});
	it("counts all choices with separate alert rule predicates", async () => {
		const f = fixture();
		expect(await countResetCategories(f.client)).toHaveLength(25);
		expect(f.tables.alertRule?.count.mock.calls).toEqual([
			[{ where: { liveChannelId: { not: null } } }],
			[{ where: { liveChannelId: null } }],
		]);
	});
	it("filters pointer families before truncation, never releasing keys for retained channels", async () => {
		const f = fixture();
		f.tables.encodingJob?.findMany.mockResolvedValue([
			{
				id: "job",
				name: "VOD",
				status: "FINISHED",
				bitmovinEncodingId: "vod",
				bitmovinAccountId: "account",
			},
		]);
		f.tables.liveChannel?.findMany.mockResolvedValue(
			Array.from({ length: ENCODER_POINTER_RECORD_LIMIT + 1 }, (_, i) => ({
				id: `channel-${i}`,
				name: "Live",
				status: "STOPPED",
				bitmovinEncodingId: `live-${i}`,
			})),
		);
		const result = await collectEncoderPointers(f.client, {
			vodJobs: true,
			liveChannels: false,
		});
		expect(
			result.pointers.map((pointer) => pointer.bitmovinEncodingId),
		).toEqual(["vod"]);
		expect(result.liveProviderIdentityTotal).toBe(0);
		expect(f.tables.liveChannel?.findMany).not.toHaveBeenCalled();
		expect(f.tables.liveChannelRun?.findMany).not.toHaveBeenCalled();
	});
});
