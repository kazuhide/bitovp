import { randomBytes, randomUUID } from "node:crypto";
import { AesGcmCipher, verificationIntentClosureDigest } from "@bitovp/core";
import {
	type AppPrismaClient,
	createPrismaClient,
	createResetCleanupTask,
	createTenantPrismaClient,
	readLockedLiveStartState,
	readResetCleanupTask,
} from "@bitovp/db";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	RESET_CATEGORIES,
	RESET_GLOBAL_MODELS,
	requiredResetCategories,
} from "@/lib/reset-selection";
import {
	collectEncoderPointers,
	deleteOperationalData,
	type EncoderStateReader,
	findActiveWork,
	isIdle,
	pointerJobWhere,
	pointerRunWhere,
	RESET_DELETES,
	RESET_KEEPS,
	reconcileEncoderPointers,
} from "@/lib/server/reset";
import { countResetCategories, deleteSelectedData } from "./selected-reset";

/** Opt-in isolated PostgreSQL proof; fixtures belong to random organizations. */
const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const runtimeUrl = process.env.BITOVP_TENANT_TEST_APP_URL;

const postgres = describe.runIf(Boolean(adminUrl && runtimeUrl));
postgres("tenant PostgreSQL reset", () => {
	const admin = createPrismaClient(adminUrl);
	const runtime = createPrismaClient(runtimeUrl);
	let prisma: AppPrismaClient;
	let organizationIds: [string, string];
	let globalFixture:
		| { userId: string; setupCodeId: string; settingKey: string }
		| undefined;
	beforeEach(async () => {
		globalFixture = undefined;
		organizationIds = [randomUUID(), randomUUID()];
		await admin.organization.createMany({
			data: organizationIds.map((id) => ({
				id,
				name: "Reset probe",
				slug: id,
			})),
		});
		prisma = createTenantPrismaClient(runtime, organizationIds[0]);
	});
	afterEach(async () => {
		// Only this test's random fixtures; global identity and other orgs stay intact.
		const tables = await admin.$queryRaw<
			{ table_name: string }[]
		>`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'organizationId'`;
		// `nullable` is a column of the reference that the fixture may clear.
		const edges = await admin.$queryRaw<
			{ child: string; parent: string; nullable: string | null }[]
		>`SELECT child.relname AS child, parent.relname AS parent, (SELECT a.attname FROM unnest(c.conkey) AS k(attnum) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum WHERE NOT a.attnotnull AND a.attname <> 'organizationId' ORDER BY a.attname LIMIT 1) AS nullable FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid WHERE c.contype='f' AND NOT c.condeferrable AND c.confdeltype IN ('a','r') ORDER BY child.relname, parent.relname, c.conname`;
		const pending = new Set(
			tables
				.map(({ table_name }) => table_name)
				.filter((table) => table !== "Membership"),
		);
		const ordered: string[] = [];
		const cleared: { child: string; nullable: string }[] = [];
		let restrictive = edges.filter((edge) => edge.child !== edge.parent);
		while (pending.size) {
			const next = [...pending].find(
				(table) =>
					!restrictive.some(
						(edge) => edge.parent === table && pending.has(edge.child),
					),
			);
			if (next) {
				ordered.push(next);
				pending.delete(next);
				continue;
			}
			// Tables that reference each other restrictively (a project and its
			// current revision, a source and its render artifact) have no delete
			// order until the fixture rows give up one nullable reference.
			const release = restrictive.find(
				(edge) =>
					edge.nullable && pending.has(edge.child) && pending.has(edge.parent),
			);
			if (!release?.nullable)
				throw new Error("Fixture cleanup has a restrictive foreign-key cycle");
			cleared.push({ child: release.child, nullable: release.nullable });
			restrictive = restrictive.filter((edge) => edge !== release);
		}
		const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
		await admin.$transaction(async (tx) => {
			await tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");
			for (const { child, nullable } of cleared)
				await tx.$executeRawUnsafe(
					`UPDATE ${quoted(child)} SET ${quoted(nullable)} = NULL WHERE "organizationId" = ANY($1::uuid[])`,
					organizationIds,
				);
			for (const table_name of ordered) {
				await tx.$executeRawUnsafe(
					`DELETE FROM ${quoted(table_name)} WHERE "organizationId" = ANY($1::uuid[])`,
					organizationIds,
				);
			}
			await tx.membership.deleteMany({
				where: { organizationId: { in: organizationIds } },
			});
			await tx.organization.deleteMany({
				where: { id: { in: organizationIds } },
			});
			if (globalFixture) {
				await tx.user.delete({ where: { id: globalFixture.userId } });
				await tx.setupCode.delete({
					where: { id: globalFixture.setupCodeId },
				});
				await tx.platformSetting.delete({
					where: { key: globalFixture.settingKey },
				});
			}
		});
	});
	it("selected all resets only A, preserves B and global identities, and binds durable cleanup to A", async () => {
		const [orgA, orgB] = organizationIds;
		const b = createTenantPrismaClient(runtime, orgB);
		const cipher = new AesGcmCipher(randomBytes(32));
		const user = await admin.user.create({
			data: {
				email: `${randomUUID()}@reset.invalid`,
				displayName: "Shared identity",
				passwordHash: "test-password-hash",
				platformOwner: true,
			},
		});
		const setup = await admin.setupCode.create({
			data: {
				codeHash: randomUUID(),
				expiresAt: new Date(Date.now() + 60000),
			},
		});
		const settingKey = `reset-probe:${randomUUID()}`;
		await admin.platformSetting.create({
			data: { key: settingKey, value: { retained: true } },
		});
		globalFixture = { userId: user.id, setupCodeId: setup.id, settingKey };
		await admin.membership.createMany({
			data: organizationIds.map((organizationId) => ({
				organizationId,
				userId: user.id,
				role: "ADMIN",
			})),
		});
		const makeRows = async (client: AppPrismaClient, label: string) => {
			const accountId = randomUUID();
			const encryptedApiKey = await cipher.encrypt(
				`key-${label}`,
				`bitmovin-account:${accountId}`,
			);
			const account = await client.bitmovinAccount.create({
				data: { id: accountId, label, encryptedApiKey },
			});
			const job = await client.encodingJob.create({
				data: {
					name: label,
					plan: {},
					status: "RUNNING",
					bitmovinAccountId: account.id,
					bitmovinEncodingId: `encoding-${randomUUID()}`,
				},
			});
			await client.appSetting.upsert({
				where: { key: "probe.shared" },
				create: { key: "probe.shared", value: { label } },
				update: {},
			});
			await client.accessEvent.create({
				data: {
					userId: user.id,
					actor: `user:${user.id}`,
					userDisplayName: user.displayName,
					method: "GET",
					path: "/probe",
					statusCode: 200,
				},
			});
			await client.operationAttempt.create({
				data: {
					id: randomUUID(),
					operation: "LIVE_MOQ_PLAYBACK",
					ownerDigest: "a".repeat(64),
				},
			});
			return { account, job };
		};
		const aRows = await makeRows(prisma, "A");
		const bRows = await makeRows(b, "B");
		const result = await deleteSelectedData(prisma, RESET_CATEGORIES, cipher);
		expect(result.requiresSetup).toBe(false);
		expect(result.deletedCounts).toHaveLength(25);
		expect(await prisma.encodingJob.count()).toBe(0);
		expect(await prisma.bitmovinAccount.count()).toBe(0);
		expect(await prisma.appSetting.count()).toBe(0);
		expect(await prisma.accessEvent.count()).toBe(0);
		expect(await prisma.operationAttempt.count()).toBe(0);
		expect(
			await b.encodingJob.findUnique({ where: { id: bRows.job.id } }),
		).toMatchObject({ name: "B" });
		expect(await b.bitmovinAccount.count()).toBe(1);
		expect(
			await b.appSetting.findUnique({ where: { key: "probe.shared" } }),
		).toMatchObject({ value: { label: "B" } });
		expect(await b.accessEvent.count()).toBe(1);
		expect(await b.operationAttempt.count()).toBe(1);
		for (const model of RESET_GLOBAL_MODELS)
			expect(() => prisma[model]).toThrow();
		expect(
			await admin.user.findUnique({ where: { id: user.id } }),
		).not.toBeNull();
		expect(
			await admin.setupCode.findUnique({ where: { id: setup.id } }),
		).not.toBeNull();
		expect(
			await admin.organization.count({
				where: { id: { in: organizationIds } },
			}),
		).toBe(2);
		expect(await admin.membership.count({ where: { userId: user.id } })).toBe(
			2,
		);
		expect(
			await admin.platformSetting.findUnique({ where: { key: settingKey } }),
		).not.toBeNull();
		if (!result.cleanupTaskId) throw new Error("Missing durable cleanup");
		const receipt = await readResetCleanupTask(
			prisma,
			cipher,
			result.cleanupTaskId,
		);
		expect(receipt?.payload.organizationId).toBe(orgA);
		expect(receipt?.payload.accounts.map((account) => account.id)).toEqual([
			aRows.account.id,
		]);
		expect(
			receipt?.payload.encodings.map((encoding) => encoding.encodingId),
		).toEqual([aRows.job.bitmovinEncodingId]);
		expect(
			await readResetCleanupTask(b, cipher, result.cleanupTaskId),
		).toBeNull();
	});

	async function archiveFixture(
		db: AppPrismaClient,
		current: string | null,
		previous: string[],
		attempt = 1,
		archived = 1,
		tenantOrgId: string | null = null,
	) {
		const account = await db.bitmovinAccount.create({
			data: {
				label: "Fixture",
				tenantOrgId,
				encryptedApiKey: "fixture-only",
				updatedAt: new Date("2025-01-01T00:00:00Z"),
			},
		});
		const stepLog = [
			{
				step: "input",
				kind: "CREATE_INPUT_RTMP",
				refs: {},
				payload: {},
				status: "DONE",
				attempt,
			},
		];
		const channel = await db.liveChannel.create({
			data: {
				name: "RTMP archive",
				plan: { bitmovin: { accountId: account.id } },
				bitmovinAccountId: null,
				status: "ERROR",
				stepLog,
			},
		});
		const run = await db.liveChannelRun.create({
			data: {
				liveChannelId: channel.id,
				seq: 1,
				status: "ERROR",
				outputPrefix: "",
				bitmovinEncodingId: current,
				previousProviderEncodingIds: previous,
				archivedRtmpAttempt: archived,
				lastHeartbeatAt: new Date("2026-08-01T00:00:00Z"),
				stepLog,
			},
		});
		return { account, channel, run };
	}

	async function claimFixture(
		channelId: string,
		runId: string,
		primary: string,
		secondary: string[],
	) {
		return prisma.liveEffectClaim.create({
			data: {
				liveChannelId: channelId,
				liveChannelRunId: runId,
				providerEncodingId: primary,
				action: "STOP",
				state: "FAILED",
				idempotencyKey: randomUUID(),
				token: randomUUID(),
				ownerId: "test",
				expiresAt: new Date(),
				generation: 1,
				stopSendEncodingIds: secondary,
			},
		});
	}

	it("replays the same scheduled STOP after schedules-only reset removes completed rows", async () => {
		const { createScheduleSweep } = await import(
			"../../../../worker/src/scheduler/sweep"
		);
		const primary = randomUUID();
		const { channel, run } = await archiveFixture(prisma, primary, []);
		await prisma.liveChannel.update({
			where: { id: channel.id },
			data: {
				status: "STOPPING",
				bitmovinEncodingId: primary,
				liveEffectFenceVersion: 3,
			},
		});
		await prisma.liveChannelRun.update({
			where: { id: run.id },
			data: { status: "STOPPING" },
		});
		const firedAt = new Date("2025-01-01");
		const data = {
			liveChannelId: channel.id,
			liveChannelRunId: run.id,
			action: "STOP" as const,
			status: "FIRED" as const,
			fireAt: firedAt,
			firedAt,
			stopProviderEncodingId: primary,
			stopAdmissionFenceVersion: 3,
		};
		const open = await prisma.liveSchedule.create({ data });
		await prisma.liveSchedule.create({
			data: { ...data, outcome: "DELIVERED", dispatchedAt: firedAt },
		});
		const legacy = await prisma.liveSchedule.create({
			data: {
				...data,
				stopProviderEncodingId: null,
				stopAdmissionFenceVersion: null,
				outcome: "UNKNOWN",
			},
		});
		const starting = await prisma.liveChannel.create({
			data: { name: "Pending start", plan: {}, status: "PROVISIONING" },
		});
		const startup = await prisma.liveSchedule.create({
			data: {
				liveChannelId: starting.id,
				action: "START",
				status: "FIRED",
				fireAt: firedAt,
				dispatchedAt: firedAt,
				firedAt,
			},
		});
		expect(
			(await countResetCategories(prisma, new Set(["liveSchedules"]))).find(
				(entry) => entry.category === "liveSchedules",
			)?.count,
		).toBe(1);
		const enqueue = vi
			.fn()
			.mockRejectedValueOnce(new Error("queue receipt lost"))
			.mockResolvedValue(undefined);
		const sweep = createScheduleSweep({
			prisma,
			enqueue,
			now: () => new Date("2025-01-02"),
		});
		expect(await sweep.dispatchPending()).toBe(0);
		expect(await prisma.liveEffectClaim.count()).toBe(0);
		const result = await deleteSelectedData(
			prisma,
			["liveSchedules"],
			new AesGcmCipher(randomBytes(32)),
		);
		expect(result.counts.liveSchedule).toBe(1);
		expect(
			await prisma.liveSchedule.count({
				where: { id: { in: [startup.id, legacy.id] } },
			}),
		).toBe(2);
		expect(await sweep.dispatchPending()).toBe(1);
		expect(enqueue.mock.calls[1]).toEqual(enqueue.mock.calls[0]);
		expect(enqueue.mock.calls[1]?.[0]).toMatchObject({
			effect: {
				scheduleId: open.id,
				liveChannelRunId: run.id,
				providerEncodingId: primary,
				admissionFenceVersion: 3,
			},
		});
		expect(
			await prisma.liveSchedule.findUnique({ where: { id: open.id } }),
		).toMatchObject({ dispatchJobId: `sched-${open.id}` });
	});

	it("excludes a retained Live claim-only encoder from verification-only cleanup while transferring an unrelated encoder", async () => {
		const [primary, journal, unrelated] = [
			randomUUID(),
			randomUUID(),
			randomUUID(),
		];
		const { account, channel, run } = await archiveFixture(prisma, primary, []);
		await claimFixture(channel.id, run.id, primary, [journal]);
		const vr = await prisma.verificationRun.create({
			data: {
				runId: randomUUID(),
				reportPath: "fixture",
				bitmovinAccountId: account.id,
			},
		});
		await prisma.verificationResourceIntent.create({
			data: {
				verificationRunId: vr.id,
				kind: "LIVE_CHANNEL",
				scenario: "reset",
				verificationKey: randomUUID(),
				requestSha256: "0".repeat(64),
				providerIds: [journal, unrelated],
			},
		});
		const cipher = new AesGcmCipher(randomBytes(32));
		const result = await deleteSelectedData(
			prisma,
			["verificationHistory"],
			cipher,
		);
		if (!result.cleanupTaskId) throw new Error("Missing cleanup task");
		const receipt = await readResetCleanupTask(
			prisma,
			cipher,
			result.cleanupTaskId,
		);
		if (!receipt) throw new Error("Missing cleanup payload");
		expect(receipt?.payload.encodings.map((e) => e.encodingId)).toEqual([
			unrelated,
		]);
		expect(await prisma.liveEffectClaim.count()).toBe(1);
	});

	it("retains a Live primary after a lost START despite a CREATED response in full and selected reset", async () => {
		const primary = randomUUID();
		const { channel, run } = await archiveFixture(prisma, primary, []);
		const stepLog = [
			{
				step: "encoding",
				kind: "CREATE_ENCODING",
				refs: {},
				payload: {},
				status: "DONE",
				resourceId: primary,
			},
			{
				step: "start",
				kind: "START_LIVE_ENCODING",
				refs: {},
				payload: {},
				status: "FAILED",
				startedAt: new Date().toISOString(),
				error: "network",
			},
		];
		await prisma.liveChannel.update({
			where: { id: channel.id },
			data: { bitmovinEncodingId: primary, stepLog },
		});
		await prisma.liveChannelRun.update({
			where: { id: run.id },
			data: { stepLog },
		});
		const result = await reconcileEncoderPointers(prisma, async () => ({
			kind: "stopped",
			providerStatus: "CREATED",
		}));
		expect(result.confirmed).toHaveLength(0);
		await prisma.liveChannel.update({
			where: { id: channel.id },
			data: { encoderStoppedConfirmedFor: primary },
		});
		await prisma.liveChannelRun.update({
			where: { id: run.id },
			data: { encoderStoppedConfirmedFor: primary },
		});
		expect(new Set(result.unverified.map((p) => p.bitmovinEncodingId))).toEqual(
			new Set([primary]),
		);
		await expect(deleteOperationalData(prisma)).rejects.toThrow();
		const cipher = new AesGcmCipher(randomBytes(32));
		const selected = await deleteSelectedData(
			prisma,
			requiredResetCategories(["liveChannels"]),
			cipher,
		);
		if (!selected.cleanupTaskId) throw new Error("Missing cleanup task");
		const task = await readResetCleanupTask(
			prisma,
			cipher,
			selected.cleanupTaskId,
		);
		if (!task) throw new Error("Missing cleanup payload");
		const { cleanResetPayload } = await import(
			"../../../../worker/src/reset/cleanup"
		);
		const provider = {
			status: vi.fn().mockResolvedValue("CREATED"),
			stop: vi.fn(),
			releaseTemporaryKeys: vi.fn(),
			removeWebhook: vi.fn(),
		};
		expect(
			(await cleanResetPayload(task.payload, async () => provider)).encodings
				.size,
		).toBe(0);
		expect(provider.releaseTemporaryKeys).not.toHaveBeenCalled();
		provider.status
			.mockResolvedValueOnce("RUNNING")
			.mockResolvedValue("FINISHED");
		expect(
			(await cleanResetPayload(task.payload, async () => provider)).encodings
				.size,
		).toBe(1);
		expect(provider.stop.mock.calls.map(([id]) => id)).toEqual([primary]);
	});

	it("confirms an orphaned STOP claim on its surviving channel and retains the exact deletion receipt", async () => {
		const primary = randomUUID(),
			other = randomUUID();
		const { channel, account } = await archiveFixture(prisma, null, []);
		const claim = await claimFixture(channel.id, randomUUID(), primary, [
			other,
		]);
		expect(isIdle(await findActiveWork(prisma))).toBe(false);
		const blocked = await reconcileEncoderPointers(prisma, async () => ({
			kind: "stopped",
			providerStatus: "CREATED",
		}));
		expect(blocked.unverified).toHaveLength(2);
		const result = await reconcileEncoderPointers(
			prisma,
			async (id, encoding) => {
				expect(id).toBe(account.id);
				expect([primary, other]).toContain(encoding);
				return { kind: "stopped", providerStatus: "FINISHED" };
			},
		);
		expect(result.confirmed.map((p) => p.bitmovinEncodingId).sort()).toEqual(
			[primary, other].sort(),
		);
		expect(
			await prisma.liveEffectClaim.findUnique({ where: { id: claim.id } }),
		).toMatchObject({ state: "FAILED" });
		expect(isIdle(await findActiveWork(prisma))).toBe(true);
		const deleted = await deleteOperationalData(prisma);
		expect(
			deleted.encoders.pointers.map((p) => p.bitmovinEncodingId).sort(),
		).toEqual([primary, other].sort());
	});

	async function selectedPreview(categories: string[]) {
		const context = await import("./context");
		const hook = vi
			.spyOn(context, "getServerContext")
			.mockResolvedValue({ prisma } as import("./context").ServerContext);
		try {
			const { GET } = await import("../../app/api/admin/reset/route");
			const result = await GET(
				new Request(
					`http://test/api/admin/reset?categories=${categories.join(",")}`,
					{ headers: { "x-bitovp-actor": "session" } },
				),
			);
			expect(result.status).toBe(200);
			return await result.json();
		} finally {
			hook.mockRestore();
		}
	}

	it("retains a closed SCTE-35 effect as the last encoder identity until its own terminal read", async () => {
		const primary = randomUUID(),
			second = randomUUID();
		const { channel, run } = await archiveFixture(prisma, primary, []);
		const claim = await claimFixture(channel.id, run.id, second, []);
		await prisma.liveEffectClaim.update({
			where: { id: claim.id },
			data: { action: "SCTE35", state: "ACKED" },
		});
		const result = await reconcileEncoderPointers(prisma, async (_acct, id) =>
			id === primary
				? { kind: "stopped", providerStatus: "FINISHED" }
				: { kind: "running", providerStatus: "RUNNING" },
		);
		expect(result.running.map((p) => p.bitmovinEncodingId)).toEqual([second]);
		await expect(deleteOperationalData(prisma)).rejects.toThrow();
		const cipher = new AesGcmCipher(randomBytes(32));
		const selected = await deleteSelectedData(
			prisma,
			requiredResetCategories(["liveChannels"]),
			cipher,
		);
		if (!selected.cleanupTaskId) throw new Error("Missing cleanup task");
		const task = await readResetCleanupTask(
			prisma,
			cipher,
			selected.cleanupTaskId,
		);
		if (!task) throw new Error("Missing cleanup payload");
		expect(
			task?.payload.encodings.some(
				(e) => e.encodingId === second && e.requireTerminal,
			),
		).toBe(true);
	});

	it("retains the host and PID of an unconfirmed publisher during feeds-only reset", async () => {
		const { channel, run } = await archiveFixture(prisma, null, []);
		const feeder = await prisma.feederSession.create({
			data: {
				liveChannelId: channel.id,
				liveChannelRunId: run.id,
				sourceCredentialId: randomUUID(),
				sourceBucket: "test",
				sourceKey: "fixtures/intro.mp4",
				protocol: "RTMP",
				target: {},
				status: "ERROR",
				pid: 21346,
				ownerHost: "owned-fixture",
			},
		});
		const preview = await selectedPreview(["pseudoLiveFeeds"]);
		expect(preview.selectionBlocked).toBe(true);
		expect(preview.active.pseudoLiveFeeds).toMatchObject([
			{ href: `/live/feeders/${feeder.id}`, sourceName: "intro.mp4" },
		]);
		const cipher = new AesGcmCipher(randomBytes(32));
		await expect(
			deleteSelectedData(prisma, ["pseudoLiveFeeds"], cipher),
		).rejects.toThrow(/publisher/i);
		expect(
			await prisma.feederSession.findUnique({ where: { id: feeder.id } }),
		).toMatchObject({ pid: 21346, ownerHost: "owned-fixture" });
		await prisma.feederSession.update({
			where: { id: feeder.id },
			data: { processGoneAt: new Date(), pid: null },
		});
		expect((await selectedPreview(["pseudoLiveFeeds"])).selectionBlocked).toBe(
			false,
		);
		expect(
			(await deleteSelectedData(prisma, ["pseudoLiveFeeds"], cipher)).counts
				.feederSession,
		).toBe(1);
	});

	it("previews and preserves a dispatched Analysis with no plan marker and no provider ID", async () => {
		const { channel, run } = await archiveFixture(prisma, null, []);
		const log = [
			{
				step: "analysis",
				kind: "CREATE_AISA_LIVE_ANALYSIS",
				payload: {},
				refs: {},
				status: "RUNNING",
				response: { aisaCreateDispatched: true },
			},
		];
		await prisma.liveChannelRun.update({
			where: { id: run.id },
			data: { stepLog: log },
		});
		const selected = requiredResetCategories(["liveChannels"]);
		const preview = await selectedPreview(selected);
		expect(preview).toMatchObject({
			blocked: true,
			selectionBlocked: true,
			active: {
				liveChannels: [{ name: channel.name, href: `/live/${channel.id}` }],
				totals: { liveChannels: 1 },
			},
		});
		expect((await selectedPreview(["liveSchedules"])).selectionBlocked).toBe(
			false,
		);
		await expect(
			deleteSelectedData(prisma, selected, new AesGcmCipher(randomBytes(32))),
		).rejects.toThrow(/Analysis/);
		await expect(deleteOperationalData(prisma)).rejects.toThrow(/Analysis/);
		expect(
			await prisma.liveChannelRun.findUnique({ where: { id: run.id } }),
		).toMatchObject({ stepLog: log });
	});

	it("accepts CREATED for an exact Live encoding with a matching generation and untouched START step", async () => {
		const primary = randomUUID();
		const { channel, run } = await archiveFixture(prisma, primary, []);
		const log = [
			{
				step: "encoding",
				kind: "CREATE_ENCODING",
				refs: {},
				payload: {},
				resourceId: primary,
				status: "DONE",
				attempt: 1,
			},
			{
				step: "start",
				kind: "START_LIVE_ENCODING",
				refs: { encodingId: "encoding" },
				payload: {},
				status: "PENDING",
				attempt: 1,
			},
		];
		await prisma.liveChannel.update({
			where: { id: channel.id },
			data: { bitmovinEncodingId: primary, stepLog: log },
		});
		await prisma.liveChannelRun.update({
			where: { id: run.id },
			data: { stepLog: log },
		});
		const result = await reconcileEncoderPointers(prisma, async () => ({
			kind: "stopped",
			providerStatus: "CREATED",
		}));
		expect(result.confirmed).toHaveLength(2);
		expect(result.unverified).toEqual([]);
		const cipher = new AesGcmCipher(randomBytes(32));
		const selected = await deleteSelectedData(
			prisma,
			requiredResetCategories(["liveChannels"]),
			cipher,
		);
		if (!selected.cleanupTaskId) throw new Error("Missing cleanup task");
		const task = await readResetCleanupTask(
			prisma,
			cipher,
			selected.cleanupTaskId,
		);
		if (!task) throw new Error("Missing cleanup payload");
		expect(task?.payload.encodings.every((e) => e.allowCreated)).toBe(true);
	});

	it("rechecks old encrypted verification cleanup tasks before issuing any provider STOP", async () => {
		const primary = randomUUID(),
			retained = randomUUID(),
			other = randomUUID();
		const { channel, account, run } = await archiveFixture(prisma, primary, []);
		await claimFixture(channel.id, run.id, primary, [retained]);
		const cipher = new AesGcmCipher(randomBytes(32));
		const id = await createResetCleanupTask(prisma, cipher, {
			v: 1,
			accounts: [
				{ id: account.id, encryptedApiKey: "fixture", tenantOrgId: null },
			],
			encodings: [retained, other].map((encodingId) => ({
				entityKey: "liveChannel:verification-intent:old",
				accountId: account.id,
				encodingId,
			})),
			verificationIntents: [
				{ state: "AMBIGUOUS", providerIds: [retained, other] },
			],
			webhooks: [],
			pendingEntities: [],
		});
		const { createResetCleanupSweep } = await import(
			"../../../../worker/src/reset/cleanup"
		);
		const provider = {
			status: vi
				.fn()
				.mockResolvedValueOnce("RUNNING")
				.mockResolvedValue("FINISHED"),
			stop: vi.fn(),
			releaseTemporaryKeys: vi.fn(),
			removeWebhook: vi.fn(),
		};
		await createResetCleanupSweep({
			prisma,
			cipher,
			providerFor: async () => provider,
		})();
		expect(provider.status.mock.calls.map(([id]) => id)).toEqual([
			other,
			other,
		]);
		expect(provider.stop.mock.calls.map(([id]) => id)).toEqual([other]);
		const remaining = await readResetCleanupTask(prisma, cipher, id);
		expect(remaining?.payload.encodings).toEqual([]);
		expect(remaining?.payload.verificationIntents).toHaveLength(1);
	});

	it("rejects a terminal orphan read when its recorded Bitmovin credential changes before commit", async () => {
		const id = randomUUID();
		const { account, channel } = await archiveFixture(prisma, null, []);
		await claimFixture(channel.id, randomUUID(), id, []);
		const previous = {
			id: account.id,
			updatedAt: account.updatedAt,
			tenantOrgId: account.tenantOrgId,
			encryptedApiKey: "fixture-only",
		};
		const report = await reconcileEncoderPointers(prisma, async () => {
			await prisma.bitmovinAccount.update({
				where: { id: account.id },
				data: { encryptedApiKey: "replacement-fixture" },
			});
			return { kind: "stopped", providerStatus: "FINISHED", account: previous };
		});
		expect(report.unverified.map((p) => p.bitmovinEncodingId)).toEqual([id]);
		expect(isIdle(await findActiveWork(prisma))).toBe(false);
	});
	it("keeps an ordinary STOP claim when only Live schedules are cleared", async () => {
		const primary = randomUUID();
		const { channel, run } = await archiveFixture(prisma, primary, []);
		const claim = await claimFixture(channel.id, run.id, primary, []);
		await deleteSelectedData(
			prisma,
			["liveSchedules"],
			new AesGcmCipher(randomBytes(32)),
		);
		expect(
			await prisma.liveEffectClaim.findUnique({ where: { id: claim.id } }),
		).not.toBeNull();
	});

	it("preserves an active persisted Analysis on selected and full reset until its final result is captured", async () => {
		const { channel, run } = await archiveFixture(prisma, null, []);
		await prisma.liveChannelRun.update({
			where: { id: run.id },
			data: { aisaAnalysisId: randomUUID(), aisaStatus: "RUNNING" },
		});
		await expect(
			deleteSelectedData(
				prisma,
				requiredResetCategories(["liveChannels"]),
				new AesGcmCipher(randomBytes(32)),
			),
		).rejects.toThrow(/Analysis/i);
		await expect(deleteOperationalData(prisma)).rejects.toThrow(
			/Analysis|work started/i,
		);
		expect(
			await prisma.liveChannel.findUnique({ where: { id: channel.id } }),
		).not.toBeNull();
	});

	it("checks the plan-only primary and both log-only and journal-only secondary encoders before full reset", async () => {
		const [primary, logged, journal] = [
			randomUUID(),
			randomUUID(),
			randomUUID(),
		];
		const { channel, run, account } = await archiveFixture(prisma, primary, []);
		const create = {
			step: "encoding",
			kind: "CREATE_ENCODING",
			status: "DONE",
			refs: {},
			payload: {},
			resourceId: logged,
		};
		await prisma.liveChannelRun.update({
			where: { id: run.id },
			data: { stepLog: [create] },
		});
		await prisma.liveChannel.update({
			where: { id: channel.id },
			data: { bitmovinEncodingId: primary },
		});
		await claimFixture(channel.id, run.id, primary, [journal]);
		const report = await reconcileEncoderPointers(prisma, async (ac, id) => {
			expect(ac).toBe(account.id);
			return id === primary
				? { kind: "stopped", providerStatus: "FINISHED" }
				: { kind: "running", providerStatus: "RUNNING" };
		});
		expect(report.confirmed.map((p) => p.bitmovinEncodingId)).toEqual([
			primary,
			primary,
		]);
		expect(report.running.map((p) => p.bitmovinEncodingId).sort()).toEqual(
			[logged, journal].sort(),
		);
		await expect(deleteOperationalData(prisma)).rejects.toThrow();
		await reconcileEncoderPointers(prisma, async () => ({
			kind: "stopped",
			providerStatus: "FINISHED",
		}));
		const outcome = await deleteOperationalData(prisma);
		expect(
			new Set(outcome.encoders.pointers.map((p) => p.bitmovinEncodingId)),
		).toEqual(new Set([primary, logged, journal]));
	});

	it("checks the exact account version under lock before recording missing plan-only encoder pointers", async () => {
		const encodingId = randomUUID();
		const { channel, run, account } = await archiveFixture(
			prisma,
			encodingId,
			[],
		);
		await prisma.liveChannel.update({
			where: { id: channel.id },
			data: { bitmovinEncodingId: encodingId },
		});
		const version = {
			id: account.id,
			updatedAt: account.updatedAt,
			encryptedApiKey: "fixture-only",
			tenantOrgId: null,
		};
		const changed = await reconcileEncoderPointers(prisma, async () => {
			await prisma.bitmovinAccount.update({
				where: { id: account.id },
				data: {
					encryptedApiKey: "new-key",
					updatedAt: new Date(channel.createdAt.getTime() + 60000),
				},
			});
			return { kind: "missing", account: version };
		});
		expect(changed.confirmed).toHaveLength(0);
		expect(changed.unverified).toHaveLength(2);
		expect(
			await prisma.liveChannelRun.findUnique({
				where: { id: run.id },
				select: { encoderStoppedConfirmedFor: true },
			}),
		).toEqual({ encoderStoppedConfirmedFor: null });
		const positive = await reconcileEncoderPointers(prisma, async () => ({
			kind: "stopped",
			providerStatus: "FINISHED",
		}));
		expect(positive.confirmed).toHaveLength(2);
	});
	it("keeps archive-only encoders for bulk reset until an exact terminal read and returns the archived identity in the deletion receipt", async () => {
		const old = randomUUID();
		const foreign = randomUUID();
		const own = await archiveFixture(prisma, null, [old]);
		const b = createTenantPrismaClient(runtime, organizationIds[1]);
		await archiveFixture(b, null, [foreign]);
		const active = await findActiveWork(prisma);
		expect(active.totals.unstoppedEncoders).toBe(1);
		expect(active.unstoppedEncoders.map((p) => p.bitmovinEncodingId)).toEqual([
			old,
		]);
		await expect(deleteOperationalData(prisma)).rejects.toThrow();
		expect(
			(
				await reconcileEncoderPointers(prisma, async (account, id) => {
					expect([account, id]).toEqual([own.account.id, old]);
					return { kind: "running", providerStatus: "RUNNING" };
				})
			).running,
		).toHaveLength(1);
		expect(
			(
				await reconcileEncoderPointers(prisma, async () => ({
					kind: "stopped",
					providerStatus: "CREATED",
				}))
			).unverified,
		).toHaveLength(1);
		expect(
			(
				await reconcileEncoderPointers(prisma, async () => ({
					kind: "stopped",
					providerStatus: "FINISHED",
				}))
			).confirmed,
		).toHaveLength(1);
		expect(isIdle(await findActiveWork(prisma))).toBe(true);
		expect(
			await prisma.liveChannelRun.findUniqueOrThrow({
				where: { id: own.run.id },
				select: { lastHeartbeatAt: true },
			}),
		).toEqual({ lastHeartbeatAt: own.run.lastHeartbeatAt });
		const result = await deleteOperationalData(prisma);
		expect(result.encoders.pointers.map((p) => p.bitmovinEncodingId)).toEqual([
			old,
		]);
		expect(
			(await findActiveWork(b)).unstoppedEncoders.map(
				(p) => p.bitmovinEncodingId,
			),
		).toEqual([foreign]);
	});

	it("moves every known RTMP identity into tenant-bound selected cleanup before deleting a run", async () => {
		const old = randomUUID(),
			fresh = randomUUID();
		const { account, run } = await archiveFixture(prisma, fresh, [old, old]);
		const cipher = new AesGcmCipher(randomBytes(32));
		const result = await deleteSelectedData(
			prisma,
			requiredResetCategories(["liveChannels"]),
			cipher,
		);
		expect(result.encoders.providerIdentityTotal).toBe(2);
		expect(
			result.encoders.pointers.map((p) => p.bitmovinEncodingId).sort(),
		).toEqual([old, fresh].sort());
		expect(
			await prisma.liveChannelRun.findUnique({ where: { id: run.id } }),
		).toBeNull();
		if (!result.cleanupTaskId) throw new Error("Missing cleanup task");
		const task = await readResetCleanupTask(
			prisma,
			cipher,
			result.cleanupTaskId,
		);
		expect(task?.payload.encodings).toEqual(
			expect.arrayContaining([
				{
					entityKey: `liveChannelRun:${run.id}`,
					accountId: account.id,
					encodingId: old,
					allowVerifiedMissing: true,
					requireTerminal: true,
				},
				{
					entityKey: `liveChannelRun:${run.id}`,
					accountId: account.id,
					encodingId: fresh,
					allowVerifiedMissing: true,
				},
			]),
		);
		expect(task?.payload.encodings).toHaveLength(2);
	});

	it("retains the rotated selected account and journal-only encoder for cleanup without treating its missing response as terminal", async () => {
		const [primary, secondary] = [randomUUID(), randomUUID()];
		const { account, run, channel } = await archiveFixture(prisma, primary, []);
		await claimFixture(channel.id, run.id, primary, [secondary]);
		await prisma.bitmovinAccount.update({
			where: { id: account.id },
			data: {
				encryptedApiKey: "different-scope",
				updatedAt: new Date(channel.createdAt.getTime() + 60000),
			},
		});
		const cipher = new AesGcmCipher(randomBytes(32));
		const result = await deleteSelectedData(
			prisma,
			requiredResetCategories(["liveChannels"]),
			cipher,
		);
		expect(result.encoders.providerIdentityTotal).toBe(2);
		if (!result.cleanupTaskId) throw new Error("Missing cleanup task");
		const task = await readResetCleanupTask(
			prisma,
			cipher,
			result.cleanupTaskId,
		);
		expect(task?.payload.accounts).toEqual([
			{ id: account.id, encryptedApiKey: "different-scope", tenantOrgId: null },
		]);
		expect(task?.payload.encodings).toEqual(
			expect.arrayContaining([
				{
					entityKey: `liveChannelRun:${run.id}`,
					accountId: account.id,
					encodingId: primary,
				},
				{
					entityKey: `liveChannelRun:${run.id}`,
					accountId: account.id,
					encodingId: secondary,
					requireTerminal: true,
				},
			]),
		);
	});

	it("keeps the legacy Analysis route private across tenants and deletes only after finalization by its preview owner", async () => {
		const context = await import("./context");
		const { DELETE } = await import("../../app/api/live-channels/[id]/route");
		const hook = vi.spyOn(context, "getServerContext");
		const owner = randomUUID(),
			analysisId = randomUUID(),
			encodingId = randomUUID();
		const { channel, run } = await archiveFixture(prisma, encodingId, []);
		const b = createTenantPrismaClient(runtime, organizationIds[1]);
		await prisma.liveChannel.update({
			where: { id: channel.id },
			data: { bitmovinEncodingId: encodingId },
		});
		await prisma.liveChannelRun.update({
			where: { id: run.id },
			data: { aisaAnalysisId: analysisId, aisaStatus: "RUNNING" },
		});
		const request = async (
			client: AppPrismaClient,
			user: string,
			role: "ADMIN" | "VIEWER",
		) => {
			hook.mockResolvedValue({
				prisma: client,
				tenant: {
					actor: `user:${user}`,
					actorUserId: user,
					effectiveUserId: user,
					role,
					actorRole: role,
					isImpersonating: false,
				},
			} as import("./context").ServerContext);
			return DELETE(
				new Request(`http://test/api/live-channels/${channel.id}`, {
					method: "DELETE",
				}),
				{ params: Promise.resolve({ id: channel.id }) },
			);
		};
		vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "true");
		vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW_USER_ID", owner);
		try {
			expect((await request(b, owner, "ADMIN")).status).toBe(404);
			expect((await request(prisma, randomUUID(), "ADMIN")).status).toBe(404);
			expect((await request(prisma, owner, "VIEWER")).status).toBe(404);
			expect((await request(prisma, owner, "ADMIN")).status).toBe(409);
			expect(await prisma.liveChannelRun.count({ where: { id: run.id } })).toBe(
				1,
			);
			await prisma.liveChannelRun.update({
				where: { id: run.id },
				data: {
					providerStatus: "ERROR",
					aisaStatus: "ERROR",
					aisaFinalization: {
						analysisId,
						encodingId,
						status: "ERROR",
						result: "UNAVAILABLE_TERMINAL_FAILURE",
						observedAt: new Date().toISOString(),
					},
				},
			});
			expect((await request(prisma, owner, "ADMIN")).status).toBe(200);
			expect(await prisma.liveChannelRun.count({ where: { id: run.id } })).toBe(
				0,
			);
		} finally {
			hook.mockRestore();
			vi.unstubAllEnvs();
		}
	});
	it("retains a claim whose logical run is gone and can transfer its exact encoder to selected cleanup", async () => {
		const primary = randomUUID(),
			secondary = randomUUID();
		const { channel, run, account } = await archiveFixture(prisma, null, []);
		await claimFixture(channel.id, randomUUID(), primary, [secondary]);
		await prisma.liveChannelRun.delete({ where: { id: run.id } });
		await prisma.liveChannel.update({
			where: { id: channel.id },
			data: { stepLog: [] },
		});
		await expect(deleteOperationalData(prisma)).rejects.toThrow();
		const cipher = new AesGcmCipher(randomBytes(32));
		const r = await deleteSelectedData(
			prisma,
			requiredResetCategories(["liveChannels"]),
			cipher,
		);
		if (!r.cleanupTaskId) throw new Error("Missing cleanup task");
		const task = await readResetCleanupTask(prisma, cipher, r.cleanupTaskId);
		expect(
			task?.payload.encodings
				.map((e) => [e.entityKey, e.accountId, e.encodingId])
				.sort(),
		).toEqual(
			[primary, secondary]
				.map((id) => [`liveChannel:${channel.id}`, account.id, id])
				.sort(),
		);
	});

	it("preserves the run and provider account when a legacy RTMP rebuild lost an unknown encoder identity", async () => {
		const { channel, run } = await archiveFixture(prisma, null, [], 1, 0);
		expect(
			(await findActiveWork(prisma)).liveChannels.map((c) => c.id),
		).toEqual([channel.id]);
		await expect(deleteOperationalData(prisma)).rejects.toThrow();
		await expect(
			deleteSelectedData(
				prisma,
				requiredResetCategories(["liveChannels"]),
				new AesGcmCipher(randomBytes(32)),
			),
		).rejects.toThrow(/missing encoder identities/);
		expect(
			await prisma.liveChannelRun.findUnique({ where: { id: run.id } }),
		).not.toBeNull();
		expect(await prisma.resetCleanupTask.count()).toBe(0);
	});
	afterAll(async () => {
		await admin.$disconnect();
		await runtime.$disconnect();
	});

	async function channelRequest(id: string, method: "GET" | "DELETE") {
		const context = await import("./context");
		const hook = vi
			.spyOn(context, "getServerContext")
			.mockResolvedValue({ prisma } as import("./context").ServerContext);
		try {
			const api = await import("../../app/api/live-channels/[id]/route");
			return await api[method](
				new Request(`http://test/api/live-channels/${id}`, {
					method,
					headers: {
						"x-bitovp-actor": "user:viewer",
						"x-bitovp-role": "VIEWER",
					},
				}),
				{ params: Promise.resolve({ id }) },
			);
		} finally {
			hook.mockRestore();
		}
	}
	it("channel DELETE retains a terminal publisher's host and PID until the exact process exits", async () => {
		const { channel } = await archiveFixture(prisma, null, []);
		const feeder = await prisma.feederSession.create({
			data: {
				liveChannelId: channel.id,
				sourceCredentialId: randomUUID(),
				sourceBucket: "fixture",
				sourceKey: "input",
				protocol: "RTMP",
				target: {},
				status: "ERROR",
				pid: 23232,
				ownerHost: "local-fixture",
			},
		});
		expect((await channelRequest(channel.id, "DELETE")).status).toBe(409);
		expect(
			await prisma.feederSession.findUnique({ where: { id: feeder.id } }),
		).toMatchObject({ pid: 23232, ownerHost: "local-fixture" });
		await prisma.feederSession.update({
			where: { id: feeder.id },
			data: { processGoneAt: new Date(), pid: null },
		});
		expect((await channelRequest(channel.id, "DELETE")).status).toBe(200);
	});
	it("ordinary channel GET conceals the admin's reconciled orphan account, encoder and receipt", async () => {
		const { account, channel } = await archiveFixture(prisma, null, []);
		const encoder = randomUUID();
		await claimFixture(channel.id, randomUUID(), encoder, []);
		await reconcileEncoderPointers(prisma, async () => ({
			kind: "stopped",
			providerStatus: "FINISHED",
		}));
		const saved = await prisma.liveChannel.findUniqueOrThrow({
			where: { id: channel.id },
		});
		expect(JSON.stringify(saved.resetOrphanEncoderEvidence)).toContain(encoder);
		const response = await channelRequest(channel.id, "GET");
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).not.toHaveProperty("resetOrphanEncoderEvidence");
		expect(JSON.stringify(body)).not.toContain(encoder);
		expect(saved.bitmovinAccountId).toBeNull();
		expect(account.id).toBeTruthy();
	});
	it("rejects archived NEVER_STARTED superseded by RESTART during reset and DELETE", async () => {
		const encoder = randomUUID();
		const { channel, run, account } = await archiveFixture(prisma, null, [
			encoder,
		]);
		await prisma.liveChannelRun.update({
			where: { id: run.id },
			data: {
				rtmpRetirementEvidence: [
					{
						accountId: account.id,
						encodingId: encoder,
						disposition: "NEVER_STARTED",
						providerStatus: "CREATED",
						observedAt: new Date(0).toISOString(),
					},
				],
			},
		});
		const claim = await claimFixture(channel.id, run.id, encoder, []);
		await prisma.liveEffectClaim.update({
			where: { id: claim.id },
			data: { action: "RESTART", state: "ACKED" },
		});
		expect(isIdle(await findActiveWork(prisma))).toBe(false);
		expect((await channelRequest(channel.id, "DELETE")).status).toBe(409);
		await expect(deleteOperationalData(prisma)).rejects.toThrow();
		await reconcileEncoderPointers(prisma, async () => ({
			kind: "stopped",
			providerStatus: "FINISHED",
		}));
		expect((await channelRequest(channel.id, "DELETE")).status).toBe(200);
	});
	it("rejects pre-upgrade CREATED stamps after START returned DONE on a failed airing", async () => {
		const id = randomUUID();
		const { channel, run } = await archiveFixture(prisma, id, []);
		const log = [
			{
				kind: "CREATE_ENCODING",
				step: "enc",
				refs: {},
				payload: {},
				status: "DONE",
				resourceId: id,
			},
			{
				kind: "START_LIVE_ENCODING",
				step: "start",
				refs: { encodingId: "enc" },
				payload: {},
				status: "DONE",
				response: { accepted: true },
			},
		];
		await prisma.liveChannel.update({
			where: { id: channel.id },
			data: {
				stepLog: log,
				bitmovinEncodingId: id,
				encoderStoppedConfirmedFor: id,
			},
		});
		await prisma.liveChannelRun.update({
			where: { id: run.id },
			data: { stepLog: log, encoderStoppedConfirmedFor: id },
		});
		const blocked = await reconcileEncoderPointers(prisma, async () => ({
			kind: "stopped",
			providerStatus: "CREATED",
		}));
		expect(blocked.unverified.map((x) => x.bitmovinEncodingId)).toContain(id);
		expect((await channelRequest(channel.id, "DELETE")).status).toBe(409);
		await expect(deleteOperationalData(prisma)).rejects.toThrow();
		await reconcileEncoderPointers(prisma, async () => ({
			kind: "stopped",
			providerStatus: "FINISHED",
		}));
		expect((await channelRequest(channel.id, "DELETE")).status).toBe(200);
	});
	it("rechecks verification cleanup deferred by an incomplete retained archive and cleans the unrelated encoder after repair", async () => {
		const adopted = randomUUID();
		const safe = randomUUID(),
			retained = randomUUID();
		const { account, channel, run } = await archiveFixture(
			prisma,
			null,
			[],
			1,
			0,
		);
		const verification = await prisma.verificationRun.create({
			data: {
				runId: randomUUID(),
				reportPath: "fixture",
				bitmovinAccountId: account.id,
			},
		});
		await prisma.verificationResourceIntent.create({
			data: {
				verificationRunId: verification.id,
				kind: "LIVE_CHANNEL",
				scenario: "intent",
				verificationKey: randomUUID(),
				requestSha256: "0".repeat(64),
				providerIds: [retained, safe, adopted],
			},
		});
		const cipher = new AesGcmCipher(randomBytes(32));
		const result = await deleteSelectedData(
			prisma,
			["verificationHistory"],
			cipher,
		);
		if (!result.cleanupTaskId) throw new Error("Missing cleanup receipt");
		const provider = {
			status: vi
				.fn()
				.mockResolvedValueOnce("RUNNING")
				.mockResolvedValue("FINISHED"),
			stop: vi.fn(),
			releaseTemporaryKeys: vi.fn(),
			removeWebhook: vi.fn(),
		};
		const { createResetCleanupSweep } = await import(
			"../../../../worker/src/reset/cleanup"
		);
		const sweep = createResetCleanupSweep({
			prisma,
			cipher,
			providerFor: async () => provider,
		});
		await sweep();
		expect(provider.status).not.toHaveBeenCalled();
		await prisma.encodingJob.create({
			data: {
				name: "Existing job took ownership",
				plan: {},
				status: "RUNNING",
				bitmovinAccountId: account.id,
				bitmovinEncodingId: adopted,
			},
		});
		await prisma.liveChannelRun.update({
			where: { id: run.id },
			data: { previousProviderEncodingIds: [retained], archivedRtmpAttempt: 1 },
		});
		await prisma.resetCleanupTask.update({
			where: { id: result.cleanupTaskId },
			data: { nextAttemptAt: new Date(0) },
		});
		await sweep();
		expect(provider.stop.mock.calls.map(([id]) => id)).toEqual([safe]);
		expect(provider.status.mock.calls).toEqual([[safe], [safe]]);
		expect(await prisma.liveChannel.count({ where: { id: channel.id } })).toBe(
			1,
		);
	});
	it("rebuilds an old encrypted verification task's missing worklist without stopping newly attributable encoders", async () => {
		const owned = randomUUID(),
			unrelated = randomUUID();
		const { account, run } = await archiveFixture(prisma, null, [], 1, 0);
		const cipher = new AesGcmCipher(randomBytes(32));
		const id = await createResetCleanupTask(prisma, cipher, {
			v: 1,
			encodings: [],
			accounts: [
				{ id: account.id, encryptedApiKey: "fixture", tenantOrgId: null },
			],
			pendingEntities: [],
			webhooks: [],
			verificationIntents: [
				{
					id: randomUUID(),
					verificationKey: randomUUID(),
					kind: "LIVE_CHANNEL",
					state: "AMBIGUOUS",
					providerIds: [owned, unrelated],
					verificationRun: { bitmovinAccountId: account.id },
				},
			],
		});
		const provider = {
			status: vi
				.fn()
				.mockResolvedValueOnce("RUNNING")
				.mockResolvedValue("FINISHED"),
			stop: vi.fn(),
			releaseTemporaryKeys: vi.fn(),
			removeWebhook: vi.fn(),
		};
		const { createResetCleanupSweep } = await import(
			"../../../../worker/src/reset/cleanup"
		);
		const sweep = createResetCleanupSweep({
			prisma,
			cipher,
			providerFor: async () => provider,
		});
		await sweep();
		expect(provider.status).not.toHaveBeenCalled();
		const old = await readResetCleanupTask(prisma, cipher, id);
		expect(old?.payload.encodings.map((e) => e.encodingId).sort()).toEqual(
			[owned, unrelated].sort(),
		);
		await prisma.liveChannelRun.update({
			where: { id: run.id },
			data: { archivedRtmpAttempt: 1, previousProviderEncodingIds: [owned] },
		});
		await prisma.resetCleanupTask.update({
			where: { id },
			data: { nextAttemptAt: new Date(0) },
		});
		await sweep();
		expect(provider.stop.mock.calls.map(([id]) => id)).toEqual([unrelated]);
		await prisma.resetCleanupTask.update({
			where: { id },
			data: { nextAttemptAt: new Date(0) },
		});
		await sweep();
		expect(provider.status.mock.calls).toEqual([[unrelated], [unrelated]]);
	});
	it.each([
		false,
		true,
	])("passes exact bound AISA never-started proof into cleanup with verification history %s", async (combined) => {
		const id = randomUUID(),
			analysis = randomUUID();
		const { channel, run, account } = await archiveFixture(prisma, id, []);
		const log = [
			"CREATE_AISA_LIVE_ANALYSIS",
			"RESOLVE_AISA_LIVE_ENCODING",
			"START_AISA_LIVE_ANALYSIS",
			"AWAIT_LIVE_RUNNING",
		].map((kind, i) => ({
			kind,
			step: String(i),
			payload: {},
			refs: {},
			status: i < 2 ? "DONE" : "PENDING",
			...(i === 0
				? { resourceId: analysis }
				: i === 1
					? { resourceId: id }
					: {}),
		}));
		await prisma.liveChannel.update({
			where: { id: channel.id },
			data: {
				stepLog: log,
				bitmovinEncodingId: id,
				encoderStoppedConfirmedFor: id,
			},
		});
		await prisma.liveChannelRun.update({
			where: { id: run.id },
			data: {
				stepLog: log,
				encoderStoppedConfirmedFor: id,
				aisaAnalysisId: analysis,
				aisaStatus: "CREATED",
				providerStatus: "CREATED",
				aisaFinalization: {
					kind: "NEVER_STARTED",
					basis: "BOUND_CREATED_NOT_STARTED",
					runId: run.id,
					analysisId: analysis,
					encodingId: id,
					analysisStatus: "CREATED",
					encodingStatus: "CREATED",
					observedAt: new Date().toISOString(),
				},
			},
		});
		if (combined) {
			const vr = await prisma.verificationRun.create({
				data: {
					runId: randomUUID(),
					reportPath: "fixture",
					bitmovinAccountId: account.id,
				},
			});
			const keys = ["provider:BITMOVIN_ENCODING:" + id];
			const seal = {
				verificationKey: randomUUID(),
				requestSha256: "0".repeat(64),
				providerIds: [id],
				state: "TERMINAL" as const,
				cleanupState: "CLEANED" as const,
				possiblyCreatedKeys: keys,
				cleanedResourceKeys: keys,
				candidates: [],
				readback: { status: "CREATED", removed: true },
			};
			await prisma.verificationResourceIntent.create({
				data: {
					verificationRunId: vr.id,
					kind: "LIVE_CHANNEL",
					scenario: "cleanup",
					...seal,
					closureDigest: verificationIntentClosureDigest(seal),
				},
			});
		}
		const cipher = new AesGcmCipher(randomBytes(32));
		const r = await deleteSelectedData(
			prisma,
			requiredResetCategories(
				combined ? ["liveChannels", "verificationHistory"] : ["liveChannels"],
			),
			cipher,
		);
		if (!r.cleanupTaskId) throw new Error("Missing receipt");
		const { createResetCleanupSweep } = await import(
			"../../../../worker/src/reset/cleanup"
		);
		const provider = {
			status: vi.fn().mockResolvedValue("CREATED"),
			stop: vi.fn(),
			releaseTemporaryKeys: vi.fn(),
			removeWebhook: vi.fn(),
		};
		await createResetCleanupSweep({
			prisma,
			cipher,
			providerFor: async () => provider,
		})();
		expect(provider.stop).not.toHaveBeenCalled();
		expect(
			provider.releaseTemporaryKeys.mock.calls.map(([key]) => key),
		).toEqual([id]);
		expect(
			await prisma.resetCleanupTask.findUnique({
				where: { id: r.cleanupTaskId },
			}),
		).toBeNull();
	});
	it("retains divergent clean STOPPED primaries until each original encoder has terminal evidence", async () => {
		const a = randomUUID(),
			b = randomUUID();
		const { channel, run } = await archiveFixture(prisma, b, []);
		await prisma.liveChannel.update({
			where: { id: channel.id },
			data: { bitmovinEncodingId: a, status: "STOPPED" },
		});
		await prisma.liveChannelRun.update({
			where: { id: run.id },
			data: { status: "STOPPED" },
		});
		const read = await reconcileEncoderPointers(prisma, async (_account, id) =>
			id === a
				? { kind: "stopped", providerStatus: "FINISHED" }
				: { kind: "running", providerStatus: "RUNNING" },
		);
		expect(read.running.map((p) => p.bitmovinEncodingId)).toContain(b);
		const startState = () =>
			prisma.$transaction((tx) => readLockedLiveStartState(tx, channel.id));
		expect((await startState()).archivesRetired).toBe(false);
		expect((await channelRequest(channel.id, "DELETE")).status).toBe(409);
		await expect(deleteOperationalData(prisma)).rejects.toThrow();
		await reconcileEncoderPointers(prisma, async () => ({
			kind: "stopped",
			providerStatus: "FINISHED",
		}));
		expect((await startState()).archivesRetired).toBe(true);
		expect((await channelRequest(channel.id, "DELETE")).status).toBe(200);
	});
	it("allows deletion only after an abandoned orphan STOP is fully reconciled and its lease is no longer live", async () => {
		const legacy = randomUUID();
		const a = randomUUID(),
			b = randomUUID();
		const { channel } = await archiveFixture(prisma, null, []);
		const c = await claimFixture(channel.id, randomUUID(), a, [b]);
		await prisma.liveEffectClaim.update({
			where: { id: c.id },
			data: { state: "AMBIGUOUS", legacyUnsentStopIds: [legacy] },
		});
		expect((await channelRequest(channel.id, "DELETE")).status).toBe(409);
		const proofs = await reconcileEncoderPointers(prisma, async () => ({
			kind: "stopped",
			providerStatus: "FINISHED",
		}));
		expect(proofs.confirmed.map((p) => p.bitmovinEncodingId).sort()).toEqual(
			[a, b, legacy].sort(),
		);
		await prisma.liveEffectClaim.update({
			where: { id: c.id },
			data: { state: "DISPATCHING", expiresAt: new Date(Date.now() + 60000) },
		});
		expect((await channelRequest(channel.id, "DELETE")).status).toBe(409);
		await prisma.liveEffectClaim.update({
			where: { id: c.id },
			data: { expiresAt: new Date(0) },
		});
		expect((await channelRequest(channel.id, "DELETE")).status).toBe(200);
	});
	it.each([
		"AMBIGUOUS",
		"DISPATCHING",
	] as const)("retires only an abandoned ordinary orphan %s after proof of every target", async (state) => {
		const a = randomUUID(),
			b = randomUUID(),
			extra = randomUUID();
		const { channel } = await archiveFixture(prisma, null, []);
		const claim = await claimFixture(channel.id, randomUUID(), a, [b]);
		await prisma.liveEffectClaim.update({
			where: { id: claim.id },
			data: {
				state,
				expiresAt: new Date(Date.now() + 60000),
				legacyUnsentStopIds: [extra],
			},
		});
		const get = () =>
			prisma.liveEffectClaim.findUniqueOrThrow({ where: { id: claim.id } });
		await reconcileEncoderPointers(prisma, async (_account, id) =>
			id === extra
				? { kind: "running", providerStatus: "RUNNING" }
				: { kind: "stopped", providerStatus: "FINISHED" },
		);
		expect((await get()).state).toBe(state);
		await reconcileEncoderPointers(prisma, async () => ({
			kind: "stopped",
			providerStatus: "FINISHED",
		}));
		if (state === "DISPATCHING") {
			expect((await get()).state).toBe("DISPATCHING");
			await prisma.liveEffectClaim.update({
				where: { id: claim.id },
				data: { expiresAt: new Date(0) },
			});
			await prisma.$transaction((tx) =>
				readLockedLiveStartState(tx, channel.id),
			);
		}
		expect((await get()).state).toBe("RESOLVED");
		const cipher = new AesGcmCipher(randomBytes(32));
		const selected = await deleteSelectedData(
			prisma,
			requiredResetCategories(["liveChannels"]),
			cipher,
		);
		if (!selected.cleanupTaskId) throw new Error("Expected a cleanup task");
		const task = await readResetCleanupTask(
			prisma,
			cipher,
			selected.cleanupTaskId,
		);
		expect(task?.payload.encodings.map((e) => e.encodingId)).toEqual(
			expect.arrayContaining([a, b, extra]),
		);
	});
	it.each([
		"full",
		"selected",
		"channel delete",
	] as const)("preserves a missing run's only Analysis handle during %s", async (mode) => {
		const { channel } = await archiveFixture(prisma, null, []);
		const claim = await claimFixture(
			channel.id,
			randomUUID(),
			randomUUID(),
			[],
		);
		const analysis = randomUUID();
		await prisma.liveEffectClaim.update({
			where: { id: claim.id },
			data: { state: "AMBIGUOUS", stopAnalysisSendId: analysis },
		});
		await reconcileEncoderPointers(prisma, async () => ({
			kind: "stopped",
			providerStatus: "FINISHED",
		}));
		expect(
			(
				await prisma.liveEffectClaim.findUniqueOrThrow({
					where: { id: claim.id },
				})
			).state,
		).toBe("AMBIGUOUS");
		if (mode === "selected")
			await expect(
				deleteSelectedData(
					prisma,
					requiredResetCategories(["liveChannels"]),
					new AesGcmCipher(randomBytes(32)),
				),
			).rejects.toThrow(/Analysis/);
		else if (mode === "full")
			await expect(deleteOperationalData(prisma)).rejects.toThrow();
		else expect((await channelRequest(channel.id, "DELETE")).status).toBe(409);
		expect(
			await prisma.liveEffectClaim.findUnique({ where: { id: claim.id } }),
		).toMatchObject({ stopAnalysisSendId: analysis });
		expect(await prisma.resetCleanupTask.count()).toBe(0);
	});
	it("protects adopted VOD encoders in a prepopulated encrypted verification worklist", async () => {
		const { account } = await archiveFixture(prisma, null, []);
		const a = randomUUID(),
			b = randomUUID(),
			alias = randomUUID(),
			defaultScope = randomUUID(),
			tenantOrgId = randomUUID(),
			free = randomUUID(),
			taskIntent = randomUUID();
		const cipher = new AesGcmCipher(randomBytes(32));
		const key = "encodingJob:verification-intent:" + taskIntent;
		await createResetCleanupTask(prisma, cipher, {
			v: 1,
			accounts: [{ id: account.id, encryptedApiKey: "fixture", tenantOrgId }],
			encodings: [a, b, alias, defaultScope, free].map((encodingId) => ({
				entityKey: key,
				accountId: account.id,
				encodingId,
			})),
			verificationIntents: [
				{
					id: taskIntent,
					verificationKey: randomUUID(),
					kind: "VOD_JOB",
					state: "AMBIGUOUS",
					providerIds: [a, b, alias, defaultScope, free],
					verificationRun: { bitmovinAccountId: account.id },
				},
			],
			webhooks: [],
			pendingEntities: [],
		});
		await prisma.encodingJob.create({
			data: {
				name: "Retained VOD",
				status: "RUNNING",
				plan: {},
				bitmovinAccountId: account.id,
				bitmovinEncodingId: a,
				stepLog: [{ kind: "CREATE_ENCODING", resourceId: b }],
			},
		});
		// Two saved entries may select the same provider organization. With no
		// explicit provider organization the overlap cannot be excluded.
		const shared = await archiveFixture(prisma, alias, [], 1, 1, tenantOrgId);
		await archiveFixture(prisma, defaultScope, []);
		await prisma.bitmovinAccount.updateMany({
			where: { id: shared.account.id },
			data: { tenantOrgId: randomUUID() },
		});
		// Distinct explicit provider organizations remain independent.
		await archiveFixture(prisma, free, [], 1, 1, randomUUID());
		const provider = {
			status: vi
				.fn()
				.mockResolvedValueOnce("RUNNING")
				.mockResolvedValue("FINISHED"),
			stop: vi.fn(),
			releaseTemporaryKeys: vi.fn(),
			removeWebhook: vi.fn(),
		};
		const { createResetCleanupSweep } = await import(
			"../../../../worker/src/reset/cleanup"
		);
		await createResetCleanupSweep({
			prisma,
			cipher,
			providerFor: async () => provider,
		})();
		expect(provider.status.mock.calls).toEqual([[free], [free]]);
		expect(provider.stop.mock.calls.map(([id]) => id)).toEqual([free]);
		expect(provider.releaseTemporaryKeys).not.toHaveBeenCalled();
	});
	it.each([
		"committed",
		"committing",
		"cleanup-first",
	] as const)("serializes native verification STOP with VOD adoption (%s)", async (mode) => {
		const { account } = await archiveFixture(prisma, null, []);
		const id = randomUUID(),
			intent = randomUUID(),
			cipher = new AesGcmCipher(randomBytes(32));
		const workId = await createResetCleanupTask(prisma, cipher, {
			v: 1,
			accounts: [
				{
					id: account.id,
					encryptedApiKey: await cipher.encrypt(
						"fixture-only",
						`bitmovin-account:${account.id}`,
					),
					tenantOrgId: null,
				},
			],
			encodings: [
				{
					entityKey: "encodingJob:verification-intent:" + intent,
					accountId: account.id,
					encodingId: id,
					verificationOwnerCheck: true,
				},
			],
			webhooks: [],
			pendingEntities: [],
			verificationIntents: [],
			verificationWorklistMaterialized: true,
		});
		const status = vi
			.fn()
			.mockResolvedValueOnce({ status: "RUNNING" })
			.mockResolvedValue({ status: "FINISHED" });
		const adoption = {
			name: "Adopting encoder",
			plan: {},
			bitmovinEncodingId: id,
		};
		let localWriteFailure: string | undefined;
		let otherOrganizationCompleted = false;
		const stop = vi.fn(async () => {
			// The provider mutation owns the fence, including while its reply is pending.
			try {
				await runtime.$transaction(async (tx) => {
					await tx.$queryRaw`SELECT set_config('bitovp.organization_id', ${organizationIds[0]}, true), set_config('lock_timeout', '100ms', true)`;
					await tx.encodingJob.create({ data: adoption });
				});
			} catch (error) {
				localWriteFailure = String(error);
			}
			await createTenantPrismaClient(
				runtime,
				organizationIds[1],
			).encodingJob.create({ data: adoption });
			otherOrganizationCompleted = true;
		});
		const liveStop = vi.fn();
		let started!: () => void;
		let resume!: () => void;
		const inserted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const release = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let writer: Promise<unknown> | undefined;
		const get = vi.fn(async () => {
			if (mode === "cleanup-first") return { id, type: "VOD" };
			writer = prisma.$transaction(async (tx) => {
				await tx.encodingJob.create({
					data: {
						name: "Just adopted",
						status: "RUNNING",
						plan: { bitmovin: { accountId: account.id } },
						bitmovinEncodingId: id,
					},
				});
				started();
				if (mode === "committing") await release;
			});
			await inserted;
			if (mode === "committed") await writer;
			return { id, type: "VOD" };
		});
		const { createResetCleanupSweep } = await import(
			"../../../../worker/src/reset/cleanup"
		);
		const { resetCleanupProvider } = await import(
			"../../../../worker/src/reset/provider"
		);
		const api = {
			encoding: { encodings: { get, status, stop, live: { stop: liveStop } } },
		};
		const sweep = createResetCleanupSweep({
			prisma,
			cipher,
			providerFor: resetCleanupProvider(
				cipher,
				() =>
					api as unknown as import("../../../../worker/src/bitmovin/sdk-ctor").BitmovinApi,
			),
		});
		try {
			await sweep();
		} finally {
			resume();
			await writer;
		}
		if (mode === "committing") {
			await prisma.resetCleanupTask.updateMany({
				where: { id: workId },
				data: { nextAttemptAt: new Date(0) },
			});
			await sweep();
		}
		expect(stop).toHaveBeenCalledTimes(mode === "cleanup-first" ? 1 : 0);
		if (mode === "cleanup-first")
			expect(localWriteFailure).toMatch(/lock timeout|55P03/i);
		else expect(localWriteFailure).toBeUndefined();
		expect(otherOrganizationCompleted).toBe(mode === "cleanup-first");
		expect(status).toHaveBeenCalledTimes(mode === "cleanup-first" ? 2 : 1);
		expect(get).toHaveBeenCalledWith(id);
		expect(liveStop).not.toHaveBeenCalled();
		expect(
			await prisma.resetCleanupTask.findUnique({ where: { id: workId } }),
		).toBeNull();
	});
	it("deletes the operational graph, keeps configuration, and reports honest counts", async () => {
		// A connected graph: parents and children across every FK the delete
		// order has to respect.
		const cred = await prisma.credential.create({
			data: {
				label: "probe cred",
				provider: "AWS_S3",
				encryptedSecret: "probe-not-a-real-secret",
			},
		});
		const preset = await prisma.preset.create({
			data: { kind: "FULL_PLAN", name: "probe preset", body: {} },
		});
		const job = await prisma.encodingJob.create({
			data: {
				name: "probe job",
				plan: {},
				status: "FINISHED",
				bitmovinEncodingId: "enc-job-1",
			},
		});
		await prisma.manifestJob.create({
			data: {
				encodingJobId: job.id,
				type: "HLS",
				mode: "DEFAULT",
				generation: "JUST_IN_TIME",
			},
		});
		const vmaf = await prisma.vmafJob.create({
			data: {
				encodingJobId: job.id,
				mode: "VOD",
				model: "vmaf_v0.6.1",
				// FINISHED explicitly: the column defaults to PENDING, which is a
				// BLOCKING status — the first run of this probe was refused by
				// its own fixture, which is the refusal working.
				status: "FINISHED",
			},
		});
		await prisma.vmafResult.create({
			data: { vmafJobId: vmaf.id, renditionRef: {}, pooled: {} },
		});
		const channel = await prisma.liveChannel.create({
			data: {
				name: "probe channel",
				plan: {},
				status: "STOPPED",
				bitmovinEncodingId: "enc-chan-1",
			},
		});
		const run = await prisma.liveChannelRun.create({
			data: {
				liveChannelId: channel.id,
				seq: 1,
				status: "STOPPED",
				outputPrefix: "",
			},
		});
		await prisma.liveHeartbeat.create({
			data: {
				liveChannelId: channel.id,
				liveChannelRunId: run.id,
				at: new Date(),
				raw: {},
				deltas: {},
			},
		});
		const scopedRule = await prisma.alertRule.create({
			data: { liveChannelId: channel.id, metric: "BITRATE_BELOW" },
		});
		const globalRule = await prisma.alertRule.create({
			data: { metric: "FPS_BELOW" },
		});
		await prisma.alertEvent.create({
			data: {
				ruleId: scopedRule.id,
				liveChannelId: channel.id,
				openedAt: new Date(),
				context: {},
			},
		});
		const watchRule = await prisma.watchRule.create({
			data: {
				// review-2 C1 disarms every ENABLED rule and this arm asserts the
				// disarmed list is empty, so its premise — no rule enabled — is
				// explicit here (the schema defaults `enabled` to true).
				enabled: false,
				name: "probe watch",
				credentialId: cred.id,
				bucket: "b",
				prefix: "p/",
				presetId: preset.id,
				outputPrefixTemplate: "out/{name}/",
			},
		});
		await prisma.watchedObject.create({
			data: {
				watchRuleId: watchRule.id,
				objectKey: "p/a.mp4",
				contentId: "probe-content-1",
			},
		});
		await prisma.auditLog.create({
			data: { method: "GET", path: "/probe", statusCode: 200 },
		});

		// Nothing is running, so the reset must proceed.
		const active = await findActiveWork(prisma);
		if (!isIdle(active)) {
			console.log("ACTIVE", JSON.stringify(active));
		}
		expect(isIdle(active)).toBe(true);

		const encoders = await collectEncoderPointers(prisma);
		expect(encoders.pointers.map((p) => p.bitmovinEncodingId).sort()).toEqual([
			"enc-chan-1",
			"enc-job-1",
		]);

		const { counts, disarmed } = await deleteOperationalData(prisma);

		// Every operational table is EMPTY — counted from the database.
		const leftovers: Record<string, number> = {};
		for (const model of RESET_DELETES) {
			const n = await (
				prisma[model] as unknown as { count: () => Promise<number> }
			).count();
			if (n > 0) {
				leftovers[model] = n;
			}
		}
		expect(leftovers).toEqual({});

		// Every configuration table still holds its rows.
		const kept: Record<string, number> = {};
		for (const model of RESET_KEEPS) {
			kept[model] = await (
				prisma[model] as unknown as { count: () => Promise<number> }
			).count();
		}
		expect(kept.credential).toBe(1);
		expect(kept.watchRule).toBe(1);
		// The scoped rule is gone, the global one survives — the B1 contract.
		expect(kept.alertRule).toBe(1);
		expect(
			await prisma.alertRule.findUnique({ where: { id: globalRule.id } }),
		).not.toBeNull();
		expect(counts.alertRuleScoped).toBe(1);
		// The count that was silently 0 before the ordering fix: the scoped
		// rule's own CHILD. Deleting the rules first cascaded these away, so
		// alertEvent.deleteMany counted nothing for a table that had just lost
		// a row — 130-B1's dishonest count, reintroduced by 130-B1's fix.
		expect(counts.alertEvent).toBe(1);
		expect(counts.encodingJob).toBe(1);
		expect(counts.liveChannel).toBe(1);
		// review-2 N4: the disarmed rules are enumerated, and this run has no
		// watch rule enabled, so the list is empty rather than absent.
		expect(disarmed).toEqual([]);
		// eslint-disable-next-line no-console
		console.log("PROBE COUNTS", JSON.stringify(counts));
	}, 60_000);

	/**
	 *  / rev425 R1 (evidence): the id-tied stamp is compared against
	 * the row's own pointer COLUMN TO COLUMN, through a Prisma field
	 * reference — a shape the offline double models but had never been
	 * serialized against Postgres. The first arm's wipe leaves the operational
	 * tables empty, so this seeds its own rows.
	 */
	it("rev425: Postgres selects a row stamped for ANOTHER encoding, ignores a row stamped for its own, and the reconcile's CAS lands only on a row that still points at what was read", async () => {
		const stale = await prisma.encodingJob.create({
			data: {
				name: "stale stamp",
				plan: {},
				status: "ERROR",
				bitmovinEncodingId: "enc-B",
				encoderStoppedConfirmedFor: "enc-A",
			},
		});
		const confirmed = await prisma.encodingJob.create({
			data: {
				name: "confirmed for its own pointer",
				plan: {},
				status: "CANCELED",
				bitmovinEncodingId: "enc-K",
				encoderStoppedConfirmedFor: "enc-K",
			},
		});
		const unstamped = await prisma.encodingJob.create({
			data: {
				name: "never confirmed",
				plan: {},
				status: "CANCELED",
				bitmovinEncodingId: "enc-U",
			},
		});
		const channel = await prisma.liveChannel.create({
			data: {
				name: "re-aired channel",
				plan: {},
				status: "STOPPED",
				error: "stop did not confirm",
				bitmovinEncodingId: "enc-B2",
				encoderStoppedConfirmedFor: "enc-A2",
			},
		});
		const staleRun = await prisma.liveChannelRun.create({
			data: {
				liveChannelId: channel.id,
				seq: 1,
				status: "ERROR",
				error: "x",
				outputPrefix: "",
				bitmovinEncodingId: "enc-B3",
				encoderStoppedConfirmedFor: "enc-A3",
			},
		});
		const okRun = await prisma.liveChannelRun.create({
			data: {
				liveChannelId: channel.id,
				seq: 2,
				status: "STOPPED",
				error: "stop did not confirm",
				outputPrefix: "",
				bitmovinEncodingId: "enc-K3",
				encoderStoppedConfirmedFor: "enc-K3",
			},
		});

		// The SQL predicate: stale stamps and the unstamped row block; matching stamps do not.
		const active = await findActiveWork(prisma);
		const stampedPointers = active.unstoppedEncoders.filter(
			(p) => !p.archivedRtmp,
		);
		expect(stampedPointers.map((p) => p.id).sort()).toEqual(
			[stale.id, unstamped.id, channel.id, staleRun.id].sort(),
		);
		expect(
			await prisma.encodingJob.count({ where: pointerJobWhere(prisma) }),
		).toBe(2);
		expect(
			await prisma.liveChannelRun.count({ where: pointerRunWhere(prisma) }),
		).toBe(1);
		expect(active.unstoppedEncoders.map((p) => p.id)).not.toContain(
			confirmed.id,
		);
		expect(stampedPointers.map((p) => p.id)).not.toContain(okRun.id);
		expect(
			active.unstoppedEncoders
				.filter((p) => p.archivedRtmp)
				.map((p) => [p.id, p.bitmovinEncodingId])
				.sort(),
		).toEqual(
			[
				[okRun.id, "enc-B2"],
				[okRun.id, "enc-K3"],
			].sort(),
		);

		// The reconcile: TERMINAL for enc-B/enc-B2/enc-B3 stamps the CURRENT id;
		// enc-U is re-pointed while it is being read, so its CAS must not land.
		const read: EncoderStateReader = async (_acct, enc) => {
			if (enc === "enc-U") {
				await prisma.encodingJob.update({
					where: { id: unstamped.id },
					data: { bitmovinEncodingId: "enc-U2" },
				});
				return { kind: "stopped", providerStatus: "FINISHED" };
			}
			return { kind: "stopped", providerStatus: "CANCELED" };
		};
		// the probe rows have no account: give them one so the reader is asked
		const account = await prisma.bitmovinAccount.create({
			data: { label: "probe account", encryptedApiKey: "probe-not-a-key" },
		});
		await prisma.encodingJob.updateMany({
			data: { bitmovinAccountId: account.id },
		});
		await prisma.liveChannel.updateMany({
			data: { bitmovinAccountId: account.id },
		});
		const report = await reconcileEncoderPointers(prisma, read);
		expect(
			report.confirmed
				.filter((p) => !p.archivedRtmp)
				.map((p) => p.id)
				.sort(),
		).toEqual([stale.id, channel.id, staleRun.id].sort());
		expect(
			report.confirmed
				.filter((p) => p.archivedRtmp)
				.map((p) => [p.id, p.bitmovinEncodingId])
				.sort(),
		).toEqual(
			[
				[okRun.id, "enc-B2"],
				[okRun.id, "enc-K3"],
			].sort(),
		);
		expect(report.unverified.map((p) => [p.id, p.message])).toEqual([
			[
				unstamped.id,
				"the row was pointed at another encoding or changed state while Bitmovin was being read; check again",
			],
		]);
		const after = await findActiveWork(prisma);
		expect(after.unstoppedEncoders.map((p) => p.id)).toEqual([unstamped.id]);
		expect(
			(await prisma.encodingJob.findUnique({ where: { id: stale.id } }))
				?.encoderStoppedConfirmedFor,
		).toBe("enc-B");
		expect(
			(await prisma.encodingJob.findUnique({ where: { id: unstamped.id } }))
				?.encoderStoppedConfirmedFor,
		).toBeNull();
		// eslint-disable-next-line no-console
		console.log(
			"PROBE rev425",
			JSON.stringify({
				before: active.unstoppedEncoders.length,
				after: after.unstoppedEncoders.length,
				confirmed: report.confirmed.length,
			}),
		);
	}, 60_000);
});
