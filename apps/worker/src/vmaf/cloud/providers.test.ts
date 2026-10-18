import type { BatchClient } from "@aws-sdk/client-batch";
import { type VmafCloudProfile, vmafCloudProfileSchema } from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import { chooseAkamaiVmafType } from "./provider-akamai.js";
import { hashId, profileHash, taskName } from "./provider-common.js";
import { createComputeAdapter } from "./providers.js";

const image = `registry.example/vmaf@sha256:${"a".repeat(64)}`;
const now = Date.parse("2026-09-24T00:00:00Z");
const launch = {
	taskId: "task-1",
	manifestUrl: "https://staging.example/manifest?secret=private",
	deadline: "2026-09-24T00:30:00Z",
};
function profile(provider: VmafCloudProfile["provider"]): VmafCloudProfile {
	return vmafCloudProfileSchema.parse({
		id: "test",
		label: "Test",
		image,
		region: "us-east-1",
		cpu: 4,
		memoryMiB: 8192,
		diskGiB: 100,
		maxParallel: 2,
		timeoutSeconds: 1800,
		queueTimeoutSeconds: 600,
		maxCostUsdPerHour: 1,
		transferUsdPerGiB: 0,
		overheadUsd: 0,
		maxStagingGiB: 100,
		staging: { provider: "S3", region: "us-east-1", bucket: "staging" },
		provider,
		...(provider === "AWS_BATCH"
			? { jobQueue: "queue", jobDefinition: "definition:3" }
			: provider === "GCP_BATCH"
				? {
						project: "project",
						machineType: "c3-standard-4",
						serviceAccount: "worker@example.com",
						spot: true,
					}
				: provider === "AZURE_BATCH"
					? {
							accountUrl: "https://account.westeurope.batch.azure.com",
							poolId: "pool",
							spot: true,
						}
					: {
							instanceType: "g6-standard-4",
							bootImage: "linode/ubuntu24.04",
							reaperEnabled: true,
						}),
	});
}
const response = (body: unknown, status = 200) =>
	new Response(body === undefined ? null : JSON.stringify(body), { status });
const metadata = (p: VmafCloudProfile) => [
	{ name: "vmaf-profile", value: profileHash(p) },
	{ name: "vmaf-task", value: hashId(launch.taskId) },
];

