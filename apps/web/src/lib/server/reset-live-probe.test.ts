import { randomBytes, randomUUID } from "node:crypto";
import { AesGcmCipher } from "@bitovp/core";
import {
	type AppPrismaClient,
	createPrismaClient,
	createTenantPrismaClient,
	readResetCleanupTask,
} from "@bitovp/db";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { RESET_CATEGORIES, RESET_GLOBAL_MODELS } from "@/lib/reset-selection";
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
import { deleteSelectedData } from "./selected-reset";

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
		const edges = await admin.$queryRaw<
			{ child: string; parent: string }[]
		>`SELECT child.relname AS child, parent.relname AS parent FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid WHERE c.contype='f' AND NOT c.condeferrable AND c.confdeltype IN ('a','r')`;
		const pending = new Set(
			tables
				.map(({ table_name }) => table_name)
				.filter((table) => table !== "Membership"),
		);
		const ordered: string[] = [];
		while (pending.size) {
			const next = [...pending].find(
				(table) =>
					!edges.some(
						(edge) =>
							edge.parent === table &&
							edge.child !== table &&
							pending.has(edge.child),
					),
			);
			if (!next)
				throw new Error("Fixture cleanup has a restrictive foreign-key cycle");
			ordered.push(next);
			pending.delete(next);
		}
		await admin.$transaction(async (tx) => {
			await tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");
			for (const table_name of ordered) {
				await tx.$executeRawUnsafe(
					'DELETE FROM "' +
						table_name.replaceAll('"', '""') +
						'" WHERE "organizationId" = ANY($1::uuid[])',
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
		expect(
			await b.encodingJob.findUnique({ where: { id: bRows.job.id } }),
		).toMatchObject({ name: "B" });
		expect(await b.bitmovinAccount.count()).toBe(1);
		expect(
			await b.appSetting.findUnique({ where: { key: "probe.shared" } }),
		).toMatchObject({ value: { label: "B" } });
		expect(await b.accessEvent.count()).toBe(1);
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
	afterAll(async () => {
		await admin.$disconnect();
		await runtime.$disconnect();
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
		expect(active.unstoppedEncoders.map((p) => p.id).sort()).toEqual(
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
		expect(active.unstoppedEncoders.map((p) => p.id)).not.toContain(okRun.id);

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
		expect(report.confirmed.map((p) => p.id).sort()).toEqual(
			[stale.id, channel.id, staleRun.id].sort(),
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
