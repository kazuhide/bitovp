import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppPrismaClient, createPrismaClient } from "./client";
import {
	claimExperimentTrial,
	completeExperimentTrial,
	controlExperimentCampaign,
	enqueueExperimentBatch,
	experimentResultPage,
	experimentSelectionRows,
	releaseExperimentTrial,
} from "./encoding-experiments";
import { createTenantPrismaClient } from "./tenant-client";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL organization isolation",
	() => {
		const orgA = randomUUID();
		const orgB = randomUUID();
		let admin: AppPrismaClient;
		let app: AppPrismaClient;
		let a: AppPrismaClient;
		let b: AppPrismaClient;
		let credentialA: string;
		let credentialB: string;

		beforeAll(async () => {
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
			a = createTenantPrismaClient(app, orgA);
			b = createTenantPrismaClient(app, orgB);
			await admin.organization.createMany({
				data: [
					{ id: orgA, name: "Test A", slug: `test-${orgA}` },
					{ id: orgB, name: "Test B", slug: `test-${orgB}` },
				],
			});
			credentialA = (
				await a.credential.create({
					data: {
						label: "A",
						provider: "AWS_S3",
						encryptedSecret: "encrypted-A",
					},
				})
			).id;
			credentialB = (
				await b.credential.create({
					data: {
						label: "B",
						provider: "AWS_S3",
						encryptedSecret: "encrypted-B",
					},
				})
			).id;
		});

		afterAll(async () => {
			if (admin) {
				await admin.storageLocationPreset.deleteMany({
					where: { organizationId: { in: [orgA, orgB] } },
				});
				await admin.appSetting.deleteMany({
					where: { organizationId: { in: [orgA, orgB] } },
				});
				await admin.encodingJob.deleteMany({
					where: { organizationId: { in: [orgA, orgB] } },
				});
				await admin.bitmovinAccount.deleteMany({
					where: { organizationId: { in: [orgA, orgB] } },
				});
				await admin.credential.deleteMany({
					where: { organizationId: { in: [orgA, orgB] } },
				});
				await admin.operationAttempt.deleteMany({
					where: { organizationId: { in: [orgA, orgB] } },
				});
				await admin.encodingExperimentBatch.deleteMany({
					where: { organizationId: { in: [orgA, orgB] } },
				});
				await admin.encodingExperimentTrial.deleteMany({
					where: { organizationId: { in: [orgA, orgB] } },
				});
				await admin.encodingExperimentCampaign.deleteMany({
					where: { organizationId: { in: [orgA, orgB] } },
				});
				await admin.organization.deleteMany({
					where: { id: { in: [orgA, orgB] } },
				});
				await admin.$disconnect();
			}
			if (app) await app.$disconnect();
		});

		it("isolates list, ID, explicit secret selects, raw SQL and unscoped queries", async () => {
			expect((await a.credential.findMany()).map((row) => row.id)).toEqual([
				credentialA,
			]);
			expect(
				await a.credential.findUnique({
					where: { id: credentialB },
					select: { encryptedSecret: true },
				}),
			).toBeNull();
			expect(
				await a.$queryRaw<
					{ label: string }[]
				>`SELECT label FROM "Credential" ORDER BY label`,
			).toEqual([{ label: "A" }]);
			expect(await app.credential.findMany()).toEqual([]);
			expect(await app.$queryRaw`SELECT label FROM "Credential"`).toEqual([]);
			expect(
				await a.credential.findUnique({ where: { id: credentialA } }),
			).not.toHaveProperty("encryptedSecret");
		});

		it("fences experiment claims, replays idempotent batches and isolates their results", async () => {
			const ctx = { organizationId: orgA, prisma: a };
			const foreign = { organizationId: orgB, prisma: b };
			const capabilityId = "a".repeat(64);
			const campaign = await a.encodingExperimentCampaign.create({
				data: { name: "NVENC experiment", capabilityId, runtime: {} },
			});
			const trial = {
				trialKey: "b".repeat(64),
				sourceSha256: "c".repeat(64),
				input: {
					sourceId: "fixture",
					window: {
						timeBase: { num: 1, den: 90_000 },
						startPts: "90000",
						endPtsExclusive: "180000",
					},
				},
			};
			const create = async () => [trial, trial];
			const first = await enqueueExperimentBatch(
				ctx,
				campaign.id,
				"key",
				capabilityId,
				create,
			);
			const replay = await enqueueExperimentBatch(
				ctx,
				campaign.id,
				"key",
				capabilityId,
				async () => {
					throw new Error("A replay must not need the current worker");
				},
			);
			expect(replay).toEqual(first);
			expect(first.items[0]?.id).toEqual(first.items[1]?.id);
			expect(
				await experimentSelectionRows(ctx, campaign.id, "fixture", "30", "60"),
			).toMatchObject([{ id: first.items[0]?.id }]);
			expect(
				await experimentSelectionRows(ctx, campaign.id, "fixture", "30", "61"),
			).toEqual([]);
			expect(
				await experimentSelectionRows(
					foreign,
					campaign.id,
					"fixture",
					"30",
					"60",
				),
			).toEqual([]);
			await expect(
				enqueueExperimentBatch(ctx, campaign.id, "key", "e".repeat(64), create),
			).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
			expect(await b.encodingExperimentCampaign.count()).toBe(0);
			await expect(
				experimentResultPage(foreign, campaign.id),
			).rejects.toMatchObject({
				status: 404,
			});
			const now = new Date();
			const claimed = await claimExperimentTrial(ctx, capabilityId, now, 1_000);
			if (!claimed) throw new Error("First claim was not acquired");
			expect(claimed.attempt).toBe(1);
			expect(
				await claimExperimentTrial(ctx, capabilityId, now, 1_000),
			).toBeNull();
			const later = new Date(now.getTime() + 2_000);
			const retry = await claimExperimentTrial(ctx, capabilityId, later, 1_000);
			if (!retry) throw new Error("Expired claim was not recovered");
			expect(retry.attempt).toBe(2);
			expect(
				await completeExperimentTrial(ctx, claimed, {
					failureCode: "STALE",
				}),
			).toBe(false);
			let live = retry;
			for (let attempt = 3; attempt <= 6; attempt++) {
				expect(await releaseExperimentTrial(ctx, live, later)).toBe(true);
				expect(
					await completeExperimentTrial(ctx, live, {
						failureCode: "RELEASED",
					}),
				).toBe(false);
				const next = await claimExperimentTrial(
					ctx,
					capabilityId,
					later,
					1_000,
				);
				if (!next) throw new Error("GPU contention exhausted the lease budget");
				expect(next.attempt).toBe(attempt);
				expect(next.expiredClaims).toBe(1);
				live = next;
			}
			await controlExperimentCampaign(ctx, campaign.id, "cancel");
			expect(await releaseExperimentTrial(ctx, live, later)).toBe(false);
			expect(
				await completeExperimentTrial(ctx, live, {
					failureCode: "STALE",
				}),
			).toBe(false);
			expect(await experimentResultPage(ctx, campaign.id)).toMatchObject({
				items: [{ status: "CANCELED", resultSequence: 1 }],
				nextCursor: null,
				snapshot: 1,
			});
			const exhausted = await a.encodingExperimentCampaign.create({
				data: { name: "Expired leases", capabilityId, runtime: {} },
			});
			await enqueueExperimentBatch(
				ctx,
				exhausted.id,
				"expired",
				capabilityId,
				create,
			);
			const claimedAt = new Date();
			const lease = 1_000;
			const firstLease = await claimExperimentTrial(
				ctx,
				capabilityId,
				claimedAt,
				lease,
			);
			if (!firstLease) throw new Error("Expected a live claim");
			const locked = Promise.withResolvers<void>();
			const unblock = Promise.withResolvers<void>();
			const locker = a.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT "id" FROM "EncodingExperimentCampaign"
					WHERE "id" = ${exhausted.id}::uuid FOR UPDATE`;
				locked.resolve();
				await unblock.promise;
			});
			await Promise.race([locked.promise, locker]);
			try {
				const waited = completeExperimentTrial(ctx, firstLease, {
					failureCode: "TOO_LATE",
				});
				await sleep(claimedAt.getTime() + lease - Date.now() + 20);
				unblock.resolve();
				expect(await waited).toBe(false);
			} finally {
				unblock.resolve();
				await locker;
			}
			for (let attempt = 2; attempt <= 3; attempt++)
				expect(
					await claimExperimentTrial(
						ctx,
						capabilityId,
						new Date(claimedAt.getTime() + (attempt - 1) * lease),
						lease,
					),
				).toMatchObject({ attempt, expiredClaims: attempt - 1 });
			expect(
				await claimExperimentTrial(
					ctx,
					capabilityId,
					new Date(claimedAt.getTime() + 3 * lease),
					lease,
				),
			).toBeNull();
			expect(await experimentResultPage(ctx, exhausted.id)).toMatchObject({
				items: [{ status: "FAILED", failureCode: "WORKER_LEASE_EXPIRED" }],
			});
		});

		it("refuses global SQL, projections and nested identity writes before reaching PostgreSQL", async () => {
			expect(() => a.$queryRawUnsafe('SELECT * FROM public."User"')).toThrow(
				/Global identity SQL/,
			);
			expect(() =>
				a.$queryRawUnsafe(
					'SELECT * FROM "public"."bitovp_auth_token"($1)',
					"prefix01",
				),
			).toThrow(/Global identity SQL/);
			expect(() =>
				a.credential.findUnique({
					where: { id: credentialA },
					include: { organization: true },
				}),
			).toThrow(/Global identity projections/);
			expect(() =>
				a.credential.update({
					where: { id: credentialA },
					data: { organization: { update: { active: false } } },
				}),
			).toThrow(/Global identity relation writes/);
			expect(() =>
				a.apiToken.update({
					where: { id: orgA },
					data: { user: { update: { passwordHash: "forbidden" } } },
				}),
			).toThrow(/Global identity relation writes/);
			expect(
				await admin.organization.findUnique({ where: { id: orgA } }),
			).toMatchObject({ active: true });
		});

		it("rejects cross-org create/connect, reassignment and an entire failed batch", async () => {
			await expect(
				a.storageLocationPreset.create({
					data: {
						label: "foreign",
						bucket: "bucket",
						role: "INPUT",
						credentialId: credentialB,
					},
				}),
			).rejects.toThrow();
			await expect(
				a.credential.update({
					where: { id: credentialA },
					data: { organizationId: orgB },
				}),
			).rejects.toThrow();
			await expect(
				a.$transaction([
					a.credential.create({
						data: {
							label: "rollback",
							provider: "AWS_S3",
							encryptedSecret: "cipher",
						},
					}),
					a.storageLocationPreset.create({
						data: {
							label: "foreign",
							bucket: "bucket",
							role: "INPUT",
							credentialId: credentialB,
						},
					}),
				]),
			).rejects.toThrow();
			expect(await a.credential.count()).toBe(1);
			expect(await b.credential.count()).toBe(1);
		});

		it("preserves logical setting keys and independent upserts in both organizations", async () => {
			await a.appSetting.upsert({
				where: { key: "test.same-key" },
				create: { key: "test.same-key", value: "A" },
				update: { value: "A" },
			});
			await b.appSetting.upsert({
				where: { key: "test.same-key" },
				create: { key: "test.same-key", value: "B" },
				update: { value: "B" },
			});
			expect(
				(await a.appSetting.findUnique({ where: { key: "test.same-key" } }))
					?.value,
			).toBe("A");
			expect(
				(await b.appSetting.findUnique({ where: { key: "test.same-key" } }))
					?.value,
			).toBe("B");
		});

		it("keeps ownership when the original account SetNull relation is deleted", async () => {
			const account = await a.bitmovinAccount.create({
				data: { label: "temporary", encryptedApiKey: "cipher" },
			});
			const job = await a.encodingJob.create({
				data: { name: "retained", plan: {}, bitmovinAccountId: account.id },
			});
			await a.bitmovinAccount.delete({ where: { id: account.id } });
			const retained = await a.encodingJob.findUniqueOrThrow({
				where: { id: job.id },
			});
			expect(retained.bitmovinAccountId).toBeNull();
			expect(retained.organizationId).toBe(orgA);
		});

		it("isolates operation attempts and keeps their organization immutable", async () => {
			const id = randomUUID();
			const ownerDigest = "a".repeat(64);
			const data = { id, operation: "LIVE_MOQ_PLAYBACK" as const, ownerDigest };
			const attempt = await app.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT set_config('TimeZone', 'Asia/Tokyo', true)`;
				await tx.$queryRaw`SELECT set_config('bitovp.organization_id', ${orgA}, true)`;
				const [clock] = await tx.$queryRaw<
					{ utc: Date }[]
				>`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) AS utc`;
				await tx.$executeRaw`
					INSERT INTO "OperationAttempt" (id, operation, "ownerDigest")
					VALUES (${id}::uuid, 'LIVE_MOQ_PLAYBACK', ${ownerDigest})
				`;
				const row = await tx.operationAttempt.findUniqueOrThrow({
					where: { organizationId_id: { organizationId: orgA, id } },
				});
				expect(row.startedAt).toEqual(clock?.utc);
				return row;
			});
			expect(attempt).toMatchObject({
				organizationId: orgA,
				startedAt: expect.any(Date),
				outcome: null,
				elapsedMs: null,
			});
			expect(
				await b.operationAttempt.updateMany({
					where: { id },
					data: { outcome: "FIRST_FRAME", elapsedMs: 500 },
				}),
			).toEqual({ count: 0 });
			await b.operationAttempt.create({
				data: { ...data, ownerDigest: "b".repeat(64) },
			});
			expect(await a.operationAttempt.findMany({ where: { id } })).toEqual([
				attempt,
			]);
			expect(await app.$queryRaw`SELECT id FROM "OperationAttempt"`).toEqual(
				[],
			);
			await expect(a.$executeRaw`
				INSERT INTO "OperationAttempt" ("organizationId", id, operation, "ownerDigest")
				VALUES (${orgB}::uuid, ${randomUUID()}::uuid, 'LIVE_MOQ_PLAYBACK', ${ownerDigest})
			`).rejects.toThrow(/row-level security/i);
			await expect(a.$executeRaw`
				UPDATE "OperationAttempt" SET "organizationId" = ${orgB}::uuid WHERE id = ${id}::uuid
			`).rejects.toThrow(/Organization ownership is immutable/);
		});

		it("enforces the operation digest and paired terminal result at the database", async () => {
			const id = randomUUID();
			const ownerDigest = "a".repeat(64);
			const insert = (digest: string) => a.$executeRaw`
				INSERT INTO "OperationAttempt" (id, operation, "ownerDigest")
				VALUES (${id}::uuid, 'LIVE_MOQ_PLAYBACK', ${digest})
			`;
			for (const digest of ["a".repeat(63), "A".repeat(64), "z".repeat(64)]) {
				await expect(insert(digest)).rejects.toThrow(
					/OperationAttempt_ownerDigest_format/,
				);
			}
			await insert(ownerDigest);
			const complete = (
				outcome: "FIRST_FRAME" | null,
				elapsedMs: number | null,
			) => a.$executeRaw`
				UPDATE "OperationAttempt" SET outcome = ${outcome}::"OperationOutcome", "elapsedMs" = ${elapsedMs}::integer
				WHERE id = ${id}::uuid
			`;
			for (const [outcome, elapsed] of [
				["FIRST_FRAME", null],
				[null, 10],
				["FIRST_FRAME", -1],
				["FIRST_FRAME", 600001],
			] as const) {
				await expect(complete(outcome, elapsed)).rejects.toThrow(
					/OperationAttempt_terminal_result/,
				);
			}
			await expect(complete("FIRST_FRAME", 0)).resolves.toBe(1);
			await expect(complete("FIRST_FRAME", 600000)).resolves.toBe(1);
		});

		it("does not leak scope between simultaneous pooled transactions and enforces read-only raw SQL", async () => {
			const lists = await Promise.all(
				Array.from({ length: 12 }, (_, index) =>
					(index % 2 ? a : b).credential.findMany({
						select: { organizationId: true },
					}),
				),
			);
			lists.forEach((rows, index) => {
				expect(
					rows.every((row) => row.organizationId === (index % 2 ? orgA : orgB)),
				).toBe(true);
			});
			const readOnly = createTenantPrismaClient(app, orgA, { readOnly: true });
			await expect(
				readOnly.$executeRaw`DELETE FROM "Credential"`,
			).rejects.toThrow();
			expect(await a.credential.count()).toBe(1);
		});
	},
);
