import { describe, expect, it } from "vitest";
import { initStepLog } from "../plan/steplog";
import {
	aisaCreateNotDispatched,
	aisaLiveFinalization,
	aisaLiveNeverStarted,
	aisaStartNotDispatched,
} from "./aisa-finalization";

const analysisId = "a0000000-0000-4000-8000-000000000001";
const encodingId = "a0000000-0000-4000-8000-000000000002";
const snapshot = {
	analysisId,
	encodingId,
	sequence: 1,
	isFinal: true,
	producedAt: "2026-11-07T00:00:00Z",
	mediaTimeOriginUnixMs: 1,
	analyzedStartTimeSeconds: 0,
	analyzedEndTimeSeconds: 1,
	metadata: { version: "1", disclaimer: "Preview" },
	observations: [],
	keyMoments: [],
	sourceGaps: [],
};
const run = {
	aisaAnalysisId: analysisId,
	bitmovinEncodingId: encodingId,
	aisaStatus: "FINISHED",
	providerStatus: "FINISHED",
	aisaSnapshot: snapshot,
};

describe("independent AISA finalization proof", () => {
	it("accepts only a matching run's persisted never-started proof and undispatched log", () => {
		const id = "a0000000-0000-4000-8000-000000000003";
		const log = initStepLog([
			{
				step: "analysis",
				kind: "CREATE_AISA_LIVE_ANALYSIS",
				payload: {},
				refs: {},
			},
			{
				step: "encoding",
				kind: "RESOLVE_AISA_LIVE_ENCODING",
				payload: {},
				refs: { analysisId: "analysis" },
			},
			{
				step: "start",
				kind: "START_AISA_LIVE_ANALYSIS",
				payload: {},
				refs: { analysisId: "analysis", encodingId: "encoding" },
			},
			{
				step: "await:running",
				kind: "AWAIT_LIVE_RUNNING",
				payload: {},
				refs: { analysisId: "analysis", encodingId: "encoding" },
			},
		]);
		const state = {
			id,
			aisaAnalysisId: null,
			bitmovinEncodingId: null,
			stepLog: log,
			aisaFinalization: {
				kind: "NEVER_STARTED",
				basis: "CREATE_NOT_DISPATCHED",
				runId: id,
				observedAt: "2026-11-07T00:00:00Z",
			},
		};
		const channel = { bitmovinEncodingId: null, stepLog: log };
		expect(aisaCreateNotDispatched(log)).toBe(true);
		expect(aisaLiveNeverStarted(state, channel)).toBe(true);
		expect(aisaLiveNeverStarted({ ...state, id: encodingId }, channel)).toBe(
			false,
		);
		const ambiguous = structuredClone(log);
		const ambiguousCreate = ambiguous[0];
		const [create, resolveEncoding, start] = log;
		if (!ambiguousCreate || !create || !resolveEncoding || !start)
			throw new Error("Incomplete fixture log");
		ambiguousCreate.response = { aisaCreateDispatched: true };
		expect(aisaCreateNotDispatched(ambiguous)).toBe(false);
		expect(
			aisaLiveNeverStarted(state, { ...channel, stepLog: ambiguous }),
		).toBe(false);
		create.status = "DONE";
		create.resourceId = analysisId;
		resolveEncoding.status = "DONE";
		resolveEncoding.resourceId = encodingId;
		const bound = {
			...state,
			aisaAnalysisId: analysisId,
			bitmovinEncodingId: encodingId,
			aisaStatus: "CREATED",
			providerStatus: "CREATED",
			encoderStoppedConfirmedFor: encodingId,
			aisaFinalization: {
				kind: "NEVER_STARTED",
				basis: "BOUND_CREATED_NOT_STARTED",
				runId: id,
				analysisId,
				encodingId,
				analysisStatus: "CREATED",
				encodingStatus: "CREATED",
				observedAt: "2026-11-07T00:00:00Z",
			},
		};
		const boundChannel = {
			bitmovinEncodingId: encodingId,
			encoderStoppedConfirmedFor: encodingId,
			stepLog: log,
		};
		expect(aisaStartNotDispatched(log, analysisId, encodingId)).toBe(true);
		expect(aisaLiveNeverStarted(bound, boundChannel)).toBe(true);
		start.response = { aisaStartDispatched: true };
		expect(aisaLiveNeverStarted(bound, boundChannel)).toBe(false);
	});
	it("leaves ordinary runs unchanged", () =>
		expect(aisaLiveFinalization({})).toBe("UNBOUND"));
	it("requires terminal Analysis and Encoder plus a final result for this pair", () => {
		expect(aisaLiveFinalization(run)).toBe("COMPLETE");
		for (const patch of [
			{ aisaStatus: "RUNNING" },
			{ providerStatus: "RUNNING" },
			{ aisaSnapshot: null },
			{ aisaSnapshot: { ...snapshot, isFinal: false } },
			{ aisaSnapshot: { ...snapshot, encodingId: analysisId } },
		])
			expect(aisaLiveFinalization({ ...run, ...patch })).toBe("PENDING");
	});
	it("keeps final terminal failure distinct from success", () => {
		expect(aisaLiveFinalization({ ...run, aisaStatus: "ERROR" })).toBe(
			"FAILED",
		);
		expect(aisaLiveFinalization({ ...run, providerStatus: "ERROR" })).toBe(
			"FAILED",
		);
		expect(
			aisaLiveFinalization({ ...run, aisaStatus: "ERROR", aisaSnapshot: null }),
		).toBe("PENDING");
		expect(
			aisaLiveFinalization({
				...run,
				aisaStatus: "ERROR",
				aisaSnapshot: null,
				aisaFinalization: {
					analysisId,
					encodingId,
					status: "ERROR",
					result: "UNAVAILABLE_TERMINAL_FAILURE",
					observedAt: "2026-11-07T00:00:00Z",
				},
			}),
		).toBe("FAILED");
	});
});
