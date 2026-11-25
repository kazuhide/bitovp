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
