import { z } from "zod";
import { localSemanticWorkerRegistryKeys } from "./local-semantic-readiness";

export const localSemanticDiagnosticRequestSchema = z.strictObject({
	version: z.literal("local-semantic-diagnostic-request-v1"),
	requestId: z.uuid(),
	expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type LocalSemanticDiagnosticRequest = z.infer<
	typeof localSemanticDiagnosticRequestSchema
>;
export const localSemanticDiagnosticResultSchema = z.strictObject({
	version: z.literal("local-semantic-diagnostic-result-v1"),
	requestId: z.uuid(),
	connectionHash: z.string().regex(/^[a-f0-9]{64}$/),
	profile: z.enum(["amd", "nvidia"]),
	observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	diagnostic: z.strictObject({
		scope: z.literal("METADATA_ONLY"),
		code: z.enum([
			"READY",
			"GATEWAY_STOPPING",
			"RUNTIME_QUARANTINED",
			"RUNTIME_UNAVAILABLE",
			"RUNTIME_VERSION_MISMATCH",
			"MODEL_MISMATCH",
			"CONNECTION_FAILED",
			"AUTH_FAILED",
			"TLS_FAILED",
			"INVALID_RESPONSE",
			"GATEWAY_VERSION_MISMATCH",
			"MODEL_NOT_INSTALLED",
		]),
	}),
});
export type LocalSemanticDiagnosticResult = z.infer<
	typeof localSemanticDiagnosticResultSchema
>;
export function localSemanticDiagnosticKeys(hash: string) {
	const prefix = localSemanticWorkerRegistryKeys(hash).times.replace(
		/:times$/,
		":diagnostic",
	);
	return {
		active: `${prefix}:active`,
		requests: `${prefix}:requests`,
		results: `${prefix}:result:`,
	};
}

/** Coalesce manual checks; requests contain no endpoint, model, tenant content or credentials. */
export const REQUEST_LOCAL_SEMANTIC_DIAGNOSTIC = `
local active=redis.call('GET',KEYS[1])
if active then return active end
redis.call('SET',KEYS[1],ARGV[1],'PX',40000)
redis.call('LPUSH',KEYS[2],ARGV[1])
redis.call('LTRIM',KEYS[2],0,19)
redis.call('PEXPIRE',KEYS[2],40000)
return ARGV[1]`;
export const PUBLISH_LOCAL_SEMANTIC_DIAGNOSTIC = `
redis.call('SET',KEYS[2],ARGV[2],'PX',60000)
local active=redis.call('GET',KEYS[1])
if active then
  local parsed=cjson.decode(active)
  if parsed.requestId==ARGV[1] then redis.call('DEL',KEYS[1]) end
end
return 1`;
