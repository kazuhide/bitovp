import { describe, expect, it, vi } from "vitest";
import type { AppPrismaClient } from "./client";
import {
	assertLiveEffectCurrent,
	beginLiveEffect,
	type LiveEffectBeginInput,
	markLiveEffectAcked,
	markLiveEffectAmbiguous,
	markLiveEffectFailed,
} from "./live-effect-claim";

type Claim = {
	id: string;
	idempotencyKey: string;
	requestSha256?: string | null;
	providerResultId?: string | null;
	liveChannelId: string;
	liveChannelRunId: string;
	providerEncodingId: string;
	action: string;
	state:
		| "CLAIMED"
		| "DISPATCHING"
		| "ACKED"
		| "FAILED"
		| "AMBIGUOUS"
		| "RESOLVED";
	token: string;
	generation: number;
	expiresAt: Date;
	acknowledgedAt: Date | null;
	failure: string | null;
	attempt: number;
};

type ChannelUpdateArgs = {
	where: { id: string; liveEffectFenceVersion: number };
	data: {
		liveEffectFenceVersion: { increment: number };
		status?: string;
	};
};

type ClaimCreateArgs = {
	data: Omit<Claim, "id" | "acknowledgedAt" | "failure" | "attempt"> & {
		attempt?: number;
	};
};

type ClaimUpdateArgs = {
	where: { id: string };
	data: Record<string, unknown>;
};

type ClaimUpdateManyArgs = {
	where: {
		id: string;
		token: string;
		state: Claim["state"] | { in: Claim["state"][] };
	};
	data: Record<string, unknown>;
};

function fakePrisma() {
	const channel = {
		id: "channel-1",
		status: "RUNNING",
		liveEffectFenceVersion: 7,
		bitmovinEncodingId: "encoding-1",
	};
	const run = {
		id: "run-1",
		bitmovinEncodingId: "encoding-1",
	};
	const claims: Claim[] = [];
	let loseNextChannelCas = false;

	const tx = {
		liveChannel: {
			findUnique: vi.fn(async () => ({ ...channel })),
			updateMany: vi.fn(async ({ where, data }: ChannelUpdateArgs) => {
				if (loseNextChannelCas) {
					loseNextChannelCas = false;
					return { count: 0 };
				}
				if (
					where.id !== channel.id ||
					where.liveEffectFenceVersion !== channel.liveEffectFenceVersion
				) {
					return { count: 0 };
				}
				channel.liveEffectFenceVersion += data.liveEffectFenceVersion.increment;
				if (data.status) channel.status = data.status;
				return { count: 1 };
			}),
		},
		liveChannelRun: {
			findFirst: vi.fn(async () => ({ ...run })),
		},
		liveEffectClaim: {
			findUnique: vi.fn(
				async ({ where }: { where: { idempotencyKey: string } }) =>
					claims.find(
						(claim) => claim.idempotencyKey === where.idempotencyKey,
					) ?? null,
			),
			findFirst: vi.fn(
				async ({
					where,
				}: {
					where: {
						liveChannelId: string;
						state: { in: Claim["state"][] };
					};
				}) =>
					claims.find(
						(claim) =>
							claim.liveChannelId === where.liveChannelId &&
							where.state.in.includes(claim.state),
					) ?? null,
			),
			create: vi.fn(async ({ data }: ClaimCreateArgs) => {
				const row: Claim = {
					...data,
					id: `claim-${claims.length + 1}`,
					acknowledgedAt: null,
					failure: null,
					attempt: data.attempt ?? 1,
				};
				claims.push(row);
				return { ...row };
			}),
			update: vi.fn(async ({ where, data }: ClaimUpdateArgs) => {
				const hit = claims.find((claim) => claim.id === where.id);
				if (!hit) throw new Error("claim not found");
				const mutable = hit as unknown as Record<string, unknown>;
				for (const [key, value] of Object.entries(data)) {
					if (
						value !== null &&
						typeof value === "object" &&
						"increment" in value
					) {
						mutable[key] =
							Number(mutable[key] ?? 0) +
							Number((value as { increment: number }).increment);
					} else {
						mutable[key] = value;
					}
				}
				return { ...hit };
			}),
			updateMany: vi.fn(async ({ where, data }: ClaimUpdateManyArgs) => {
				const hit = claims.find(
					(claim) =>
						claim.id === where.id &&
						claim.token === where.token &&
						(typeof where.state === "object" && Array.isArray(where.state.in)
							? where.state.in.includes(claim.state)
							: claim.state === where.state),
				);
				if (!hit) return { count: 0 };
				Object.assign(hit, data);
				return { count: 1 };
			}),
		},
	};

	const prisma = {
		...tx,
		$transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => {
			const channelBefore = { ...channel };
			const claimsBefore = claims.map((claim) => ({ ...claim }));
			try {
				return await callback(tx);
			} catch (error) {
				Object.assign(channel, channelBefore);
				claims.splice(0, claims.length, ...claimsBefore);
				throw error;
			}
		}),
	} as unknown as AppPrismaClient;

	return {
		prisma,
		channel,
		run,
		claims,
		loseNextChannelCas: () => {
			loseNextChannelCas = true;
		},
	};
}

