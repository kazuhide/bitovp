import { afterEach, expect, it, vi } from "vitest";
import {
	startLocalSemanticDiagnostics,
	startLocalStoryChoiceDiagnostics,
	startLocalStoryFlowDiagnostics,
} from "./runtime-diagnostics";

const defaultProbes = vi.hoisted(() => ({
	legacy: vi.fn(),
	flow: vi.fn().mockResolvedValue({ scope: "METADATA_ONLY", code: "READY" }),
	choice: vi.fn().mockResolvedValue({ scope: "METADATA_ONLY", code: "READY" }),
}));
vi.mock("@bitovp/core/local-semantic-diagnostic-probe", () => ({
	probeLocalSemanticGateway: defaultProbes.legacy,
	probeLocalStoryFlowGateway: defaultProbes.flow,
	probeLocalStoryChoiceGateway: defaultProbes.choice,
}));

const env = {
	BITOVP_LOCAL_SEMANTIC_ENABLED: "1",
	BITOVP_LOCAL_SEMANTIC_GATEWAY_URL: "https://fixture.invalid:11437",
	BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN: "a".repeat(48),
	BITOVP_LOCAL_SEMANTIC_CA_FILE: "/run/ca.pem",
	BITOVP_LOCAL_SEMANTIC_PROFILE: "nvidia",
	BITOVP_LOCAL_SEMANTIC_CONFIG_ID: "11111111-1111-4111-8111-111111111111",
};
const request = () => ({
	version: "local-semantic-diagnostic-request-v1",
	requestId: "22222222-2222-4222-8222-222222222222",
	expiresAt: Date.now() + 40_000,
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.useRealTimers();
});

it.each([
	false,
	true,
])("does not advertise Choice until its flag and initialized worker are present, initialized=%s", async (initialized) => {
	vi.useFakeTimers();
	const claim = vi.fn(),
		publish = vi.fn();
	const runtime = await startLocalStoryChoiceDiagnostics({
		env: initialized ? env : { ...env, BITOVP_LOCAL_STORY_CHOICE_ENABLED: "1" },
		initialized,
		claim,
		publish,
	});
	await vi.advanceTimersByTimeAsync(2_000);
	expect(claim).not.toHaveBeenCalled();
	expect(publish).not.toHaveBeenCalled();
	expect(defaultProbes.choice).not.toHaveBeenCalled();
	await runtime.stop();
});
it("binds Choice readiness to its dedicated request namespace and exact five-stage probe", async () => {
	vi.useFakeTimers();
	const value = {
		...request(),
		version: "local-story-choice-diagnostic-request-v1",
	};
	const claim = vi
			.fn()
			.mockResolvedValueOnce(JSON.stringify(value))
			.mockResolvedValue(null),
		publish = vi.fn();
	const runtime = await startLocalStoryChoiceDiagnostics({
		env: { ...env, BITOVP_LOCAL_STORY_CHOICE_ENABLED: "1" },
		initialized: true,
		claim,
		publish,
	});
	await vi.advanceTimersByTimeAsync(1_000);
	expect(defaultProbes.choice).toHaveBeenCalledTimes(1);
	expect(defaultProbes.legacy).not.toHaveBeenCalled();
	expect(claim.mock.calls[0]?.[0].requests).toContain(":choice-diagnostic:");
	expect(publish).toHaveBeenCalledTimes(1);
	expect(publish.mock.calls[0]?.[1]).toMatchObject({
		version: "local-story-choice-diagnostic-result-v1",
		requestId: value.requestId,
		profile: "nvidia",
		diagnostic: { code: "READY", scope: "METADATA_ONLY" },
	});
	await runtime.stop();
});
it("does not reuse an old four-stage request on the Choice channel", async () => {
	vi.useFakeTimers();
	const claim = vi
			.fn()
			.mockResolvedValueOnce(JSON.stringify(request()))
			.mockResolvedValue(null),
		publish = vi.fn();
	const runtime = await startLocalStoryChoiceDiagnostics({
		env: { ...env, BITOVP_LOCAL_STORY_CHOICE_ENABLED: "1" },
		initialized: true,
		claim,
		publish,
	});
	await vi.advanceTimersByTimeAsync(1_000);
	expect(defaultProbes.choice).not.toHaveBeenCalled();
	expect(publish).not.toHaveBeenCalled();
	await runtime.stop();
});

