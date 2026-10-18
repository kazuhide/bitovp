import { vmafCloudProfileSchema } from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import { azureAdapter } from "./provider-azure.js";

const now = Date.parse("2026-09-24T00:00:00Z");
const launch = {
	taskId: "auto-1",
	manifestUrl: "https://staging.example/manifest",
	deadline: "2026-09-24T00:30:00Z",
};
function setup(cpu = 4, memoryMiB = 8192, diskGiB = 100, spot = true) {
	const profile = vmafCloudProfileSchema.parse({
		id: "azure",
		label: "Azure",
		provider: "AZURE_BATCH",
		region: "westeurope",
		accountUrl: "https://account.westeurope.batch.azure.com",
		poolId: "template",
		image: `registry.example/vmaf@sha256:${"a".repeat(64)}`,
		cpu,
		memoryMiB,
		diskGiB,
		spot,
		maxParallel: 1,
		timeoutSeconds: 1800,
		queueTimeoutSeconds: 600,
		maxCostUsdPerHour: 1,
		transferUsdPerGiB: 0,
		overheadUsd: 0,
		maxStagingGiB: 100,
		staging: { provider: "S3", region: "eu-west-1", bucket: "staging" },
	});
	if (profile.provider !== "AZURE_BATCH") throw new Error("test profile");
	const template: Record<string, unknown> = {
		id: "template",
		vmSize: "Standard_D2s_v5",
		targetDedicatedNodes: 20,
		enableAutoScale: true,
		autoScaleFormula: "ignored",
		taskSlotsPerNode: 8,
		virtualMachineConfiguration: {
			nodeAgentSKUId: "batch.node.ubuntu 22.04",
			imageReference: {
				publisher: "microsoft-azure-batch",
				offer: "ubuntu-server-container",
			},
			containerConfiguration: { type: "dockerCompatible" },
		},
		networkConfiguration: { subnetId: "/subscriptions/example/subnet" },
	};
	let submitted: Record<string, unknown> = {};
	const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
		if (init?.method === "POST") {
			submitted = JSON.parse(String(init.body));
			return new Response("{}", { status: 201 });
		}
		return new Response(JSON.stringify(template));
	});
	const adapter = azureAdapter(profile, {
		fetch: fetcher as typeof fetch,
		azureToken: async () => "test",
		now: () => now,
	});
	return { adapter, template, fetcher, submitted: () => submitted };
}

describe("Azure per-pair automatic pool", () => {
	it.each([
		[4, 8192, 100, "Standard_D4ds_v5"],
		[8, 32768, 250, "Standard_D8ds_v5"],
		[16, 65536, 500, "Standard_D16ds_v5"],
		[4, 8192, 300, "Standard_D16ds_v5"],
	])("fits %i CPU / %i MiB / %i GiB", async (cpu, memory, disk, vmSize) => {
		const test = setup(cpu, memory, disk);
		await test.adapter.submit(launch);
		expect(test.submitted()).toMatchObject({
			poolInfo: {
				autoPoolSpecification: {
					poolLifetimeOption: "job",
					keepAlive: false,
					pool: {
						vmSize,
						targetDedicatedNodes: 0,
						targetLowPriorityNodes: 1,
						taskSlotsPerNode: 1,
						enableAutoScale: false,
						networkConfiguration: test.template.networkConfiguration,
						virtualMachineConfiguration:
							test.template.virtualMachineConfiguration,
					},
				},
			},
		});
		const info = test.submitted().poolInfo as Record<string, unknown>;
		expect(info).not.toHaveProperty("poolId");
		expect(test.fetcher.mock.calls.map(([, init]) => init?.method)).toEqual([
			"GET",
			"POST",
		]);
		expect(test.submitted().jobManagerTask).toMatchObject({
			commandLine: expect.stringContaining(
				'TMPDIR="$AZ_BATCH_TASK_WORKING_DIR"',
			),
			killJobOnCompletion: true,
			runExclusive: true,
		});
	});
	it("allocates only one dedicated node when spot is disabled", async () => {
		const test = setup(4, 8192, 100, false);
		await test.adapter.submit(launch);
		expect(test.submitted()).toMatchObject({
			poolInfo: {
				autoPoolSpecification: {
					pool: {
						targetDedicatedNodes: 1,
						targetLowPriorityNodes: 0,
					},
				},
			},
		});
	});
	it("refuses disk requirements beyond the supported temporary disks before creating", async () => {
		const test = setup(4, 8192, 4096);
		await expect(test.adapter.submit(launch)).rejects.toThrow(
			"Azure VM capacity",
		);
		expect(
			test.fetcher.mock.calls.some(([, init]) => init?.method === "POST"),
		).toBe(false);
	});
	it("refuses a template identity that auto pools cannot reproduce", async () => {
		const test = setup();
		test.template.identity = { type: "UserAssigned" };
		await expect(test.adapter.submit(launch)).rejects.toThrow("identity");
		expect(
			test.fetcher.mock.calls.some(([, init]) => init?.method === "POST"),
		).toBe(false);
	});
	it.each([
		[
			{ osDisk: { ephemeralOSDiskSettings: { placement: "ResourceDisk" } } },
			"ephemeral",
		],
		[
			{
				containerConfiguration: {
					containerRegistries: [{ username: "private" }],
				},
			},
			"credentials",
		],
		[
			{
				containerConfiguration: {
					containerRegistries: [
						{ identityReference: { resourceId: "identity" } },
					],
				},
			},
			"identity",
		],
	])("rejects incompatible template configuration before creating", async (fields, error) => {
		const test = setup();
		Object.assign(test.template.virtualMachineConfiguration as object, fields);
		await expect(test.adapter.submit(launch)).rejects.toThrow(error);
		expect(
			test.fetcher.mock.calls.some(([, init]) => init?.method === "POST"),
		).toBe(false);
	});
});
