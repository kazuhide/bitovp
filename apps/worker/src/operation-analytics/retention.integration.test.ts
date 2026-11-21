import { randomUUID } from "node:crypto";
import { createPrismaClient, createTenantPrismaClient } from "@bitovp/db";
import { expect, it } from "vitest";
import { pruneOperationAttempts } from "./retention";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;

it.runIf(Boolean(adminUrl && appUrl))(
	"prunes expired pending and completed attempts within the tenant only",
	async () => {
		for (const url of [adminUrl, appUrl]) {
			const database = new URL(url ?? "");
			expect(database.hostname).toBe("127.0.0.1");
			expect(database.pathname).toMatch(/^\/bitovp_integration_[a-f0-9]{32}$/);
		}
		const admin = createPrismaClient(adminUrl);
		const app = createPrismaClient(appUrl);
		const orgA = randomUUID();
		const orgB = randomUUID();
		const a = createTenantPrismaClient(app, orgA);
		const b = createTenantPrismaClient(app, orgB);
		const now = new Date("2026-11-21T03:00:00.000Z");
		const cutoff = new Date("2026-08-23T03:00:00.000Z");
		const expired = new Date(cutoff.getTime() - 1);
		const attempt = (startedAt: Date) => ({
			id: randomUUID(),
			operation: "LIVE_MOQ_PLAYBACK" as const,
			ownerDigest: "a".repeat(64),
			startedAt,
		});
		try {
			await admin.organization.createMany({
				data: [orgA, orgB].map((id) => ({
					id,
					name: "Retention test",
					slug: id,
				})),
			});
			const edge = attempt(cutoff);
			await a.operationAttempt.createMany({
				data: [
					attempt(expired),
					{ ...attempt(expired), outcome: "FIRST_FRAME", elapsedMs: 500 },
					edge,
				],
			});
			const other = await b.operationAttempt.create({ data: attempt(expired) });

			await expect(pruneOperationAttempts(a, now)).resolves.toEqual({
				count: 2,
			});
			expect(
				await a.operationAttempt.findMany({ select: { id: true } }),
			).toEqual([{ id: edge.id }]);
			expect(await b.operationAttempt.findMany()).toEqual([other]);
			await expect(pruneOperationAttempts(a, now)).resolves.toEqual({
				count: 0,
			});
		} finally {
			try {
				await admin.operationAttempt.deleteMany({
					where: { organizationId: { in: [orgA, orgB] } },
				});
				await admin.organization.deleteMany({
					where: { id: { in: [orgA, orgB] } },
				});
			} finally {
				await Promise.all([admin.$disconnect(), app.$disconnect()]);
			}
		}
	},
);