it("does not probe the gateway on startup or while idle", async () => {
	vi.useFakeTimers();
	const claim = vi.fn().mockResolvedValue(null);
	const publish = vi.fn();
	const probe = vi.fn();
	const runtime = await startLocalSemanticDiagnostics({
		env,
		claim,
		publish,
		probe,
	});
	expect(claim).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(probe).not.toHaveBeenCalled();
	expect(publish).not.toHaveBeenCalled();
	await runtime.stop();
});
it.each([
	null,
	"bad json",
	JSON.stringify({ ...request(), url: "https://foreign.invalid" }),
	JSON.stringify({ ...request(), expiresAt: 1 }),
	JSON.stringify({ ...request(), expiresAt: Date.now() + 500_000 }),
	"x".repeat(513),
])("rejects absent, expired and request-selected connection data %#", async (raw) => {
	vi.useFakeTimers();
	const claim = vi.fn().mockResolvedValueOnce(raw).mockResolvedValue(null);
	const publish = vi.fn();
	const probe = vi.fn();
	const runtime = await startLocalSemanticDiagnostics({
		env,
		claim,
		publish,
		probe,
	});
	await vi.advanceTimersByTimeAsync(1_000);
	expect(probe).not.toHaveBeenCalled();
	expect(publish).not.toHaveBeenCalled();
	await runtime.stop();
});
it("uses only its startup configuration and binds sanitized results to the request and connection", async () => {
	vi.useFakeTimers();
	const value = request();
	const claim = vi
		.fn()
		.mockResolvedValueOnce(JSON.stringify(value))
		.mockResolvedValue(null);
	const publish = vi.fn().mockResolvedValue(undefined);
	const probe = vi
		.fn()
		.mockResolvedValue({ code: "MODEL_MISMATCH", scope: "METADATA_ONLY" });
	const runtime = await startLocalSemanticDiagnostics({
		env,
		claim,
		publish,
		probe,
	});
	await vi.advanceTimersByTimeAsync(1_000);
	expect(probe.mock.calls[0]?.[0]).toMatchObject({
		url: env.BITOVP_LOCAL_SEMANTIC_GATEWAY_URL,
		token: env.BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN,
		profile: "nvidia",
	});
	expect(publish.mock.calls[0]?.[1]).toMatchObject({
		version: "local-semantic-diagnostic-result-v1",
		requestId: value.requestId,
		profile: "nvidia",
		diagnostic: { code: "MODEL_MISMATCH" },
	});
	expect(JSON.stringify(publish.mock.calls)).not.toMatch(
		/fixture\.invalid|aaaa|\/run\/ca/,
	);
	await runtime.stop();
});
it("serializes checks and aborts an in-flight request during shutdown", async () => {
	vi.useFakeTimers();
	let signal: AbortSignal | undefined;
	const claim = vi.fn().mockResolvedValue(JSON.stringify(request()));
	const publish = vi.fn();
	const probe = vi.fn(
		(_config, abort: AbortSignal) =>
			new Promise<never>((_resolve, reject) => {
				signal = abort;
				abort.addEventListener("abort", () => reject(new Error("aborted")), {
					once: true,
				});
			}),
	);
	const runtime = await startLocalSemanticDiagnostics({
		env,
		claim,
		publish,
		probe,
	});
	await vi.advanceTimersByTimeAsync(5_000);
	expect(claim).toHaveBeenCalledTimes(1);
	expect(probe).toHaveBeenCalledTimes(1);
	await runtime.stop();
	expect(signal?.aborted).toBe(true);
	expect(publish).not.toHaveBeenCalled();
});
it("starts no request listener when local settings are disabled or malformed", async () => {
	vi.useFakeTimers();
	for (const value of [{}, { BITOVP_LOCAL_SEMANTIC_ENABLED: "1" }]) {
		const claim = vi.fn();
		const publish = vi.fn();
		const probe = vi.fn();
		const runtime = await startLocalSemanticDiagnostics({
			env: value,
			claim,
			publish,
			probe,
		});
		await vi.advanceTimersByTimeAsync(5_000);
		await runtime.stop();
		expect(claim).not.toHaveBeenCalled();
		expect(probe).not.toHaveBeenCalled();
	}
});

