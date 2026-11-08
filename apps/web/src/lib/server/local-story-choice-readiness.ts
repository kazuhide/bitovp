import "server-only";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
	hashEditingEvidence,
	LOCAL_SEMANTIC_HEARTBEAT_TTL_MS,
	loadEnv,
	localSemanticConnectionHash,
	localSemanticWorkerRegistryKeys,
	localStoryChoiceDiagnosticKeys,
	localStoryChoiceDiagnosticRequestSchema,
	localStoryChoiceDiagnosticResultSchema,
	REQUEST_LOCAL_STORY_CHOICE_DIAGNOSTIC,
	readLocalSemanticConfiguration,
} from "@bitovp/core";
import { readLocalCaptionTranslationSelection } from "@bitovp/core/local-caption-config";
import { Redis } from "ioredis";

/** Read-only metadata travels through the initialized worker, never directly from Web to the LAN. */
export async function isLocalStoryChoiceReady(
	env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
	if (env.BITOVP_LOCAL_STORY_CHOICE_ENABLED !== "1") return false;
	let config: NonNullable<ReturnType<typeof readLocalSemanticConfiguration>>;
	let captionModelHash: string;
	try {
		const configured = readLocalSemanticConfiguration(env);
		if (!configured) return false;
		config = configured;
		captionModelHash = hashEditingEvidence(
			readLocalCaptionTranslationSelection(config, env).identity,
		);
	} catch {
		return false;
	}
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
		const connectionHash = await localSemanticConnectionHash(
			config,
			captionModelHash,
		);
		const registry = localSemanticWorkerRegistryKeys(connectionHash);
		const keys = localStoryChoiceDiagnosticKeys(connectionHash);
		await redis.connect();
		const now = Date.now();
		if (
			!(await redis.zcount(
				registry.times,
				now - LOCAL_SEMANTIC_HEARTBEAT_TTL_MS,
				now + 5_000,
			))
		)
			return false;
		const raw = await redis.eval(
			REQUEST_LOCAL_STORY_CHOICE_DIAGNOSTIC,
			2,
			keys.active,
			keys.requests,
			JSON.stringify({
				version: "local-story-choice-diagnostic-request-v1",
				requestId: randomUUID(),
				expiresAt: now + 40_000,
			}),
		);
		if (typeof raw !== "string" || raw.length > 512) return false;
		const request = localStoryChoiceDiagnosticRequestSchema.parse(
			JSON.parse(raw),
		);
		if (request.expiresAt <= now || request.expiresAt > now + 45_000)
			return false;
		while (Date.now() < request.expiresAt) {
			const text = await redis.get(`${keys.results}${request.requestId}`);
			if (text) {
				if (text.length > 2048) return false;
				const result = localStoryChoiceDiagnosticResultSchema.safeParse(
					JSON.parse(text),
				);
				return !!(
					result.success &&
					result.data.requestId === request.requestId &&
					result.data.connectionHash === connectionHash &&
					result.data.profile === config.profile &&
					result.data.observedAt >= request.expiresAt - 40_000 &&
					result.data.observedAt <=
						Math.min(request.expiresAt, Date.now() + 5_000) &&
					result.data.diagnostic.code === "READY"
				);
			}
			await delay(250);
		}
		return false;
	} catch {
		return false;
	} finally {
		redis.disconnect();
	}
}
