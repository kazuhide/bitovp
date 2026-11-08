import { z } from "zod";
import { localSemanticDiagnosticResultSchema } from "./local-semantic-diagnostics";
import { localSemanticWorkerHeartbeatSchema } from "./local-semantic-readiness";
import { localStoryFlowWorkflowIdentitySchema } from "./local-story-flow-contracts";
import { hashEditingEvidence } from "./verify-automatic-binding";

export const LOCAL_STORY_FLOW_READINESS_POLICY = Object.freeze({
	version: "local-story-flow-readiness-v1",
	heartbeatTtlMs: 45_000,
	heartbeatRenewMs: 15_000,
	futureToleranceMs: 5_000,
	registryLimit: 100,
	diagnosticActiveMs: 40_000,
	diagnosticRequestMaxMs: 45_000,
	diagnosticRequestMaxChars: 512,
	diagnosticResultMaxChars: 2_048,
	diagnosticResultTtlMs: 60_000,
	diagnosticQueueLimit: 20,
});
const policy = LOCAL_STORY_FLOW_READINESS_POLICY;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const capabilitySchema = z.strictObject({
	workflow: localStoryFlowWorkflowIdentitySchema,
	generationPolicyFingerprint: hashSchema,
	asrModelSha256: hashSchema,
	transcriptionPolicyFingerprint: hashSchema,
});
const capabilityInvalid = () =>
	new Error("LOCAL_STORY_FLOW_CAPABILITY_INVALID");
const diagnosticInvalid = () =>
	new Error("LOCAL_STORY_FLOW_DIAGNOSTIC_INVALID");

/** Expected compiled pins only; this hash does not attest to ASR, inference or clip quality. */
export function localStoryFlowCapabilityHash(value: unknown): string {
	const parsed = capabilitySchema.safeParse(value);
	if (!parsed.success) throw capabilityInvalid();
	return hashEditingEvidence({
		version: "local-story-flow-capability-v1",
		...parsed.data,
	});
}
export function localStoryFlowOperatorGate(value: string | undefined) {
	return value === "1"
		? "ENABLED"
		: value === undefined || value === "0"
			? "DISABLED"
			: "INVALID";
}
function prefix(connectionHash: string, capabilityHash: string) {
	if (
		!hashSchema.safeParse(connectionHash).success ||
		!hashSchema.safeParse(capabilityHash).success
	)
		throw capabilityInvalid();
	return `bitovp:local-story-flow:{${connectionHash}}:${capabilityHash}`;
}
export function localStoryFlowWorkerRegistryKeys(
	connectionHash: string,
	capabilityHash: string,
) {
	const base = `${prefix(connectionHash, capabilityHash)}:workers`;
	return { times: `${base}:times`, records: `${base}:records` };
}
export function localStoryFlowDiagnosticKeys(
	connectionHash: string,
	capabilityHash: string,
) {
	const base = `${prefix(connectionHash, capabilityHash)}:diagnostic`;
	return {
		active: `${base}:active`,
		requests: `${base}:requests`,
		results: `${base}:result:`,
		latest: `${base}:latest`,
	};
}

export const localStoryFlowWorkerHeartbeatSchema = z.strictObject({
	version: z.literal("local-story-flow-worker-v1"),
	connectionHash: hashSchema,
	capabilityHash: hashSchema,
	instanceId: z.uuid(),
	profile: z.enum(["amd", "nvidia"]),
	state: z.enum(["READY", "INITIALIZATION_FAILED"]),
	observedAt: timestamp,
});
export type LocalStoryFlowWorkerHeartbeat = z.infer<
	typeof localStoryFlowWorkerHeartbeatSchema
>;
type WorkerCode =
	| "READY"
	| "MISSING"
	| "INITIALIZATION_FAILED"
	| "MIXED_WORKERS_UNSUPPORTED"
	| "REGISTRY_UNAVAILABLE"
	| "REGISTRY_LIMIT";
export type LocalStoryFlowWorkerSummary = {
	code: WorkerCode;
	legacyReadyCount: number;
	flowReadyCount: number;
	failedCount: number;
	instanceId?: string;
};

