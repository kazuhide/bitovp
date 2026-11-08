import { describe, expect, it } from "vitest";
import {
	localStoryFlowCapabilityHash,
	localStoryFlowDiagnosticKeys,
	localStoryFlowDiagnosticResultSchema,
	localStoryFlowOperatorGate,
	localStoryFlowWorkerHeartbeatSchema,
	localStoryFlowWorkerRegistryKeys,
	parseLocalStoryFlowDiagnosticRequest,
	parseLocalStoryFlowDiagnosticResult,
	summarizeLocalStoryFlowWorkers,
} from "./local-story-flow-readiness";
import { localStoryFlowIdentityForConfiguration } from "./local-story-flow-stages";

const now = 100_000;
const connectionHash = "a".repeat(64);
const capabilityHash = "b".repeat(64);
const instanceId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const profile = "nvidia" as const;
const config = {
	url: "https://fixture.invalid:11437/",
	token: "a".repeat(48),
	caFile: "/run/ca.pem",
	profile,
	configId: "11111111-1111-4111-8111-111111111111",
};
const heartbeat = (change = {}) => ({
	version: "local-story-flow-worker-v1",
	connectionHash,
	capabilityHash,
	instanceId,
	profile,
	state: "READY",
	observedAt: now,
	...change,
});
const legacy = (change = {}) => {
	const { capabilityHash: _capability, ...row } = heartbeat(change);
	return { ...row, version: "local-semantic-worker-v1" };
};
const summary = (flowRows: unknown[], legacyRows: unknown[] = [legacy()]) =>
	summarizeLocalStoryFlowWorkers({
		flowRows,
		legacyRows,
		connectionHash,
		capabilityHash,
		profile,
		now,
	});
const request = (change = {}) => ({
	version: "local-story-flow-diagnostic-request-v1",
	requestId,
	capabilityHash,
	expiresAt: now + 40_000,
	...change,
});
const result = (change = {}) => ({
	version: "local-story-flow-diagnostic-result-v1",
	requestId,
	connectionHash,
	capabilityHash,
	instanceId,
	profile,
	observedAt: now,
	diagnostic: { scope: "METADATA_ONLY", code: "READY" },
	...change,
});
const expectedResult = {
	requestId,
	connectionHash,
	capabilityHash,
	instanceId,
	profile,
	now,
	notBefore: now - 1_000,
	notAfter: now + 40_000,
};

