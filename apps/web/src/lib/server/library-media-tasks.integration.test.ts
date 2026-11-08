import { randomUUID } from "node:crypto";
import {
	type AppPrismaClient,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import {
	cancelMediaTask,
	createMediaTask,
	readMediaTask,
	retryMediaTask,
} from "./library-media-tasks";

const holder = vi.hoisted(() => ({
	context: null as unknown as ServerContext,
}));
vi.mock("./context", () => ({ getServerContext: async () => holder.context }));
const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL,
	appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL durable production intake",
	() => {
		const org = randomUUID(),
			otherOrg = randomUUID();
		let admin: AppPrismaClient,
			app: AppPrismaClient,
			a: AppPrismaClient,
			b: AppPrismaClient;
		beforeAll(async () => {
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
			a = createTenantPrismaClient(app, org);
			b = createTenantPrismaClient(app, otherOrg);
			for (const id of [org, otherOrg])
				await admin.organization.create({
					data: {
						id,
						name: "Media task API fixture",
						slug: `media-task-${id}`,
					},
				});
		});
		afterAll(async () => {
			try {
				if (!admin) return;
				for (const organizationId of [org, otherOrg]) {
					const where = { organizationId };
					await admin.libraryMediaTask.deleteMany({ where });
					await admin.libraryMediaVersion.deleteMany({ where });
					await admin.librarySource.deleteMany({ where });
					await admin.credential.deleteMany({ where });
					await admin.organization.delete({ where: { id: organizationId } });
				}
			} finally {
				await admin?.$disconnect();
				await app?.$disconnect();
			}
		});
		const use = (prisma = a, organizationId = org) => {
			holder.context = {
				prisma,
				tenant: { organizationId },
			} as unknown as ServerContext;
		};
		async function fixture(client = a) {
			const source = await client.librarySource.create({
				data: {
					sourceKey: randomUUID(),
					originalJobId: randomUUID(),
					encodingId: randomUUID(),
					accountId: randomUUID(),
					snapshot: {},
					locales: [],
				},
			});
			const credential = await client.credential.create({
				data: {
					label: "Task fixture",
					provider: "AWS_S3",
					encryptedSecret: "fixture",
				},
			});
			const id = randomUUID();
			const media = await client.libraryMediaVersion.create({
				data: {
					id,
					sourceId: source.id,
					credentialId: credential.id,
					outputCredentialId: credential.id,
					state: "READY",
					sha256: "a".repeat(64),
					width: 640,
					height: 360,
					durationUs: 2_000_000n,
					fpsNum: 30,
					fpsDen: 1,
					timeMap: {
						id,
						mediaVersionId: id,
						kind: "CFR",
						sourceStartUs: 0,
						sourceEndUs: 2_000_000,
						editingStartFrame: 0,
						editingEndFrame: 60,
						fps: { num: 30, den: 1 },
					},
					probe: {},
					storage: { output: { credentialId: credential.id } },
				},
			});
			return {
				media,
				input: {
					kind: "TRANSCRIBE",
					mediaVersionId: media.id,
					requestKey: randomUUID(),
					parameters: { language: "ja" },
				},
			};
		}
		it("serializes simultaneous duplicate keys and rejects an altered replay", async () => {
			use();
			const f = await fixture();
			const [one, two] = await Promise.all([
				createMediaTask(f.input, "fixture"),
				createMediaTask(f.input, "fixture"),
			]);
			expect(one.taskId).toBe(two.taskId);
			expect(
				await a.libraryMediaTask.count({
					where: { requestKey: f.input.requestKey },
				}),
			).toBe(1);
			await expect(
				createMediaTask(
					{ ...f.input, parameters: { language: "en" } },
					"fixture",
				),
			).rejects.toMatchObject({ code: "REQUEST_KEY_REUSED" });
		});
		it("reuses only exact immutable same-tenant results and records every new request key", async () => {
			use();
			const f = await fixture();
			const first = await createMediaTask(f.input, null);
			await a.libraryMediaTask.update({
				where: { id: first.taskId },
				data: {
					state: "SUCCEEDED",
					phase: "COMPLETE",
					result: { segments: [{ text: "保持" }] },
					finishedAt: new Date(),
				},
			});
			const key = randomUUID(),
				second = await createMediaTask({ ...f.input, requestKey: key }, null);
			expect(second).toMatchObject({ state: "SUCCEEDED", cached: true });
			expect(second.taskId).not.toBe(first.taskId);
			expect((await readMediaTask(second.taskId)).result).toEqual({
				segments: [{ text: "保持" }],
			});
			await expect(
				createMediaTask(
					{ ...f.input, requestKey: key, parameters: { language: "en" } },
					null,
				),
			).rejects.toMatchObject({ code: "REQUEST_KEY_REUSED" });
		});
		it("does not read, mutate or replay a foreign task or foreign media", async () => {
			use();
			const f = await fixture(),
				own = await createMediaTask(f.input, null);
			use(b, otherOrg);
			await expect(readMediaTask(own.taskId)).rejects.toMatchObject({
				code: "TASK_NOT_FOUND",
			});
			await expect(createMediaTask(f.input, null)).rejects.toMatchObject({
				code: "MEDIA_NOT_FOUND",
			});
			const other = await fixture(b);
			const otherTask = await createMediaTask(
				{ ...other.input, requestKey: f.input.requestKey },
				null,
			);
			expect(otherTask.taskId).not.toBe(own.taskId);
			expect(await b.libraryMediaTask.count()).toBe(1);
			use();
			expect((await readMediaTask(own.taskId)).state).toBe("PENDING");
		});
		it("retains canceled history and gives retries immutable child identities", async () => {
			use();
			const f = await fixture(),
				original = await createMediaTask(f.input, null);
			await cancelMediaTask(original.taskId);
			const requestKey = randomUUID(),
				child = await retryMediaTask(
					original.taskId,
					{ requestKey },
					"fixture",
				);
			expect(
				await retryMediaTask(original.taskId, { requestKey }, "fixture"),
			).toEqual(child);
			expect(
				await a.libraryMediaTask.findUnique({ where: { id: original.taskId } }),
			).toMatchObject({ state: "CANCELED", requestKey: f.input.requestKey });
			expect(
				await a.libraryMediaTask.findUnique({ where: { id: child.taskId } }),
			).toMatchObject({
				state: "PENDING",
				parentTaskId: original.taskId,
				requestKey,
			});
			await expect(
				a.libraryMediaTask.update({
					where: { id: original.taskId },
					data: { state: "PENDING" },
				}),
			).rejects.toThrow("Completed media task results are immutable");
		});
		it("stores preparation waiting separately from exact-byte cache identity", async () => {
			use();
			const f = await fixture();
			const pending = await a.libraryMediaVersion.create({
				data: {
					sourceId: f.media.sourceId,
					credentialId: f.media.credentialId,
					outputCredentialId: f.media.outputCredentialId,
					storage: { output: { credentialId: f.media.outputCredentialId } },
				},
			});
			const created = await createMediaTask(
				{ ...f.input, mediaVersionId: pending.id },
				null,
			);
			const row = await a.libraryMediaTask.findUniqueOrThrow({
				where: { id: created.taskId },
			});
			expect(row).toMatchObject({
				state: "PENDING",
				phase: "WAITING_FOR_MEDIA",
				attempts: 0,
			});
			expect(row.parameters).toMatchObject({
				identity: { mediaSha256: null, timeMapHash: null },
			});
		});
	},
);