/** A single dual-publishing process is required. Malformed members never become absence. */
export function summarizeLocalStoryFlowWorkers(input: {
	legacyRows: readonly unknown[];
	flowRows: readonly unknown[];
	connectionHash: string;
	capabilityHash: string;
	profile: "amd" | "nvidia";
	now: number;
}): LocalStoryFlowWorkerSummary {
	const response = (code: WorkerCode): LocalStoryFlowWorkerSummary => ({
		code,
		legacyReadyCount: 0,
		flowReadyCount: 0,
		failedCount: 0,
	});
	if (
		!timestamp.safeParse(input.now).success ||
		!hashSchema.safeParse(input.connectionHash).success ||
		!hashSchema.safeParse(input.capabilityHash).success ||
		!["amd", "nvidia"].includes(input.profile)
	)
		return response("REGISTRY_UNAVAILABLE");
	if (
		input.legacyRows.length > policy.registryLimit ||
		input.flowRows.length > policy.registryLimit
	)
		return response("REGISTRY_LIMIT");
	const oldRows: z.infer<typeof localSemanticWorkerHeartbeatSchema>[] = [];
	const flowRows: LocalStoryFlowWorkerHeartbeat[] = [];
	try {
		for (const value of input.legacyRows) {
			const parsed = localSemanticWorkerHeartbeatSchema.safeParse(value);
			if (!parsed.success) return response("REGISTRY_UNAVAILABLE");
			const row = parsed.data;
			if (
				row.connectionHash !== input.connectionHash ||
				row.profile !== input.profile ||
				row.observedAt > input.now + policy.futureToleranceMs
			)
				return response("REGISTRY_UNAVAILABLE");
			if (row.observedAt >= input.now - policy.heartbeatTtlMs)
				oldRows.push(row);
		}
		for (const value of input.flowRows) {
			const parsed = localStoryFlowWorkerHeartbeatSchema.safeParse(value);
			if (!parsed.success) return response("REGISTRY_UNAVAILABLE");
			const row = parsed.data;
			if (
				row.connectionHash !== input.connectionHash ||
				row.capabilityHash !== input.capabilityHash ||
				row.profile !== input.profile ||
				row.observedAt > input.now + policy.futureToleranceMs
			)
				return response("REGISTRY_UNAVAILABLE");
			if (row.observedAt >= input.now - policy.heartbeatTtlMs)
				flowRows.push(row);
		}
	} catch {
		return response("REGISTRY_UNAVAILABLE");
	}
	const counts = {
		legacyReadyCount: oldRows.filter((row) => row.state === "READY").length,
		flowReadyCount: flowRows.filter((row) => row.state === "READY").length,
		failedCount: [...oldRows, ...flowRows].filter(
			(row) => row.state !== "READY",
		).length,
	};
	const blocked = (code: WorkerCode) => ({ code, ...counts });
	if (oldRows.length > 1 || flowRows.length > 1)
		return blocked("MIXED_WORKERS_UNSUPPORTED");
	if (counts.failedCount) return blocked("INITIALIZATION_FAILED");
	const legacy = oldRows[0],
		flow = flowRows[0];
	if (!legacy || !flow) return blocked("MISSING");
	if (legacy.instanceId !== flow.instanceId)
		return blocked("MIXED_WORKERS_UNSUPPORTED");
	return { code: "READY", ...counts, instanceId: flow.instanceId };
}

export const localStoryFlowDiagnosticRequestSchema = z.strictObject({
	version: z.literal("local-story-flow-diagnostic-request-v1"),
	requestId: z.uuid(),
	capabilityHash: hashSchema,
	expiresAt: timestamp,
});
export type LocalStoryFlowDiagnosticRequest = z.infer<
	typeof localStoryFlowDiagnosticRequestSchema
