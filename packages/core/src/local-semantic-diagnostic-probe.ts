import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { z } from "zod";
import type { LocalCaptionTranslationSelection } from "./content-editing/local-caption-config-node";
import { localPlamoCaptionReadinessSchema } from "./content-editing/local-plamo-caption-protocol";
import type { LocalSemanticConfiguration } from "./content-editing/local-semantic-config";
import {
	LOCAL_SEMANTIC_MODEL,
	LOCAL_SEMANTIC_MODEL_DIGEST,
	LOCAL_SEMANTIC_RUNTIME_VERSION,
} from "./content-editing/local-semantic-protocol";
import {
	LOCAL_CLIP_AVAILABILITY_TTL_MS,
	type LocalSemanticReadinessReport,
	localSemanticGatewayReadinessSchema,
} from "./content-editing/local-semantic-readiness";
import { localSemanticStageRegistry } from "./content-editing/local-semantic-stages";
import { localSemanticPlanningStageRegistry } from "./content-editing/local-story-choice-stages";
import { localSemanticCombinedStageRegistry } from "./content-editing/local-story-flow-stages";
import { hashEditingEvidence } from "./content-editing/verify-automatic-binding";

type GatewayResult = LocalSemanticReadinessReport["gateway"];
type MetadataPath =
	| "/health"
	| `/readiness/${"amd" | "nvidia"}`
	| `/readiness/plamo/${"amd" | "nvidia"}/${string}`;
const gatewayHealth = z.object({
	version: z.literal("bitovp-semantic-gateway-v1"),
	runtimeVersion: z.literal(LOCAL_SEMANTIC_RUNTIME_VERSION),
	model: z.literal(LOCAL_SEMANTIC_MODEL),
	modelDigest: z.literal(LOCAL_SEMANTIC_MODEL_DIGEST),
	profiles: z.array(z.enum(["amd", "nvidia"])).max(2),
	stages: z
		.array(
			z.object({
				stage: z.string().max(80),
				promptVersion: z.string().max(80),
				schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
				maxOutputTokens: z.number().int().positive(),
			}),
		)
		.max(16),
});

class ProbeError extends Error {
	constructor(readonly code: GatewayResult["code"]) {
		super(code);
	}
}

/** Fixed GET paths and pinned TLS; no redirects, request-selected hosts, model load or inference. */
export async function readLocalSemanticMetadata(
	config: LocalSemanticConfiguration,
	path: MetadataPath,
	signal?: AbortSignal,
): Promise<unknown> {
	if (
		path !== "/health" &&
		!/^\/readiness\/(amd|nvidia)$/.test(path) &&
		!/^\/readiness\/plamo\/(amd|nvidia)\/[a-f0-9]{64}$/.test(path)
	)
		throw new ProbeError("INVALID_RESPONSE");
	let ca: Buffer;
	try {
		ca = await readFile(config.caFile);
	} catch {
		throw new ProbeError("TLS_FAILED");
	}
	return new Promise((resolve, reject) => {
		const req = request(
			new URL(path, config.url),
			{
				method: "GET",
				ca,
				rejectUnauthorized: true,
				agent: false,
				signal: AbortSignal.any([
					AbortSignal.timeout(path === "/health" ? 3_000 : 32_000),
					...(signal ? [signal] : []),
				]),
				headers: {
					authorization: `Bearer ${config.token}`,
					accept: "application/json",
				},
			},
			(res) => {
				if (res.statusCode === 401 || res.statusCode === 403) {
					res.destroy();
					reject(new ProbeError("AUTH_FAILED"));
					return;
				}
				if (res.statusCode !== 200) {
					res.destroy();
					reject(new ProbeError("CONNECTION_FAILED"));
					return;
				}
				let length = 0;
				const chunks: Buffer[] = [];
				res.on("error", () => reject(new ProbeError("CONNECTION_FAILED")));
				res.on("data", (chunk: Buffer) => {
					length += chunk.length;
					if (length > 16_384) {
						reject(new ProbeError("INVALID_RESPONSE"));
						res.destroy();
					} else chunks.push(chunk);
				});
				res.on("end", () => {
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
					} catch {
						reject(new ProbeError("INVALID_RESPONSE"));
					}
				});
			},
		);
		req.on("error", (error: NodeJS.ErrnoException) =>
			reject(
				new ProbeError(
					error.code &&
						/^(ERR_TLS_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_)/.test(
							error.code,
						)
						? "TLS_FAILED"
						: "CONNECTION_FAILED",
				),
			),
		);
		req.end();
	});
}

export async function probeLocalSemanticGateway(
	config: LocalSemanticConfiguration,
	readMetadata = readLocalSemanticMetadata,
	signal?: AbortSignal,
	captionSelection?: LocalCaptionTranslationSelection,
): Promise<GatewayResult> {
	return probeGateway(config, readMetadata, signal, captionSelection, false);
}

