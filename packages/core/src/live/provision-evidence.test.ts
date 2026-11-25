import { expect, it } from "vitest";
import { reseedFailedSteps, type StepLogEntry } from "../plan/steplog";
import {
	restoreCompiledLiveProvisionGraph,
	restoreLiveProvisionEvidence,
} from "./provision-evidence";

const pending = (kind: StepLogEntry["kind"]): StepLogEntry => ({
	step: kind,
	kind,
	payload: {},
	refs: {},
	status: "PENDING",
});
const at = "2026-11-25T00:00:00.000Z";
it.each([
	"CREATE_ENCODING",
	"START_LIVE_ENCODING",
] as const)("preserves the evidence of an in-flight %s in either projection", (kind) => {
	const step = pending(kind),
		attempted = { ...step, status: "RUNNING" as const, startedAt: at };
	expect(restoreLiveProvisionEvidence([step], [attempted])).toEqual([
		attempted,
	]);
	expect(restoreLiveProvisionEvidence([], [attempted])).toEqual([attempted]);
	expect(restoreLiveProvisionEvidence([attempted], [step])).toEqual([
		attempted,
	]);
});
it("recovers a confirmed native CREATE from the matching provider generation with nullable primary columns", () => {
	const step = pending("CREATE_ENCODING"),
		saved = { ...step, status: "DONE" as const, resourceId: "enc" };
	expect(restoreLiveProvisionEvidence([step], [saved], null)).toEqual([saved]);
	expect(restoreLiveProvisionEvidence([step], [saved], "other-enc")).toBeNull();
	expect(
		restoreLiveProvisionEvidence([{ ...step, attempt: 1 }], [saved], null),
	).toEqual([{ ...step, attempt: 1 }]);
});
it("an accepted managed START supersedes its earlier in-flight marker", () => {
	const step = pending("START_AISA_LIVE_ANALYSIS");
	const saved = {
		...step,
		status: "RUNNING" as const,
		response: { aisaStartDispatched: true },
		startedAt: at,
	};
	const done = {
		...step,
		status: "DONE" as const,
		startedAt: at,
		response: { started: true },
	};
	expect(restoreLiveProvisionEvidence([done], [saved])).toEqual([done]);
	expect(restoreLiveProvisionEvidence([step], [done])).toEqual([done]);
});
it("a completed or in-flight START in another operation generation cannot override the current one", () => {
	const step = pending("START_LIVE_ENCODING");
	expect(
		restoreLiveProvisionEvidence(
			[{ ...step, attempt: 1 }],
			[{ ...step, status: "DONE", startedAt: at, response: { started: true } }],
		),
	).toEqual([{ ...step, attempt: 1 }]);
	expect(
		restoreLiveProvisionEvidence(
			[step],
			[{ ...step, attempt: 1, status: "RUNNING", startedAt: at }],
		),
	).toBeNull();
});

it("restores exact completed graph steps for the same revival generation", () => {
	const stream = pending("CREATE_STREAM");
	const saved = {
		...stream,
		status: "DONE" as const,
		resourceId: "prior-stream",
		response: { id: "prior-stream" },
	};
	expect(restoreLiveProvisionEvidence([stream], [saved], null, true)).toEqual([
		saved,
	]);
	const newer = { ...stream, attempt: 1 };
	expect(restoreLiveProvisionEvidence([newer], [saved], null, true)).toEqual([
		newer,
	]);
	expect(
		restoreLiveProvisionEvidence(
			[stream],
			[{ ...saved, attempt: 1 }],
			null,
			true,
		),
	).toBeNull();
	expect(
		restoreLiveProvisionEvidence(
			[{ ...saved, resourceId: "other-stream" }],
			[saved],
			null,
			true,
		),
	).toBeNull();
});

