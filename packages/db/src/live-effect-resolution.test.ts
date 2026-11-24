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
		origin: "MANAGED",
		plan: {} as unknown,
		stepLog: [] as unknown,
		bitmovinAccountId: "account-1",
		status: "STOPPED",
		error: null as string | null,
		liveEffectFenceVersion: 8,
		bitmovinEncodingId: "encoding-1",
	};
	const run = {
		stepLog: [] as unknown,
		endedAt: null as Date | null,
		aisaAnalysisId: null as string | null,
		aisaStatus: null as string | null,
		aisaSnapshot: null as unknown,
		aisaFinalization: null as unknown,
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
						if ("status" in data) channel.status = String(data.status);
						if ("error" in data) channel.error = data.error as string | null;
						channel.liveEffectFenceVersion += (
							data.liveEffectFenceVersion as { increment: number }
						).increment;
					}
					return { count: matches ? 1 : 0 };
				},
			),
		},
		liveChannelRun: {
			findFirst: vi.fn(async () => ({ ...run })),
			updateMany: vi.fn(async ({ where, data }) => {
				if (
					where.id !== run.id ||
					where.bitmovinEncodingId !== run.bitmovinEncodingId
				)
					return { count: 0 };
				Object.assign(run, data);
				return { count: 1 };
			}),
		},
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
			const runSnapshot = { ...run };
			const claimSnapshots = claims.map((claim) => ({ ...claim }));
			try {
				return await fn(tx);
			} catch (error) {
				Object.assign(channel, channelSnapshot);
				Object.assign(run, runSnapshot);
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
	function ambiguousStop() {
		const f = setup();
		Object.assign(f.channel, { status: "ERROR", error: "stop response lost" });
		Object.assign(f.run, {
			status: "ERROR",
			error: "stop response lost",
			providerStatus: "RUNNING",
		});
		const stopClaim = f.claims[1];
		if (!stopClaim) throw new Error("missing STOP fixture");
		Object.assign(stopClaim, {
			state: "AMBIGUOUS",
			failure:
				"stop response lost; the provider/process call crossed its send boundary, so exact readback or operator resolution is required before retry",
		});
		return { ...f, stopClaim };
	}

	const observedStop = {
		...input,
		terminalReadback: {
			generation: 8,
			bitmovinAccountId: "account-1",
			providerStatus: "FINISHED",
		},
	};

	it("settles a recorded STOP response loss on a fresh read of the exact terminal encoding", async () => {
		const f = ambiguousStop();
		const terminalAt = f.run.providerTerminalAt;
		const endedAt = new Date("2026-09-01T00:00:00.000Z");
		f.run.endedAt = endedAt;
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, observedStop),
		).resolves.toMatchObject({ kind: "RESOLVED" });
		expect(f.channel).toMatchObject({
			status: "STOPPED",
			error: null,
			liveEffectFenceVersion: 9,
		});
		expect(f.run).toMatchObject({
			status: "STOPPED",
			error: null,
			providerStatus: "FINISHED",
			providerStatusObservedAt: input.at,
			providerTerminalAt: terminalAt,
			endedAt,
		});
		expect(f.claims[1]?.state).toBe("ACKED");
	});

	it.each([
		"live status",
		"account changed",
		"stale run",
		"new generation",
		"unrelated error",
		"unexpired dispatch",
		"managed Analysis",
		"bound Analysis",
		"unreadable log",
		"conflicting encoding",
		"held feeder",
		"historic second encoding",
	])("keeps a recorded STOP unresolved on %s", async (reason) => {
		const f = ambiguousStop();
		const request = {
			...observedStop,
			terminalReadback: { ...observedStop.terminalReadback },
		};
		if (reason === "live status")
			request.terminalReadback.providerStatus = "RUNNING";
		if (reason === "account changed") f.channel.bitmovinAccountId = "account-2";
		if (reason === "stale run") f.run.id = "later-run";
		if (reason === "new generation") f.channel.liveEffectFenceVersion++;
		if (reason === "unrelated error")
			f.channel.error = f.run.error = "disk full";
		if (reason === "unexpired dispatch") f.stopClaim.state = "DISPATCHING";
		if (reason === "managed Analysis")
			f.channel.plan = { start: { aiSceneAnalysisLive: {} } };
		if (reason === "bound Analysis") f.run.aisaAnalysisId = "analysis";
		if (reason === "unreadable log") f.run.stepLog = "unreadable";
		if (reason === "conflicting encoding")
			f.channel.stepLog = [
				{
					step: "create",
					kind: "CREATE_ENCODING",
					resourceId: "another",
					payload: {},
					refs: {},
					status: "DONE",
				},
			];
		if (reason === "held feeder") f.setFeederOccupiesRun(true);
		if (reason === "historic second encoding") {
			f.channel.status = f.run.status = "STOPPED";
			f.channel.error =
				f.run.error =
				f.stopClaim.failure =
					"stop did not confirm — other-encoding: still RUNNING after the stop was accepted";
		}
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, request),
		).resolves.toMatchObject({ kind: "BLOCKED" });
		expect(f.channel.status).toBe(
			reason === "historic second encoding" ? "STOPPED" : "ERROR",
		);
		expect(f.run.providerStatus).toBe("RUNNING");
		expect(f.claims[1]?.state).not.toBe("ACKED");
	});
	it("recovers a completed inline poll that still saw the claimed encoder running", async () => {
		const f = ambiguousStop();
		f.channel.status = f.run.status = "STOPPED";
		f.channel.error =
			f.run.error =
			f.stopClaim.failure =
				"stop did not confirm — encoding-1: still RUNNING after the stop was accepted; encoding-1: the exact claimed encoding has no terminal readback";
		f.run.providerTerminalAt = null;
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, observedStop),
		).resolves.toMatchObject({ kind: "RESOLVED" });
		expect(f.run).toMatchObject({
			endedAt: input.at,
			providerTerminalAt: input.at,
			error: null,
		});
	});
	it("cannot acknowledge an Encoder-only stop while its Analysis finalization is unproven", async () => {
		const f = setup();
		f.run.aisaAnalysisId = "analysis-1";
		f.run.aisaStatus = "RUNNING";
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, input),
		).resolves.toMatchObject({ kind: "BLOCKED" });
		expect(f.claims[1]?.state).toBe("DISPATCHING");
	});
	it("closes confirmed terminal failure while preserving ERROR and separate no-result proof", async () => {
		const f = setup();
		const analysisId = "a0000000-0000-4000-8000-000000000001";
		const encodingId = "a0000000-0000-4000-8000-000000000002";
		Object.assign(f.channel, {
			status: "ERROR",
			error: "AISA_LIVE_TERMINAL_FAILURE",
			bitmovinEncodingId: encodingId,
		});
		Object.assign(f.run, {
			status: "ERROR",
			error: "AISA_LIVE_TERMINAL_FAILURE",
			bitmovinEncodingId: encodingId,
			providerStatus: "ERROR",
			aisaAnalysisId: analysisId,
			aisaStatus: "ERROR",
			aisaFinalization: {
				analysisId,
				encodingId,
				status: "ERROR",
				result: "UNAVAILABLE_TERMINAL_FAILURE",
				observedAt: "2026-09-01T00:00:00Z",
			},
		});
		for (const claim of f.claims) claim.providerEncodingId = encodingId;
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, {
				...input,
				providerEncodingId: encodingId,
			}),
		).resolves.toMatchObject({ kind: "RESOLVED" });
		expect(f.channel).toMatchObject({
			status: "ERROR",
			error: "AISA_LIVE_TERMINAL_FAILURE",
		});
		expect(f.claims[1]).toMatchObject({
			state: "ACKED",
			failure: "AISA_LIVE_TERMINAL_FAILURE",
		});
		expect(f.run.aisaSnapshot).toBeNull();
	});
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
