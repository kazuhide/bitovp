import { describe, expect, it, vi } from "vitest";
import type { AppPrismaClient } from "./client";
import { resolveLiveEffectsAfterConfirmedStop } from "./live-effect-claim";

type ClaimState =
	| "CLAIMED"
	| "DISPATCHING"
	| "ACKED"
	| "FAILED"
	| "AMBIGUOUS"
	| "RESOLVED";

function setup() {
	const channel = {
		status: "STOPPED",
		error: null as string | null,
		liveEffectFenceVersion: 8,
		bitmovinEncodingId: "encoding-1",
	};
	const run = {
		id: "00000000-0000-4000-8000-0000000000aa",
		status: "STOPPED",
		error: null as string | null,
		bitmovinEncodingId: "encoding-1",
		providerStatus: "FINISHED",
		providerStatusObservedAt: new Date("2026-09-01T00:00:00.000Z"),
		providerTerminalAt: new Date("2026-09-01T00:00:00.000Z") as Date | null,
	};
	const claims = [
		{
			id: "old-ambiguous",
			idempotencyKey: "manual:scte35:old",
			action: "SCTE35",
			liveChannelId: "channel-1",
			liveChannelRunId: run.id,
			providerEncodingId: "encoding-1",
			generation: 7,
			state: "AMBIGUOUS" as ClaimState,
			acknowledgedAt: null as Date | null,
			failure: "response lost",
		},
		{
			id: "stop-claim",
			idempotencyKey: "manual:stop:channel-1:run-1:7",
			action: "STOP",
			liveChannelId: "channel-1",
			liveChannelRunId: run.id,
			providerEncodingId: "encoding-1",
			generation: 8,
			state: "DISPATCHING" as ClaimState,
			acknowledgedAt: null as Date | null,
			failure: null as string | null,
		},
	];
	let feederOccupiesRun = false;
	let beforeChannelLock: (() => void) | undefined;
	let forceStopAckMiss = false;
	let serializationFailures = 0;
	let transactionAttempts = 0;
	let transactionOptions: unknown;

	const tx = {
		liveChannel: {
			findUnique: vi.fn(async () => ({ ...channel })),
			updateMany: vi.fn(
				async ({
					where,
					data,
				}: {
					where: Record<string, unknown>;
					data: Record<string, unknown>;
				}) => {
					beforeChannelLock?.();
					const stop = (
						where.effectClaims as { some: Record<string, unknown> } | undefined
					)?.some;
					const stopMatches =
						stop === undefined ||
						claims.some(
							(claim) =>
								claim.id === stop.id &&
								claim.idempotencyKey === stop.idempotencyKey &&
								claim.liveChannelRunId === stop.liveChannelRunId &&
								claim.providerEncodingId === stop.providerEncodingId &&
								claim.action === stop.action &&
								claim.generation === stop.generation &&
								(stop.state as { in: ClaimState[] }).in.includes(claim.state),
						);
					const matches =
						where.id === "channel-1" &&
						where.status === channel.status &&
						where.error === channel.error &&
						where.bitmovinEncodingId === channel.bitmovinEncodingId &&
						where.liveEffectFenceVersion === channel.liveEffectFenceVersion &&
						stopMatches;
					if (matches) {
						channel.liveEffectFenceVersion += (
							data.liveEffectFenceVersion as { increment: number }
						).increment;
					}
					return { count: matches ? 1 : 0 };
				},
			),
		},
		liveChannelRun: { findFirst: vi.fn(async () => ({ ...run })) },
		feederSession: {
			findFirst: vi.fn(async () =>
				feederOccupiesRun ? { id: "feeder-1" } : null,
			),
		},
		liveEffectClaim: {
			findUnique: vi.fn(
				async ({ where }: { where: { id: string } }) =>
					claims.find((claim) => claim.id === where.id) ?? null,
			),
			updateMany: vi.fn(
				async ({
					where,
					data,
				}: {
					where: Record<string, unknown>;
					data: Record<string, unknown>;
				}) => {
					if (where.id === "stop-claim" && forceStopAckMiss) {
						return { count: 0 };
					}
					const states =
						typeof where.state === "object"
							? (where.state as { in: ClaimState[] }).in
							: [where.state as ClaimState];
					const id = where.id as string | { not: string } | undefined;
					const channelFence = (
						where.liveChannel as
							| {
									is: {
										status: string;
										error: null;
										bitmovinEncodingId: string;
										liveEffectFenceVersion: number;
									};
							  }
							| undefined
					)?.is;
					const matching = claims.filter(
						(claim) =>
							(id === undefined ||
								(typeof id === "string"
									? claim.id === id
									: claim.id !== id.not)) &&
							(where.action === undefined || claim.action === where.action) &&
							(where.idempotencyKey === undefined ||
								claim.idempotencyKey === where.idempotencyKey) &&
							(where.generation === undefined ||
								claim.generation === where.generation) &&
							(where.liveChannelId === undefined ||
								claim.liveChannelId === where.liveChannelId) &&
							(where.liveChannelRunId === undefined ||
								claim.liveChannelRunId === where.liveChannelRunId) &&
							(where.providerEncodingId === undefined ||
								claim.providerEncodingId === where.providerEncodingId) &&
							(channelFence === undefined ||
								(channel.status === channelFence.status &&
									channel.error === channelFence.error &&
									channel.bitmovinEncodingId ===
										channelFence.bitmovinEncodingId &&
									channel.liveEffectFenceVersion ===
										channelFence.liveEffectFenceVersion)) &&
							states.includes(claim.state),
					);
					for (const claim of matching) Object.assign(claim, data);
					return { count: matching.length };
				},
			),
		},
	};
	const prisma = {
		...tx,
		$transaction: async (
			fn: (client: typeof tx) => Promise<unknown>,
			options?: unknown,
		) => {
			transactionAttempts += 1;
			transactionOptions = options;
			if (serializationFailures > 0) {
				serializationFailures -= 1;
				throw Object.assign(new Error("serialization conflict"), {
					code: "P2034",
				});
			}
			const channelSnapshot = { ...channel };
			const claimSnapshots = claims.map((claim) => ({ ...claim }));
			try {
				return await fn(tx);
			} catch (error) {
				Object.assign(channel, channelSnapshot);
				for (const [index, snapshot] of claimSnapshots.entries()) {
					if (claims[index]) Object.assign(claims[index], snapshot);
				}
				throw error;
			}
		},
	} as unknown as AppPrismaClient;

	return {
		prisma,
		channel,
		run,
		claims,
		transactionOptions: () => transactionOptions,
		transactionAttempts: () => transactionAttempts,
		setBeforeChannelLock(hook: () => void) {
			beforeChannelLock = hook;
		},
		setForceStopAckMiss(value: boolean) {
			forceStopAckMiss = value;
		},
		setSerializationFailures(value: number) {
			serializationFailures = value;
		},
		setFeederOccupiesRun(value: boolean) {
			feederOccupiesRun = value;
		},
	};
}

