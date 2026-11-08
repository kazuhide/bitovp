import { z } from "zod";
import type { LocalSemanticConfiguration } from "./local-semantic-config";

export const LOCAL_SEMANTIC_HEARTBEAT_TTL_MS = 45_000;
export const localSemanticWorkerHeartbeatSchema = z.strictObject({
	version: z.literal("local-semantic-worker-v1"),
	connectionHash: z.string().regex(/^[a-f0-9]{64}$/),
	instanceId: z.uuid(),
	profile: z.enum(["amd", "nvidia"]),
	state: z.enum(["READY", "INITIALIZATION_FAILED"]),
	observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type LocalSemanticWorkerHeartbeat = z.infer<
	typeof localSemanticWorkerHeartbeatSchema
>;

/** A deployment-owned identity, never exposed in diagnostic responses. CA mount paths may differ. */
export async function localSemanticConnectionHash(
	config: LocalSemanticConfiguration,
	captionModelHash?: string,
) {
	if (
		captionModelHash !== undefined &&
		!/^[a-f0-9]{64}$/.test(captionModelHash)
	)
		throw new Error("LOCAL_SEMANTIC_CAPTION_IDENTITY_INVALID");
	const bytes = new TextEncoder().encode(
		JSON.stringify([
			"local-semantic-connection-v1",
			config.configId,
			new URL(config.url).href,
			config.profile,
			config.token,
			...(captionModelHash ? [captionModelHash] : []),
		]),
	);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (n) =>
		n.toString(16).padStart(2, "0"),
	).join("");
}

export function localSemanticWorkerRegistryKeys(connectionHash: string) {
	if (!/^[a-f0-9]{64}$/.test(connectionHash))
		throw new Error("LOCAL_SEMANTIC_REGISTRY_ID_INVALID");
	const prefix = `bitovp:local-semantic:workers:{${connectionHash}}`;
	return { times: `${prefix}:times`, records: `${prefix}:records` };
}

export function summarizeLocalSemanticWorkers(
	rows: readonly unknown[],
	connectionHash: string,
	profile: "amd" | "nvidia",
	now: number,
) {
	const accepted = new Map<string, LocalSemanticWorkerHeartbeat>();
	for (const value of rows.slice(0, 100)) {
		const result = localSemanticWorkerHeartbeatSchema.safeParse(value);
		if (!result.success) continue;
		const row = result.data;
		if (
			row.connectionHash !== connectionHash ||
			row.profile !== profile ||
			row.observedAt < now - LOCAL_SEMANTIC_HEARTBEAT_TTL_MS ||
			row.observedAt > now + 5_000
		)
			continue;
		accepted.set(row.instanceId, row);
	}
	const readyCount = [...accepted.values()].filter(
		(row) => row.state === "READY",
	).length;
	const failedCount = accepted.size - readyCount;
	const code = readyCount
		? failedCount
			? "MIXED"
			: "READY"
		: failedCount
			? "INITIALIZATION_FAILED"
			: "MISSING";
	return { code, readyCount, failedCount } as const;
}

export const localSemanticGatewayReadinessSchema = z
	.strictObject({
		version: z.literal("bitovp-semantic-readiness-v1"),
		profile: z.enum(["amd", "nvidia"]),
		scope: z.literal("METADATA_ONLY"),
		ready: z.boolean(),
		code: z.enum([
			"READY",
			"GATEWAY_STOPPING",
			"RUNTIME_QUARANTINED",
			"RUNTIME_UNAVAILABLE",
			"RUNTIME_VERSION_MISMATCH",
			"MODEL_MISMATCH",
		]),
	})
	.refine(
		(row) => row.ready === (row.code === "READY"),
		"Readiness code and state must agree",
	);

export type LocalSemanticReadinessReport = {
	checkedAt: string;
	configuration: "DISABLED" | "INVALID" | "CONFIGURED";
	profile?: "amd" | "nvidia";
	worker: {
		code:
			| "NOT_CHECKED"
			| "MISSING"
			| "READY"
			| "MIXED"
			| "INITIALIZATION_FAILED"
			| "REGISTRY_UNAVAILABLE"
			| "REGISTRY_LIMIT";
		readyCount: number;
		failedCount: number;
	};
	gateway: {
		code:
			| "NOT_CHECKED"
			| z.infer<typeof localSemanticGatewayReadinessSchema>["code"]
			| "CONNECTION_FAILED"
			| "AUTH_FAILED"
			| "TLS_FAILED"
			| "INVALID_RESPONSE"
			| "GATEWAY_VERSION_MISMATCH"
			| "MODEL_NOT_INSTALLED"
			| "WORKER_UNAVAILABLE"
			| "DIAGNOSTIC_TIMEOUT";
		scope: "METADATA_ONLY";
	};
};
