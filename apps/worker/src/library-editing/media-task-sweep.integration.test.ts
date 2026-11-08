import { randomUUID } from "node:crypto";
import {
	DEFAULT_ASR_MODEL_SHA256,
	hashEditingEvidence,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskIntentHash,
} from "@bitovp/core";
import {
	type AppPrismaClient,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLibraryMediaTaskSweep } from "./media-task-sweep";

const execute = vi.hoisted(() => vi.fn());
vi.mock("./media-task-execution", async (original) => ({
	...(await original<object>()),
	executeMediaTask: execute,
}));
const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL,
	appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL production queue claims",
	() => {
		const organizationId = randomUUID();
		let admin: AppPrismaClient,
			app: AppPrismaClient,
			a: AppPrismaClient,
			credentialId: string;
		beforeAll(async () => {
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
			a = createTenantPrismaClient(app, organizationId);
			await admin.organization.create({
				data: {
					id: organizationId,
					name: "Queue fixture",
					slug: `queue-${organizationId}`,
				},
			});
			credentialId = (
				await a.credential.create({
					data: {
						label: "Queue fixture",
						provider: "AWS_S3",
						encryptedSecret: "fixture",
					},
				})
			).id;
		});
		afterAll(async () => {
			try {
				if (!admin) return;
				const where = { organizationId };
				await admin.libraryMediaTask.deleteMany({ where });
				await admin.libraryMediaVersion.deleteMany({ where });
				await admin.librarySource.deleteMany({ where });
				await admin.credential.deleteMany({ where });
				await admin.organization.delete({ where: { id: organizationId } });
			} finally {
				await admin?.$disconnect();
				await app?.$disconnect();
			}
		});
		async function fixture(ready = true) {
			const source = await a.librarySource.create({
				data: {
					sourceKey: randomUUID(),
					originalJobId: randomUUID(),
					encodingId: randomUUID(),
					accountId: randomUUID(),
					snapshot: {},
					locales: [],
				},
			});
			const mediaId = randomUUID(),
				map = {
					id: mediaId,
					mediaVersionId: mediaId,
					kind: "CFR",
					sourceStartUs: 0,
					sourceEndUs: 2_000_000,
					editingStartFrame: 0,
					editingEndFrame: 60,
					fps: { num: 30, den: 1 },
				};
			const media = await a.libraryMediaVersion.create({
				data: {
					id: mediaId,
					sourceId: source.id,
					credentialId,
					outputCredentialId: credentialId,
					storage: { output: { credentialId } },
					...(ready
						? {
								state: "READY",
								sha256: "a".repeat(64),
								width: 640,
								height: 360,
								durationUs: 2_000_000n,
								fpsNum: 30,
								fpsDen: 1,
								timeMap: map,
								probe: {},
							}
						: {}),
				},
			});
			const input = mediaTaskCreateSchema.parse({
				kind: "TRANSCRIBE",
				mediaVersionId: media.id,
				requestKey: randomUUID(),
				parameters: { language: "ja" },
			});
			const identity = {
				organizationId,
				mediaSha256: ready ? media.sha256 : null,
				modelSha256: DEFAULT_ASR_MODEL_SHA256,
				analysisDocumentHash: null,
				analysisRawHash: null,
				timeMapHash: ready ? hashEditingEvidence(map) : null,
				bindingHash: null,
			};
			const data = {
				organizationId,
				mediaVersionId: media.id,
				kind: input.kind,
				requestKey: input.requestKey,
				requestHash: mediaTaskIntentHash(input),
				cacheKey: mediaTaskCacheKey(input, identity),
				parameters: { schemaVersion: 1, input, identity },
			};
			const task = await a.libraryMediaTask.create({ data });
			return { media, map, task, data };
		}
		const sweep = (now = () => new Date()) =>
			createLibraryMediaTaskSweep({
				canClaim: async () => true,
				prisma: a,
				browserFor: vi.fn(),
				concurrency: 2,
				now,
			});
		it("serializes duplicate-cache execution across concurrent sweep factories", async () => {
			const f = await fixture();
			const parameters = f.data.parameters;
			const requestKey = randomUUID(),
				input = { ...parameters.input, requestKey };
			const second = await a.libraryMediaTask.create({
				data: {
					...f.data,
					requestKey,
					requestHash: mediaTaskIntentHash(input),
					parameters: { ...parameters, input },
				},
			});
			let release!: () => void, started!: () => void;
			const startedPromise = new Promise<void>((resolve) => {
					started = resolve;
				}),
				hold = new Promise<void>((resolve) => {
					release = resolve;
				});
			execute.mockReset();
			execute.mockImplementation(async () => {
				started();
				await hold;
				return { actual: "one execution" };
			});
			const running = Promise.allSettled([sweep()(), sweep()()]);
			try {
				await startedPromise;
				const deadline = Date.now() + 3_000;
				let waiting = false;
				while (Date.now() < deadline) {
					const row = await a.libraryMediaTask.findUnique({
						where: { id: second.id },
					});
					if (row?.phase === "WAITING_FOR_CACHE") {
						waiting = true;
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				expect(waiting).toBe(true);
				expect(execute).toHaveBeenCalledOnce();
			} finally {
				release();
				await running;
			}
			await sweep(() => new Date(Date.now() + 10_000))();
			expect(
				await a.libraryMediaTask.findUnique({ where: { id: f.task.id } }),
			).toMatchObject({ state: "SUCCEEDED", attempts: 1 });
			expect(
				await a.libraryMediaTask.findUnique({ where: { id: second.id } }),
			).toMatchObject({ state: "SUCCEEDED", phase: "CACHED", attempts: 0 });
			expect(execute).toHaveBeenCalledOnce();
		});
		it("waits without attempts and runs once after immutable media preparation completes", async () => {
			const f = await fixture(false);
			execute.mockReset();
			execute.mockResolvedValue({ complete: true });
			await sweep()();
			expect(
				await a.libraryMediaTask.findUnique({ where: { id: f.task.id } }),
			).toMatchObject({
				state: "PENDING",
				phase: "WAITING_FOR_MEDIA",
				attempts: 0,
			});
			expect(execute).not.toHaveBeenCalled();
			await a.libraryMediaVersion.update({
				where: { id: f.media.id },
				data: {
					state: "READY",
					sha256: "a".repeat(64),
					width: 640,
					height: 360,
					durationUs: 2_000_000n,
					fpsNum: 30,
					fpsDen: 1,
					timeMap: f.map,
					probe: {},
				},
			});
			await sweep(() => new Date(Date.now() + 10_000))();
			expect(
				await a.libraryMediaTask.findUnique({ where: { id: f.task.id } }),
			).toMatchObject({ state: "SUCCEEDED", attempts: 1, phase: "COMPLETE" });
		});
		it("observes cancellation before result publication and preserves no result", async () => {
			const f = await fixture();
			execute.mockReset();
			execute.mockImplementation(async () => {
				await a.libraryMediaTask.update({
					where: { id: f.task.id },
					data: { cancelRequestedAt: new Date() },
				});
				return { mustNotPublish: true };
			});
			await sweep()();
			expect(
				await a.libraryMediaTask.findUnique({ where: { id: f.task.id } }),
			).toMatchObject({ state: "CANCELED", phase: "CANCELED", result: null });
		});
		it("recovers an expired owner through a new token and refuses an exhausted task", async () => {
			const f = await fixture();
			execute.mockReset();
			execute.mockResolvedValue({ recovered: true });
			const token = randomUUID();
			await a.libraryMediaTask.update({
				where: { id: f.task.id },
				data: {
					state: "RUNNING",
					attempts: 1,
					leaseToken: token,
					leaseUntil: new Date(Date.now() - 1),
				},
			});
			await sweep()();
			expect(
				await a.libraryMediaTask.findUnique({ where: { id: f.task.id } }),
			).toMatchObject({
				state: "SUCCEEDED",
				attempts: 2,
				leaseToken: null,
				result: { recovered: true },
			});
			const exhausted = await fixture();
			await a.libraryMediaTask.update({
				where: { id: exhausted.task.id },
				data: {
					state: "RUNNING",
					attempts: 3,
					leaseToken: randomUUID(),
					leaseUntil: new Date(Date.now() - 1),
				},
			});
			await sweep()();
			expect(
				await a.libraryMediaTask.findUnique({
					where: { id: exhausted.task.id },
				}),
			).toMatchObject({ state: "ERROR", error: "TASK_ATTEMPTS_EXHAUSTED" });
		});
	},
);
