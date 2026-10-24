import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SubmitOutcome } from "@bitovp/core";
import {
	type AppPrismaClient,
	type AppTransactionClient,
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
import { claimStableWatchObjects, createWatchSweep } from "./sweep";

const runtimeUrl = process.env.BITOVP_MONITORING_TEST_DATABASE_URL;
const adminUrl = process.env.BITOVP_MONITORING_TEST_ADMIN_URL;

function barrier() {
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { ready, release };
}

async function bounded<T>(pending: Promise<T>, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			pending,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), 4_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function pid(tx: AppTransactionClient) {
	const [row] = await tx.$queryRaw<
		{ pid: number }[]
	>`SELECT pg_backend_pid() AS pid`;
	if (!row) throw new Error("Missing PostgreSQL backend");
	return row.pid;
}

function observeRuleLock(
	base: AppPrismaClient,
	before: (tx: AppTransactionClient) => Promise<void>,
	after: () => Promise<void> = async () => {},
): AppPrismaClient {
	return new Proxy(base, {
		get(target, key) {
			if (key === "$transaction")
				return (
					run: (tx: AppTransactionClient) => Promise<unknown>,
					options: unknown,
				) =>
					target.$transaction(
						async (tx) =>
							run(
								new Proxy(tx, {
									get(transaction, property) {
										if (property === "$queryRaw")
											return async (
												query: TemplateStringsArray,
												...values: unknown[]
											) => {
												const ruleLock = query
													.join("")
													.includes('FROM "WatchRule"');
												if (ruleLock) await before(transaction);
												const result = await transaction.$queryRaw(
													query,
													...values,
												);
												if (ruleLock) await after();
												return result;
											};
										const value = Reflect.get(transaction, property);
										return typeof value === "function"
											? value.bind(transaction)
											: value;
									},
								}),
							),
						options as never,
					);
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

describe.runIf(Boolean(runtimeUrl && adminUrl))(
	"real PostgreSQL watch-folder capacity reservations",
	() => {
		const organizations = [randomUUID(), randomUUID()];
		const now = new Date();
		let admin: AppPrismaClient;
		let runtimeA: AppPrismaClient;
		let runtimeB: AppPrismaClient;
		let first: AppPrismaClient;
		let second: AppPrismaClient;
		let otherTenant: AppPrismaClient;

		beforeAll(async () => {
			for (const value of [runtimeUrl, adminUrl]) {
				if (!value) throw new Error("Missing dedicated PostgreSQL URL");
				const url = new URL(value);
				if (
					!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
					!/^\/bitovp_integration_[a-f0-9]{32}$/.test(url.pathname)
				)
					throw new Error(
						"Watch capacity tests require dedicated loopback PostgreSQL",
					);
			}
			admin = createPrismaClient(adminUrl);
			runtimeA = createPrismaClient(runtimeUrl);
			runtimeB = createPrismaClient(runtimeUrl);
			first = createTenantPrismaClient(runtimeA, organizations[0] as string);
			second = createTenantPrismaClient(runtimeB, organizations[0] as string);
			otherTenant = createTenantPrismaClient(
				runtimeB,
				organizations[1] as string,
			);
			for (const id of organizations)
				await admin.organization.create({
					data: { id, name: "Watch capacity test", slug: id },
				});
		});

		beforeEach(async () => {
			await first.watchRule.updateMany({ data: { enabled: false } });
		});

		afterAll(async () => {
			try {
				if (admin) {
					const where = { organizationId: { in: organizations } };
					await admin.watchedObject.deleteMany({ where });
					await admin.watchRule.deleteMany({ where });
					await admin.encodingJob.deleteMany({ where });
					await admin.preset.deleteMany({ where });
					await admin.credential.deleteMany({ where });
					await admin.organization.deleteMany({
						where: { id: { in: organizations } },
					});
				}
			} finally {
				if (runtimeA) await runtimeA.$disconnect();
				if (runtimeB) await runtimeB.$disconnect();
				if (admin) await admin.$disconnect();
			}
		});

		async function fixture(cap = 1, keys = ["a.mp4", "b.mp4"]) {
			const credential = await first.credential.create({
				data: {
					label: randomUUID(),
					provider: "AWS_S3",
					encryptedSecret: "synthetic-not-decrypted",
				},
			});
			const body = JSON.parse(
				readFileSync(
					join(
						__dirname,
						"../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-dash-hls-streamcondition-on-aws.plan.json",
					),
					"utf8",
				),
			);
			body.bitmovin.accountId = randomUUID();
			const preset = await first.preset.create({
				data: { name: randomUUID(), kind: "FULL_PLAN", body },
			});
			const rule = await first.watchRule.create({
				data: {
					name: randomUUID(),
					credentialId: credential.id,
					bucket: "synthetic-only",
					presetId: preset.id,
					outputPrefixTemplate: "out/{basename}/{uuid}",
					maxConcurrentJobs: cap,
				},
			});
			const objects = [];
			for (const [index, objectKey] of keys.entries())
				objects.push(
					await first.watchedObject.create({
						data: {
							watchRuleId: rule.id,
							objectKey,
							contentId: randomUUID(),
							state: "STABLE",
							stableCount: 2,
							createdAt: new Date(now.getTime() + index),
							updatedAt: now,
						},
					}),
				);
			return { rule, objects };
		}

		async function queuedJob(): Promise<SubmitOutcome> {
			const job = await first.encodingJob.create({
				data: {
					name: "Synthetic watch job",
					plan: {},
					stepLog: {},
					status: "QUEUED",
				},
			});
			return { ok: true, id: job.id, plan: {} as never, issues: [] };
		}

		function sweep(
			prisma: AppPrismaClient,
			submit = queuedJob,
			list = async () => ({ objects: [] }),
		) {
			return createWatchSweep({
				prisma,
				listPage: list,
				submitPlan: submit,
				now: () => now,
				uuid: randomUUID,
			});
		}

		it("keeps the cap while another instance submits outside its transaction", async () => {
			const f = await fixture();
			const entered = barrier();
			const held = barrier();
			const submit = vi.fn(async () => {
				entered.release();
				await held.ready;
				return queuedJob();
			});
			const running = sweep(first, submit)();
			try {
				await bounded(entered.ready, "First submission did not start");
				const otherSubmit = vi.fn(queuedJob);
				await bounded(
					sweep(second, otherSubmit)(),
					"Submission kept the database transaction open",
				);
				expect(otherSubmit).not.toHaveBeenCalled();
				expect(
					await first.watchedObject.count({
						where: { watchRuleId: f.rule.id, state: "SUBMITTED" },
					}),
				).toBe(1);
			} finally {
				held.release();
				await running;
			}
		});

		it("serializes count and claim across two independent PostgreSQL connections", async () => {
			const f = await fixture();
			const owned = barrier();
			const waiting = barrier();
			const held = barrier();
			let owner = 0;
			let waiter = 0;
			const ownerClient = observeRuleLock(
				first,
				async (tx) => {
					owner = await pid(tx);
				},
				async () => {
					owned.release();
					await held.ready;
				},
			);
			const waiterClient = observeRuleLock(second, async (tx) => {
				waiter = await pid(tx);
				waiting.release();
			});
			const a = claimStableWatchObjects(ownerClient, f.rule.id);
			let b: ReturnType<typeof claimStableWatchObjects> | undefined;
			let claims: Awaited<ReturnType<typeof claimStableWatchObjects>>[] = [];
			try {
				await bounded(owned.ready, "First worker did not own the rule lock");
				b = claimStableWatchObjects(waiterClient, f.rule.id);
				await bounded(
					waiting.ready,
					"Second PostgreSQL transaction did not start",
				);
				await bounded(
					(async () => {
						while (true) {
							const [row] = await admin.$queryRaw<{ blocked: boolean }[]>`
							SELECT ${owner}::integer = ANY(pg_blocking_pids(${waiter}::integer)) AS blocked`;
							if (row?.blocked) return;
							await new Promise((resolve) => setTimeout(resolve, 5));
						}
					})(),
					"The second worker bypassed rule ownership",
				);
			} finally {
				held.release();
				claims = await Promise.all([a, b ?? Promise.resolve([])]);
			}
			expect(claims.flat()).toHaveLength(1);
			expect(
				await first.watchedObject.count({
					where: { watchRuleId: f.rule.id, state: "SUBMITTED" },
				}),
			).toBe(1);
		});

		it("does not lock unrelated rules during a reservation", async () => {
			const a = await fixture();
			const b = await fixture();
			const owned = barrier();
			const held = barrier();
			const owner = first.$transaction(
				async (tx) => {
					await tx.$queryRaw`SELECT id FROM "WatchRule" WHERE id = ${a.rule.id}::uuid FOR UPDATE`;
					owned.release();
					await held.ready;
				},
				{ timeout: 10_000 },
			);
			try {
				await bounded(owned.ready, "Rule lock was not acquired");
				expect(
					await bounded(
						claimStableWatchObjects(second, b.rule.id),
						"An unrelated rule was blocked",
					),
				).toHaveLength(1);
			} finally {
				held.release();
				await owner;
			}
		});

		it.each([
			"FINISHED",
			"ERROR",
			"CANCELED",
		] as const)("releases linked capacity when the previous job becomes %s", async (status) => {
			const f = await fixture();
			const [reserved] = await claimStableWatchObjects(first, f.rule.id);
			const job = await first.encodingJob.create({
				data: {
					name: "Terminal watch job",
					plan: {},
					stepLog: {},
					status: "QUEUED",
				},
			});
			await first.watchedObject.update({
				where: { id: reserved?.id },
				data: { encodingJobId: job.id },
			});
			expect(await claimStableWatchObjects(second, f.rule.id)).toHaveLength(0);
			await first.encodingJob.update({
				where: { id: job.id },
				data: { status },
			});
			expect(await claimStableWatchObjects(second, f.rule.id)).toHaveLength(1);
		});

		it("releases refused submissions without automatically retrying that object", async () => {
			const f = await fixture();
			const refused: () => Promise<SubmitOutcome> = async () => ({
				ok: false,
				code: "ACCOUNT_MISSING",
				message: "Synthetic refusal",
			});
			await sweep(first, refused)();
			expect(
				await first.watchedObject.count({
					where: { watchRuleId: f.rule.id, state: "ERROR" },
				}),
			).toBe(1);
			expect(await claimStableWatchObjects(second, f.rule.id)).toHaveLength(1);
		});

		it("reaps an abandoned reservation before admitting a different object", async () => {
			const f = await fixture();
			await first.watchedObject.update({
				where: { id: f.objects[0]?.id },
				data: {
					state: "SUBMITTED",
					updatedAt: new Date(now.getTime() - 16 * 60_000),
				},
			});
			const submit = vi.fn(queuedJob);
			const result = await sweep(first, submit)();
			expect(result.errors).toBeGreaterThanOrEqual(1);
			expect(submit).toHaveBeenCalledTimes(1);
			expect(
				await first.watchedObject.findUnique({
					where: { id: f.objects[0]?.id },
				}),
			).toMatchObject({
				state: "ERROR",
				encodingJobId: null,
			});
		});

		it.each([
			"disable",
			"lower cap",
		] as const)("re-reads the rule before reserving after an administrator selects %s", async (change) => {
			const f = await fixture(3, ["a.mp4", "b.mp4", "c.mp4"]);
			const list = async () => {
				await second.watchRule.update({
					where: { id: f.rule.id },
					data:
						change === "disable"
							? { enabled: false }
							: { maxConcurrentJobs: 1 },
				});
				return { objects: [] };
			};
			const submit = vi.fn(queuedJob);
			await sweep(first, submit, list)();
			expect(submit).toHaveBeenCalledTimes(change === "disable" ? 0 : 1);
		});

		it("cannot read or reserve another tenant's rule by its known UUID", async () => {
			const f = await fixture();
			expect(
				await otherTenant.watchRule.findUnique({ where: { id: f.rule.id } }),
			).toBeNull();
			expect(await claimStableWatchObjects(otherTenant, f.rule.id)).toEqual([]);
			expect(
				await first.watchedObject.count({
					where: { watchRuleId: f.rule.id, state: "STABLE" },
				}),
			).toBe(2);
		});
	},
);
