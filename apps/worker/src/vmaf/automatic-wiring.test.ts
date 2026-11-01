import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileFunction } from "node:vm";
import { vmafJobSchema } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { DelayedError, type Job } from "bullmq";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { createTenantConsumer } from "../tenant/consumer";
import { requireOrganizationId } from "../tenant/scope";
import {
	cloudJobConcurrency,
	createLocalExecutionGate,
} from "./execution-dispatch";
import { queueExcessVmafJobs } from "./job-capacity";

// Execute the actual bootstrap declarations without importing index.ts, which
// would connect services and start every worker. Dependencies stay explicit.
const text = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const source = ts.createSourceFile(
	"index.ts",
	text,
	ts.ScriptTarget.Latest,
	true,
);
function declaration(name: string) {
	const matches: ts.VariableStatement[] = [];
	function visit(node: ts.Node) {
		if (
			ts.isVariableStatement(node) &&
			node.declarationList.declarations.some(
				(item) => ts.isIdentifier(item.name) && item.name.text === name,
			)
		)
			matches.push(node);
		ts.forEachChild(node, visit);
	}
	visit(source);
	if (matches.length !== 1)
		throw new Error(`Expected one bootstrap declaration for ${name}`);
	return matches[0]?.getText(source) ?? "";
}
function evaluate(code: string, scope: Record<string, unknown>) {
	const javascript = ts.transpileModule(code, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
		},
	}).outputText;
	return compileFunction(
		javascript,
		Object.keys(scope),
	)(...Object.values(scope));
}
function load(
	names: string[],
	scope: Record<string, unknown>,
): Record<string, unknown> {
	return evaluate(
		`${names.map(declaration).join("\n")}\nreturn {${names.join(",")}};`,
		scope,
	);
}
async function loadAsync(
	names: string[],
	scope: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return evaluate(
		`return (async () => {${names.map(declaration).join("\n")}\nreturn {${names.join(",")}};})();`,
		scope,
	);
}
function barrier() {
	let release!: () => void;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { wait, release };
}

it("awaits compatibility on native Linux and preserves an omitted GPU index", async () => {
	for (const [platform, nativePath, rawDevice] of [
		["linux", "/native", undefined],
		["linux", "/native", " "],
		["linux", "/native", "2"],
		["linux", "/native", "0"],
		["darwin", "/native", undefined],
		["linux", undefined, undefined],
	] as const) {
		const runtime = {
				runner: {},
				resolveLocalResources: vi.fn(),
				execute: vi.fn(),
			},
			raw = {},
			redis = {};
		const create = vi.fn(async (_deps: unknown) => runtime);
		const loaded = await loadAsync(
			["automaticVmafSelectionState", "automaticVmafRuntime"],
			{
				process: { platform, env: { VMAF_GPU_DEVICE: rawDevice } },
				env: {
					VMAF_NATIVE_PATH: nativePath,
					VMAF_FFMPEG_PATH: "/vmaf-ffmpeg",
					FFMPEG_PATH: "/ffmpeg",
					FFPROBE_PATH: "/ffprobe",
					VMAF_THREADS: 3,
					VMAF_CONCURRENCY: 2,
					VMAF_GPU_DEVICE: rawDevice?.trim() ? Number(rawDevice) : 0,
				},
				vmafWorkDir: "/scratch",
				vmafRunner: raw,
				wakePublisher: redis,
				join,
				createAvailableAutomaticVmafRuntime: create,
				console: { warn: vi.fn() },
			},
		);
		if (platform !== "linux" || !nativePath) {
			expect(create).not.toHaveBeenCalled();
			expect(loaded.automaticVmafRuntime).toBeUndefined();
			continue;
		}
		expect(loaded.automaticVmafRuntime).toBe(runtime);
		expect(create).toHaveBeenCalledOnce();
		const args = create.mock.calls[0]?.[0] as unknown as Record<
			string,
			unknown
		>;
		expect(args).toMatchObject({
			runner: raw,
			redis,
			nativePath,
			ffmpegPath: "/vmaf-ffmpeg",
			ffprobePath: "/ffprobe",
			workDirectory: "/scratch/.native-automatic",
			configured: { threads: 3, concurrency: 2 },
		});
		if (rawDevice?.trim()) expect(args.device).toBe(Number(rawDevice));
		else expect(args).not.toHaveProperty("device");
	}
});

