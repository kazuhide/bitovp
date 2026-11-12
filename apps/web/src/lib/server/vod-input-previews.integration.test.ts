import { createHash, randomUUID } from "node:crypto";
import { cipherFromEnv } from "@bitovp/core";
import type { VodInputPreviewRequest } from "@bitovp/core/vod-input-timeline";
import {
	type AppPrismaClient,
	createBitmovinAccountStore,
	createCredentialStore,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { ServerContext } from "./context";
import {
	cancelVodInputPreviewTask,
	createVodInputPreviewTask,
	getVodInputPreviewTask,
} from "./vod-input-previews";

const holder = vi.hoisted(() => ({
	context: null as unknown as ServerContext,
}));
const queue = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("./context", () => ({ getServerContext: async () => holder.context }));
vi.mock("./queue", () => ({ getVodInputPreviewQueue: () => queue }));

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
type PreviewRequest = Extract<VodInputPreviewRequest, { kind: "PREVIEW" }>;

describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL VOD input preview service",
	() => {
		const org = randomUUID(),
			otherOrg = randomUUID();
		let admin: AppPrismaClient,
			app: AppPrismaClient,
			a: AppPrismaClient,
			b: AppPrismaClient;

		function use(prisma = a, organizationId = org) {
			const cipher = cipherFromEnv();
			holder.context = {
				prisma,
				cipher,
				credentials: createCredentialStore(prisma, cipher),
				bitmovinAccounts: createBitmovinAccountStore(prisma, cipher),
				tenant: {
					organizationId,
					actorUserId: null,
					effectiveUserId: null,
					role: "OPERATOR",
					actorRole: "OPERATOR",
					platformOwner: false,
					isImpersonating: false,
					organizationName: "VOD preview fixture",
					targetDisplayName: null,
					actor: "vod-preview-integration",
				},
			};
		}

		beforeAll(async () => {
			vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 19).toString("base64"));
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
			a = createTenantPrismaClient(app, org);
			b = createTenantPrismaClient(app, otherOrg);
			await admin.organization.createMany({
				data: [org, otherOrg].map((id) => ({
					id,
					name: "VOD preview integration",
					slug: `vod-preview-${id}`,
				})),
			});
		});
		beforeEach(() => {
			queue.add.mockReset().mockResolvedValue(undefined);
			use();
		});
		afterAll(async () => {
			try {
				if (admin) {
					const where = { organizationId: { in: [org, otherOrg] } };
					await admin.vodInputPreviewTask.deleteMany({ where });
					await admin.credential.deleteMany({ where });
					await admin.organization.deleteMany({
						where: { id: { in: [org, otherOrg] } },
					});
				}
			} finally {
				await app?.$disconnect();
				await admin?.$disconnect();
				vi.unstubAllEnvs();
			}
		});

		async function fixture(
			client = a,
			expiresAt = new Date(Date.now() + 24 * 3600_000),
		) {
			const credential = await client.credential.create({
				data: {
					label: "VOD preview source fixture",
					provider: "AWS_S3",
					encryptedSecret: "unused-fixture-ciphertext",
				},
			});
			const request = {
				kind: "PROBE" as const,
				sources: [
					{
						key: "source",
						credentialId: credential.id,
						bucket: "input",
						objectKey: "fixture.mp4",
					},
				],
			};
			const facts = {
				key: "source",
				durationMs: 5000,
				video: { streamIndex: 0, width: 1920, height: 1080 },
				audio: { streamIndex: 1, sampleRate: 48000, channels: 2 },
				identity: { size: 1024, etag: '"fixture-v1"' },
			};
			const probe = await client.vodInputPreviewTask.create({
				data: {
					kind: "PROBE",
					status: "SUCCEEDED",
					stage: "READY",
					requestHash: hash(request),
					request,
					result: { sources: [facts] },
					finishedAt: new Date(),
					expiresAt,
				},
			});
			const preview: PreviewRequest = {
				kind: "PREVIEW",
				probeId: probe.id,
				document: {
					schemaVersion: 1,
					id: randomUUID(),
					audioEnabled: true,
					clips: [
						{ id: randomUUID(), sourceKey: "source", inMs: 0, outMs: 4000 },
					],
				},
				range: { startMs: 0, durationMs: 1000 },
			};
			return { credential, probe, request, preview };
		}

		async function complete(id: string, request: PreviewRequest) {
			return a.vodInputPreviewTask.update({
				where: { id },
				data: {
					status: "SUCCEEDED",
					stage: "READY",
					finishedAt: new Date(),
					result: {
						preview: {
							startMs: request.range.startMs,
							durationMs: request.range.durationMs,
							size: 1024,
							sha256: "a".repeat(64),
						},
					},
					artifactPath: `/fixture/${org}/${id}/preview.mp4`,
					artifactToken: randomUUID(),
					artifactSize: 1024n,
					artifactSha256: "a".repeat(64),
				},
			});
		}

		it("enforces forced RLS for lists, IDs, raw reads and writes under a restricted runtime role", async () => {
			const own = await fixture(),
				foreign = await fixture(b);
			const roles = await app.$queryRaw<
				{ rolsuper: boolean; rolbypassrls: boolean }[]
			>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
			expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
			const policy = await admin.$queryRaw<
				{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]
			>`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'VodInputPreviewTask'`;
			expect(policy).toEqual([
				{ relrowsecurity: true, relforcerowsecurity: true },
			]);
			const ids = [own.probe.id, foreign.probe.id];
			expect(
				(
					await a.vodInputPreviewTask.findMany({ where: { id: { in: ids } } })
				).map((row) => row.id),
			).toEqual([own.probe.id]);
			expect(
				await a.vodInputPreviewTask.findUnique({
					where: { id: foreign.probe.id },
				}),
			).toBeNull();
			expect(
				await a.$queryRaw`SELECT "id" FROM "VodInputPreviewTask" WHERE "id" IN (${own.probe.id}::uuid, ${foreign.probe.id}::uuid)`,
			).toEqual([{ id: own.probe.id }]);
			expect(
				await app.vodInputPreviewTask.findMany({ where: { id: { in: ids } } }),
			).toEqual([]);
			expect(
				await app.$queryRaw`SELECT "id" FROM "VodInputPreviewTask"`,
			).toEqual([]);
			expect(
				await b.vodInputPreviewTask.updateMany({
					where: { id: own.probe.id },
					data: { status: "FAILED" },
				}),
			).toEqual({ count: 0 });
			expect(
				(
					await a.vodInputPreviewTask.findUniqueOrThrow({
						where: { id: own.probe.id },
					})
				).status,
			).toBe("SUCCEEDED");
		});

		it("refuses foreign service reads, cancellation, source credentials and composite probe links", async () => {
			const own = await fixture();
			use(b, otherOrg);
			await expect(getVodInputPreviewTask(own.probe.id)).rejects.toMatchObject({
				code: "PREVIEW_NOT_FOUND",
				status: 404,
			});
			await expect(
				cancelVodInputPreviewTask(own.probe.id),
			).rejects.toMatchObject({ code: "PREVIEW_NOT_FOUND", status: 404 });
			await expect(
				createVodInputPreviewTask(own.preview),
			).rejects.toMatchObject({ code: "PREVIEW_NOT_FOUND", status: 404 });
			await expect(
				createVodInputPreviewTask(own.request),
			).rejects.toMatchObject({
				code: "SOURCE_CREDENTIAL_NOT_FOUND",
				status: 404,
			});
			const candidate = randomUUID();
			await expect(
				b.vodInputPreviewTask.create({
					data: {
						id: candidate,
						kind: "PREVIEW",
						requestHash: hash(own.preview),
						request: own.preview,
						probeId: own.probe.id,
						expiresAt: new Date(Date.now() + 60_000),
					},
				}),
			).rejects.toThrow("VodInputPreviewTask_probeId_tenant_fkey");
			expect(
				await admin.vodInputPreviewTask.findUnique({
					where: { id: candidate },
				}),
			).toBeNull();
			expect(queue.add).not.toHaveBeenCalled();
		});

		it("keeps simultaneous identical PROBE and PREVIEW requests independently cancelable", async () => {
			const f = await fixture();
			const probes = await Promise.all([
				createVodInputPreviewTask(f.request),
				createVodInputPreviewTask(f.request),
			]);
			expect(new Set(probes.map((task) => task.id)).size).toBe(2);
			const previews = await Promise.all([
				createVodInputPreviewTask(f.preview),
				createVodInputPreviewTask(f.preview),
			]);
			expect(new Set(previews.map((task) => task.id)).size).toBe(2);
			expect(previews[0]?.requestHash).toBe(previews[1]?.requestHash);
			expect(queue.add).toHaveBeenCalledTimes(4);
			await cancelVodInputPreviewTask(previews[0]?.id ?? "");
			expect((await getVodInputPreviewTask(previews[0]?.id ?? "")).status).toBe(
				"CANCELED",
			);
			expect((await getVodInputPreviewTask(previews[1]?.id ?? "")).status).toBe(
				"PENDING",
			);
		});

		it("reuses only exact completed results and leaves a succeeded artifact unchanged on cancel", async () => {
			const f = await fixture();
			const first = await createVodInputPreviewTask(f.preview);
			const completed = await complete(first.id, f.preview);
			queue.add.mockClear();
			const cached = await createVodInputPreviewTask(f.preview);
			expect(cached).toMatchObject({
				id: first.id,
				status: "SUCCEEDED",
				requestHash: hash(f.preview),
			});
			expect(cached).not.toHaveProperty("artifactPath");
			expect(cached).not.toHaveProperty("artifactToken");
			expect(queue.add).not.toHaveBeenCalled();
			expect((await cancelVodInputPreviewTask(first.id)).status).toBe(
				"SUCCEEDED",
			);
			expect(
				await a.vodInputPreviewTask.findUniqueOrThrow({
					where: { id: first.id },
				}),
			).toEqual(completed);
			const changed = await createVodInputPreviewTask({
				...f.preview,
				range: { startMs: 0, durationMs: 500 },
			});
			expect(changed.id).not.toBe(first.id);
			expect(changed.status).toBe("PENDING");
			expect(queue.add).toHaveBeenCalledTimes(1);
		});

		it("never advertises a preview lifetime beyond its source probe", async () => {
			const sourceExpiry = new Date(Date.now() + 75_000);
			const nearExpiry = await fixture(a, sourceExpiry);
			const short = await createVodInputPreviewTask(nearExpiry.preview);
			expect(short.expiresAt).toBe(sourceExpiry.toISOString());
			const regular = await fixture();
			const before = Date.now();
			const ordinary = await createVodInputPreviewTask(regular.preview);
			expect(Date.parse(ordinary.expiresAt)).toBeGreaterThanOrEqual(
				before + 2 * 3600_000,
			);
			expect(Date.parse(ordinary.expiresAt)).toBeLessThanOrEqual(
				Date.now() + 2 * 3600_000,
			);
			expect(Date.parse(ordinary.expiresAt)).toBeLessThan(
				regular.probe.expiresAt.getTime(),
			);
		});

		it("revokes derived reads and new previews after the actual source credential is deleted", async () => {
			const f = await fixture();
			const preview = await createVodInputPreviewTask(f.preview);
			await complete(preview.id, f.preview);
			await a.credential.delete({ where: { id: f.credential.id } });
			queue.add.mockClear();
			await expect(getVodInputPreviewTask(f.probe.id)).rejects.toMatchObject({
				code: "SOURCE_CREDENTIAL_NOT_FOUND",
				status: 404,
			});
			await expect(getVodInputPreviewTask(preview.id)).rejects.toMatchObject({
				code: "SOURCE_CREDENTIAL_NOT_FOUND",
				status: 404,
			});
			await expect(createVodInputPreviewTask(f.preview)).rejects.toMatchObject({
				code: "SOURCE_CREDENTIAL_NOT_FOUND",
				status: 404,
			});
			expect(queue.add).not.toHaveBeenCalled();
		});

		it("enforces SQL intent and artifact constraints without corrupting completed rows", async () => {
			const f = await fixture();
			const task = await createVodInputPreviewTask(f.preview);
			const completed = await complete(task.id, f.preview);
			await expect(
				a.vodInputPreviewTask.update({
					where: { id: task.id },
					data: { requestHash: "b".repeat(64) },
				}),
			).rejects.toThrow("VOD input preview intent is immutable");
			await expect(
				a.vodInputPreviewTask.update({
					where: { id: task.id },
					data: { status: "CANCELED" },
				}),
			).rejects.toThrow("VodInputPreviewTask_artifact_check");
			await expect(
				a.vodInputPreviewTask.update({
					where: { id: task.id },
					data: { artifactSize: 0n },
				}),
			).rejects.toThrow("VodInputPreviewTask_artifact_check");
			const pending = await createVodInputPreviewTask(f.request);
			await expect(
				a.vodInputPreviewTask.update({
					where: { id: pending.id },
					data: { artifactPath: "/not-a-complete-preview.mp4" },
				}),
			).rejects.toThrow("VodInputPreviewTask_artifact_check");
			const input = {
				requestHash: hash(f.request),
				request: f.request,
				expiresAt: new Date(Date.now() + 60_000),
			};
			await expect(
				a.vodInputPreviewTask.create({ data: { ...input, kind: "INVALID" } }),
			).rejects.toThrow("VodInputPreviewTask_kind_check");
			await expect(
				a.vodInputPreviewTask.create({
					data: { ...input, kind: "PROBE", status: "INVALID" },
				}),
			).rejects.toThrow("VodInputPreviewTask_status_check");
			expect(
				await a.vodInputPreviewTask.findUniqueOrThrow({
					where: { id: task.id },
				}),
			).toEqual(completed);
			expect(
				(
					await a.vodInputPreviewTask.findUniqueOrThrow({
						where: { id: pending.id },
					})
				).artifactPath,
			).toBeNull();
		});

		it("persists queue failures as valid terminal SQL rows with a sanitized public error", async () => {
			const f = await fixture();
			queue.add.mockRejectedValue(
				new Error("private redis connection diagnostics"),
			);
			await expect(createVodInputPreviewTask(f.preview)).rejects.toMatchObject({
				code: "PREVIEW_QUEUE_UNAVAILABLE",
				status: 503,
			});
			const failed = await a.vodInputPreviewTask.findFirstOrThrow({
				where: { requestHash: hash(f.preview) },
			});
			expect(failed).toMatchObject({
				status: "FAILED",
				stage: "FAILED",
				artifactPath: null,
				artifactToken: null,
				artifactSize: null,
			});
			expect(failed.finishedAt).not.toBeNull();
			expect(await getVodInputPreviewTask(failed.id)).toMatchObject({
				status: "FAILED",
				error: {
					code: "PREVIEW_QUEUE_UNAVAILABLE",
					message: "Preview queue is unavailable. Try again.",
				},
			});
			expect(
				JSON.stringify(await getVodInputPreviewTask(failed.id)),
			).not.toContain("private redis");
		});
	},
);
