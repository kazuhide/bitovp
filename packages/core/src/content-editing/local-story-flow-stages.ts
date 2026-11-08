import { z } from "zod";
import { canonicalEditingJson } from "./automatic-binding";
import type { LocalSemanticConfiguration } from "./local-semantic-config";
import {
	localSemanticStageRegistry,
	localStoryIdentityForConfiguration,
	localStoryIdentityForModelPin,
	localStoryStageRegistry,
} from "./local-semantic-stages";
import type { LocalStoryModelIdentity } from "./local-story-contracts";
import {
	LOCAL_STORY_FLOW_CONTEXT_PROMPT_VERSION,
	LOCAL_STORY_FLOW_H1_POLICY,
	LOCAL_STORY_FLOW_ROUTE_PROMPT_VERSION,
	localStoryFlowContextOutputSchema,
	localStoryFlowRouteOutputSchema,
	localStoryFlowWorkflowIdentitySchema,
} from "./local-story-flow-contracts";
import { hashEditingEvidence } from "./verify-automatic-binding";

/** Separate FLOW metadata; transport expansion preserves legacy registries and model identity. */
export function localStoryFlowStageRegistry() {
	const entry = (
		definition: z.ZodType,
		promptVersion:
			| typeof LOCAL_STORY_FLOW_CONTEXT_PROMPT_VERSION
			| typeof LOCAL_STORY_FLOW_ROUTE_PROMPT_VERSION,
	) => {
		const schema = z.toJSONSchema(definition);
		return {
			promptVersion,
			schemaHash: hashEditingEvidence(schema),
			schema,
			maxOutputTokens:
				LOCAL_STORY_FLOW_H1_POLICY.leafPageLimits.maxOutputTokens,
		};
	};
	return {
		version: "local-story-flow-stages-v1" as const,
		stages: {
			LOCAL_FLOW_CONTEXT_V1: entry(
				localStoryFlowContextOutputSchema,
				LOCAL_STORY_FLOW_CONTEXT_PROMPT_VERSION,
			),
			LOCAL_FLOW_ROUTE_V1: entry(
				localStoryFlowRouteOutputSchema,
				LOCAL_STORY_FLOW_ROUTE_PROMPT_VERSION,
			),
		},
	};
}

export function localSemanticCombinedStageRegistry() {
	const legacy = localSemanticStageRegistry(),
		flow = localStoryFlowStageRegistry();
	if (
		Object.keys(flow.stages).some((name) => Object.hasOwn(legacy.stages, name))
	)
		throw new Error("LOCAL_STORY_FLOW_REGISTRY_INVALID");
	return {
		version: "bitovp-semantic-stages-combined-v1" as const,
		legacyRegistryHash: hashEditingEvidence(legacy),
		flowRegistryHash: hashEditingEvidence(flow),
		stages: structuredClone({ ...legacy.stages, ...flow.stages }),
	};
}

/** No source, result, or ROOT commitment is needed to construct this workflow identity. */
export function localStoryFlowIdentityForConfiguration(
	config: LocalSemanticConfiguration,
	mode: "FLOW",
) {
	return workflowIdentity(localStoryIdentityForConfiguration(config), mode);
}

export function localStoryFlowIdentityForModelPin(pin: unknown, mode: "FLOW") {
	return workflowIdentity(localStoryIdentityForModelPin(pin), mode);
}

function workflowIdentity(baseModel: LocalStoryModelIdentity, mode: "FLOW") {
	return localStoryFlowWorkflowIdentitySchema.parse({
		version: "local-story-flow-workflow-v1",
		mode,
		baseModel,
		legacyStoryRegistryHash: hashEditingEvidence(localStoryStageRegistry()),
		legacySemanticRegistryHash: hashEditingEvidence(
			localSemanticStageRegistry(),
		),
		flowRegistryHash: hashEditingEvidence(localStoryFlowStageRegistry()),
		policyHash: hashEditingEvidence(LOCAL_STORY_FLOW_H1_POLICY),
	});
}

const jsonObject = (value: unknown): value is Record<string, unknown> =>
	value !== null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	Object.getPrototypeOf(value) === Object.prototype &&
	Object.getOwnPropertySymbols(value).length === 0 &&
	Object.getOwnPropertyNames(value).length === Object.keys(value).length;

export function validateLocalStoryFlowWorkflowIdentity(
	value: unknown,
	config: LocalSemanticConfiguration,
	mode: "FLOW",
) {
	return validateWorkflowIdentity(value, () =>
		localStoryFlowIdentityForConfiguration(config, mode),
	);
}

export function validateLocalStoryFlowWorkflowIdentityForModelPin(
	value: unknown,
	pin: unknown,
	mode: "FLOW",
) {
	try {
		const workflow = workflowIdentityData(value),
			modelPin = workflowIdentityData(pin);
		return validateWorkflowIdentity(workflow, () =>
			localStoryFlowIdentityForModelPin(modelPin, mode),
		);
	} catch {
		throw new Error("LOCAL_STORY_FLOW_IDENTITY_INVALID");
	}
}

/** Inspect both unknown inputs before schema parsing; never invoke data accessors. */
function workflowIdentityData(input: unknown): unknown {
	let nodes = 0,
		bytes = 0;
	const active = new Set<object>(),
		encoder = new TextEncoder();
	const invalid = (): never => {
		throw new Error("LOCAL_STORY_FLOW_IDENTITY_INVALID");
	};
	const string = (value: string) => {
		if (value.length > 4096) invalid();
		bytes += encoder.encode(value).length;
		if (bytes > 16_384) invalid();
		return value;
	};
	const copy = (value: unknown, depth: number): unknown => {
		if (++nodes > 128 || depth > 8) invalid();
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "string") return string(value);
		if (typeof value === "number")
			return Number.isFinite(value) ? value : invalid();
		if (typeof value !== "object" || active.has(value)) return invalid();
		const array = Array.isArray(value);
		if (
			Object.getPrototypeOf(value) !==
				(array ? Array.prototype : Object.prototype) ||
			Object.getOwnPropertySymbols(value).length
		)
			invalid();
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Object.keys(descriptors).length > 129) invalid();
		active.add(value);
		const data = (descriptor: PropertyDescriptor | undefined) => {
			if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
			return copy(descriptor.value, depth + 1);
		};
		try {
			if (array) {
				const length = descriptors.length?.value;
				if (
					!Number.isSafeInteger(length) ||
					length < 0 ||
					length > 128 ||
					Object.keys(descriptors).length !== length + 1
				)
					invalid();
				return Array.from({ length }, (_, i) => data(descriptors[String(i)]));
			}
			return Object.fromEntries(
				Object.entries(descriptors).map(([key, descriptor]) => [
					string(key),
					data(descriptor),
				]),
			);
		} finally {
			active.delete(value);
		}
	};
	return copy(input, 0);
}

function validateWorkflowIdentity(
	value: unknown,
	expectedIdentity: () => ReturnType<
		typeof localStoryFlowIdentityForConfiguration
	>,
) {
	if (!jsonObject(value) || !jsonObject(value.baseModel))
		throw new Error("LOCAL_STORY_FLOW_IDENTITY_INVALID");
	const parsed = localStoryFlowWorkflowIdentitySchema.safeParse(value),
		expected = expectedIdentity();
	if (
		!parsed.success ||
		canonicalEditingJson(parsed.data) !== canonicalEditingJson(expected)
	)
		throw new Error("LOCAL_STORY_FLOW_IDENTITY_INVALID");
	return structuredClone(parsed.data);
}