it("retains the legacy gate when optional compatibility preflight is unavailable", async () => {
	const hold = barrier();
	const create = vi.fn(async () => {
		await hold.wait;
		return undefined;
	});
	const gate = vi.fn(createLocalExecutionGate);
	const pending = loadAsync(
		[
			"automaticVmafSelectionState",
			"automaticVmafRuntime",
			"localVmafExecution",
		],
		{
			process: { platform: "linux", env: {} },
			env: {
				VMAF_NATIVE_PATH: "/native",
				FFMPEG_PATH: "/ffmpeg",
				FFPROBE_PATH: "/ffprobe",
			},
			vmafWorkDir: "/scratch",
			vmafRunner: {},
			wakePublisher: {},
			join,
			createAvailableAutomaticVmafRuntime: create,
			createLocalExecutionGate: gate,
			console: { warn: vi.fn() },
		},
	);
	expect(create).toHaveBeenCalledOnce();
	expect(gate).not.toHaveBeenCalled();
	hold.release();
	const loaded = await pending;
	expect(loaded.automaticVmafRuntime).toBeUndefined();
	expect(gate).toHaveBeenCalledOnce();
	expect(loaded.localVmafExecution).toBe(gate.mock.results[0]?.value);
});

it.each([
	true,
	false,
])("keeps VOD/cloud and Live on the selected execution path (automatic=%s)", (available) => {
	const raw = {},
		supervised = {},
		resolver = vi.fn(),
		selectLocalNative = vi.fn(),
		execute = vi.fn();
	const automaticVmafRuntime = available
		? {
				runner: supervised,
				resolveLocalResources: resolver,
				selectLocalNative,
				execute,
			}
		: undefined;
	const resource = {},
		createResources = vi.fn((_deps: unknown) => resource),
		vod = vi.fn((_deps: unknown) => ({})),
		live = vi.fn((_deps: unknown) => ({})),
		inspect = vi.fn((_deps: unknown) => ({}));
	load(
		[
			"localVmafResources",
			"vmafProcessor",
			"liveVmafProcessor",
			"storageInspectProcessor",
		],
		{
			automaticVmafRuntime,
			automaticVmafSelectionState: {},
			createLocalVmafResources: createResources,
			tenantService: (factory: () => unknown) => factory(),
			createVmafProcessor: vod,
			createLiveVmafProcessor: live,
			createStorageInspectProcessor: inspect,
			vmafRunner: raw,
			vmafCloud: { score: vi.fn(), resolveProfile: vi.fn() },
			env: {
				VMAF_FFMPEG_PATH: "/vmaf-ffmpeg",
				FFMPEG_PATH: "/ffmpeg",
				FFPROBE_PATH: "/ffprobe",
				VMAF_GPU_DEVICE: 0,
				VMAF_DECODE_BACKEND: "cpu",
				VMAF_SCORING_BACKEND: "cuda",
				VMAF_NATIVE_PATH: "/native",
			},
			vmafWorkDir: "/scratch",
			feederSpoolDir: "/spool",
			requireOrganizationId: () => "tenant-a",
			processorDeps: { resolveCredential: vi.fn(), now: vi.fn() },
			emitEvent: vi.fn(),
			orchestratorProducerQueue: {},
			prisma: {},
			vmafSubsample: undefined,
			resolveModelPath: undefined,
			join,
		},
	);
	expect(createResources.mock.calls[0]?.[0]).toMatchObject({
		execute: available ? execute : undefined,
	});
	expect(vod.mock.calls[0]?.[0]).toMatchObject({
		runner: raw,
		localResources: resource,
		// An unavailable optional companion never changes the requested scorer.
		scoringBackend: "cuda",
		nativePath: "/native",
	});
	expect(live.mock.calls[0]?.[0]).toMatchObject({
		runner: available ? supervised : raw,
		localResources: resource,
	});
	for (const args of [vod.mock.calls[0]?.[0], live.mock.calls[0]?.[0]]) {
		if (available)
			expect(args).toMatchObject({ resolveLocalResources: resolver });
		else expect(args).not.toHaveProperty("resolveLocalResources");
	}
	if (available)
		expect(vod.mock.calls[0]?.[0]).toMatchObject({ localRunner: supervised });
	else expect(vod.mock.calls[0]?.[0]).not.toHaveProperty("localRunner");
	expect(inspect.mock.calls[0]?.[0]).toMatchObject({ runner: raw });
	if (available)
		expect(vod.mock.calls[0]?.[0]).toMatchObject({ selectLocalNative });
	else expect(vod.mock.calls[0]?.[0]).not.toHaveProperty("selectLocalNative");
	expect(live.mock.calls[0]?.[0]).not.toHaveProperty("selectLocalNative");
});