>;
export const localStoryFlowDiagnosticResultSchema = z.strictObject({
	version: z.literal("local-story-flow-diagnostic-result-v1"),
	requestId: z.uuid(),
	connectionHash: hashSchema,
	capabilityHash: hashSchema,
	instanceId: z.uuid(),
	profile: z.enum(["amd", "nvidia"]),
	observedAt: timestamp,
	diagnostic: localSemanticDiagnosticResultSchema.shape.diagnostic,
});
export type LocalStoryFlowDiagnosticResult = z.infer<
	typeof localStoryFlowDiagnosticResultSchema
>;
function decode(raw: unknown, maxChars: number): unknown {
	if (typeof raw !== "string" || raw.length > maxChars)
		throw diagnosticInvalid();
	try {
		return JSON.parse(raw);
	} catch {
		throw diagnosticInvalid();
	}
}
export function parseLocalStoryFlowDiagnosticRequest(
	raw: unknown,
	expected: { capabilityHash: string; now: number },
): LocalStoryFlowDiagnosticRequest {
	const parsed = localStoryFlowDiagnosticRequestSchema.safeParse(
		decode(raw, policy.diagnosticRequestMaxChars),
	);
	if (
		!timestamp.safeParse(expected.now).success ||
		!hashSchema.safeParse(expected.capabilityHash).success ||
		!parsed.success ||
		parsed.data.capabilityHash !== expected.capabilityHash ||
		parsed.data.expiresAt <= expected.now ||
		parsed.data.expiresAt > expected.now + policy.diagnosticRequestMaxMs
	)
		throw diagnosticInvalid();
	return parsed.data;
}
export function parseLocalStoryFlowDiagnosticResult(
	raw: unknown,
	expected: {
		requestId: string;
		connectionHash: string;
		capabilityHash: string;
		instanceId: string;
		profile: "amd" | "nvidia";
		now: number;
		notBefore: number;
		notAfter: number;
	},
): LocalStoryFlowDiagnosticResult {
	const parsed = localStoryFlowDiagnosticResultSchema.safeParse(
		decode(raw, policy.diagnosticResultMaxChars),
	);
	if (
		!timestamp.safeParse(expected.now).success ||
		!timestamp.safeParse(expected.notBefore).success ||
		!timestamp.safeParse(expected.notAfter).success ||
		expected.notBefore > expected.notAfter ||
		!parsed.success
	)
		throw diagnosticInvalid();
	const row = parsed.data;
	if (
		row.requestId !== expected.requestId ||
		row.connectionHash !== expected.connectionHash ||
		row.capabilityHash !== expected.capabilityHash ||
		row.instanceId !== expected.instanceId ||
		row.profile !== expected.profile ||
		row.observedAt <
			Math.max(expected.notBefore, expected.now - policy.heartbeatTtlMs) ||
		row.observedAt >
			Math.min(expected.notAfter, expected.now + policy.futureToleranceMs)
	)
		throw diagnosticInvalid();
	return row;
}

/** Coalesce manual checks in the FLOW-only channel; the caller validates the bounded request. */
export const REQUEST_LOCAL_STORY_FLOW_DIAGNOSTIC = `
local active=redis.call('GET',KEYS[1])
if active then return active end
redis.call('SET',KEYS[1],ARGV[1],'PX',40000)
redis.call('LPUSH',KEYS[2],ARGV[1])
redis.call('LTRIM',KEYS[2],0,19)
redis.call('PEXPIRE',KEYS[2],40000)
return ARGV[1]`;

/** Late results remain owner-readable but cannot replace a different active request's latest. */
export const PUBLISH_LOCAL_STORY_FLOW_DIAGNOSTIC = `
redis.call('SET',KEYS[2],ARGV[2],'PX',60000)
local active=redis.call('GET',KEYS[1])
if active then
  local ok,parsed=pcall(cjson.decode,active)
  local outputOk,output=pcall(cjson.decode,ARGV[2])
  if ok and outputOk and type(parsed)=='table' and type(output)=='table'
    and parsed.requestId==ARGV[1] and output.requestId==ARGV[1]
    and parsed.capabilityHash==output.capabilityHash then
    redis.call('SET',KEYS[3],ARGV[2],'PX',60000)
    redis.call('DEL',KEYS[1])
  end
end
return 1`;