const NOW = new Date("2026-08-31T12:00:00.000Z");
const INPUT: LiveEffectBeginInput = {
	idempotencyKey: "schedule:schedule-1:slate",
	requestSha256: "a".repeat(64),
	liveChannelId: "channel-1",
	liveChannelRunId: "run-1",
	providerEncodingId: "encoding-1",
	expectedFenceVersion: 7,
	action: "SLATE_INSERT",
	scheduleId: "schedule-1",
	targetId: "content-1",
	ownerId: "worker-1",
	now: NOW,
	expiresAt: new Date(NOW.getTime() + 30_000),
};

describe("durable live effect claims", () => {
	it("commits DISPATCHING intent under the exact run before an effect may execute", async () => {
		const fake = fakePrisma();
		const result = await beginLiveEffect(fake.prisma, INPUT);

		expect(result.kind).toBe("EXECUTE");
		expect(fake.claims).toEqual([
			expect.objectContaining({
				state: "DISPATCHING",
				liveChannelRunId: "run-1",
				providerEncodingId: "encoding-1",
				generation: 8,
			}),
		]);
		expect(fake.channel.liveEffectFenceVersion).toBe(8);
	});

	it("rolls back a post-claim/pre-intent crash, so no phantom claim survives", async () => {
		const fake = fakePrisma();
		await expect(
			beginLiveEffect(fake.prisma, INPUT, {
				afterClaimed: () => {
					throw new Error("KILL_POST_CLAIM");
				},
			}),
		).rejects.toThrow("KILL_POST_CLAIM");
		expect(fake.claims).toEqual([]);
		expect(fake.channel.liveEffectFenceVersion).toBe(7);
	});

	it("refuses a stale run/encoding and a lost generation CAS with zero intent", async () => {
		for (const mutate of [
			(fake: ReturnType<typeof fakePrisma>) => {
				fake.run.id = "run-2";
			},
			(fake: ReturnType<typeof fakePrisma>) => {
				fake.run.bitmovinEncodingId = "encoding-2";
			},
			(fake: ReturnType<typeof fakePrisma>) => fake.loseNextChannelCas(),
		]) {
			const fake = fakePrisma();
			mutate(fake);
			await expect(beginLiveEffect(fake.prisma, INPUT)).resolves.toMatchObject({
				kind: "STALE",
			});
			expect(fake.claims).toEqual([]);
		}
	});

	it("never blind-retries an open or expired intent; expiry becomes AMBIGUOUS", async () => {
		const fake = fakePrisma();
		const first = await beginLiveEffect(fake.prisma, INPUT);
		expect(first.kind).toBe("EXECUTE");

		await expect(beginLiveEffect(fake.prisma, INPUT)).resolves.toMatchObject({
			kind: "BLOCKED",
			state: "DISPATCHING",
		});
		const firstClaim = fake.claims[0];
		if (!firstClaim) throw new Error("claim missing");
		firstClaim.expiresAt = new Date(NOW.getTime() - 1);
		await expect(beginLiveEffect(fake.prisma, INPUT)).resolves.toMatchObject({
			kind: "BLOCKED",
			state: "AMBIGUOUS",
		});
		expect(fake.claims[0]?.state).toBe("AMBIGUOUS");
		expect(fake.claims).toHaveLength(1);
	});

	it("deduplicates an exact manual STOP delivery before a second provider call", async () => {
		const fake = fakePrisma();
		const firstInput: LiveEffectBeginInput = {
			...INPUT,
			idempotencyKey: "manual:stop:channel-1:run-1:7",
			action: "STOP",
			scheduleId: undefined,
			targetId: undefined,
			supersedeOpen: true,
		};
		const first = await beginLiveEffect(fake.prisma, firstInput);
		const duplicate = await beginLiveEffect(fake.prisma, firstInput);

		expect(first.kind).toBe("EXECUTE");
		expect(duplicate).toMatchObject({
			kind: "BLOCKED",
			state: "DISPATCHING",
		});
		expect(fake.claims).toHaveLength(1);
		expect(fake.channel.liveEffectFenceVersion).toBe(8);
	});

	it("a STOP adopts the current generation and supersedes an intervening same-run effect", async () => {
		const fake = fakePrisma();
		const slate = await beginLiveEffect(fake.prisma, INPUT);
		expect(slate.kind).toBe("EXECUTE");
		expect(fake.channel.liveEffectFenceVersion).toBe(8);

		const stop = await beginLiveEffect(fake.prisma, {
			...INPUT,
			idempotencyKey: "manual:stop:channel-1:run-1",
			expectedFenceVersion: 7,
			action: "STOP",
			scheduleId: undefined,
			targetId: undefined,
			supersedeOpen: true,
		});

		expect(stop.kind).toBe("EXECUTE");
		if (stop.kind !== "EXECUTE") throw new Error("expected STOP execution");
		expect(stop.claim.generation).toBe(9);
		expect(fake.channel.liveEffectFenceVersion).toBe(9);
		expect(fake.claims).toEqual([
			expect.objectContaining({
				action: "SLATE_INSERT",
				state: "AMBIGUOUS",
			}),
			expect.objectContaining({
				action: "STOP",
				state: "DISPATCHING",
				generation: 9,
			}),
		]);
	});

	it("atomically preempts an intervening same-run RESTART while PROVISIONING", async () => {
		const fake = fakePrisma();
		// Model the route's atomic restart admission: same immutable run/provider,
		// PROVISIONING status, and one advanced fence generation.
		fake.channel.status = "PROVISIONING";
		fake.channel.liveEffectFenceVersion = 8;
		const restart = await beginLiveEffect(fake.prisma, {
			...INPUT,
			idempotencyKey: "manual:restart:channel-1:run-1:8",
			expectedFenceVersion: 8,
			action: "RESTART",
			scheduleId: undefined,
			targetId: undefined,
			allowedChannelStatuses: ["PROVISIONING"],
		});
		expect(restart).toMatchObject({
			kind: "EXECUTE",
			claim: { generation: 9 },
		});

		// This STOP was durably admitted before the restart. It must adopt the
		// exact same run/provider's current generation, atomically fence restart,
		// and own STOPPING before any worker can call the provider.
		const stop = await beginLiveEffect(fake.prisma, {
			...INPUT,
			idempotencyKey: "manual:stop:channel-1:run-1:7",
			expectedFenceVersion: 7,
			action: "STOP",
			scheduleId: undefined,
			targetId: undefined,
			supersedeOpen: true,
			allowedChannelStatuses: ["RUNNING", "STOPPING", "ERROR", "STOPPED"],
		});

		expect(stop).toMatchObject({
			kind: "EXECUTE",
			claim: { generation: 10 },
		});
		expect(fake.channel).toMatchObject({
			status: "STOPPING",
			liveEffectFenceVersion: 10,
		});
		expect(fake.claims).toEqual([
			expect.objectContaining({ action: "RESTART", state: "AMBIGUOUS" }),
			expect.objectContaining({
				action: "STOP",
				state: "DISPATCHING",
				generation: 10,
			}),
		]);
	});

	it("does not broaden the manual handoff rule to scheduled STOP", async () => {
		const fake = fakePrisma();
		await expect(beginLiveEffect(fake.prisma, INPUT)).resolves.toMatchObject({
			kind: "EXECUTE",
		});

		await expect(
			beginLiveEffect(fake.prisma, {
				...INPUT,
				idempotencyKey: "schedule:schedule-2:stop",
				action: "STOP",
				scheduleId: "schedule-2",
				targetId: undefined,
				supersedeOpen: true,
			}),
		).resolves.toMatchObject({ kind: "STALE" });
		expect(fake.claims).toHaveLength(1);
	});

	it("a STOP retries a concurrent admission CAS loss and converges, never STALE", async () => {
		const fake = fakePrisma();
		fake.loseNextChannelCas();
		const stopInput: LiveEffectBeginInput = {
			...INPUT,
			idempotencyKey: "manual:stop:channel-1:run-1",
			action: "STOP",
			scheduleId: undefined,
			targetId: undefined,
			supersedeOpen: true,
		};

		await expect(beginLiveEffect(fake.prisma, stopInput)).rejects.toThrow(
			"LIVE_STOP_ADMISSION_RACE",
		);
		expect(fake.claims).toEqual([]);
		expect(fake.channel.liveEffectFenceVersion).toBe(7);

		await expect(
			beginLiveEffect(fake.prisma, stopInput),
		).resolves.toMatchObject({
			kind: "EXECUTE",
			claim: { generation: 8 },
		});
		expect(fake.claims).toHaveLength(1);
	});

	it("refuses an old manual stop after the channel has moved to a new run", async () => {
		const fake = fakePrisma();
		fake.run.id = "run-2";
		fake.run.bitmovinEncodingId = "encoding-2";
		fake.channel.bitmovinEncodingId = "encoding-2";
		fake.channel.liveEffectFenceVersion = 8;
		fake.channel.status = "PROVISIONING";

		const result = await beginLiveEffect(fake.prisma, {
			...INPUT,
			idempotencyKey: "manual:stop:channel-1:run-1:7",
			action: "STOP",
			scheduleId: undefined,
			targetId: undefined,
			supersedeOpen: true,
			allowedChannelStatuses: ["RUNNING", "STOPPING", "ERROR", "STOPPED"],
		});

		expect(result).toMatchObject({ kind: "STALE" });
		expect(fake.claims).toEqual([]);
	});

	it("fences pre-send and ACK writes by claim token and channel generation", async () => {
		const fake = fakePrisma();
		const begun = await beginLiveEffect(fake.prisma, INPUT);
		if (begun.kind !== "EXECUTE") throw new Error("expected EXECUTE");

		await expect(
			assertLiveEffectCurrent(fake.prisma, begun.claim, NOW),
		).resolves.toBe(true);
		fake.channel.liveEffectFenceVersion += 1;
		await expect(
			assertLiveEffectCurrent(fake.prisma, begun.claim, NOW),
		).resolves.toBe(false);

		await expect(
			markLiveEffectAcked(fake.prisma, { ...begun.claim, token: "wrong" }, NOW),
		).resolves.toBe(false);
		await expect(
			markLiveEffectAmbiguous(fake.prisma, begun.claim, "response lost"),
		).resolves.toBe(true);
		await expect(
			markLiveEffectAcked(fake.prisma, begun.claim, NOW, {
				providerResultId: "provider-result-1",
			}),
		).resolves.toBe(true);
		expect(fake.claims[0]).toMatchObject({
			state: "ACKED",
			acknowledgedAt: NOW,
			providerResultId: "provider-result-1",
		});
		await expect(beginLiveEffect(fake.prisma, INPUT)).resolves.toEqual({
			kind: "ACKED",
			claimId: begun.claim.id,
			providerResultId: "provider-result-1",
		});
		for (const rebound of [
			{ liveChannelRunId: "run-2" },
			{ providerEncodingId: "encoding-2" },
			{ action: "SCTE35" as const },
		]) {
			await expect(
				beginLiveEffect(fake.prisma, { ...INPUT, ...rebound }),
			).resolves.toMatchObject({
				kind: "CONFLICT",
				reason: expect.stringMatching(/identity|run|provider/i),
			});
		}
		await expect(
			beginLiveEffect(fake.prisma, {
				...INPUT,
				requestSha256: "b".repeat(64),
			}),
		).resolves.toMatchObject({ kind: "CONFLICT" });
	});

	it("admits a new effect after an older ambiguous claim is authoritatively resolved", async () => {
		const fake = fakePrisma();
		const first = await beginLiveEffect(fake.prisma, INPUT);
		if (first.kind !== "EXECUTE") throw new Error("expected EXECUTE");
		await markLiveEffectAmbiguous(fake.prisma, first.claim, "response lost");
		expect(fake.claims[0]?.state).toBe("AMBIGUOUS");

		if (!fake.claims[0]) throw new Error("claim missing");
		fake.claims[0].state = "RESOLVED";
		const reair = await beginLiveEffect(fake.prisma, {
			...INPUT,
			idempotencyKey: "manual:reair:new-request",
			requestSha256: "c".repeat(64),
			expectedFenceVersion: 8,
		});

		expect(reair.kind).toBe("EXECUTE");
		expect(fake.claims).toHaveLength(2);
	});

	it("retries only a conclusively FAILED claim, with a new token and generation", async () => {
		const fake = fakePrisma();
		const first = await beginLiveEffect(fake.prisma, INPUT);
		if (first.kind !== "EXECUTE") throw new Error("expected EXECUTE");
		await expect(
			markLiveEffectFailed(fake.prisma, first.claim, "refused before send"),
		).resolves.toBe(true);

		const retried = await beginLiveEffect(fake.prisma, {
			...INPUT,
			ownerId: "worker-2",
			now: new Date(NOW.getTime() + 1_000),
			expiresAt: new Date(NOW.getTime() + 31_000),
		});
		expect(retried.kind).toBe("EXECUTE");
		if (retried.kind !== "EXECUTE") throw new Error("expected retry");
		expect(retried.claim.id).toBe(first.claim.id);
		expect(retried.claim.token).not.toBe(first.claim.token);
		expect(retried.claim.generation).toBe(first.claim.generation + 1);
		expect(fake.claims).toHaveLength(1);
		expect(fake.claims[0]).toMatchObject({
			state: "DISPATCHING",
			attempt: 2,
		});

		await markLiveEffectFailed(
			fake.prisma,
			retried.claim,
			"refused before send again",
		);
		for (const rebound of [
			{ liveChannelRunId: "run-2" },
			{ scheduleId: "schedule-2" },
			{ targetId: "target-2" },
		]) {
			await expect(
				beginLiveEffect(fake.prisma, { ...INPUT, ...rebound }),
			).resolves.toMatchObject({
				kind: "STALE",
				reason: expect.stringMatching(/cannot be rebound/),
			});
		}
	});
});
