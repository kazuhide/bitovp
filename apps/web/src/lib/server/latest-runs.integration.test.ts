import { randomUUID } from "node:crypto";
import {
	type AppPrismaClient,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { latestRunsFor } from "./latest-runs";

/**
 * What no double can answer: does the statement really return one row per
 * channel, and is it really the NEWEST one?
 *
 * Runs with the PostgreSQL integration fixture. Every row belongs to an
 * organization that this file creates and removes, and the statement is asked
 * for this file's channels only, so other tests may use the same tables.
 *
 * A broken statement shows in the first test: `LIMIT 5` gives seq [1, 1, 3],
 * because the map keeps the last row it is handed per channel, and
 * `ORDER BY r."seq" ASC` gives [1, 1, 1], the oldest airing of each channel.
 */
const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const runtimeUrl = process.env.BITOVP_TENANT_TEST_APP_URL;

describe.runIf(Boolean(adminUrl && runtimeUrl))(
	"latestRunsFor against a real Postgres",
	() => {
		const organizationId = randomUUID();
		let admin: AppPrismaClient;
		let runtime: AppPrismaClient;
		let prisma: AppPrismaClient;

		beforeAll(async () => {
			admin = createPrismaClient(adminUrl);
			runtime = createPrismaClient(runtimeUrl);
			await admin.organization.create({
				data: {
					id: organizationId,
					name: "Latest run probe",
					slug: organizationId,
				},
			});
			prisma = createTenantPrismaClient(runtime, organizationId);
		});
		afterAll(async () => {
			if (admin) {
				const where = { organizationId };
				await admin.liveChannelRun.deleteMany({ where });
				await admin.liveChannel.deleteMany({ where });
				await admin.organization.deleteMany({ where: { id: organizationId } });
				await admin.$disconnect();
			}
			if (runtime) await runtime.$disconnect();
		});

		/** 1, 3 and 7 airings — the shapes a re-aired channel actually reaches. */
		const PLAN = [1, 3, 7];

		async function seed(): Promise<string[]> {
			const ids: string[] = [];
			for (const airings of PLAN) {
				const channel = await prisma.liveChannel.create({
					data: { name: `probe-${airings}`, plan: {} },
					select: { id: true },
				});
				ids.push(channel.id);
				for (let seq = 1; seq <= airings; seq += 1) {
					await prisma.liveChannelRun.create({
						data: {
							liveChannelId: channel.id,
							seq,
							// Only the newest may be non-terminal: the partial unique
							// index allows at most one live run per channel (#108 PR1).
							status: seq === airings ? "RUNNING" : "STOPPED",
							outputPrefix: `runs/${seq}`,
							lastHeartbeat: { at: `2026-08-29T00:00:0${seq}.000Z` },
						},
					});
				}
			}
			return ids;
		}

		it("returns exactly one row per channel, and it is the newest seq", async () => {
			const ids = await seed();
			const map = await latestRunsFor(prisma, ids);
			expect(map.size).toBe(ids.length);
			expect(ids.map((id) => map.get(id)?.seq)).toEqual(PLAN);
			// The row really is that run's, not another channel's newest.
			for (const id of ids) {
				expect(map.get(id)?.liveChannelId).toBe(id);
			}
		});

		it("a channel with no runs is absent, rather than a null row", async () => {
			const ids = await seed();
			const empty = await prisma.liveChannel.create({
				data: { name: "probe-never-aired", plan: {} },
				select: { id: true },
			});
			const map = await latestRunsFor(prisma, [...ids, empty.id]);
			expect(map.has(empty.id)).toBe(false);
			expect(map.size).toBe(ids.length);
		});
	},
);