const instanceId = "33333333-3333-4333-8333-333333333333";
const capabilityHash = "b".repeat(64);
const flowEnv = { ...env, BITOVP_LOCAL_STORY_FLOW_ENABLED: "1" };
const flowRequest = (change = {}) => ({
	version: "local-story-flow-diagnostic-request-v1",
	requestId: "22222222-2222-4222-8222-222222222222",
	capabilityHash,
	expiresAt: Date.now() + 40_000,
	...change,
});

it("starts no FLOW consumer without actual initialization, operator, valid config and owned identity", async () => {
	vi.useFakeTimers();
	for (const change of [
		{ initialized: false },
		{ env },
		{ env: { ...flowEnv, BITOVP_LOCAL_STORY_FLOW_ENABLED: "0" } },
		{ env: { ...flowEnv, BITOVP_LOCAL_STORY_FLOW_ENABLED: "true" } },
		{ env: { BITOVP_LOCAL_STORY_FLOW_ENABLED: "1" } },
		{ instanceId: "bad" },
		{ capabilityHash: "bad" },
		{ captionModelHash: "bad" },
	]) {
		const claim = vi.fn();
		const publish = vi.fn();
		const probe = vi.fn();
		const runtime = await startLocalStoryFlowDiagnostics({
			env: flowEnv,
			initialized: true,
			instanceId,
			capabilityHash,
			claim,
			publish,
			probe,
			...change,
		});
		await vi.advanceTimersByTimeAsync(5_000);
		await runtime.stop();
		expect(claim).not.toHaveBeenCalled();
		expect(probe).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();
	}
});