it("restores only the archived generation of an exact-airing RTMP graph", () => {
	const prefix = pending("CREATE_OUTPUT_S3");
	const input = pending("CREATE_INPUT_RTMP");
	const create = pending("CREATE_ENCODING");
	const wait = pending("AWAIT_LIVE_RUNNING");
	const compiled = [prefix, input, create, wait];
	const savedInput = {
		...input,
		attempt: 2,
		status: "DONE" as const,
		resourceId: "input",
	};
	const savedCreate = {
		...create,
		attempt: 2,
		status: "RUNNING" as const,
		startedAt: at,
	};
	const saved = [prefix, savedInput, savedCreate];
	expect(restoreCompiledLiveProvisionGraph(compiled, saved, null, 2)).toEqual([
		prefix,
		savedInput,
		savedCreate,
		{ ...wait, attempt: 2 },
	]);
	expect(
		restoreCompiledLiveProvisionGraph(compiled, saved, null, 3),
	).toBeNull();
	expect(
		restoreCompiledLiveProvisionGraph(
			compiled,
			[...saved, { ...wait, attempt: 1 }],
			null,
			2,
		),
	).toBeNull();
	expect(
		restoreCompiledLiveProvisionGraph(compiled, [savedCreate], null, 2),
	).toBeNull();
	expect(
		restoreCompiledLiveProvisionGraph(
			compiled,
			[...saved, savedCreate],
			null,
			2,
		),
	).toBeNull();
	expect(
		restoreCompiledLiveProvisionGraph(
			compiled,
			[{ ...prefix, attempt: 2 }, savedInput],
			null,
			2,
		),
	).toBeNull();
	expect(
		restoreCompiledLiveProvisionGraph(
			compiled,
			[savedInput, { ...savedCreate, resourceId: "different-encoder" }],
			"current-encoder",
			2,
		),
	).toBeNull();
});

it("keeps each saved runtime record once without turning it into a provision step", () => {
	const stream = pending("CREATE_STREAM");
	const event = {
		...pending("LIVE_AUTO_SHUTDOWN_UPDATE"),
		status: "DONE" as const,
		finishedAt: at,
	};
	const other = { ...event, step: "another-change" };
	const inFlight = { ...event, status: "RUNNING" as const };
	expect(
		reseedFailedSteps([inFlight, { ...stream, status: "FAILED" }]),
	).toEqual([inFlight, stream]);
	expect(
		restoreLiveProvisionEvidence([stream, event], [other, event], null, true),
	).toEqual([stream, event, other]);
	expect(
		restoreLiveProvisionEvidence(
			[stream],
			[{ ...event, step: stream.step }],
			null,
			true,
		),
	).toBeNull();
});

it("matches concurrent same-key runtime events by occurrence across both mirrors", () => {
	const graph = pending("CREATE_MUXING_FMP4");
	const event = {
		...pending("ESAM_MEDIA_POINT"),
		step: "esam-123",
		status: "DONE" as const,
		finishedAt: at,
		request: { matchTime: "00:00:01", signals: [{ offset: 1 }] },
	};
	const other = {
		...event,
		request: { signals: [{ offset: 2 }], matchTime: "00:00:01" },
	};
	const channel = [graph, event];
	const history = [
		graph,
		{ ...event, request: { signals: [{ offset: 1 }], matchTime: "00:00:01" } },
		other,
		event,
	];
	const expected = [graph, event, other, event];
	expect(restoreLiveProvisionEvidence(channel, history, null, true)).toEqual(
		expected,
	);
	expect(restoreLiveProvisionEvidence(expected, history, null, true)).toEqual(
		expected,
	);
	expect(restoreCompiledLiveProvisionGraph([graph], history, null, 0)).toEqual(
		expected,
	);
	expect(
		restoreCompiledLiveProvisionGraph(
			[graph],
			[graph, { ...event, step: graph.step }],
			null,
			0,
		),
	).toBeNull();
});

it("retains child adoption after a failed lookup or a prior reseed, only for its recorded generation", () => {
	const child = pending("CREATE_MUXING_FMP4");
	const started = { ...child, startedAt: at, status: "RUNNING" as const };
	const expected = { ...child, startedAt: at, adoptExistingOnly: true };
	expect(restoreLiveProvisionEvidence([child], [started], null, true)).toEqual([
		expected,
	]);
	const failed = {
		...expected,
		adoptExistingOnly: true as const,
		finishedAt: at,
		status: "FAILED" as const,
	};
	expect(
		restoreLiveProvisionEvidence(
			[child],
			reseedFailedSteps([failed]),
			null,
			true,
		),
	).toEqual([expected]);
	expect(
		restoreLiveProvisionEvidence(
			[{ ...child, attempt: 1 }],
			[started],
			null,
			true,
		),
	).toEqual([{ ...child, attempt: 1 }]);
});
