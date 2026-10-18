import { vmafCloudProfileSchema } from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import { hashId, profileHash, taskName } from "./provider-common.js";
import { createComputeAdapter } from "./providers.js";

const profile = vmafCloudProfileSchema.parse({
	id: "test",
	label: "Test",
	provider: "GCP_BATCH",
	project: "project",
	region: "europe-west1",
	machineType: "n2-standard-8",
	serviceAccount: "worker@example.com",
	spot: true,
	image: `registry.example/vmaf@sha256:${"a".repeat(64)}`,
	cpu: 8,
	memoryMiB: 32768,
	diskGiB: 100,
	maxParallel: 2,
	timeoutSeconds: 1800,
	queueTimeoutSeconds: 600,
	maxCostUsdPerHour: 1,
	transferUsdPerGiB: 0,
	overheadUsd: 0,
	maxStagingGiB: 100,
	staging: { provider: "GCS", bucket: "staging" },
});
const id = `projects/project/locations/europe-west1/jobs/${taskName("task-1")}`;
const task = (exitCode: number) => ({
	name: `${id}/taskGroups/group0/tasks/0`,
	status: {
		state: "FAILED",
		statusEvents: [
			{
				type: "TASK_STATE_CHANGED",
				taskState: "FAILED",
				taskExecution: { exitCode },
			},
		],
	},
});
function fixture(
	events: unknown[] = [],
	pages: unknown[] = [],
	state = "FAILED",
) {
	const fetcher = vi.fn(
		async (url: string | URL | Request) =>
			new Response(
				JSON.stringify(
					String(url).includes("/tasks?")
						? (pages.shift() ?? {})
						: {
								labels: {
									"vmaf-profile": profileHash(profile),
									"vmaf-task": hashId("task-1"),
								},
								status: {
									state,
									statusEvents: events,
									taskGroups: { group0: {} },
								},
							},
				),
				{ status: 200 },
			),
	);
	const adapter = createComputeAdapter(profile, {
		fetch: fetcher as typeof fetch,
		googleToken: async () => "token",
	});
	return { adapter, fetcher };
}

describe("GCP failure classification", () => {
	it("reads exact task exit codes beyond generic job TASK_FAILED and paginates", async () => {
		const { adapter, fetcher } = fixture(
			[{ type: "TASK_FAILED" }],
			[{ tasks: [], nextPageToken: "next&token" }, { tasks: [task(50001)] }],
		);
		expect(await adapter.failureReason?.(id)).toBe("PREEMPTED");
		expect(String(fetcher.mock.calls[2]?.[0])).toContain(
			"pageToken=next%26token",
		);
	});
	it.each([
		1, 137, 50000, 50002, 50005,
	])("does not retry unknown/application exit %i", async (code) => {
		const { adapter } = fixture(
			[{ description: "ZONE_RESOURCE_POOL_EXHAUSTED" }],
			[{ tasks: [task(code)] }],
		);
		expect(await adapter.failureReason?.(id)).toBe("OTHER");
	});
	it.each([
		"ZONE_RESOURCE_POOL_EXHAUSTED",
		"ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS",
	])("recognizes exact capacity code %s while queued", async (code) => {
		const { adapter } = fixture(
			[{ description: `VM allocation failed: ${code}` }],
			[{}],
			"QUEUED",
		);
		expect(await adapter.failureReason?.(id)).toBe("CAPACITY");
	});
	it.each([
		"RESOURCE_EXHAUSTED",
		"quota exceeded",
		"permission denied",
		"capacity problem",
		"exit code 50001",
	])("fails closed on vague evidence %s", async (description) => {
		const { adapter } = fixture([{ description }], [{}]);
		expect(await adapter.failureReason?.(id)).toBe("OTHER");
	});
	it("does not let old stockout evidence override a generic terminal task failure", async () => {
		const { adapter } = fixture(
			[
				{ description: "ZONE_RESOURCE_POOL_EXHAUSTED" },
				{ type: "TASK_FAILED" },
			],
			[{}],
		);
		expect(await adapter.failureReason?.(id)).toBe("OTHER");
	});
	it("accepts the documented preemption event description", async () => {
		const { adapter } = fixture(
			[
				{
					description:
						"Task state is updated from RUNNING to FAILED on zones/z/instances/vm due to Spot Preemption with exit code 50001.",
				},
			],
			[{}],
		);
		expect(await adapter.failureReason?.(id)).toBe("PREEMPTED");
	});
	it("fails closed on conflicting preemption and application failure", async () => {
		const { adapter } = fixture([], [{ tasks: [task(50001), task(1)] }]);
		expect(await adapter.failureReason?.(id)).toBe("OTHER");
	});
	it("rejects task-read authentication errors without classifying them as capacity", async () => {
		const { adapter, fetcher } = fixture([
			{ description: "ZONE_RESOURCE_POOL_EXHAUSTED" },
		]);
		fetcher.mockImplementationOnce(
			async () =>
				new Response(
					JSON.stringify({
						labels: {
							"vmaf-profile": profileHash(profile),
							"vmaf-task": hashId("task-1"),
						},
						status: { state: "FAILED", taskGroups: { group0: {} } },
					}),
				),
		);
		fetcher.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
		await expect(adapter.failureReason?.(id)).rejects.toThrow(
			"VMAF cloud failure reason failed",
		);
	});
	it("does not retry successful or running jobs with old failure events", async () => {
		for (const state of ["RUNNING", "SUCCEEDED"]) {
			const { adapter, fetcher } = fixture(
				[{ taskExecution: { exitCode: 50001 } }],
				[],
				state,
			);
			expect(await adapter.failureReason?.(id)).toBe("OTHER");
			expect(fetcher).toHaveBeenCalledTimes(1);
		}
	});
	it("does not let preemption evidence override explicit job-level application failure", async () => {
		const { adapter } = fixture(
			[{ taskExecution: { exitCode: 1 } }],
			[{ tasks: [task(50001)] }],
		);
		expect(await adapter.failureReason?.(id)).toBe("OTHER");
	});
	it("rejects a foreign job before querying its tasks", async () => {
		const { adapter, fetcher } = fixture();
		await expect(
			adapter.failureReason?.(
				id.replace("projects/project/", "projects/foreign/"),
			),
		).rejects.toThrow("VMAF cloud failure reason failed");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("rejects ownership mismatch before querying tasks", async () => {
		const { adapter, fetcher } = fixture();
		fetcher.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					labels: { "vmaf-profile": "foreign", "vmaf-task": hashId("task-1") },
				}),
			),
		);
		await expect(adapter.failureReason?.(id)).rejects.toThrow(
			"VMAF cloud failure reason failed",
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("rejects foreign task identity and incomplete pagination", async () => {
		const foreign = fixture(
			[],
			[{ tasks: [{ ...task(50001), name: "foreign/task" }] }],
		);
		await expect(foreign.adapter.failureReason?.(id)).rejects.toThrow(
			"VMAF cloud failure reason failed",
		);
		const incomplete = fixture(
			[],
			[{ tasks: [task(50001)], unreachable: ["zone"] }],
		);
		await expect(incomplete.adapter.failureReason?.(id)).rejects.toThrow(
			"VMAF cloud failure reason failed",
		);
	});
	it("rejects repeating pagination tokens instead of looping", async () => {
		const { adapter } = fixture(
			[],
			[{ nextPageToken: "repeat" }, { nextPageToken: "repeat" }],
		);
		await expect(adapter.failureReason?.(id)).rejects.toThrow(
			"VMAF cloud failure reason failed",
		);
	});
});