describe("hierarchical FLOW metadata capability", () => {
	it("rejects newline-suffixed hashes in all new capability and wire identities", () => {
		const invalid = `${capabilityHash}\n`;
		expect(() =>
			localStoryFlowCapabilityHash({
				workflow: localStoryFlowIdentityForConfiguration(config, "FLOW"),
				generationPolicyFingerprint: invalid,
				asrModelSha256: "d".repeat(64),
				transcriptionPolicyFingerprint: "e".repeat(64),
			}),
		).toThrow("LOCAL_STORY_FLOW_CAPABILITY_INVALID");
		expect(() =>
			localStoryFlowWorkerRegistryKeys(connectionHash, invalid),
		).toThrow("LOCAL_STORY_FLOW_CAPABILITY_INVALID");
		expect(
			localStoryFlowWorkerHeartbeatSchema.safeParse(
				heartbeat({ capabilityHash: invalid }),
			).success,
		).toBe(false);
		expect(
			localStoryFlowDiagnosticResultSchema.safeParse(
				result({ capabilityHash: invalid }),
			).success,
		).toBe(false);
		expect(() =>
			parseLocalStoryFlowDiagnosticRequest(
				JSON.stringify(request({ capabilityHash: invalid })),
				{ capabilityHash: invalid, now },
			),
		).toThrow("LOCAL_STORY_FLOW_DIAGNOSTIC_INVALID");
	});
	it("keeps the operator gate disabled unless the exact private value is 1", () => {
		expect(localStoryFlowOperatorGate(undefined)).toBe("DISABLED");
		expect(localStoryFlowOperatorGate("0")).toBe("DISABLED");
		expect(localStoryFlowOperatorGate("1")).toBe("ENABLED");
		for (const value of ["", "true", "01", " 1", "2"])
			expect(localStoryFlowOperatorGate(value)).toBe("INVALID");
	});
	it("binds the workflow, generation policy and configured ASR policies independently", () => {
		const expected = {
			workflow: localStoryFlowIdentityForConfiguration(config, "FLOW"),
			generationPolicyFingerprint: "c".repeat(64),
			asrModelSha256: "d".repeat(64),
			transcriptionPolicyFingerprint: "e".repeat(64),
		};
		const hash = localStoryFlowCapabilityHash(expected);
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
		for (const key of [
			"generationPolicyFingerprint",
			"asrModelSha256",
			"transcriptionPolicyFingerprint",
		] as const)
			expect(
				localStoryFlowCapabilityHash({ ...expected, [key]: "f".repeat(64) }),
			).not.toBe(hash);
		expect(
			localStoryFlowCapabilityHash({
				...expected,
				workflow: localStoryFlowIdentityForConfiguration(
					{ ...config, profile: "amd" },
					"FLOW",
				),
			}),
		).not.toBe(hash);
		expect(() =>
			localStoryFlowCapabilityHash({ ...expected, asrModelSha256: null }),
		).toThrow("LOCAL_STORY_FLOW_CAPABILITY_INVALID");
		expect(() =>
			localStoryFlowCapabilityHash({ ...expected, endpoint: config.url }),
		).toThrow("LOCAL_STORY_FLOW_CAPABILITY_INVALID");
	});
	it("uses a separate namespace with a common connection Redis hash tag", () => {
		const prefix = `bitovp:local-story-flow:{${connectionHash}}:${capabilityHash}`;
		expect(
			localStoryFlowWorkerRegistryKeys(connectionHash, capabilityHash),
		).toEqual({
			times: `${prefix}:workers:times`,
			records: `${prefix}:workers:records`,
		});
		expect(
			localStoryFlowDiagnosticKeys(connectionHash, capabilityHash),
		).toEqual({
			active: `${prefix}:diagnostic:active`,
			requests: `${prefix}:diagnostic:requests`,
			results: `${prefix}:diagnostic:result:`,
			latest: `${prefix}:diagnostic:latest`,
		});
		expect(() =>
			localStoryFlowWorkerRegistryKeys("bad", capabilityHash),
		).toThrow("LOCAL_STORY_FLOW_CAPABILITY_INVALID");
	});
	it("requires one fresh legacy and FLOW heartbeat from the same instance", () => {
		expect(summary([heartbeat()])).toMatchObject({ code: "READY", instanceId });
		expect(summary([]).code).toBe("MISSING");
		expect(summary([heartbeat()], []).code).toBe("MISSING");
		expect(
			summary([heartbeat()], [legacy({ instanceId: requestId })]).code,
		).toBe("MIXED_WORKERS_UNSUPPORTED");
		expect(summary([heartbeat(), heartbeat()]).code).toBe(
			"MIXED_WORKERS_UNSUPPORTED",
		);
		expect(summary([heartbeat()], [legacy(), legacy()]).code).toBe(
			"MIXED_WORKERS_UNSUPPORTED",
		);
		expect(summary([heartbeat({ state: "INITIALIZATION_FAILED" })]).code).toBe(
			"INITIALIZATION_FAILED",
		);
		expect(
			summary([heartbeat()], [legacy({ state: "INITIALIZATION_FAILED" })]).code,
		).toBe("INITIALIZATION_FAILED");
	});
	it("does not hide malformed, foreign, wrong-profile or wrong-capability members", () => {
		for (const row of [
			null,
			{},
			heartbeat({ extra: true }),
			heartbeat({ connectionHash: "f".repeat(64) }),
			heartbeat({ capabilityHash: "f".repeat(64) }),
			heartbeat({ profile: "amd" }),
			heartbeat({ observedAt: now + 5_001 }),
		])
			expect(summary([heartbeat(), row]).code).toBe("REGISTRY_UNAVAILABLE");
		expect(summary([heartbeat()], [legacy(), { broken: true }]).code).toBe(
			"REGISTRY_UNAVAILABLE",
		);
		expect(summary(Array.from({ length: 101 }, () => heartbeat())).code).toBe(
			"REGISTRY_LIMIT",
		);
		expect(
			summary(
				[heartbeat()],
				Array.from({ length: 101 }, () => legacy()),
			).code,
		).toBe("REGISTRY_LIMIT");
	});
	it("enforces inclusive heartbeat age and future boundaries without manufacturing a worker", () => {
		expect(summary([heartbeat({ observedAt: now - 45_000 })]).code).toBe(
			"READY",
		);
		expect(summary([heartbeat({ observedAt: now - 45_001 })]).code).toBe(
			"MISSING",
		);
		expect(summary([heartbeat({ observedAt: now + 5_000 })]).code).toBe(
			"READY",
		);
	});
	it("decodes only bounded, current requests for the expected capability", () => {
		expect(
			parseLocalStoryFlowDiagnosticRequest(JSON.stringify(request()), {
				capabilityHash,
				now,
			}),
		).toEqual(request());
		for (const raw of [
			"{",
			" ".repeat(513),
			JSON.stringify(request({ expiresAt: now })),
			JSON.stringify(request({ expiresAt: now + 45_001 })),
			JSON.stringify(request({ capabilityHash: "f".repeat(64) })),
			JSON.stringify(request({ endpoint: config.url })),
		])
			expect(() =>
				parseLocalStoryFlowDiagnosticRequest(raw, { capabilityHash, now }),
			).toThrow("LOCAL_STORY_FLOW_DIAGNOSTIC_INVALID");
	});
	it("checks result request, instance, pin, profile and both freshness windows", () => {
		expect(
			parseLocalStoryFlowDiagnosticResult(
				JSON.stringify(result()),
				expectedResult,
			),
		).toEqual(result());
		for (const change of [
			{ requestId: instanceId },
			{ instanceId: requestId },
			{ connectionHash: "f".repeat(64) },
			{ capabilityHash: "f".repeat(64) },
			{ profile: "amd" },
			{ observedAt: now - 1_001 },
			{ observedAt: now + 5_001 },
			{
				diagnostic: {
					scope: "METADATA_ONLY",
					code: "READY",
					token: "sentinel",
				},
			},
			{ diagnostic: { scope: "METADATA_ONLY", code: "sentinel" } },
		])
			expect(() =>
				parseLocalStoryFlowDiagnosticResult(
					JSON.stringify(result(change)),
					expectedResult,
				),
			).toThrow("LOCAL_STORY_FLOW_DIAGNOSTIC_INVALID");
		expect(() =>
			parseLocalStoryFlowDiagnosticResult(" ".repeat(2049), expectedResult),
		).toThrow("LOCAL_STORY_FLOW_DIAGNOSTIC_INVALID");
		expect(() =>
			parseLocalStoryFlowDiagnosticResult(
				JSON.stringify(result({ observedAt: now - 45_001 })),
				{ ...expectedResult, notBefore: 0 },
			),
		).toThrow("LOCAL_STORY_FLOW_DIAGNOSTIC_INVALID");
		expect(() =>
			parseLocalStoryFlowDiagnosticResult(
				JSON.stringify(result({ observedAt: now + 100 })),
				{ ...expectedResult, notAfter: now },
			),
		).toThrow("LOCAL_STORY_FLOW_DIAGNOSTIC_INVALID");
	});
});
