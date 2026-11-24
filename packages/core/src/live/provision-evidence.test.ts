import { expect, it } from "vitest";
import type { StepLogEntry } from "../plan/steplog";
import { restoreLiveProvisionEvidence } from "./provision-evidence";

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