it("expands default physical slots without expanding the cloud cap and preserves explicit overrides", () => {
	for (const [automatic, cpu, value, expected, cloud] of [
		[true, 8, undefined, 10, 2],
		[true, 64, undefined, 32, 2],
		[true, 0.5, undefined, 3, 2],
		[false, 8, undefined, 3, 2],
		[true, 8, "5", 5, 5],
		[false, 8, "1", 1, 1],
		[true, 8, " ", 10, 2],
	] as const) {
		const loaded = load(
			["VMAF_CLOUD_JOB_CONCURRENCY", "VMAF_JOB_CONCURRENCY"],
			{
				cloudJobConcurrency,
				process: { env: { VMAF_JOB_CONCURRENCY: value } },
				automaticVmafRuntime: automatic ? {} : undefined,
				readLocalResources: () => ({ cpuCapacity: cpu }),
			},
		);
		expect(loaded.VMAF_JOB_CONCURRENCY).toBe(expected);
		expect(loaded.VMAF_CLOUD_JOB_CONCURRENCY).toBe(cloud);
	}
});

const org = "11111111-1111-4111-8111-111111111111";
const id = (number: number) =>
	`22222222-2222-4222-8222-${String(number).padStart(12, "0")}`;
function job(number: number): Job {
	return {
		data: { organizationId: org, payload: { vmafJobId: id(number) } },
		token: "owned-lock",
		moveToDelayed: vi.fn(async () => {}),
	} as unknown as Job;
}
it("authenticates before classification and keeps local, cloud, and terminal parent admissions separate", async () => {
	const hold = barrier(),
		events: string[] = [];
	const records: Record<
		string,
		{ status: string; mode: string; params: object }
	> = {
		[id(1)]: { status: "PENDING", mode: "VOD", params: {} },
		[id(2)]: { status: "PENDING", mode: "VOD", params: {} },
		[id(3)]: {
			status: "PENDING",
			mode: "VOD",
			params: { execution: { backend: "CLOUD" } },
		},
		[id(4)]: {
			status: "PENDING",
			mode: "VOD",
			params: { execution: { backend: "CLOUD" } },
		},
		[id(5)]: {
			status: "PENDING",
			mode: "VOD",
			params: { execution: { backend: "CLOUD" } },
		},
		[id(6)]: { status: "ERROR", mode: "LIVE", params: {} },
		[id(7)]: {
			status: "PENDING",
			mode: "LIVE",
			params: { execution: { backend: "CLOUD" } },
		},
	};
	const prisma = {
		vmafJob: {
			findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
				expect(requireOrganizationId()).toBe(org);
				events.push("owned");
				return records[where.id] ? { id: where.id } : null;
			}),
			findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
				expect(requireOrganizationId()).toBe(org);
				events.push("classify");
				return records[where.id] ?? null;
			}),
		},
	};
	const process = vi.fn(async (value: Job) => {
		if (value.data.vmafJobId !== id(6)) await hold.wait;
		return "processed";
	});
	const consumeTenantJob = createTenantConsumer({
		prisma: prisma as unknown as AppPrismaClient,
		forEachOrganization: async () => {},
	});
	const loaded = load(["classifyVmafJob", "queuedVmafParents", "consume"], {
		prisma,
		vmafJobSchema,
		queueExcessVmafJobs,
		automaticVmafRuntime: {},
		localVmafResources: { jobCapacity: () => 1 },
		VMAF_CLOUD_JOB_CONCURRENCY: 2,
		handlers: { vmafRunner: process },
		consumeTenantJob,
		key: "vmafRunner",
	});
	const consume = loaded.consume as (value: Job) => Promise<unknown>;
	await expect(consume(job(8))).rejects.toThrow("Tenant resource unavailable");
	expect(prisma.vmafJob.findUnique).not.toHaveBeenCalled();
	expect(process).not.toHaveBeenCalled();
	events.length = 0;
	const local = consume(job(1));
	await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(1));
	expect(events.slice(0, 2)).toEqual(["owned", "classify"]);
	const extraLocal = job(2),
		extraCloud = job(5),
		liveAsCloud = job(7);
	const clouds = [consume(job(3)), consume(job(4))];
	try {
		await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(3));
		await expect(consume(extraLocal)).rejects.toBeInstanceOf(DelayedError);
		await expect(consume(extraCloud)).rejects.toBeInstanceOf(DelayedError);
		await expect(consume(liveAsCloud)).rejects.toBeInstanceOf(DelayedError);
		await expect(consume(job(6))).resolves.toBe("processed");
		for (const pending of [extraLocal, extraCloud, liveAsCloud])
			expect(pending.moveToDelayed).toHaveBeenCalledOnce();
	} finally {
		hold.release();
		await Promise.all([local, ...clouds]);
	}
	await expect(consume(extraLocal)).resolves.toBe("processed");
});

