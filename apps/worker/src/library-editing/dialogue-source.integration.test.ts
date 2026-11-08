import { randomBytes, randomUUID } from "node:crypto";
import { AesGcmCipher } from "@bitovp/core";
import {
	type AppPrismaClient,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DIALOGUE_SOURCE_ID } from "./dialogue-fixture";
import {
	DIALOGUE_ACCOUNT_ID,
	DIALOGUE_ENCODING_ID,
	DIALOGUE_JOB_ID,
	ensureDialoguePreviewSource,
} from "./dialogue-source";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL,
	appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL dialogue source origin admission",
	() => {
		const organizationId = randomUUID(),
			cipher = new AesGcmCipher(randomBytes(32));
		let admin: AppPrismaClient, app: AppPrismaClient, db: AppPrismaClient;
		beforeAll(async () => {
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
			db = createTenantPrismaClient(app, organizationId);
			await admin.organization.create({
				data: {
					id: organizationId,
					slug: `dialogue-origin-${organizationId}`,
					name: "Isolated dialogue origin fixture",
				},
			});
		});
		afterAll(async () => {
			try {
				if (!admin) return;
				const where = { organizationId };
				await admin.librarySource.deleteMany({ where });
				await admin.encodingJob.deleteMany({ where });
				await admin.bitmovinAccount.deleteMany({ where });
				await admin.organization.delete({ where: { id: organizationId } });
			} finally {
				await admin?.$disconnect();
				await app?.$disconnect();
			}
		});
		const seed = () =>
			db.$transaction((tx) =>
				ensureDialoguePreviewSource(tx, { organizationId, cipher }),
			);
		const snapshot = async () => ({
			account: await db.bitmovinAccount.findUniqueOrThrow({
				where: { id: DIALOGUE_ACCOUNT_ID },
				select: {
					id: true,
					organizationId: true,
					label: true,
					defaults: true,
					tenantOrgId: true,
					encryptedApiKey: true,
					createdAt: true,
					updatedAt: true,
				},
			}),
			job: await db.encodingJob.findUniqueOrThrow({
				where: { id: DIALOGUE_JOB_ID },
			}),
			source: await db.librarySource.findUniqueOrThrow({
				where: { id: DIALOGUE_SOURCE_ID },
			}),
		});
		it("creates a VOD source under the real kind check with matching local account/job/encoding rows", async () => {
			const result = await seed(),
				rows = await snapshot();
			expect(result.created).toBe(true);
			expect(rows.source).toMatchObject({
				organizationId,
				sourceKind: "VOD_JOB",
				jobId: rows.job.id,
				originalJobId: rows.job.id,
				encodingId: rows.job.bitmovinEncodingId,
				accountId: rows.account.id,
				renderArtifactId: null,
			});
			expect(rows.job).toMatchObject({
				status: "FINISHED",
				bitmovinAccountId: rows.account.id,
				bitmovinEncodingId: DIALOGUE_ENCODING_ID,
				libraryCaptureSuppressed: true,
				plan: { fixtureOnly: true, providerExecution: false },
			});
			expect(rows.source.snapshot).toMatchObject({ identity: "UNVERIFIED" });
		});
		it("preserves the full second seed and refuses a changed origin without repairing it", async () => {
			await seed();
			const before = await snapshot();
			expect((await seed()).created).toBe(false);
			expect(await snapshot()).toEqual(before);
			await db.encodingJob.update({
				where: { id: DIALOGUE_JOB_ID },
				data: { name: "Operator changed local fixture" },
			});
			const changed = await snapshot();
			await expect(seed()).rejects.toThrow("PREVIEW_DIALOGUE_ORIGIN_CHANGED");
			expect(await snapshot()).toEqual(changed);
			expect(await db.librarySource.count()).toBe(1);
			expect(await db.encodingJob.count()).toBe(1);
			expect(await db.bitmovinAccount.count()).toBe(1);
		});
	},
);
