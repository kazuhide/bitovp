import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { AesGcmCipher } from "@bitovp/core";
import {
	type AppPrismaClient,
	createBitmovinAccountStore,
	createCredentialStore,
	createPrismaClient,
	createTenantPrismaClient,
	type Prisma,
} from "@bitovp/db";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	DELETE as removeVod,
	POST as verifyVod,
} from "@/app/api/encoding-jobs/[id]/resources/route";
import {
	GET as listLive,
	DELETE as removeLive,
} from "@/app/api/live-channels/[id]/runs/[runId]/resources/route";
import * as auth from "../context";
import { routeError } from "../http";
import { resourceFixture } from "./__fixtures__/journal";
import contracts from "./__fixtures__/sdk-contracts.json";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL,
	runtimeUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
describe.runIf(!!adminUrl && !!runtimeUrl)(
	"typed provider resource ownership under PostgreSQL RLS",
	() => {
		const admin = createPrismaClient(adminUrl),
			runtime = createPrismaClient(runtimeUrl);
		const ownOrg = randomUUID(),
			otherOrg = randomUUID(),
			upstream = randomUUID(),
			cipher = new AesGcmCipher(randomBytes(32));
		const own = createTenantPrismaClient(runtime, ownOrg),
			foreign = createTenantPrismaClient(runtime, otherOrg);
		const send = vi.fn();
		async function account(db: AppPrismaClient, upstream: string) {
			const id = randomUUID();
			return db.bitmovinAccount.create({
				data: {
					id,
					label: "Ephemeral fixture",
					tenantOrgId: upstream,
					encryptedApiKey: await cipher.encrypt(
						"synthetic-key",
						`bitmovin-account:${id}`,
					),
				},
			});
		}
		type Account = Awaited<ReturnType<typeof account>>;
		let a: Account, b: Account;
		function useTenant(
			db: AppPrismaClient,
			org: string,
			role: "ADMIN" | "OPERATOR" | "VIEWER" = "OPERATOR",
			isImpersonating = false,
		) {
			vi.spyOn(auth, "getServerContext").mockResolvedValue({
				prisma: db,
				cipher,
				credentials: createCredentialStore(db, cipher),
				bitmovinAccounts: createBitmovinAccountStore(db, cipher),
				tenant: {
					organizationId: org,
					role,
					isImpersonating,
					actorRole: role,
					actorUserId: null,
					effectiveUserId: null,
					organizationName: "Fixture",
					platformOwner: false,
					targetDisplayName: null,
					actor: "local fixture",
				},
			});
		}
		beforeAll(async () => {
			await admin.organization.createMany({
				data: [ownOrg, otherOrg].map((id) => ({
					id,
					name: "Typed resources fixture",
					slug: id,
				})),
			});
			a = await account(own, upstream);
			b = await account(foreign, upstream);
		});
		beforeEach(() => {
			useTenant(own, ownOrg);
			send.mockReset();
			vi.stubGlobal("fetch", send);
		});
		afterEach(async () => {
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
			for (const db of [own, foreign]) {
				await db.encodingResourceRemoval.deleteMany();
				await db.auditLog.deleteMany();
				await db.liveChannelRun.deleteMany();
				await db.liveChannel.deleteMany();
				await db.encodingJob.deleteMany();
			}
		});
		afterAll(async () => {
			await own.bitmovinAccount.deleteMany();
			await foreign.bitmovinAccount.deleteMany();
			await admin.organization.deleteMany({
				where: { id: { in: [ownOrg, otherOrg] } },
			});
			await Promise.all([admin.$disconnect(), runtime.$disconnect()]);
		});
		const defaultContract = contracts.find(
			(c) => c.kind === "CREATE_CODEC_AAC",
		);
		async function seed(
			db = own,
			acc = a,
			contract = defaultContract,
			target?: string,
			live = false,
		) {
			if (!contract) throw new Error("No contract");
			const f = resourceFixture(contract, acc.id, acc.resourceScopeVersion);
			if (target) {
				for (const s of f.steps)
					if (s.step === "selected") {
						s.resourceId = target;
						s.response = { id: target };
					}
				f.expected = f.expected.replace(f.id, target);
				f.id = target;
			}
			const stepLog = JSON.parse(
				JSON.stringify(f.steps),
			) as Prisma.InputJsonValue;
			if (live) {
				const encodingId =
					f.steps.find((s) => s.kind === "CREATE_ENCODING")?.resourceId ?? null;
				const channel = await db.liveChannel.create({
					data: {
						name: "Fixtures",
						plan: { bitmovin: { accountId: acc.id } },
						bitmovinAccountId: acc.id,
						status: "STOPPED",
						bitmovinEncodingId: encodingId,
						stepLog,
					},
				});
				const run = await db.liveChannelRun.create({
					data: {
						liveChannelId: channel.id,
						seq: 1,
						status: "STOPPED",
						bitmovinEncodingId: encodingId,
						stepLog,
						outputPrefix: "fixture",
					},
				});
				return { ...f, sourceId: run.id, channelId: channel.id };
			}
			const job = await db.encodingJob.create({
				data: {
					name: "Fixture",
					plan: { bitmovin: { accountId: acc.id } },
					bitmovinAccountId: acc.id,
					status: "FINISHED",
					stepLog,
				},
			});
			return { ...f, sourceId: job.id, channelId: null };
		}
		type Source = Awaited<ReturnType<typeof seed>>;
		async function submit(
			s: Source,
			mode: "remove" | "verify" = "remove",
			override = {},
		) {
			const method = mode === "verify" ? "POST" : "DELETE";
			const req = new Request("http://local.test/resources", {
				method,
				headers: {
					"content-type": "application/json",
					"x-bitovp-actor": "session",
				},
				body: JSON.stringify({
					step: "selected",
					attempt: 0,
					confirmResourceId: s.id,
					...override,
				}),
			});
			return s.channelId
				? removeLive(req, {
						params: Promise.resolve({ id: s.channelId, runId: s.sourceId }),
					})
				: (mode === "remove" ? removeVod : verifyVod)(req, {
						params: Promise.resolve({ id: s.sourceId }),
					});
		}
		function wire(s: Source, onDelete?: () => Promise<Response>) {
			send.mockImplementation(async (url: string, init: RequestInit) => {
				expect(new URL(url).pathname).toBe(s.expected);
				expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe(upstream);
				expect(["GET", "DELETE"]).toContain(init.method);
				if (init.method === "DELETE" && onDelete) return onDelete();
				return Response.json({
					status: "SUCCESS",
					data: {
						result: { id: s.id, name: "fixture", secret: "fixture-secret" },
					},
				});
			});
		}
		it.each(
			contracts,
		)("removes the recorded $kind through its exact SDK path and persists the result", async (c) => {
			const s = await seed(own, a, c);
			wire(s);
			const result = await submit(s);
			const body = await result.json();
			expect(result.status, JSON.stringify(body)).toBe(200);
			expect(body).toEqual({ state: "REMOVED", disposition: "removed" });
			expect(send.mock.calls.map(([, init]) => init.method)).toEqual([
				"GET",
				"DELETE",
			]);
			expect(
				await own.encodingResourceRemoval.findFirst({
					where: { sourceId: s.sourceId },
				}),
			).toMatchObject({
				accountId: a.id,
				state: "REMOVED",
				pendingJobId: null,
				pendingRunId: null,
			});
			expect(await (await submit(s)).json()).toMatchObject({
				state: "REMOVED",
				disposition: "recorded",
			});
			expect(send).toHaveBeenCalledTimes(2);
		});
		it("rejects a foreign job, a viewer, impersonation, wrong confirmation and an active job before provider access", async () => {
			const s = await seed();
			useTenant(foreign, otherOrg);
			expect((await submit(s)).status).toBe(404);
			useTenant(own, ownOrg, "VIEWER");
			expect((await submit(s)).status).toBe(403);
			useTenant(own, ownOrg, "ADMIN", true);
			expect((await submit(s)).status).toBe(403);
			useTenant(own, ownOrg);
			expect(
				(await submit(s, "remove", { confirmResourceId: randomUUID() })).status,
			).toBe(409);
			await own.encodingJob.update({
				where: { id: s.sourceId },
				data: { status: "RUNNING" },
			});
			expect((await submit(s)).status).toBe(409);
			expect(send).not.toHaveBeenCalled();
		});
		it("protects shared credentials across two application organizations and permits independent upstream organizations with the same ID", async () => {
			const s = await seed();
			await seed(foreign, b, defaultContract, s.id);
			expect((await submit(s)).status).toBe(409);
			expect(send).not.toHaveBeenCalled();
			await foreign.encodingJob.deleteMany();
			const separate = await account(foreign, randomUUID());
			await seed(foreign, separate, defaultContract, s.id);
			wire(s);
			expect((await submit(s)).status).toBe(200);
		});
		it("fences incoming VOD plans and live/journal references sharing the provider scope throughout an in-flight removal", async () => {
			const s = await seed();
			const separate = await account(foreign, randomUUID());
			const unreferenced = await foreign.encodingJob.create({
				data: {
					name: "Existing consumer",
					plan: { bitmovin: { accountId: b.id } },
					bitmovinAccountId: b.id,
				},
			});
			const channel = await foreign.liveChannel.create({
				data: {
					name: "Existing live",
					plan: { bitmovin: { accountId: b.id } },
					bitmovinAccountId: b.id,
				},
			});
			const run = await foreign.liveChannelRun.create({
				data: {
					liveChannelId: channel.id,
					seq: 1,
					status: "STOPPED",
					outputPrefix: "test",
				},
			});
			let entered!: () => void, resume!: () => void;
			const seen = new Promise<void>((r) => {
				entered = r;
			});
			const release = new Promise<void>((r) => {
				resume = r;
			});
			wire(s, async () => {
				entered();
				await release;
				return Response.json({
					status: "SUCCESS",
					data: { result: { id: s.id } },
				});
			});
			const first = submit(s);
			try {
				await Promise.race([
					seen,
					first.then(() => {
						throw new Error("Native removal was not reached");
					}),
				]);
				const journal = [
					{ step: "new-consumer", request: { codecConfigurationId: s.id } },
				];
				await expect(
					foreign.encodingJob.create({
						data: {
							name: "New consumer",
							plan: {
								bitmovin: { accountId: b.id },
								codecConfigurationId: s.id,
							},
						},
					}),
				).rejects.toThrow();
				await expect(
					foreign.encodingJob.update({
						where: { id: unreferenced.id },
						data: { stepLog: journal },
					}),
				).rejects.toThrow();
				await expect(
					foreign.liveChannel.update({
						where: { id: channel.id },
						data: { plan: { bitmovin: { accountId: b.id }, outputs: [s.id] } },
					}),
				).rejects.toThrow();
				await expect(
					foreign.liveChannelRun.update({
						where: { id: run.id },
						data: { stepLog: journal },
					}),
				).rejects.toThrow();
				await expect(
					foreign.encodingJob.create({
						data: {
							name: "Isolated true peer",
							plan: {
								bitmovin: { accountId: separate.id },
								codecConfigurationId: s.id,
							},
						},
					}),
				).resolves.toBeTruthy();
				await expect(
					foreign.encodingJob.update({
						where: { id: unreferenced.id },
						data: { stepLog: [] },
					}),
				).resolves.toBeTruthy();
			} finally {
				resume();
			}
			expect((await first).status).toBe(200);
		});
		it("waits for an unrelated short publication and sends the original confirmed removal", async () => {
			const s = await seed();
			wire(s);
			const inserted = Promise.withResolvers<void>(),
				release = Promise.withResolvers<void>();
			const writer = foreign.$transaction(async (tx) => {
				await tx.encodingJob.create({
					data: {
						name: "Unrelated writer",
						plan: { bitmovin: { accountId: b.id } },
					},
				});
				inserted.resolve();
				await release.promise;
			});
			await Promise.race([
				inserted.promise,
				writer.then(() => {
					throw new Error("Unrelated writer did not insert");
				}),
			]);
			const removal = submit(s);
			const monitor = async () => {
				for (let i = 0; i < 150; i++) {
					const [row] = await admin.$queryRaw<
						{ waiting: boolean }[]
					>`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%bitovp_resource_exclusive%') AS waiting`;
					if (row?.waiting) return;
					await wait(5);
				}
				throw new Error("Removal did not wait for the existing writer");
			};
			try {
				await Promise.race([
					monitor(),
					removal.then(() => {
						throw new Error(
							"Removal refused or sent before publication completed",
						);
					}),
				]);
			} finally {
				release.resolve();
				await writer;
			}
			expect((await removal).status).toBe(200);
		});
		it("offers read-only access to a stopped Live run and sends no provider removal", async () => {
			const s = await seed(own, a, defaultContract, undefined, true);
			if (!s.channelId) throw new Error("Live fixture missing");
			const index = await listLive(new Request("http://fixture/resources"), {
				params: Promise.resolve({ id: s.channelId, runId: s.sourceId }),
			});
			expect(await index.json()).toMatchObject({
				canRemove: false,
				resources: expect.arrayContaining([
					expect.objectContaining({ id: s.id }),
				]),
			});
			expect((await submit(s)).status).toBe(409);
			expect(send).not.toHaveBeenCalled();
		});
		it("withholds Live deletion even after confirmation for the current encoder", async () => {
			const s = await seed(own, a, defaultContract, undefined, true);
			if (!s.channelId) throw new Error("Live fixture missing");
			const encoder = randomUUID();
			await own.liveChannel.update({
				where: { id: s.channelId },
				data: {
					status: "ERROR",
					error: "Unknown encoder status",
					bitmovinEncodingId: encoder,
					encoderStoppedConfirmedFor: randomUUID(),
				},
			});
			expect((await submit(s)).status).toBe(409);
			expect(send).not.toHaveBeenCalled();
			await own.liveChannel.update({
				where: { id: s.channelId },
				data: { encoderStoppedConfirmedFor: encoder },
			});
			expect((await submit(s)).status).toBe(409);
			expect(send).not.toHaveBeenCalled();
		});
		it("keeps an output for future publication and protects a stopped run during publication", async () => {
			const contract = contracts.find((c) => c.kind === "CREATE_OUTPUT_S3");
			if (!contract) throw new Error("Missing S3 output fixture");
			const source = await seed(own, a, contract, undefined, true);
			if (!source.channelId) throw new Error("Missing Live channel");
			const step = "output:archive";
			const stepLog = JSON.parse(
				JSON.stringify(
					source.steps.map((entry) =>
						entry.step === "selected" ? { ...entry, step } : entry,
					),
				),
			);
			await own.liveChannel.update({
				where: { id: source.channelId },
				data: { stepLog },
			});
			await own.liveChannelRun.update({
				where: { id: source.sourceId },
				data: { stepLog },
			});
			expect((await submit(source, "remove", { step })).status).toBe(409);
			const other = await seed(own, a, defaultContract, undefined, true);
			if (!other.channelId) throw new Error("Missing second channel");
			await own.liveChannel.update({
				where: { id: other.channelId },
				data: {
					liveToVod: { status: "RUNNING", outputKey: "archive", manifests: [] },
				},
			});
			expect((await submit(other)).status).toBe(409);
			expect(send).not.toHaveBeenCalled();
		});
		it("refuses resource removal while a stopped channel still has a publisher or a current run effect", async () => {
			const s = await seed(own, a, defaultContract, undefined, true);
			if (!s.channelId) throw new Error("Live fixture missing");
			const publisher = await own.feederSession.create({
				data: {
					liveChannelId: s.channelId,
					sourceCredentialId: randomUUID(),
					sourceBucket: "local",
					sourceKey: "sample",
					protocol: "RTMP",
					target: {},
					status: "ERROR",
					pid: 31321,
					ownerHost: "local-fixture",
				},
			});
			expect((await submit(s)).status).toBe(409);
			expect(send).not.toHaveBeenCalled();
			await own.feederSession.delete({ where: { id: publisher.id } });
			const claim = await own.liveEffectClaim.create({
				data: {
					liveChannelId: s.channelId,
					liveChannelRunId: s.sourceId,
					providerEncodingId: randomUUID(),
					action: "STOP",
					state: "DISPATCHING",
					idempotencyKey: randomUUID(),
					token: randomUUID(),
					ownerId: "fixture",
					generation: 1,
					expiresAt: new Date(Date.now() + 60000),
				},
			});
			expect((await submit(s)).status).toBe(409);
			expect(send).not.toHaveBeenCalled();
			await own.liveEffectClaim.delete({ where: { id: claim.id } });
			expect((await submit(s)).status).toBe(409);
			expect(send).not.toHaveBeenCalled();
		});
		it("an in-flight reference publication wins before a competing removal can send", async () => {
			const s = await seed();
			const entered = Promise.withResolvers<void>(),
				resume = Promise.withResolvers<void>();
			const writer = foreign.$transaction(async (tx) => {
				await tx.encodingJob.create({
					data: {
						name: "Child",
						plan: { bitmovin: { accountId: b.id }, existingId: s.id },
					},
				});
				entered.resolve();
				await resume.promise;
			});
			try {
				await Promise.race([
					entered.promise,
					writer.then(() => {
						throw new Error("Publisher stopped before reservation");
					}),
				]);
				expect((await submit(s)).status).toBe(409);
				expect(send).not.toHaveBeenCalled();
			} finally {
				resume.resolve();
				await writer;
			}
			expect((await submit(s)).status).toBe(409);
			expect(send).not.toHaveBeenCalled();
		});
		it("protects the original account until an uncertain removal is resolved and permits safe credential maintenance", async () => {
			const original = await account(own, upstream);
			const s = await seed(own, original);
			wire(s, async () => {
				throw new Error("lost response");
			});
			expect((await submit(s)).status).toBe(502);
			await expect(
				own.bitmovinAccount.update({
					where: { id: original.id },
					data: { tenantOrgId: randomUUID() },
				}),
			).rejects.toThrow();
			await expect(
				own.bitmovinAccount.delete({ where: { id: original.id } }),
			).rejects.toThrow();
			await expect(
				own.bitmovinAccount.update({
					where: { id: original.id },
					data: {
						label: "Updated",
						encryptedApiKey: await cipher.encrypt(
							"replacement-key",
							`bitmovin-account:${original.id}`,
						),
					},
				}),
			).resolves.toMatchObject({
				resourceScopeVersion: original.resourceScopeVersion,
			});
			send.mockImplementation(async () =>
				Response.json(
					{ status: "ERROR", data: { code: 1001, message: "not found" } },
					{ status: 404 },
				),
			);
			expect((await submit(s, "verify")).status).toBe(200);
			await expect(
				own.bitmovinAccount.delete({ where: { id: original.id } }),
			).resolves.toBeTruthy();
		});
		it("retains an uncertain DELETE through a lost response, blocks competing retries and source erasure, and verifies absence without resending", async () => {
			const s = await seed();
			let entered!: () => void, resume!: () => void;
			const seen = new Promise<void>((r) => {
				entered = r;
			});
			const release = new Promise<void>((r) => {
				resume = r;
			});
			wire(s, async () => {
				entered();
				await release;
				throw new Error("lost test response");
			});
			const original = submit(s);
			try {
				await Promise.race([
					seen,
					original.then(() => {
						throw new Error("Provider boundary was not reached");
					}),
				]);
				expect((await submit(s)).status).toBe(409);
				expect(
					(
						await own.encodingJob.updateMany({
							where: { id: s.sourceId },
							data: { status: "QUEUED" },
						})
					).count,
				).toBe(0);
				const fk = await own.encodingJob
					.delete({ where: { id: s.sourceId } })
					.catch((e: unknown) => e);
				expect(fk).toMatchObject({
					code: "P2003",
					meta: { constraint: "EncodingResourceRemoval_pendingJob_fkey" },
				});
				expect(routeError(fk).status).toBe(409);
			} finally {
				resume();
			}
			expect((await original).status).toBe(502);
			wire(s);
			expect(await (await submit(s, "verify")).json()).toMatchObject({
				state: "UNKNOWN",
				disposition: "present",
			});
			send.mockImplementation(async () =>
				Response.json(
					{ status: "ERROR", data: { code: 1001, message: "not found" } },
					{ status: 404 },
				),
			);
			expect(await (await submit(s, "verify")).json()).toMatchObject({
				state: "REMOVED",
				disposition: "absent",
			});
			expect(
				(
					await own.encodingJob.updateMany({
						where: { id: s.sourceId },
						data: { status: "QUEUED" },
					})
				).count,
			).toBe(0);
			await expect(
				own.encodingJob.delete({ where: { id: s.sourceId } }),
			).resolves.toBeTruthy();
		});
	},
);
