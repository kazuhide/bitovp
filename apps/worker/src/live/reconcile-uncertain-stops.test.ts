import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import type { SdkOps } from "../orchestrator/sdk-ops";
import { createUncertainStopReconciler } from "./reconcile-uncertain-stops";

const db = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@bitovp/db", async (original) => ({
	...(await original<typeof import("@bitovp/db")>()),
	resolveLiveEffectsAfterConfirmedStop: db.resolve,
}));

function setup() {
	db.resolve.mockReset().mockResolvedValue({ kind: "RESOLVED", count: 0 });
	const now = () => "2026-11-24T05:00:00.000Z";
	const candidate = {
		id: "claim",
		liveChannelRunId: "run",
		providerEncodingId: "encoding",
		idempotencyKey: "stop",
		generation: 4,
		liveChannelId: "channel",
		state: "AMBIGUOUS",
		failure:
			"response lost; the provider/process call crossed its send boundary, so exact readback or operator resolution is required before retry",
		liveChannel: {
			origin: "MANAGED",
			bitmovinAccountId: "account",
			plan: {},
			bitmovinEncodingId: "encoding",
			status: "ERROR",
			error: "response lost",
			liveEffectFenceVersion: 4,
			runs: [
				{ id: "run", bitmovinEncodingId: "encoding", aisaAnalysisId: null },
			],
		},
	};
	const findMany = vi.fn().mockResolvedValue([candidate]);
	const getEncodingStatus = vi.fn().mockResolvedValue({ status: "FINISHED" });
	const stopLiveEncoding = vi.fn();
	const tick = createUncertainStopReconciler({
		now,
		prisma: { liveEffectClaim: { findMany } } as unknown as AppPrismaClient,
		revealBitmovinAccount: vi
			.fn()
			.mockResolvedValue({ apiKey: "mock", tenantOrgId: null }),
		makeSdk: () =>
			({ getEncodingStatus, stopLiveEncoding }) as unknown as SdkOps,
	});
	return { candidate, findMany, getEncodingStatus, stopLiveEncoding, tick };
}

describe("ordinary Live STOP reconciliation", () => {
	it("observes a terminal encoder on a later tick after a running and an unreadable sample, without a second STOP", async () => {
		const f = setup();
		f.getEncodingStatus
			.mockResolvedValueOnce({ status: "RUNNING" })
			.mockRejectedValueOnce(new Error("unavailable"));
		expect(await f.tick()).toBe(0);
		expect(await f.tick()).toBe(0);
		expect(db.resolve).not.toHaveBeenCalled();
		expect(await f.tick()).toBe(1);
		expect(f.getEncodingStatus.mock.calls).toEqual([
			["encoding"],
			["encoding"],
			["encoding"],
		]);
		expect(db.resolve).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				liveChannelId: "channel",
				liveChannelRunId: "run",
				providerEncodingId: "encoding",
				stopClaimId: "claim",
				terminalReadback: {
					generation: 4,
					bitmovinAccountId: "account",
					providerStatus: "FINISHED",
				},
			}),
		);
		expect(f.stopLiveEncoding).not.toHaveBeenCalled();
	});

	it("closes an interrupted ACK from already-persisted clean evidence without provider I/O", async () => {
		const f = setup();
		f.candidate.state = "DISPATCHING";
		Object.assign(f.candidate.liveChannel, { status: "STOPPED", error: null });
		await f.tick();
		expect(f.getEncodingStatus).not.toHaveBeenCalled();
		expect(db.resolve.mock.calls[0]?.[1]).not.toHaveProperty(
			"terminalReadback",
		);
		expect(f.findMany.mock.calls[0]?.[0].where.OR).toContainEqual(
			expect.objectContaining({
				state: "DISPATCHING",
				expiresAt: { lte: expect.any(Date) },
			}),
		);
	});

	it("skips stale runs, generations, AISA and uncompleted dispatches before provider I/O", async () => {
		const f = setup();
		for (const patch of [
			{ liveEffectFenceVersion: 6 },
			{ runs: [] },
			{ bitmovinEncodingId: "other" },
			{ plan: { start: { aiSceneAnalysisLive: {} } } },
			{ origin: "AISA_IMPORTED" },
			{ error: "unrelated local fault" },
		]) {
			f.findMany.mockResolvedValueOnce([
				{
					...f.candidate,
					liveChannel: { ...f.candidate.liveChannel, ...patch },
				},
			]);
			expect(await f.tick()).toBe(0);
		}
		f.candidate.state = "DISPATCHING";
		expect(await f.tick()).toBe(0);
		expect(db.resolve).not.toHaveBeenCalled();
		expect(f.getEncodingStatus).not.toHaveBeenCalled();
	});

	it("rotates past an unresolved page and wraps after exhausting the bounded scan", async () => {
		const f = setup();
		f.findMany.mockImplementation(async ({ take, where }) =>
			where.id
				? []
				: Array.from({ length: take }, (_, i) => ({
						...f.candidate,
						id: String(i + 1),
					})),
		);
		f.getEncodingStatus.mockResolvedValue({ status: "RUNNING" });
		await f.tick();
		await f.tick();
		await f.tick();
		const [first, second, third] = f.findMany.mock.calls.map(([args]) => args);
		expect(first.take).toBeGreaterThan(0);
		expect(second.where.id).toEqual({ gt: String(first.take) });
		expect(third.where.id).toBeUndefined();
	});
});
