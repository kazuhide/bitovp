import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FeederStatus } from "../generated/client";
import { type AppPrismaClient, createPrismaClient } from "./client";
import { claimFeederSinglePassDispatch } from "./feeder-single-pass";
import { createTenantPrismaClient } from "./tenant-client";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;

function barrier() {
	let release = () => {};
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { ready, release };
}

describe.runIf(Boolean(adminUrl && appUrl))(
	"PostgreSQL single-pass dispatch fence",
	() => {
		let admin: AppPrismaClient;
		let credentialId: string;
		const organizationId = randomUUID();
		const runtimes = new Set<AppPrismaClient>();
		beforeAll(async () => {
			for (const value of [adminUrl, appUrl]) {
				if (!value)
					throw new Error("Dedicated single-pass test URLs are required");
				const url = new URL(value);
				if (
					url.hostname !== "127.0.0.1" ||
					!/^\/bitovp_integration_[a-f0-9]{32}$/.test(url.pathname)
				) {
					throw new Error(
						"Single-pass tests require a dedicated loopback PostgreSQL fixture",
					);
				}
			}
			admin = createPrismaClient(adminUrl);
			await admin.organization.create({
				data: {
					id: organizationId,
					name: "Single-pass fixture",
					slug: organizationId,
				},
			});
			const credential = await admin.credential.create({
				data: {
					organizationId,
					label: "Synthetic single-pass input",
					provider: "AWS_S3",
					encryptedSecret: "unused-synthetic-secret",
				},
			});
			credentialId = credential.id;
		});
		afterAll(async () => {
			try {
				if (admin) {
					await admin.liveChannel.deleteMany({ where: { organizationId } });
					await admin.credential.deleteMany({ where: { organizationId } });
					await admin.organization.deleteMany({
						where: { id: organizationId },
					});
				}
			} finally {
				await Promise.all(
					[...runtimes].map((runtime) => runtime.$disconnect()),
				);
				await admin?.$disconnect();
			}
		});
		function client(tenantId = organizationId) {
			const url = new URL(appUrl as string);
			url.searchParams.set("connection_limit", "1");
			const runtime = createPrismaClient(url.toString());
			runtimes.add(runtime);
			return { runtime, tenant: createTenantPrismaClient(runtime, tenantId) };
		}
		async function fixture(
			overrides: {
				publisherClaimedAt?: Date | null;
				publisherReleasedAt?: Date | null;
				ownerId?: string;
				ownerGeneration?: number;
				playbackMode?: string;
				status?: FeederStatus;
			} = {},
		) {
			const { tenant } = client();
			const channel = await tenant.liveChannel.create({
				data: { name: "Single-pass fixture", status: "RUNNING", plan: {} },
			});
			const row = await tenant.feederSession.create({
				data: {
					liveChannelId: channel.id,
					sourceCredentialId: credentialId,
					sourceBucket: "fixture",
					sourceKey: "full.mp4",
					protocol: "RTMP",
					target: { url: "rtmp://example.invalid/live", streamKey: "fixture" },
					status: "DOWNLOADING",
					playbackMode: "ONCE",
					ownerId: "first-owner",
					ownerGeneration: 1,
					publisherClaimedAt: new Date(),
					...overrides,
				},
			});
			return {
				row,
				tenant,
				fence: { id: row.id, ownerId: "first-owner", ownerGeneration: 1 },
			};
		}
		async function backend(runtime: AppPrismaClient) {
			const [row] = await runtime.$queryRaw<
				{ pid: number }[]
			>`SELECT pg_backend_pid() AS pid`;
			if (!row) throw new Error("Missing PostgreSQL backend");
			return row.pid;
		}
		async function waitForBothBlocked(first: number, second: number) {
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				const [row] = await admin.$queryRaw<{ blocked: boolean }[]>`
				SELECT cardinality(pg_blocking_pids(${first}::integer)) > 0
				AND cardinality(pg_blocking_pids(${second}::integer)) > 0 AS blocked`;
				if (row?.blocked) return;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			throw new Error(
				"Both single-pass writers did not overlap at the row lock",
			);
		}

		it("allows exactly one of two genuinely concurrent connections to dispatch the same source", async () => {
			const f = await fixture();
			const first = client();
			const second = client();
			const firstPid = await backend(first.runtime);
			const secondPid = await backend(second.runtime);
			expect(firstPid).not.toBe(secondPid);
			const held = barrier();
			const release = barrier();
			const owner = admin.$transaction(
				async (tx) => {
					await tx.$queryRaw`SELECT id FROM "FeederSession" WHERE id = ${f.row.id}::uuid FOR UPDATE`;
					held.release();
					await release.ready;
				},
				{ timeout: 15_000 },
			);
			let attempts: Promise<boolean>[] = [];
			const at = [
				new Date("2026-11-09T12:00:00.001Z"),
				new Date("2026-11-09T12:00:00.002Z"),
			] as const;
			try {
				await Promise.race([
					held.ready,
					owner.then(() => {
						throw new Error("Row lock ended before its barrier");
					}),
				]);
				attempts = [
					claimFeederSinglePassDispatch(first.tenant, f.fence, at[0]),
					claimFeederSinglePassDispatch(second.tenant, f.fence, at[1]),
				];
				await waitForBothBlocked(firstPid, secondPid);
			} finally {
				release.release();
				await Promise.allSettled([owner, ...attempts]);
			}
			await owner;
			const result = await Promise.all(attempts);
			expect(result.filter(Boolean)).toHaveLength(1);
			const row = await f.tenant.feederSession.findUniqueOrThrow({
				where: { id: f.row.id },
			});
			expect(row.playbackDispatchedAt).toEqual(at[result.indexOf(true)]);
		});

		it("retains a committed dispatch marker across disconnect and a new owner without replay", async () => {
			const f = await fixture();
			const first = client();
			const at = new Date("2026-11-09T12:00:01.123Z");
			expect(
				await claimFeederSinglePassDispatch(first.tenant, f.fence, at),
			).toBe(true);
			await first.runtime.$disconnect();
			const replacement = client();
			expect(
				(
					await replacement.tenant.feederSession.findUniqueOrThrow({
						where: { id: f.row.id },
					})
				).playbackDispatchedAt,
			).toEqual(at);
			await replacement.tenant.feederSession.update({
				where: { id: f.row.id },
				data: { ownerId: "replacement-owner", ownerGeneration: 2 },
			});
			expect(
				await claimFeederSinglePassDispatch(
					replacement.tenant,
					{
						id: f.row.id,
						ownerId: "replacement-owner",
						ownerGeneration: 2,
					},
					new Date(),
				),
			).toBe(false);
			expect(
				(
					await replacement.tenant.feederSession.findUniqueOrThrow({
						where: { id: f.row.id },
					})
				).playbackDispatchedAt,
			).toEqual(at);
		});

		it("refuses missing rows, unheld publishers, stale owners, wrong modes and non-staging states", async () => {
			const variants = [
				{ publisherClaimedAt: null },
				{ publisherReleasedAt: new Date() },
				{ ownerId: "different-owner" },
				{ ownerGeneration: 2 },
				{ playbackMode: "LOOP" },
				{ status: "PUSHING" as const },
			];
			for (const variant of variants) {
				const f = await fixture(variant);
				expect(
					await claimFeederSinglePassDispatch(f.tenant, f.fence, new Date()),
				).toBe(false);
				expect(
					(
						await f.tenant.feederSession.findUniqueOrThrow({
							where: { id: f.row.id },
						})
					).playbackDispatchedAt,
				).toBeNull();
			}
			const f = await fixture();
			expect(
				await claimFeederSinglePassDispatch(
					f.tenant,
					{ ...f.fence, id: randomUUID() },
					new Date(),
				),
			).toBe(false);
			const foreign = client(randomUUID());
			expect(
				await claimFeederSinglePassDispatch(
					foreign.tenant,
					f.fence,
					new Date(),
				),
			).toBe(false);
		});

		it("enforces the migrated LOOP default and rejects unknown playback modes in PostgreSQL", async () => {
			const f = await fixture();
			const [column] = await admin.$queryRaw<
				{ column_default: string | null; is_nullable: string }[]
			>`
			SELECT column_default, is_nullable FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'FeederSession' AND column_name = 'playbackMode'`;
			expect(column?.column_default).toContain("'LOOP'");
			expect(column?.is_nullable).toBe("NO");
			await admin.$executeRaw`UPDATE "FeederSession" SET "playbackMode" = DEFAULT WHERE id = ${f.row.id}::uuid`;
			expect(
				(
					await f.tenant.feederSession.findUniqueOrThrow({
						where: { id: f.row.id },
					})
				).playbackMode,
			).toBe("LOOP");
			await expect(
				admin.$executeRaw`UPDATE "FeederSession" SET "playbackMode" = 'UNKNOWN' WHERE id = ${f.row.id}::uuid`,
			).rejects.toMatchObject({ code: "P2010", meta: { code: "23514" } });
			expect(
				(
					await f.tenant.feederSession.findUniqueOrThrow({
						where: { id: f.row.id },
					})
				).playbackMode,
			).toBe("LOOP");
		});
	},
);