describe("cloud provider adapters", () => {
	it("pins the AWS definition and disables creation retries; recovers exact owned jobs across pages", async () => {
		const p = profile("AWS_BATCH");
		const seen: { name: string; input: Record<string, unknown> }[] = [];
		const send = vi.fn(
			async (command: {
				constructor: { name: string };
				input: Record<string, unknown>;
			}) => {
				const name = command.constructor.name;
				seen.push({ name, input: command.input });
				if (name === "DescribeJobDefinitionsCommand")
					return {
						jobDefinitions: [
							{
								jobDefinitionArn: "definition:3",
								revision: 3,
								type: "container",
								platformCapabilities: ["EC2"],
								containerProperties: { image },
							},
						],
					};
				if (name === "SubmitJobCommand") return { jobId: "job-1" };
				if (name === "ListJobsCommand")
					return command.input.nextToken
						? {
								jobSummaryList: [
									{ jobId: "job-1", jobName: taskName(launch.taskId) },
								],
							}
						: {
								nextToken: "page-2",
								jobSummaryList: [{ jobId: "foreign", jobName: "different" }],
							};
				return {
					jobs: [
						{
							jobId: "job-1",
							jobName: taskName(launch.taskId),
							status: "RUNNING",
							tags: {
								"bitovp:vmaf-profile": p.id,
								"bitovp:vmaf-task": launch.taskId,
							},
						},
					],
				};
			},
		);
		const adapter = createComputeAdapter(p, {
			awsClient: { send } as unknown as BatchClient,
			now: () => now,
		});
		expect(await adapter.submit(launch)).toBe("job-1");
		const submitted = seen.find(
			(item) => item.name === "SubmitJobCommand",
		)?.input;
		expect(submitted).toMatchObject({
			jobDefinition: "definition:3",
			retryStrategy: { attempts: 1 },
			timeout: { attemptDurationSeconds: 1800 },
			containerOverrides: {
				command: [
					"node",
					"--import",
					"tsx",
					"/app/apps/worker/scripts/vmaf-cloud-worker.mjs",
				],
			},
		});
		expect(await adapter.find(launch.taskId)).toBe("job-1");
		expect(seen.filter((item) => item.name === "ListJobsCommand")).toHaveLength(
			2,
		);
	});
	it("does not retry an ambiguous AWS submit or expose its signed URL error", async () => {
		let creates = 0;
		const send = vi.fn(async (command: { constructor: { name: string } }) => {
			if (command.constructor.name === "DescribeJobDefinitionsCommand")
				return {
					jobDefinitions: [
						{
							jobDefinitionArn: "definition:3",
							type: "container",
							containerProperties: { image },
						},
					],
				};
			creates++;
			throw new Error(launch.manifestUrl);
		});
		const adapter = createComputeAdapter(profile("AWS_BATCH"), {
			awsClient: { send } as unknown as BatchClient,
			now: () => now,
		});
		await expect(adapter.submit(launch)).rejects.toThrow(
			/^VMAF cloud submit failed$/,
		);
		expect(creates).toBe(1);
	});
	it("rejects an AWS definition image mismatch before any paid submit", async () => {
		const send = vi.fn(async () => ({
			jobDefinitions: [
				{
					jobDefinitionArn: "definition:3",
					type: "container",
					containerProperties: { image: "mutable:latest" },
				},
			],
		}));
		const adapter = createComputeAdapter(profile("AWS_BATCH"), {
			awsClient: { send } as unknown as BatchClient,
			now: () => now,
		});
		await expect(adapter.submit(launch)).rejects.toThrow(
			"VMAF cloud submit failed",
		);
		expect(send).toHaveBeenCalledTimes(1);
	});
	it("submits a deterministic GCP job with disk, Spot, resources, no retry and bounded runtime", async () => {
		const p = profile("GCP_BATCH");
		const calls: { url: string; init?: RequestInit }[] = [];
		const fetcher = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				calls.push({ url: String(url), init });
				return response({ name: "created" });
			},
		);
		const adapter = createComputeAdapter(p, {
			fetch: fetcher as typeof fetch,
			googleToken: async () => "token",
			now: () => now,
		});
		expect(await adapter.submit(launch)).toBe(
			`projects/project/locations/us-east-1/jobs/${taskName(launch.taskId)}`,
		);
		const body = JSON.parse(String(calls[0]?.init?.body));
		expect(body.taskGroups[0].taskSpec).toMatchObject({
			maxRetryCount: 0,
			maxRunDuration: "1800s",
			computeResource: { cpuMilli: 4000, memoryMib: 8192 },
		});
		expect(body.allocationPolicy.instances[0].policy).toMatchObject({
			provisioningModel: "SPOT",
			bootDisk: { sizeGb: "100", type: "pd-balanced" },
		});
		expect(body.taskGroups[0].taskSpec.runnables[0].container.imageUri).toBe(
			image,
		);
		expect(calls[0]?.init?.redirect).toBe("error");
	});
	it("finds GCP ownership but rejects a foreign profile before cancellation", async () => {
		const p = profile("GCP_BATCH");
		const fetcher = vi.fn(async () =>
			response({
				labels: {
					"vmaf-profile": "foreign",
					"vmaf-task": hashId(launch.taskId),
				},
			}),
		);
		const adapter = createComputeAdapter(p, {
			fetch: fetcher as typeof fetch,
			googleToken: async () => "token",
		});
		await expect(
			adapter.cancel(
				`projects/project/locations/us-east-1/jobs/${taskName(launch.taskId)}`,
			),
		).rejects.toThrow("VMAF cloud cancel failed");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("creates Azure job and container worker atomically and waits for cleanup disappearance", async () => {
		const p = profile("AZURE_BATCH");
		const calls: { url: string; init?: RequestInit }[] = [];
		let deleted = false;
		let deletingReads = 0;
		const fetcher = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				calls.push({ url: String(url), init });
				if (String(url).includes("/pools/"))
					return response({
						virtualMachineConfiguration: {
							containerConfiguration: { type: "dockerCompatible" },
							nodeAgentSKUId: "batch.node.ubuntu 22.04",
						},
					});
				if (init?.method === "POST") return response(undefined, 201);
				if (init?.method === "DELETE") {
					deleted = true;
					return response(undefined, 202);
				}
				if (deleted && deletingReads++ > 0) return response(undefined, 404);
				return response({
					metadata: metadata(p),
					state: deleted ? "deleting" : "active",
				});
			},
		);
		const sleep = vi.fn(async () => {});
		const adapter = createComputeAdapter(p, {
			fetch: fetcher as typeof fetch,
			azureToken: async () => "token",
			now: () => now,
			sleep,
		});
		const id = await adapter.submit(launch);
		const create = calls.find((call) => call.init?.method === "POST");
		const body = JSON.parse(String(create?.init?.body));
		expect(body.jobManagerTask).toMatchObject({
			commandLine: expect.stringContaining("TMPDIR"),
			allowLowPriorityNode: true,
			constraints: { maxTaskRetryCount: 0 },
			containerSettings: { imageName: image },
		});
		expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(
			1,
		);
		await adapter.cleanup(id);
		expect(sleep).toHaveBeenCalledTimes(1);
	});
	it("selects the cheapest fitting dedicated Akamai type using regional prices", () => {
		const p = profile("AKAMAI_VM") as Extract<
			VmafCloudProfile,
			{ provider: "AKAMAI_VM" }
		>;
		const type = {
			id: "g6-dedicated-4",
			class: "dedicated",
			vcpus: 4,
			memory: 8192,
			disk: 200 * 1024,
			price: { hourly: 0.2 },
		};
		expect(
			chooseAkamaiVmafType(
				[
					{
						...type,
						id: "g6-standard-4",
						class: "standard",
						price: { hourly: 0.01 },
					},
					{ ...type, id: "g6-dedicated-2", memory: 4096 },
					{
						...type,
						id: "g6-dedicated-8",
						price: { hourly: 0.1 },
						region_prices: [{ id: p.region, hourly: 2 }],
					},
					type,
				],
				p,
			),
		).toBe(type.id);
		expect(() => chooseAkamaiVmafType([{ ...type, disk: 1024 }], p)).toThrow();
	});
	it("automatically looks across catalog pages before launching exactly one Akamai VM", async () => {
		const p = {
			...profile("AKAMAI_VM"),
			instanceType: "auto",
		} as VmafCloudProfile;
		const selected = {
			id: "g6-dedicated-4",
			class: "dedicated",
			vcpus: 4,
			memory: 8192,
			disk: 200 * 1024,
			price: { hourly: 0.2 },
		};
		const posts: Record<string, unknown>[] = [];
		const fetcher = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				if (String(url).includes("types?page=1"))
					return response({ pages: 2, data: [] });
				if (String(url).includes("types?page=2"))
					return response({ pages: 2, data: [selected] });
				if (String(url).includes("/types/")) return response(selected);
				posts.push(JSON.parse(String(init?.body)));
				return response({ id: 123 });
			},
		);
		const adapter = createComputeAdapter(p, {
			fetch: fetcher as typeof fetch,
			akamaiToken: () => "token",
			now: () => now,
		});
		expect(await adapter.submit(launch)).toBe("123");
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({ type: "g6-dedicated-4" });
	});
	it("distinguishes Azure task failure from completed success", async () => {
		const p = profile("AZURE_BATCH");
		const fetcher = vi.fn(async (url: string | URL | Request) =>
			String(url).includes("/tasks/")
				? response({
						state: "completed",
						executionInfo: { result: "failure", exitCode: 1 },
					})
				: response({ metadata: metadata(p), state: "completed" }),
		);
		const adapter = createComputeAdapter(p, {
			fetch: fetcher as typeof fetch,
			azureToken: async () => "token",
		});
		expect(await adapter.status(taskName(launch.taskId))).toBe("FAILED");
	});
	it("launches one Akamai VM with owned tags, fixed argv, random password and absolute shutdown", async () => {
		const p = profile("AKAMAI_VM");
		let body: Record<string, unknown> = {};
		const fetcher = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				if (String(url).includes("/types/"))
					return response({ vcpus: 4, memory: 8192, disk: 102400 });
				body = JSON.parse(String(init?.body));
				return response({ id: 123 });
			},
		);
		const adapter = createComputeAdapter(p, {
			fetch: fetcher as typeof fetch,
			akamaiToken: () => "token",
			now: () => now,
		});
		expect(await adapter.submit(launch)).toBe("123");
		expect(String(body.root_pass).length).toBeGreaterThan(48);
		expect(body.tags).toContain("bitovp-vmaf");
		const userData = Buffer.from(
			(body.metadata as { user_data: string }).user_data,
			"base64",
		).toString();
		const cloud = JSON.parse(userData.split("\n").slice(1).join("\n"));
		expect(cloud.bootcmd[0]).toContain(
			`--on-calendar=@${Date.parse(launch.deadline) / 1000}`,
		);
		const script = Buffer.from(
			cloud.write_files[1].content,
			"base64",
		).toString();
		expect(script).toContain('"--import","tsx"');
		expect(script).not.toContain(launch.manifestUrl);
		expect(cloud.runcmd[1]).toEqual(["python3", "/var/lib/bitovp/run.py"]);
	});
	it("rejects expired deadlines and never leaks signed URLs from REST failures", async () => {
		const fetcher = vi.fn(async () => {
			throw new Error(launch.manifestUrl);
		});
		const adapter = createComputeAdapter(profile("GCP_BATCH"), {
			fetch: fetcher as typeof fetch,
			googleToken: async () => "token",
			now: () => now,
		});
		await expect(
			adapter.submit({ ...launch, deadline: "2020-01-01T00:00:00Z" }),
		).rejects.toThrow(/^VMAF cloud submit failed$/);
		expect(fetcher).not.toHaveBeenCalled();
		await expect(adapter.submit(launch)).rejects.toThrow(
			/^VMAF cloud submit failed$/,
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("finds only exact owned Akamai labels across pages and confirms VM deletion", async () => {
		const p = profile("AKAMAI_VM");
		const vm = {
			id: 123,
			label: taskName(launch.taskId),
			status: "running",
			tags: [
				"bitovp-vmaf",
				`vmaf-p-${profileHash(p)}`,
				`vmaf-t-${hashId(launch.taskId)}`,
			],
		};
		let removed = false;
		const fetcher = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				if (init?.method === "DELETE") {
					removed = true;
					return response(undefined, 200);
				}
				if (String(url).includes("page=1"))
					return response({ pages: 2, data: [{ id: 999, label: "foreign" }] });
				if (String(url).includes("page=2"))
					return response({ pages: 2, data: [vm] });
				return removed ? response(undefined, 404) : response(vm);
			},
		);
		const adapter = createComputeAdapter(p, {
			fetch: fetcher as typeof fetch,
			akamaiToken: () => "token",
			sleep: async () => {},
		});
		expect(await adapter.find(launch.taskId)).toBe("123");
		await adapter.cleanup("123");
		expect(removed).toBe(true);
		expect(await adapter.status("123")).toBe("MISSING");
	});

	it("does not call Akamai create for an undersized VM type", async () => {
		const fetcher = vi.fn(async () =>
			response({ vcpus: 1, memory: 1024, disk: 10240 }),
		);
		const adapter = createComputeAdapter(profile("AKAMAI_VM"), {
			fetch: fetcher as typeof fetch,
			akamaiToken: () => "token",
			now: () => now,
		});
		await expect(adapter.submit(launch)).rejects.toThrow(
			/^VMAF cloud submit failed$/,
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("waits for GCP deletion operation completion before reporting cleanup", async () => {
		const p = profile("GCP_BATCH");
		let removed = false;
		let polls = 0;
		const operation = "projects/project/locations/us-east-1/operations/op-1";
		const fetcher = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				if (init?.method === "DELETE") {
					removed = true;
					return response({ name: operation, done: false });
				}
				if (String(url).includes("/operations/"))
					return response({ name: operation, done: ++polls > 1 });
				return removed
					? response(undefined, 404)
					: response({
							labels: {
								"vmaf-profile": profileHash(p),
								"vmaf-task": hashId(launch.taskId),
							},
						});
			},
		);
		const sleep = vi.fn(async () => {});
		const adapter = createComputeAdapter(p, {
			fetch: fetcher as typeof fetch,
			googleToken: async () => "token",
			sleep,
		});
		await adapter.cleanup(
			`projects/project/locations/us-east-1/jobs/${taskName(launch.taskId)}`,
		);
		expect(polls).toBe(2);
		expect(sleep).toHaveBeenCalledTimes(1);
	});
});
