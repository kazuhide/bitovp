import "server-only";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
	hashEditingEvidence,
	LOCAL_SEMANTIC_HEARTBEAT_TTL_MS,
	type LocalSemanticConfiguration,
	type LocalSemanticReadinessReport,
	loadEnv,
	localSemanticConnectionHash,
	localSemanticDiagnosticKeys,
	localSemanticDiagnosticRequestSchema,
	localSemanticDiagnosticResultSchema,
	localSemanticWorkerRegistryKeys,
	REQUEST_LOCAL_SEMANTIC_DIAGNOSTIC,
	readLocalSemanticConfiguration,
	summarizeClipEditingAvailability,
	summarizeLocalSemanticWorkers,
} from "@bitovp/core";
import { readLocalCaptionTranslationSelection } from "@bitovp/core/local-caption-config";
import { Redis } from "ioredis";

export {
	probeLocalSemanticGateway,
	readLocalSemanticMetadata,
} from "@bitovp/core/local-semantic-diagnostic-probe";

type GatewayResult = LocalSemanticReadinessReport["gateway"];
type WorkerResult = LocalSemanticReadinessReport["worker"];
type DiagnosticConfig = LocalSemanticConfiguration & {
	captionModelHash: string;
};

/** Read only recent worker-owned GPU checks. A page request never probes the LAN. */
export async function readWorkerClipAvailability(
	config: DiagnosticConfig,
): Promise<boolean> {
	const redis = new Redis(loadEnv().REDIS_URL, {
		lazyConnect: true,
		enableOfflineQueue: false,
		connectTimeout: 1_000,
		commandTimeout: 1_000,
		maxRetriesPerRequest: 0,
		retryStrategy: () => null,
	});
	redis.on("error", () => {});
	try {
		const hash = await localSemanticConnectionHash(
			config,
			config.captionModelHash,
		);
		const keys = localSemanticWorkerRegistryKeys(hash);
		await redis.connect();
		const now = Date.now();
		const ids = await redis.zrangebyscore(
			keys.times,
			now - LOCAL_SEMANTIC_HEARTBEAT_TTL_MS,
			now + 5_000,
			"LIMIT",
			0,
			101,
		);
		if (ids.length > 100) return false;
		const rows = ids.length ? await redis.hmget(keys.records, ...ids) : [];
		return summarizeClipEditingAvailability(
			rows.map((row) => {
				try {
					return row && row.length <= 2048 ? JSON.parse(row) : null;
				} catch {
					return null;
				}
			}),
			hash,
			config.profile,
			Date.now(),
		);
	} catch {
		return false;
	} finally {
		redis.disconnect();
	}
}

/** Web stays on the internal network. Only the configured editing worker contacts the LAN gateway. */
async function requestWorkerGatewayDiagnostic(
	config: DiagnosticConfig,
): Promise<GatewayResult> {
	const scope = "METADATA_ONLY" as const;
	const redis = new Redis(loadEnv().REDIS_URL, {
		lazyConnect: true,
		enableOfflineQueue: false,
		connectTimeout: 1_500,
		commandTimeout: 2_000,
		maxRetriesPerRequest: 0,
		retryStrategy: () => null,
	});
	redis.on("error", () => {});
	try {
		const hash = await localSemanticConnectionHash(
			config,
			config.captionModelHash,
		);
		const registry = localSemanticWorkerRegistryKeys(hash);
		const keys = localSemanticDiagnosticKeys(hash);
		await redis.connect();
		const now = Date.now();
		const count = await redis.zcount(
			registry.times,
			now - LOCAL_SEMANTIC_HEARTBEAT_TTL_MS,
			now + 5_000,
		);
		if (!count) return { code: "WORKER_UNAVAILABLE", scope };
		const raw = await redis.eval(
			REQUEST_LOCAL_SEMANTIC_DIAGNOSTIC,
			2,
			keys.active,
			keys.requests,
			JSON.stringify({
				version: "local-semantic-diagnostic-request-v1",
				requestId: randomUUID(),
				expiresAt: now + 40_000,
			}),
		);
		if (typeof raw !== "string" || raw.length > 512)
			return { code: "INVALID_RESPONSE", scope };
		const request = localSemanticDiagnosticRequestSchema.parse(JSON.parse(raw));
		if (request.expiresAt > now + 45_000)
			return { code: "INVALID_RESPONSE", scope };
		while (Date.now() < request.expiresAt) {
			const text = await redis.get(`${keys.results}${request.requestId}`);
			if (text) {
				if (text.length > 2048) return { code: "INVALID_RESPONSE", scope };
				const result = localSemanticDiagnosticResultSchema.safeParse(
					JSON.parse(text),
				);
				if (
					!result.success ||
					result.data.requestId !== request.requestId ||
					result.data.connectionHash !== hash ||
					result.data.profile !== config.profile ||
					result.data.observedAt < request.expiresAt - 40_000 ||
					result.data.observedAt >
						Math.min(request.expiresAt, Date.now() + 5_000)
				)
					return { code: "INVALID_RESPONSE", scope };
				return result.data.diagnostic;
			}
			await delay(250);
		}
		return { code: "DIAGNOSTIC_TIMEOUT", scope };
	} catch {
		return { code: "WORKER_UNAVAILABLE", scope };
	} finally {
		redis.disconnect();
	}
}