it.each([
	false,
	true,
])("keeps the whole-job fallback gate only without the automatic runtime (automatic=%s)", async (automatic) => {
	const hold = barrier();
	const vod = vi.fn(async () => hold.wait),
		live = vi.fn(async () => hold.wait);
	const gate = vi.fn(createLocalExecutionGate);
	const loaded = load(["localVmafExecution", "dispatchVmaf"], {
		automaticVmafRuntime: automatic ? {} : undefined,
		createLocalExecutionGate: gate,
		vmafJobSchema,
		prisma: {
			vmafJob: {
				findUnique: async ({ where }: { where: { id: string } }) => ({
					mode: where.id === id(2) ? "LIVE" : "VOD",
					params: {},
				}),
			},
		},
		vmafProcessor: { process: vod },
		liveVmafProcessor: { process: live },
	});
	const dispatch = loaded.dispatchVmaf as (data: unknown) => Promise<unknown>;
	const work = [dispatch({ vmafJobId: id(1) }), dispatch({ vmafJobId: id(2) })];
	try {
		await vi.waitFor(() => expect(vod).toHaveBeenCalledOnce());
		if (automatic) {
			await vi.waitFor(() => expect(live).toHaveBeenCalledOnce());
			expect(gate).not.toHaveBeenCalled();
		} else {
			expect(live).not.toHaveBeenCalled();
			expect(gate).toHaveBeenCalledOnce();
		}
	} finally {
		hold.release();
		await Promise.all(work);
	}
	expect(live).toHaveBeenCalledOnce();
});

it("retains invalid native preflight separately for AUTO selection", async () => {
	const error = new Error("VMAF_SUPERVISOR_IDENTITY_MISMATCH");
	const loaded = await loadAsync(
		["automaticVmafSelectionState", "automaticVmafRuntime"],
		{
			process: { platform: "linux", env: {} },
			env: {
				VMAF_NATIVE_PATH: "/native",
				FFMPEG_PATH: "/ffmpeg",
				FFPROBE_PATH: "/ffprobe",
			},
			vmafWorkDir: "/scratch",
			vmafRunner: {},
			wakePublisher: {},
			join,
			createAvailableAutomaticVmafRuntime: async (deps: {
				onInvalid(error: Error): void;
			}) => {
				deps.onInvalid(error);
				return undefined;
			},
			console: { warn: vi.fn() },
		},
	);
	expect(loaded.automaticVmafRuntime).toBeUndefined();
	expect(loaded.automaticVmafSelectionState).toEqual({ failure: error });
});
