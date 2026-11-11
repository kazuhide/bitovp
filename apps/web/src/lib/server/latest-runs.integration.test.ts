import { randomUUID } from "node:crypto";
import {
	type AppPrismaClient,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { latestRunsFor } from "./latest-runs";

/**
 * What no double can answer: is the row that the statement returns for a
 * channel really its NEWEST run, and only for channels of the caller's
 * organization?
 *
 * Runs with the PostgreSQL integration fixture. Every row belongs to one of
 * two organizations that this file creates and removes, and the statement is
 * asked for this file's channels only, so other tests may use the same tables.
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
		const otherOrganizationId = randomUUID();
		let admin: AppPrismaClient;
		let runtime: AppPrismaClient;
		let prisma: AppPrismaClient;

		beforeAll(async () => {
			admin = createPrismaClient(adminUrl);
			runtime = createPrismaClient(runtimeUrl);
			for (const id of [organizationId, otherOrganizationId])
				await admin.organization.create({
					data: { id, name: "Latest run probe", slug: id },
				});
			prisma = createTenantPrismaClient(runtime, organizationId);
		});
		afterAll(async () => {
			try {
				for (const id of admin ? [organizationId, otherOrganizationId] : []) {
					const where = { organizationId: id };
					await admin.liveChannelRun.deleteMany({ where });
					await admin.liveChannel.deleteMany({ where });
					await admin.organization.deleteMany({ where: { id } });
				}
			} finally {
				// Both connections close, also after a delete that failed.
				await Promise.allSettled([
					admin?.$disconnect(),
					runtime?.$disconnect(),
				]);
			}
		});

		/** 1, 3 and 7 airings — the shapes a re-aired channel actually reaches. */
		const PLAN = [1, 3, 7];

		/** The channels, and the id of each one's newest run. */
		async function seed(): Promise<{ ids: string[]; newest: string[] }> {
			const ids: string[] = [];
			const newest: string[] = [];
			for (const airings of PLAN) {
				const channel = await prisma.liveChannel.create({
					data: { name: `probe-${airings}`, plan: {} },
					select: { id: true },
				});
				ids.push(channel.id);
				for (let seq = 1; seq <= airings; seq += 1) {
					const run = await prisma.liveChannelRun.create({
						data: {
							liveChannelId: channel.id,
							seq,
							// Only the newest may be non-terminal: the partial unique
							// index allows at most one live run per channel (#108 PR1).
							status: seq === airings ? "RUNNING" : "STOPPED",
							outputPrefix: `runs/${seq}`,
							lastHeartbeat: { at: `2026-08-29T00:00:0${seq}.000Z` },
						},
						select: { id: true },
					});
					if (seq === airings) newest.push(run.id);
				}
			}
			return { ids, newest };
		}

		it("returns the newest run of each channel", async () => {
			const { ids, newest } = await seed();
			const map = await latestRunsFor(prisma, ids);
			expect(map.size).toBe(ids.length);
			expect(ids.map((id) => map.get(id)?.seq)).toEqual(PLAN);
			// The row is that channel's newest run, not another channel's.
			expect(ids.map((id) => map.get(id)?.id)).toEqual(newest);
		});

		it("a channel with no runs is absent, rather than a null row", async () => {
			const { ids } = await seed();
			const empty = await prisma.liveChannel.create({
				data: { name: "probe-never-aired", plan: {} },
				select: { id: true },
			});
			const map = await latestRunsFor(prisma, [...ids, empty.id]);
			expect(map.has(empty.id)).toBe(false);
			expect(map.size).toBe(ids.length);
		});

		// The statement is written by hand, so only row security keeps it inside
		// one organization.
		it("a channel of another organization is absent", async () => {
			const { ids } = await seed();
			const other = createTenantPrismaClient(runtime, otherOrganizationId);
			const foreign = await other.liveChannel.create({
				data: { name: "probe-foreign", plan: {} },
				select: { id: true },
			});
			await other.liveChannelRun.create({
				data: {
					liveChannelId: foreign.id,
					seq: 1,
					status: "RUNNING",
					outputPrefix: "runs/1",
				},
			});
			// Its own organization gets the run; this one does not.
			const own = await latestRunsFor(other, [foreign.id]);
			expect(own.get(foreign.id)?.seq).toBe(1);
			const map = await latestRunsFor(prisma, [...ids, foreign.id]);
			expect(map.has(foreign.id)).toBe(false);
			expect(map.size).toBe(ids.length);
		});
	},
);