it("leaves FLOW idle until a request and uses the named six-stage probe with pinned startup identity", async () => {
	vi.useFakeTimers();
	const claim = vi.fn().mockResolvedValue(null);
	const publish = vi.fn().mockResolvedValue(undefined);
	const options = {
		env: { ...flowEnv },
		initialized: true,
		instanceId,
		capabilityHash,
		claim,
		publish,
	};
	const runtime = await startLocalStoryFlowDiagnostics(options);
	expect(claim).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(3_000);
	expect(defaultProbes.flow).not.toHaveBeenCalled();
	options.env.BITOVP_LOCAL_SEMANTIC_GATEWAY_URL = "https://foreign.invalid";
	options.capabilityHash = "f".repeat(64);
	options.instanceId = "44444444-4444-4444-8444-444444444444";
	const value = flowRequest();
	claim.mockResolvedValueOnce(JSON.stringify(value));
	await vi.advanceTimersByTimeAsync(1_000);
	expect(defaultProbes.flow).toHaveBeenCalledTimes(1);
	expect(defaultProbes.legacy).not.toHaveBeenCalled();
	expect(defaultProbes.flow.mock.calls[0]?.[0]).toMatchObject({
		url: env.BITOVP_LOCAL_SEMANTIC_GATEWAY_URL,
	});
	expect(defaultProbes.flow.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
	const row = publish.mock.calls[0]?.[1];
	expect(row).toEqual({
		version: "local-story-flow-diagnostic-result-v1",
		requestId: value.requestId,
		connectionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
		capabilityHash,
		instanceId,
		profile: "nvidia",
		observedAt: Date.now(),
		diagnostic: { scope: "METADATA_ONLY", code: "READY" },
	});
	expect(publish.mock.calls[0]?.[0]).toEqual({
		active: `bitovp:local-story-flow:{${row.connectionHash}}:${capabilityHash}:diagnostic:active`,
		requests: `bitovp:local-story-flow:{${row.connectionHash}}:${capabilityHash}:diagnostic:requests`,
		results: `bitovp:local-story-flow:{${row.connectionHash}}:${capabilityHash}:diagnostic:result:`,
		latest: `bitovp:local-story-flow:{${row.connectionHash}}:${capabilityHash}:diagnostic:latest`,
	});
	expect(JSON.stringify(row).length).toBeLessThanOrEqual(2_048);
	expect(JSON.stringify(publish.mock.calls)).not.toMatch(
		/fixture\.invalid|foreign\.invalid|aaaa|\/run\/ca/,
	);
	await runtime.stop();
});

it.each([
	() => null,
	() => "bad JSON",
	() => "x".repeat(513),
	() => JSON.stringify(flowRequest({ capabilityHash: "f".repeat(64) })),
	() => JSON.stringify(flowRequest({ url: "https://foreign.invalid" })),
	() => JSON.stringify(flowRequest({ expiresAt: Date.now() })),
	() => JSON.stringify(flowRequest({ expiresAt: Date.now() + 50_000 })),
])("rejects malformed, foreign, oversized and expired FLOW requests before probing %#", async (raw) => {
	vi.useFakeTimers();
	const claim = vi.fn().mockResolvedValueOnce(raw()).mockResolvedValue(null);
	const publish = vi.fn();
	const probe = vi.fn();
	const runtime = await startLocalStoryFlowDiagnostics({
		env: flowEnv,
		initialized: true,
		instanceId,
		capabilityHash,
		claim,
		publish,
		probe,
	});
	await vi.advanceTimersByTimeAsync(1_000);
	expect(probe).not.toHaveBeenCalled();
	expect(publish).not.toHaveBeenCalled();
	await runtime.stop();
});

it("bounds independent legacy/FLOW channels to one pending metadata operation each", async () => {
	vi.useFakeTimers();
	const oldClaim = vi.fn().mockResolvedValue(JSON.stringify(request()));
	const flowClaim = vi.fn().mockResolvedValue(JSON.stringify(flowRequest()));
	const publish = vi.fn();
	const probe = vi.fn(
		(_config, signal: AbortSignal) =>
			new Promise<never>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => reject(new Error("authored abort")),
					{ once: true },
				);
			}),
	);
	const legacy = await startLocalSemanticDiagnostics({
		env,
		claim: oldClaim,
		publish,
		probe,
	});
	const flow = await startLocalStoryFlowDiagnostics({
		env: flowEnv,
		initialized: true,
		instanceId,
		capabilityHash,
		claim: flowClaim,
		publish,
		probe,
	});
	await vi.advanceTimersByTimeAsync(5_000);
	expect(oldClaim).toHaveBeenCalledTimes(1);
	expect(flowClaim).toHaveBeenCalledTimes(1);
	expect(probe).toHaveBeenCalledTimes(2);
	expect(oldClaim.mock.calls[0]?.[0].active).not.toBe(
		flowClaim.mock.calls[0]?.[0].active,
	);
	await Promise.all([legacy.stop(), flow.stop()]);
	expect(publish).not.toHaveBeenCalled();
});

