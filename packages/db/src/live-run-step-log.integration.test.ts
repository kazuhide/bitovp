import { randomUUID } from "node:crypto";
import { readLiveAutoShutdownUpdate, type StepLogEntry } from "@bitovp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	createPrismaClient,
} from "./client";
import type { LiveEffectClaimHandle } from "./live-effect-claim";
import {
	appendLiveEffectStepLogEntry,
	replaceLiveRunStepLogSnapshot,
} from "./step-log";
import { createTenantPrismaClient } from "./tenant-client";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
const slate: StepLogEntry = {
	step: "slate",
	kind: "SLATE_INSERTED",
	status: "RUNNING",
	payload: {},
	refs: {},
};
function receipt(requestId: string): StepLogEntry {
	return {
		step: requestId,
		kind: "LIVE_AUTO_SHUTDOWN_UPDATE",
		status: "DONE",
		refs: {},
		payload: {
			requestId,
			configuration: {},
			appliedAt: "2026-10-21T00:00:00.000Z",
		},
	};
}
function barrier() {
	let release = () => {};
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { ready, release };
}
async function pid(tx: AppTransactionClient) {
	const [row] = await tx.$queryRaw<
		{ pid: number }[]
	>`SELECT pg_backend_pid() AS pid`;
	if (!row) throw new Error("Missing PostgreSQL backend");
	return row.pid;
}
function instrument(
	client: AppPrismaClient,
	started: (pid: number) => void,
	afterRunWrite?: () => Promise<void>,
): AppPrismaClient {
	return new Proxy(client, {
		get(target, key) {
			if (key === "$transaction")
				return (fn: (tx: AppTransactionClient) => Promise<unknown>) =>
					target.$transaction(
						async (tx) => {
							started(await pid(tx));
							const decorated = new Proxy(tx, {
								get(inner, member) {
									if (member === "$executeRaw")
										return async (
											query: TemplateStringsArray,
											...values: unknown[]
										) => {
											const result = await inner.$executeRaw(query, ...values);
											if (query.join(" ").includes('UPDATE "LiveChannelRun"'))
												await afterRunWrite?.();
											return result;
										};
									const value = Reflect.get(inner, member);
									return typeof value === "function"
										? value.bind(inner)
										: value;
								},
							});
							return fn(decorated);
						},
						{ timeout: 15_000, maxWait: 5_000 },
					);
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
async function reach(ready: Promise<void>, operation: Promise<unknown>) {
	await Promise.race([
		ready,
		operation.then(() => {
			throw new Error("Operation settled before its barrier");
		}),
	]);
}
async function blockedBy(
	admin: AppPrismaClient,
	waiter: number,
	owner: number,
) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const [row] = await admin.$queryRaw<
			{ blocked: boolean }[]
		>`SELECT ${owner}::integer = ANY(pg_blocking_pids(${waiter}::integer)) AS blocked`;
		if (row?.blocked) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Concurrent step-log writer did not wait for its owner");
}

describe.runIf(Boolean(adminUrl && appUrl))(
	"PostgreSQL canonical live stop receipts",
	() => {
		let admin: AppPrismaClient;
		let runtime: AppPrismaClient;
		let tenant: AppPrismaClient;
		const organizationId = randomUUID();
		beforeAll(async () => {
			for (const value of [adminUrl, appUrl]) {
				if (!value)
					throw new Error("Dedicated step-log test URLs are required");
				const url = new URL(value);
				if (
					url.hostname !== "127.0.0.1" ||
					!/^\/bitovp_integration_[a-f0-9]{32}$/.test(url.pathname)
				)
					throw new Error(
						"Step-log tests require a dedicated loopback PostgreSQL fixture",
					);
			}
			admin = createPrismaClient(adminUrl);
			runtime = createPrismaClient(appUrl);
			await admin.organization.create({
				data: {
					id: organizationId,
					name: "Step-log test",
					slug: organizationId,
				},
			});
			tenant = createTenantPrismaClient(runtime, organizationId);
		});
		afterAll(async () => {
			try {
				if (admin) {
					await admin.liveChannel.deleteMany({ where: { organizationId } });
					await admin.organization.delete({ where: { id: organizationId } });
				}
			} finally {
				await runtime?.$disconnect();
				await admin?.$disconnect();
			}
		});
		async function fixture() {
			const encodingId = `step-log-${randomUUID()}`;
			const channel = await tenant.liveChannel.create({
				data: {
					name: "Step-log test",
					status: "RUNNING",
					plan: {},
					bitmovinEncodingId: encodingId,
					liveEffectFenceVersion: 1,
				},
			});
			const run = await tenant.liveChannelRun.create({
				data: {
					liveChannelId: channel.id,
					seq: 1,
					status: "RUNNING",
					bitmovinEncodingId: encodingId,
					outputPrefix: "",
				},
			});
			return { channel, run, encodingId };
		}
		type Fixture = Awaited<ReturnType<typeof fixture>>;
		async function claim(
			f: Fixture,
			generation: number,
			state: "AMBIGUOUS" | "DISPATCHING" = "AMBIGUOUS",
		): Promise<LiveEffectClaimHandle> {
			const idempotencyKey = `manual:auto-shutdown:${f.channel.id}:${randomUUID()}`;
			const row = await tenant.liveEffectClaim.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					providerEncodingId: f.encodingId,
					action: "AUTO_SHUTDOWN_UPDATE",
					generation,
					state,
					idempotencyKey,
					token: randomUUID(),
					ownerId: "step-log-test",
					expiresAt: new Date("2026-10-21T00:20:00.000Z"),
				},
			});
			return {
				id: row.id,
				idempotencyKey,
				token: row.token,
				liveChannelId: f.channel.id,
				liveChannelRunId: f.run.id,
				providerEncodingId: f.encodingId,
				action: "AUTO_SHUTDOWN_UPDATE",
				generation,
				expiresAt: row.expiresAt,
			};
		}
		async function accepted(f: Fixture) {
			const prior = await claim(f, 1);
			const entry = receipt(prior.idempotencyKey);
			expect(await appendLiveEffectStepLogEntry(tenant, prior, entry)).toEqual({
				runUpdated: 1,
				channelUpdated: 0,
			});
			await tenant.liveEffectClaim.update({
				where: { id: prior.id },
				data: { state: "ACKED" },
			});
			return entry;
		}
		it("retains a run-only late success and every later revision through stale snapshot mirrors", async () => {
			const f = await fixture();
			const prior = await accepted(f);
			await replaceLiveRunStepLogSnapshot(tenant, f.channel.id, f.run.id, [
				slate,
			]);
			expect(
				(
					await tenant.liveChannelRun.findUniqueOrThrow({
						where: { id: f.run.id },
					})
				).stepLog,
			).toEqual([slate, prior]);
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { liveEffectFenceVersion: 2 },
			});
			const next = await claim(f, 2, "DISPATCHING");
			const latest = receipt(next.idempotencyKey);
			expect(await appendLiveEffectStepLogEntry(tenant, next, latest)).toEqual({
				runUpdated: 1,
				channelUpdated: 1,
			});
			await replaceLiveRunStepLogSnapshot(tenant, f.channel.id, f.run.id, [
				prior,
				slate,
			]);
			const row = await tenant.liveChannelRun.findUniqueOrThrow({
				where: { id: f.run.id },
			});
			expect(row.stepLog).toEqual([slate, prior, latest]);
			expect(readLiveAutoShutdownUpdate(row.stepLog)?.requestId).toBe(
				next.idempotencyKey,
			);
		});
		it.each([
			"append",
			"mirror",
		] as const)("preserves the new revision when %s obtains the run lock first", async (first) => {
			const f = await fixture();
			const prior = await accepted(f);
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { liveEffectFenceVersion: 2 },
			});
			const next = await claim(f, 2, "DISPATCHING");
			const latest = receipt(next.idempotencyKey);
			const held = barrier();
			const release = barrier();
			const waiterStarted = barrier();
			let ownerPid = 0;
			let waiterPid = 0;
			const ownerClient = instrument(
				tenant,
				(value) => {
					ownerPid = value;
				},
				async () => {
					held.release();
					await release.ready;
				},
			);
			const waiterClient = instrument(tenant, (value) => {
				waiterPid = value;
				waiterStarted.release();
			});
			const perform = (client: AppPrismaClient, kind: "append" | "mirror") =>
				kind === "append"
					? appendLiveEffectStepLogEntry(client, next, latest)
					: client.$transaction((tx) =>
							replaceLiveRunStepLogSnapshot(tx, f.channel.id, f.run.id, [
								prior,
								slate,
							]),
						);
			const owner = perform(ownerClient, first);
			let waiter: Promise<unknown> | undefined;
			try {
				await reach(held.ready, owner);
				waiter = perform(
					waiterClient,
					first === "append" ? "mirror" : "append",
				);
				await reach(waiterStarted.ready, waiter);
				await blockedBy(admin, waiterPid, ownerPid);
			} finally {
				release.release();
				await Promise.allSettled([owner, ...(waiter ? [waiter] : [])]);
			}
			await owner;
			await waiter;
			expect(
				(
					await tenant.liveChannelRun.findUniqueOrThrow({
						where: { id: f.run.id },
					})
				).stepLog,
			).toEqual([slate, prior, latest]);
		}, 20_000);
		it("does not import old receipts into a successor run or update a mismatched channel", async () => {
			const f = await fixture();
			const prior = await accepted(f);
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { status: "STOPPED" },
			});
			const next = await tenant.liveChannelRun.create({
				data: {
					liveChannelId: f.channel.id,
					seq: 2,
					status: "RUNNING",
					bitmovinEncodingId: `step-log-${randomUUID()}`,
					outputPrefix: "",
				},
			});
			expect(
				await replaceLiveRunStepLogSnapshot(tenant, f.channel.id, next.id, [
					prior,
					slate,
				]),
			).toBe(1);
			expect(
				(
					await tenant.liveChannelRun.findUniqueOrThrow({
						where: { id: next.id },
					})
				).stepLog,
			).toEqual([slate]);
			expect(
				(
					await tenant.liveChannelRun.findUniqueOrThrow({
						where: { id: f.run.id },
					})
				).stepLog,
			).toEqual([prior]);
			expect(
				await replaceLiveRunStepLogSnapshot(tenant, randomUUID(), next.id, []),
			).toBe(0);
		});
	},
);