/** Preserve the original GPU observation clock; downstream caches cannot renew old proof. */
export async function probeLocalClipGateway(
	config: LocalSemanticConfiguration,
	readMetadata = readLocalSemanticMetadata,
	signal?: AbortSignal,
	captionSelection?: LocalCaptionTranslationSelection,
) {
	let gpuObservedAt: number | undefined;
	let authorizedOrganizationId: string | undefined;
	const diagnostic = await probeGateway(
		config,
		readMetadata,
		signal,
		captionSelection,
		false,
		(observedAt, organizationId) => {
			gpuObservedAt = observedAt;
			authorizedOrganizationId = organizationId;
		},
	);
	return { ...diagnostic, gpuObservedAt, authorizedOrganizationId };
}

export async function probeLocalStoryFlowGateway(
	config: LocalSemanticConfiguration,
	readMetadata = readLocalSemanticMetadata,
	signal?: AbortSignal,
	captionSelection?: LocalCaptionTranslationSelection,
): Promise<GatewayResult> {
	return probeGateway(config, readMetadata, signal, captionSelection, true);
}

export async function probeLocalStoryChoiceGateway(
	config: LocalSemanticConfiguration,
	readMetadata = readLocalSemanticMetadata,
	signal?: AbortSignal,
	captionSelection?: LocalCaptionTranslationSelection,
): Promise<GatewayResult> {
	return probeGateway(config, readMetadata, signal, captionSelection, "CHOICE");
}

async function probeGateway(
	config: LocalSemanticConfiguration,
	readMetadata: typeof readLocalSemanticMetadata,
	signal: AbortSignal | undefined,
	captionSelection: LocalCaptionTranslationSelection | undefined,
	flow: boolean | "CHOICE",
	observeGpu?: (observedAt: number, organizationId: string) => void,
): Promise<GatewayResult> {
	const scope = "METADATA_ONLY" as const;
	const deadline = AbortSignal.any([
		AbortSignal.timeout(35_000),
		...(signal ? [signal] : []),
	]);
	try {
		const health = gatewayHealth.safeParse(
			await readMetadata(config, "/health", deadline),
		);
		if (!health.success || !health.data.profiles.includes(config.profile))
			return { code: "GATEWAY_VERSION_MISMATCH", scope };
		const expectedStages =
			flow === "CHOICE"
				? localSemanticPlanningStageRegistry().stages
				: flow
					? localSemanticCombinedStageRegistry().stages
					: localSemanticStageRegistry().stages;
		if (
			flow &&
			health.data.stages.length !== Object.keys(expectedStages).length
		)
			return { code: "GATEWAY_VERSION_MISMATCH", scope };
		for (const [stage, expected] of Object.entries(expectedStages)) {
			const matches = health.data.stages.filter((row) => row.stage === stage);
			if (
				matches.length !== 1 ||
				matches[0]?.promptVersion !== expected.promptVersion ||
				matches[0]?.schemaHash !== expected.schemaHash ||
				matches[0]?.maxOutputTokens !== expected.maxOutputTokens
			)
				return { code: "GATEWAY_VERSION_MISMATCH", scope };
		}
		const readiness = localSemanticGatewayReadinessSchema.safeParse(
			await readMetadata(config, `/readiness/${config.profile}`, deadline),
		);
		if (!readiness.success || readiness.data.profile !== config.profile)
			return { code: "INVALID_RESPONSE", scope };
		const gpu = readiness.data.gpu;
		if (
			readiness.data.ready &&
			(!gpu ||
				gpu.profile !== config.profile ||
				gpu.backend !== (config.profile === "nvidia" ? "CUDA" : "ROCm") ||
				gpu.observedAt < Date.now() - LOCAL_CLIP_AVAILABILITY_TTL_MS ||
				gpu.observedAt > Date.now() + 5_000)
		)
			return { code: "GPU_UNVERIFIED", scope };
		if (readiness.data.ready && gpu)
			observeGpu?.(gpu.observedAt, readiness.data.organizationId);
		if (readiness.data.ready && captionSelection?.provider === "PLAMO") {
			if (captionSelection.identity.profile !== config.profile)
				return { code: "MODEL_MISMATCH", scope };
			const plamo = localPlamoCaptionReadinessSchema.safeParse(
				await readMetadata(
					config,
					`/readiness/plamo/${config.profile}/${captionSelection.manifestHash}`,
					deadline,
				),
			);
			if (!plamo.success || plamo.data.profile !== config.profile)
				return { code: "INVALID_RESPONSE", scope };
			if (
				plamo.data.ready &&
				(plamo.data.manifestHash !== captionSelection.manifestHash ||
					hashEditingEvidence(plamo.data.identity) !==
						hashEditingEvidence(captionSelection.identity))
			)
				return { code: "MODEL_MISMATCH", scope };
			return { code: plamo.data.code, scope };
		}
		return { code: readiness.data.code, scope };
	} catch (error) {
		return {
			code: error instanceof ProbeError ? error.code : "CONNECTION_FAILED",
			scope,
		};
	}
}
