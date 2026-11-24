import { describe, expect, it, vi } from "vitest";
import type { AppPrismaClient } from "./client";
import {
	collectLiveStopTargets,
	mergeRtmpRetirementEvidence,
	resolveLiveEffectsAfterConfirmedStop,
	unconfirmedRtmpEncoders,
} from "./live-effect-claim";

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
		bitmovinAccountId: "account-1" as string | null,
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
			expiresAt: new Date("2026-09-01T00:00:00.000Z"),
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
		liveStopNotification: {
			create: vi.fn(async (args: { data: unknown }) => args.data),
		},
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
					("bitmovinEncodingId" in where &&
						where.bitmovinEncodingId !== run.bitmovinEncodingId)
				)
					return { count: 0 };
				Object.assign(run, data);
				return { count: 1 };
			}),
		},
		feederSession: {
			findFirst: vi.fn(async (_args: { where: Record<string, unknown> }) =>
				feederOccupiesRun ? { id: "feeder-1" } : null,
			),
		},
		liveEffectClaim: {
			findMany: vi.fn(async () => claims),
			findFirst: vi.fn(
				async ({ where }) =>
					claims.find(
						(c) =>
							c.id !== where.id.not &&
							c.liveChannelId === where.liveChannelId &&
							c.liveChannelRunId === where.liveChannelRunId &&
							c.action === where.action &&
							where.state.in.includes(c.state),
					) ?? null,
			),
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
							(where.action === undefined ||
								(typeof where.action === "string"
									? claim.action === where.action
									: claim.action !== (where.action as { not: string }).not)) &&
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
		feederLookup: tx.feederSession.findFirst,
		createNotification: tx.liveStopNotification.create,
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

describe("displaced RTMP encoder retirement", () => {
	it("trusts only the exact account and verified encoder, and keeps a legacy archive gap separate", () => {
		const receipt = {
			accountId: "a",
			encodingId: "old",
			disposition: "NEVER_STARTED" as const,
			providerStatus: "CREATED",
			observedAt: "2026-11-25T00:00:00Z",
		};
		const run = {
			stepLog: [] as unknown,
			previousProviderEncodingIds: ["old", "other"],
			rtmpRetirementEvidence: mergeRtmpRetirementEvidence(
				[{ ...receipt, encodingId: "other", providerStatus: "RUNNING" }],
				[receipt, receipt],
			),
		};
		expect(run.rtmpRetirementEvidence).toEqual([receipt]);
		expect(unconfirmedRtmpEncoders(run, { stepLog: [] }, "a")).toEqual([
			"other",
		]);
		expect(unconfirmedRtmpEncoders(run, { stepLog: [] }, "b")).toEqual([
			"old",
			"other",
		]);
		run.stepLog = [
			{
				step: "input",
				kind: "CREATE_INPUT_RTMP",
				status: "DONE",
				attempt: 1,
				refs: {},
				payload: {},
			},
		];
		expect(unconfirmedRtmpEncoders(run, { stepLog: [] }, "a")).toBeNull();
		const partial = collectLiveStopTargets(
			{ ...run, bitmovinEncodingId: "primary" },
			{ bitmovinEncodingId: "primary", stepLog: [] },
			[],
			"a",
		);
		expect(partial.complete).toBe(false);
		expect(partial.encodingIds).toEqual(
			expect.arrayContaining(["primary", ...run.previousProviderEncodingIds]),
		);
	});
});

describe("resolveLiveEffectsAfterConfirmedStop", () => {
	it("requires a contiguous encoder archive for a rebuild already recorded before upgrade", async () => {
		const f = setup();
		const receipt = {
			step: "rtmp",
			kind: "CREATE_INPUT_RTMP",
			payload: {},
			refs: {},
			status: "DONE",
			resourceId: "current-input",
			attempt: 1,
		};
		Object.assign(f.run, {
			stepLog: [receipt],
			archivedRtmpAttempt: 0,
			previousProviderEncodingIds: [],
		});
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, input),
		).resolves.toMatchObject({
			kind: "BLOCKED",
			reason: expect.stringContaining("RTMP rebuild"),
		});
		expect(f.channel.liveEffectFenceVersion).toBe(8);
		Object.assign(f.run, { archivedRtmpAttempt: 1 });
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, input),
		).resolves.toMatchObject({ kind: "RESOLVED" });
	});

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

	it.each([
		"late feeder",
		"previous run error",
		"lost pre-upgrade dispatch",
		"redelivered pre-upgrade dispatch",
	] as const)("recovers a fenced terminal observation after %s", async (kind) => {
		const f = ambiguousStop();
		if (kind === "late feeder") {
			f.channel.status = f.run.status = "STOPPING";
			f.channel.error = f.run.error = null;
			Object.assign(f.stopClaim, {
				stopProtocolVersion: 1,
				failure: "a feeder still occupies this channel",
			});
		} else if (kind === "previous run error") {
			f.channel.status = "STOPPING";
			f.stopClaim.state = "DISPATCHING";
		} else if (kind === "redelivered pre-upgrade dispatch") {
			f.stopClaim.failure =
				"effect owner expired after DISPATCHING; exact readback is required before retry";
		} else {
			f.stopClaim.state = "DISPATCHING";
			f.stopClaim.failure = null;
		}
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, observedStop),
		).resolves.toMatchObject({ kind: "RESOLVED" });
		if (kind === "late feeder")
			expect(f.createNotification).toHaveBeenCalledOnce();
		if (kind.includes("pre-upgrade"))
			expect(f.stopClaim).toMatchObject({
				stopOutcomeEvidence: {
					error: "stop response lost",
					accountId: "account-1",
				},
			});
	});
	it.each([
		"ERROR",
		"STOPPED",
	] as const)("recovers a legacy %s projection interrupted before it mirrored the run", async (status) => {
		const f = ambiguousStop();
		Object.assign(f.channel, {
			status,
			error:
				status === "ERROR"
					? "could not read provider"
					: "stop did not confirm — encoding-1: still RUNNING",
		});
		Object.assign(f.run, { status: "STOPPING", error: null });
		Object.assign(f.stopClaim, { state: "DISPATCHING", failure: null });
		expect(
			await resolveLiveEffectsAfterConfirmedStop(f.prisma, observedStop),
		).toMatchObject({ kind: "RESOLVED" });
		expect(f.run.status).toBe("STOPPED");
	});
	it("accepts a drained feeder enqueue failure only after exact terminal target and channel-wide release", async () => {
		const f = ambiguousStop();
		f.channel.status = f.run.status = "STOPPED";
		f.channel.error =
			f.run.error =
			f.stopClaim.failure =
				"stop did not confirm — feeder stop could not be enqueued (legacy-feeder: queue unavailable; disconnect during write) — its push may still be running";
		f.setFeederOccupiesRun(true);
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, observedStop),
		).resolves.toMatchObject({ kind: "BLOCKED" });
		f.setFeederOccupiesRun(false);
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, observedStop),
		).resolves.toMatchObject({ kind: "RESOLVED" });
	});
	it("keeps an overwritten provisioning target until every retained encoder has terminal proof", async () => {
		const f = ambiguousStop();
		Object.assign(f.run, { previousProviderEncodingIds: ["rtmp-first"] });
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, observedStop),
		).resolves.toMatchObject({ kind: "BLOCKED" });
		const readbacks = {
			...observedStop.terminalReadback,
			encodings: [{ id: "rtmp-first", status: "FINISHED" }],
		};
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, {
				...input,
				terminalReadback: readbacks,
			}),
		).resolves.toMatchObject({ kind: "RESOLVED" });
	});

	it("refuses primary-only readback when a failed same-run RESTART preserves another encoder", async () => {
		const f = ambiguousStop();
		const prior = f.claims[0];
		if (!prior) throw new Error("Missing earlier effect fixture");
		Object.assign(prior, {
			action: "RESTART",
			state: "FAILED",
			providerEncodingId: "encoding-B",
		});
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, observedStop),
		).resolves.toMatchObject({ kind: "BLOCKED" });
		expect(f.channel.status).toBe("ERROR");
	});

	it("settles matched sibling STOPs together without losing their original failure", async () => {
		const f = ambiguousStop();
		const prior = f.claims[0];
		if (!prior) throw new Error("Missing earlier effect fixture");
		Object.assign(prior, {
			action: "STOP",
			failure:
				"stop response lost; the provider/process call crossed its send boundary, so exact readback or operator resolution is required before retry",
		});
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, observedStop),
		).resolves.toMatchObject({ kind: "RESOLVED" });
		expect(f.claims.map((c) => c.state)).toEqual(["ACKED", "ACKED"]);
		expect(f.claims[0]?.failure).toContain("stop response lost");
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, observedStop),
		).resolves.toMatchObject({ kind: "ALREADY_ACKED" });
	});

	it("recovers a null run encoder only from its positive creation receipt", async () => {
		const f = ambiguousStop();
		Object.assign(f.run, { bitmovinEncodingId: null });
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, observedStop),
		).resolves.toMatchObject({ kind: "BLOCKED" });
		f.run.stepLog = [
			{
				step: "create",
				kind: "CREATE_ENCODING",
				status: "DONE",
				resourceId: input.providerEncodingId,
				refs: {},
				payload: {},
			},
		];
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, observedStop),
		).resolves.toMatchObject({ kind: "RESOLVED" });
		expect(f.run.bitmovinEncodingId).toBe(input.providerEncodingId);
	});

	it("repairs a historical run-only terminal heartbeat only when the STOP owns channel ERROR", async () => {
		const f = ambiguousStop();
		Object.assign(f.run, {
			status: "STOPPED",
			error: null,
			providerStatus: "FINISHED",
		});
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, observedStop),
		).resolves.toMatchObject({ kind: "RESOLVED" });
		expect(f.run.endedAt).toEqual(input.at);
	});

	it("commits the owner's compound STOP only after readback of every historical and logged target", async () => {
		const f = setup();
		const owner = f.claims[1];
		if (!owner) throw new Error("Missing STOP owner fixture");
		Object.assign(owner, { token: "owner" });
		const prior = f.claims[0];
		if (!prior) throw new Error("Missing earlier effect fixture");
		Object.assign(prior, {
			action: "RESTART",
			state: "FAILED",
			providerEncodingId: "encoding-B",
		});
		f.channel.status = f.run.status = "STOPPING";
		const logged = {
			step: "created",
			kind: "CREATE_ENCODING",
			status: "DONE",
			resourceId: "encoding-C",
			refs: {},
			payload: {},
		};
		f.run.stepLog = [logged];
		const proof = {
			...input,
			ownerReadbacks: {
				generation: 8,
				token: "owner",
				bitmovinAccountId: "account-1",
				encodings: [
					{ id: "encoding-1", status: "FINISHED" },
					{ id: "encoding-B", status: "CANCELED" },
				],
			},
		};
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, proof),
		).resolves.toMatchObject({ kind: "BLOCKED" });
		expect(f.channel.status).toBe("STOPPING");
		expect(owner.state).toBe("DISPATCHING");
		proof.ownerReadbacks.encodings.push({
			id: "encoding-C",
			status: "FINISHED",
		});
		f.setFeederOccupiesRun(true);
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, proof),
		).resolves.toMatchObject({ kind: "BLOCKED" });
		expect(f.feederLookup.mock.lastCall?.[0].where).not.toHaveProperty(
			"liveChannelRunId",
		);
		f.setFeederOccupiesRun(false);
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, proof),
		).resolves.toMatchObject({ kind: "RESOLVED" });
		expect(owner.state).toBe("ACKED");
		expect(f.claims[0]?.state).toBe("FAILED");
		expect(f.run).toMatchObject({
			status: "STOPPED",
			endedAt: input.at,
			stopNotificationAt: input.at,
			providerStatus: "FINISHED",
		});
	});

	it("requires read-only terminal proof after a worker exits during STOPPING", async () => {
		const f = setup();
		f.channel.status = f.run.status = "STOPPING";
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, input),
		).resolves.toMatchObject({ kind: "BLOCKED" });
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, observedStop),
		).resolves.toMatchObject({ kind: "RESOLVED" });
		expect(f.run.endedAt).toEqual(input.at);
	});

	it("does not acknowledge a clean interrupted STOP when the run log alone names a second encoding", async () => {
		const f = setup();
		f.run.stepLog = [
			{
				step: "secondary",
				kind: "CREATE_ENCODING",
				status: "DONE",
				resourceId: "other",
				refs: {},
				payload: {},
			},
		];
		const interrupted = { ...input, interruptedAckGeneration: 8 };
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, interrupted),
		).resolves.toMatchObject({ kind: "BLOCKED" });
		expect(f.claims[1]?.state).toBe("DISPATCHING");
	});

	it("requires all channel feeders to release their claims before acknowledging a clean interrupted STOP", async () => {
		const f = setup();
		const interrupted = { ...input, interruptedAckGeneration: 8 };
		const finder = f.feederLookup;
		finder.mockImplementation(async ({ where }) =>
			"liveChannelRunId" in where ? null : { id: "legacy-held-feeder" },
		);
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, interrupted),
		).resolves.toMatchObject({ kind: "BLOCKED" });
		expect(finder.mock.calls[0]?.[0]?.where).toMatchObject({
			liveChannelId: input.liveChannelId,
			OR: expect.any(Array),
		});
		finder.mockResolvedValueOnce(null);
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, interrupted),
		).resolves.toMatchObject({ kind: "RESOLVED" });
	});

	it("settles a recorded STOP response loss on a fresh read of the exact terminal encoding", async () => {
		const f = ambiguousStop();
		const terminalAt = f.run.providerTerminalAt;
		const endedAt = new Date("2026-09-01T00:00:00.000Z");
		f.run.endedAt = endedAt;
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, observedStop),
		).resolves.toMatchObject({ kind: "RESOLVED", recoveredFromError: true });
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
		expect(f.stopClaim.failure).toContain("stop response lost");
		expect(f.claims[0]?.failure).toBe("response lost");
	});

	it.each([
		"clean interrupted ACK",
		"new terminal GET",
		"inline ACK",
		"job redelivery",
	])("preserves a previous STOP's second-encoding evidence during %s", async (mode) => {
		const f = ambiguousStop();
		const previous = f.claims[0];
		if (!previous) throw new Error("missing earlier claim");
		const evidence =
			"stop did not confirm — encoding-B: still RUNNING after the stop was accepted";
		Object.assign(previous, { action: "STOP", failure: evidence });
		if (mode !== "new terminal GET") {
			f.channel.status = f.run.status = "STOPPED";
			f.channel.error = f.run.error = null;
			f.run.providerStatus = "FINISHED";
		}
		if (mode === "inline ACK") f.stopClaim.state = "DISPATCHING";
		const request =
			mode === "new terminal GET"
				? observedStop
				: mode === "clean interrupted ACK"
					? { ...input, interruptedAckGeneration: 8 }
					: input;
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, request),
		).resolves.toMatchObject({ kind: "BLOCKED" });
		expect(previous).toMatchObject({ state: "AMBIGUOUS", failure: evidence });
		expect(f.stopClaim.state).toBe(
			mode === "inline ACK" ? "DISPATCHING" : "AMBIGUOUS",
		);
		expect(f.channel.liveEffectFenceVersion).toBe(8);
	});

	it("matches and rechecks the tenant credential recorded only in a legacy plan", async () => {
		const f = ambiguousStop();
		f.channel.bitmovinAccountId = null;
		f.channel.plan = { bitmovin: { accountId: "other-account" } };
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, observedStop),
		).resolves.toMatchObject({ kind: "BLOCKED" });
		f.channel.plan = { bitmovin: { accountId: "account-1" } };
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, observedStop),
		).resolves.toMatchObject({ kind: "RESOLVED" });
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
		if (reason === "unexpired dispatch") {
			f.stopClaim.state = "DISPATCHING";
			f.stopClaim.expiresAt = new Date("2099-01-01T00:00:00Z");
		}
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
	it("retains a slow feeder until it drains, including after a simultaneous encoder timeout", async () => {
		const f = ambiguousStop();
		f.channel.status = f.run.status = "STOPPED";
		f.channel.error =
			f.run.error =
			f.stopClaim.failure =
				"stop did not confirm — encoding-1: still RUNNING after the stop was accepted; encoding-1: the exact claimed encoding has no terminal readback; feeder bbb08c73-7de4-4c1b-86f3-f6c27e8847bf: stop was enqueued but publisher termination was not confirmed";
		f.setFeederOccupiesRun(true);
		await expect(
			resolveLiveEffectsAfterConfirmedStop(f.prisma, observedStop),
		).resolves.toMatchObject({ kind: "BLOCKED" });
		f.setFeederOccupiesRun(false);
		const settled = await resolveLiveEffectsAfterConfirmedStop(
			f.prisma,
			observedStop,
		);
		expect(settled).toMatchObject({ kind: "RESOLVED" });
		expect(settled).not.toHaveProperty("recoveredFromError");
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