const input = {
	liveChannelId: "channel-1",
	liveChannelRunId: "00000000-0000-4000-8000-0000000000aa",
	providerEncodingId: "encoding-1",
	stopClaimId: "stop-claim",
	stopIdempotencyKey: "manual:stop:channel-1:run-1:7",
	at: new Date("2026-09-01T00:00:01.000Z"),
};

describe("resolveLiveEffectsAfterConfirmedStop", () => {
	it("closes an older AMBIGUOUS claim only after the exact run is provider-terminal and every feeder is gone", async () => {
		const fake = setup();
		fake.setFeederOccupiesRun(true);

		await expect(
			resolveLiveEffectsAfterConfirmedStop(fake.prisma, input),
		).resolves.toMatchObject({
			kind: "BLOCKED",
			reason: expect.stringMatching(/feeder/i),
		});
		expect(fake.claims[0]?.state).toBe("AMBIGUOUS");

		fake.setFeederOccupiesRun(false);
		await expect(
			resolveLiveEffectsAfterConfirmedStop(fake.prisma, input),
		).resolves.toEqual({ kind: "RESOLVED", count: 1 });
		expect(fake.claims[0]).toMatchObject({
			state: "RESOLVED",
			acknowledgedAt: input.at,
		});
		expect(fake.claims[1]).toMatchObject({
			state: "ACKED",
			acknowledgedAt: input.at,
			failure: null,
		});
		expect(fake.channel.liveEffectFenceVersion).toBe(9);
		expect(fake.transactionOptions()).toEqual({
			isolationLevel: "Serializable",
		});
	});

	it("leaves claims blocking when STOP or the provider readback is unconfirmed", async () => {
		for (const makeUnconfirmed of [
			(fake: ReturnType<typeof setup>) => {
				fake.channel.error = "feeder stop not confirmed";
			},
			(fake: ReturnType<typeof setup>) => {
				fake.run.providerTerminalAt = null;
			},
			(fake: ReturnType<typeof setup>) => {
				fake.run.providerStatus = "RUNNING";
			},
		]) {
			const fake = setup();
			makeUnconfirmed(fake);
			await expect(
				resolveLiveEffectsAfterConfirmedStop(fake.prisma, input),
			).resolves.toMatchObject({ kind: "BLOCKED" });
			expect(fake.claims[0]?.state).toBe("AMBIGUOUS");
		}
	});

	it("leaves every claim unchanged when the current run or exact STOP claim identity does not match", async () => {
		for (const makeMismatched of [
			(fake: ReturnType<typeof setup>) => {
				fake.run.id = "00000000-0000-4000-8000-0000000000bb";
			},
			(fake: ReturnType<typeof setup>) => {
				fake.channel.bitmovinEncodingId = "encoding-successor";
			},
			(fake: ReturnType<typeof setup>) => {
				fake.channel.liveEffectFenceVersion = 9;
			},
			(fake: ReturnType<typeof setup>) => {
				if (!fake.claims[1]) throw new Error("stop claim missing");
				fake.claims[1].idempotencyKey = "manual:stop:different";
			},
		]) {
			const fake = setup();
			makeMismatched(fake);
			await expect(
				resolveLiveEffectsAfterConfirmedStop(fake.prisma, input),
			).resolves.toMatchObject({ kind: "BLOCKED" });
			expect(fake.claims.map(({ state }) => state)).toEqual([
				"AMBIGUOUS",
				"DISPATCHING",
			]);
		}
	});

	it("does not ACK when a re-air advances the channel after validation but before the claim write", async () => {
		const fake = setup();
		fake.setBeforeChannelLock(() => {
			fake.channel.status = "PROVISIONING";
			fake.channel.liveEffectFenceVersion = 9;
			fake.channel.bitmovinEncodingId = "encoding-successor";
		});

		await expect(
			resolveLiveEffectsAfterConfirmedStop(fake.prisma, input),
		).resolves.toMatchObject({ kind: "BLOCKED" });
		expect(fake.claims.map(({ state }) => state)).toEqual([
			"AMBIGUOUS",
			"DISPATCHING",
		]);
	});

	it("rolls back the fence advance when the exact STOP ACK loses its CAS", async () => {
		const fake = setup();
		fake.setForceStopAckMiss(true);

		await expect(
			resolveLiveEffectsAfterConfirmedStop(fake.prisma, input),
		).rejects.toThrow("LIVE_STOP_RECONCILIATION_ACK_FENCE_LOST");
		expect(fake.channel.liveEffectFenceVersion).toBe(8);
		expect(fake.claims.map(({ state }) => state)).toEqual([
			"AMBIGUOUS",
			"DISPATCHING",
		]);
	});

	it("retries one Serializable P2034 without duplicating reconciliation", async () => {
		const fake = setup();
		fake.setSerializationFailures(1);

		await expect(
			resolveLiveEffectsAfterConfirmedStop(fake.prisma, input),
		).resolves.toEqual({ kind: "RESOLVED", count: 1 });
		expect(fake.transactionAttempts()).toBe(2);
		expect(fake.channel.liveEffectFenceVersion).toBe(9);
		expect(fake.claims[1]?.state).toBe("ACKED");
	});
});
