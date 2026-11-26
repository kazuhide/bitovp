import { describe, expect, it } from "vitest";
import type { StepLogEntry } from "../plan/steplog";
import { projectMoqTaskHistory, projectMoqTaskStatus } from "./moq-task-status";

const secretText =
	"MoQ authToken=publisher-secret moqt://relay.example/private";
const entry = (kind: StepLogEntry["kind"]): StepLogEntry => ({
	step: kind,
	kind,
	status: "DONE",
	payload: {},
	refs: {},
});

describe("MoQ public Task metadata", () => {
	it.each([
		"CREATED",
		"QUEUED",
		"RUNNING",
		"FINISHED",
		"ERROR",
		"CANCELED",
		"TRANSFER_ERROR",
	])("retains only known status %s and finite progress including zero", (status) => {
		expect(
			projectMoqTaskStatus({
				status,
				progress: 0,
				messages: [secretText],
				error: secretText,
				futureProviderField: secretText,
			}),
		).toEqual({ status, progress: 0 });
	});
	it.each([
		null,
		{},
		{ status: secretText },
		{ status: "UNKNOWN" },
	])("does not turn an invalid Task into a known state", (task) =>
		expect(projectMoqTaskStatus(task)).toBeNull());
	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		"42",
	])("omits invalid optional progress %s", (progress) =>
		expect(projectMoqTaskStatus({ status: "RUNNING", progress })).toEqual({
			status: "RUNNING",
		}));
});

describe("stored MoQ Task history", () => {
	it("projects DONE await text and all entry/top-level error prose without mutating history", () => {
		const entries = [
			{
				...entry("CREATE_OUTPUT_MOQ"),
				error: secretText,
				resourceId: "output",
			},
			{
				...entry("AWAIT_LIVE_RUNNING"),
				response: { status: "RUNNING", progress: 0, messages: [secretText] },
				error: secretText,
			},
		];
		const original = structuredClone(entries);
		const view = projectMoqTaskHistory(entries, secretText);
		expect(view.moq).toBe(true);
		expect(view.stepLog).toEqual([
			{ ...original[0], error: "MoQ encoding operation failed" },
			{
				...original[1],
				response: { status: "RUNNING", progress: 0 },
				error: "MoQ encoding operation failed",
			},
		]);
		expect(view.error).toBe("MoQ encoding operation failed");
		expect(entries).toEqual(original);
	});
	it("keeps legacy Live/VOD history and errors unchanged", () => {
		const entries = [
			{ ...entry("CREATE_OUTPUT_S3"), error: "storage error" },
			{
				...entry("AWAIT_LIVE_RUNNING"),
				response: { messages: ["diagnostic"] },
			},
		];
		const view = projectMoqTaskHistory(entries, "legacy error");
		expect(view).toEqual({
			moq: false,
			stepLog: entries,
			error: "legacy error",
		});
		expect(view.stepLog).toBe(entries);
	});
	it("withholds malformed MoQ logs and unknown Task shapes without inventing healthy data", () => {
		expect(
			projectMoqTaskHistory([{ kind: "CREATE_OUTPUT_MOQ" }], null),
		).toEqual({
			moq: true,
			stepLog: [],
			error: null,
		});
		const view = projectMoqTaskHistory(
			[
				entry("CREATE_OUTPUT_MOQ"),
				{ ...entry("AWAIT_LIVE_RUNNING"), response: { status: secretText } },
			],
			"",
		);
		if (!view.moq) throw new Error("Expected MoQ projection");
		expect(view.stepLog[1]?.response).toBeNull();
		expect(view.error).toBeNull();
	});
});
