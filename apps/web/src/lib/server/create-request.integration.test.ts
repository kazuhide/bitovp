import { randomUUID } from "node:crypto";
import {
	type AppPrismaClient,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	isCreateRequestUniqueConflict,
	lookupCreateRequest,
	recordCreateRequest,
} from "./create-request";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;

describe.runIf(Boolean(adminUrl && appUrl))(
	"create receipt errors from real restricted PostgreSQL",
	() => {
		const organizationId = randomUUID();
		let admin: AppPrismaClient;
		let app: AppPrismaClient;
		let tenant: AppPrismaClient;

		beforeAll(async () => {
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
			tenant = createTenantPrismaClient(app, organizationId);
			await admin.organization.create({
				data: {
					id: organizationId,
					name: "Create receipt",
					slug: organizationId,
				},
			});
		});

		afterAll(async () => {
			try {
				if (admin) {
					const where = { organizationId };
					await admin.createRequest.deleteMany({ where });
					await admin.encodingJob.deleteMany({ where });
					await admin.liveChannel.deleteMany({ where });
					await admin.organization.deleteMany({
						where: { id: organizationId },
					});
				}
			} finally {
				await app?.$disconnect();
				await admin?.$disconnect();
			}
		});

		it.each([
			"VOD_JOB",
			"LIVE_CHANNEL",
		] as const)("recognizes a %s receipt collision and rolls back its candidate resource", async (kind) => {
			const identity = {
				requestKey: randomUUID(),
				requestSha256: "a".repeat(64),
			};
			const originalId = randomUUID();
			const candidateId = randomUUID();
			const create = (id: string) =>
				tenant.$transaction(async (tx) => {
					const data = { id, name: "Receipt candidate", plan: {} };
					if (kind === "VOD_JOB") await tx.encodingJob.create({ data });
					else await tx.liveChannel.create({ data });
					await recordCreateRequest(tx, kind, identity, id);
				});
			await create(originalId);
			const failure = await create(candidateId).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(isCreateRequestUniqueConflict(failure)).toBe(true);
			expect(await lookupCreateRequest(tenant, kind, identity)).toEqual({
				kind: "existing",
				resourceId: originalId,
			});
			const candidate =
				kind === "VOD_JOB"
					? await tenant.encodingJob.findUnique({ where: { id: candidateId } })
					: await tenant.liveChannel.findUnique({ where: { id: candidateId } });
			expect(candidate).toBeNull();
		});

		it("does not classify an unrelated resource constraint as a receipt collision", async () => {
			const data = { id: randomUUID(), name: "Existing resource", plan: {} };
			await tenant.encodingJob.create({ data });
			const failure = await tenant.encodingJob.create({ data }).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(failure).toMatchObject({ code: "P2002" });
			expect(isCreateRequestUniqueConflict(failure)).toBe(false);
		});
	},
);