async function readWorkers(config: DiagnosticConfig): Promise<WorkerResult> {
	const fallback = {
		code: "REGISTRY_UNAVAILABLE",
		readyCount: 0,
		failedCount: 0,
	} as const;
	const redis = new Redis(loadEnv().REDIS_URL, {
		lazyConnect: true,
		enableOfflineQueue: false,
		connectTimeout: 1_500,
		commandTimeout: 2_000,
		maxRetriesPerRequest: 0,
		retryStrategy: () => null,
	});
	redis.on("error", () => {});
	try {
		const hash = await localSemanticConnectionHash(
			config,
			config.captionModelHash,
		);
		const keys = localSemanticWorkerRegistryKeys(hash);
		await redis.connect();
		const now = Date.now();
		const ids = await redis.zrangebyscore(
			keys.times,
			now - LOCAL_SEMANTIC_HEARTBEAT_TTL_MS,
			now + 5_000,
			"LIMIT",
			0,
			101,
		);
		if (ids.length > 100) return { ...fallback, code: "REGISTRY_LIMIT" };
		const records = ids.length ? await redis.hmget(keys.records, ...ids) : [];
		return summarizeLocalSemanticWorkers(
			records.map((row) => {
				try {
					return row && row.length <= 1024 ? JSON.parse(row) : null;
				} catch {
					return null;
				}
			}),
			hash,
			config.profile,
			now,
		);
	} catch {
		return fallback;
	} finally {
		redis.disconnect();
	}
}

/** GET returns configuration only; expensive connectivity checks are an explicit operator action. */
export async function diagnoseLocalSemanticReadiness(
	input: {
		env?: Record<string, string | undefined>;
		diagnose?: boolean;
		readWorkers?: typeof readWorkers;
		probeGateway?: (
			config: LocalSemanticConfiguration,
		) => Promise<GatewayResult>;
		now?: Date;
	} = {},
): Promise<LocalSemanticReadinessReport> {
	const base: LocalSemanticReadinessReport = {
		checkedAt: (input.now ?? new Date()).toISOString(),
		configuration: "DISABLED",
		worker: { code: "NOT_CHECKED", readyCount: 0, failedCount: 0 },
		gateway: { code: "NOT_CHECKED", scope: "METADATA_ONLY" },
	};
	let config: DiagnosticConfig | undefined;
	try {
		const env = input.env ?? process.env;
		const connection = readLocalSemanticConfiguration(env);
		if (connection)
			config = {
				...connection,
				captionModelHash: hashEditingEvidence(
					readLocalCaptionTranslationSelection(connection, env).identity,
				),
			};
	} catch {
		return { ...base, configuration: "INVALID" };
	}
	if (!config) return base;
	const result = {
		...base,
		configuration: "CONFIGURED" as const,
		profile: config.profile,
	};
	if (!input.diagnose) return result;
	const [worker, gateway] = await Promise.allSettled([
		(input.readWorkers ?? readWorkers)(config),
		(input.probeGateway ?? requestWorkerGatewayDiagnostic)(config),
	]);
	return {
		...result,
		worker:
			worker.status === "fulfilled"
				? worker.value
				: { code: "REGISTRY_UNAVAILABLE", readyCount: 0, failedCount: 0 },
		gateway:
			gateway.status === "fulfilled"
				? gateway.value
				: { code: "CONNECTION_FAILED", scope: "METADATA_ONLY" },
	};
}