it("uses the request deadline and suppresses late probe success after expiry", async () => {
	vi.useFakeTimers();
	// Node's AbortSignal.timeout uses native timers; drive this clock boundary explicitly.
	const timeout = vi
		.spyOn(AbortSignal, "timeout")
		.mockImplementation((delay) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), delay);
			return controller.signal;
		});
	const value = flowRequest({ expiresAt: Date.now() + 2_000 });
	const claim = vi
		.fn()
		.mockResolvedValueOnce(JSON.stringify(value))
		.mockResolvedValue(null);
	const publish = vi.fn();
	let observed: AbortSignal | undefined;
	let finish: (() => void) | undefined;
	const probe = vi.fn(
		(_config, signal: AbortSignal) =>
			new Promise<{ scope: "METADATA_ONLY"; code: "READY" }>((resolve) => {
				observed = signal;
				finish = () => resolve({ scope: "METADATA_ONLY", code: "READY" });
			}),
	);
	const runtime = await startLocalStoryFlowDiagnostics({
		env: flowEnv,
		initialized: true,
		instanceId,
		capabilityHash,
		claim,
		publish,
		probe,
	});
	await vi.advanceTimersByTimeAsync(1_000);
	expect(timeout).toHaveBeenCalledExactlyOnceWith(1_000);
	expect(observed?.aborted).toBe(false);
	await vi.advanceTimersByTimeAsync(1_000);
	expect(observed?.aborted).toBe(true);
	finish?.();
	await vi.advanceTimersByTimeAsync(0);
	expect(publish).not.toHaveBeenCalled();
	await runtime.stop();
});

it.each([
	"claim",
	"probe",
] as const)("bounds FLOW shutdown when %s ignores cancellation and rejects late work", async (stage) => {
	vi.useFakeTimers();
	let releaseClaim: ((raw: string) => void) | undefined;
	let releaseProbe: (() => void) | undefined;
	let observed: AbortSignal | undefined;
	const raw = JSON.stringify(flowRequest());
	const claim = vi.fn(() =>
		stage === "claim"
			? new Promise<string>((resolve) => {
					releaseClaim = resolve;
				})
			: Promise.resolve(raw),
	);
	const probe = vi.fn(
		(_config, signal: AbortSignal) =>
			new Promise<{ scope: "METADATA_ONLY"; code: "READY" }>((resolve) => {
				observed = signal;
				releaseProbe = () => resolve({ scope: "METADATA_ONLY", code: "READY" });
			}),
	);
	const publish = vi.fn();
	const runtime = await startLocalStoryFlowDiagnostics({
		env: flowEnv,
		initialized: true,
		instanceId,
		capabilityHash,
		claim,
		publish,
		probe,
	});
	await vi.advanceTimersByTimeAsync(1_000);
	const stopped = runtime.stop();
	await vi.advanceTimersByTimeAsync(1_000);
	await expect(stopped).resolves.toBeUndefined();
	if (stage === "probe") expect(observed?.aborted).toBe(true);
	releaseClaim?.(raw);
	releaseProbe?.();
	await vi.advanceTimersByTimeAsync(60_000);
	expect(claim).toHaveBeenCalledTimes(1);
	if (stage === "claim") expect(probe).not.toHaveBeenCalled();
	expect(publish).not.toHaveBeenCalled();
});

it("never publishes private probe errors or malformed diagnostic fields", async () => {
	vi.useFakeTimers();
	for (const probe of [
		vi.fn().mockRejectedValue(new Error("private-token-sentinel")),
		vi.fn().mockResolvedValue({
			scope: "METADATA_ONLY",
			code: "READY",
			url: "https://private.invalid",
		}),
		vi.fn().mockResolvedValue({
			scope: "METADATA_ONLY",
			code: "private-token-sentinel",
		}),
	]) {
		const claim = vi
			.fn()
			.mockResolvedValueOnce(JSON.stringify(flowRequest()))
			.mockResolvedValue(null);
		const publish = vi.fn();
		const runtime = await startLocalStoryFlowDiagnostics({
			env: flowEnv,
			initialized: true,
			instanceId,
			capabilityHash,
			claim,
			publish,
			probe,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(publish).not.toHaveBeenCalled();
		await runtime.stop();
	}
});
