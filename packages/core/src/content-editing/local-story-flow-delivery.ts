import { z } from "zod";
import { localStoryFlowWorkflowIdentitySchema } from "./local-story-flow-contracts";

/** Standalone shape/wire policy only. Existing delivery acceptors remain unchanged. */
export const LOCAL_STORY_FLOW_DELIVERY_HEADER_POLICY = Object.freeze({
	version: "local-story-flow-delivery-header-policy-v1",
	headerVersion: "local-story-flow-delivery-v1",
	maxWireUtf8Bytes: 32_768,
	maxStringUtf8Bytes: 32_768,
	maxNodes: 128,
	maxDepth: 8,
} as const);
const policies = [
	"aisa-local-story-hierarchical-flow-v1",
	"aisa-prepared-local-story-hierarchical-flow-v1",
] as const;
export type LocalStoryFlowDeliveryPolicy = (typeof policies)[number];
export function isLocalStoryFlowDeliveryPolicy(
	value: unknown,
): value is LocalStoryFlowDeliveryPolicy {
	return typeof value === "string" && policies.some((p) => value === p);
}
export class LocalStoryFlowDeliveryHeaderError extends Error {
	readonly code = "LOCAL_STORY_ARTIFACT_UNVERIFIED";
	constructor() {
		super("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		this.name = "LocalStoryFlowDeliveryHeaderError";
	}
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const eventId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const body = z.strictObject({
	version: z.literal("local-story-flow-delivery-v1"),
	generationTaskId: z.uuid(),
	artifactRef: z.strictObject({
		kind: z.literal("LOCAL_FLOW_PLAN_V1"),
		receiptId: z.uuid(),
		cacheHash: digest,
		inputKeyHash: digest,
		proofHash: digest,
	}),
	artifactHash: digest,
	workflow: localStoryFlowWorkflowIdentitySchema,
	sourceBindingHash: digest,
	corpusHash: digest,
	manifestHash: digest,
	treeHash: digest,
	nativeTraceHash: digest,
	structuralTraceHash: digest,
	scopeHash: digest,
	planHash: digest,
	generationPolicyFingerprint: digest,
	originalBlueprintHash: digest,
	originalSelectionHash: digest,
	originalSelectedEventIds: z
		.array(eventId)
		.min(1)
		.max(5)
		.refine((ids) => new Set(ids).size === ids.length),
	clock: z.strictObject({
		status: z.literal("LEGACY_FORWARD_COVERAGE_VALIDATED"),
		strictEventMomentOrder: z.literal("NOT_PROVEN"),
	}),
});
export type LocalStoryFlowDeliveryHeader = z.infer<typeof body>;
function requireHeader(value: unknown): asserts value {
	if (!value) throw new LocalStoryFlowDeliveryHeaderError();
}
function snapshot(input: unknown): unknown {
	let nodes = 0,
		stringBytes = 0;
	const active = new Set<object>(),
		encoder = new TextEncoder();
	const string = (value: string) => {
		requireHeader(
			value.length <=
				LOCAL_STORY_FLOW_DELIVERY_HEADER_POLICY.maxStringUtf8Bytes,
		);
		stringBytes += encoder.encode(value).length;
		requireHeader(
			stringBytes <= LOCAL_STORY_FLOW_DELIVERY_HEADER_POLICY.maxStringUtf8Bytes,
		);
		return value;
	};
	const copy = (value: unknown, depth: number): unknown => {
		requireHeader(
			++nodes <= LOCAL_STORY_FLOW_DELIVERY_HEADER_POLICY.maxNodes &&
				depth <= LOCAL_STORY_FLOW_DELIVERY_HEADER_POLICY.maxDepth,
		);
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "string") return string(value);
		if (typeof value === "number") {
			requireHeader(Number.isFinite(value));
			return value;
		}
		requireHeader(
			typeof value === "object" && value !== null && !active.has(value),
		);
		const array = Array.isArray(value);
		requireHeader(
			Object.getPrototypeOf(value) ===
				(array ? Array.prototype : Object.prototype) &&
				Object.getOwnPropertySymbols(value).length === 0,
		);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		active.add(value);
		try {
			if (array) {
				const length = descriptors.length;
				requireHeader(
					length &&
						"value" in length &&
						!length.enumerable &&
						Number.isSafeInteger(length.value) &&
						length.value >= 0 &&
						length.value <= LOCAL_STORY_FLOW_DELIVERY_HEADER_POLICY.maxNodes &&
						Object.keys(descriptors).length === length.value + 1,
				);
				return Array.from({ length: length.value }, (_, index) => {
					const d = descriptors[String(index)];
					requireHeader(d?.enumerable && "value" in d && d.value !== undefined);
					return copy(d.value, depth + 1);
				});
			}
			return Object.fromEntries(
				Object.entries(descriptors).map(([key, d]) => {
					requireHeader(d.enumerable && "value" in d && d.value !== undefined);
					return [string(key), copy(d.value, depth + 1)];
				}),
			);
		} finally {
			active.delete(value);
		}
	};
	return copy(input, 0);
}
/** Order-independent object comparison, with exact array order and field preservation. */
function sameJson(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (!left || !right || typeof left !== "object" || typeof right !== "object")
		return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	const a = left as Record<string, unknown>,
		b = right as Record<string, unknown>,
		keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
	);
}
/** Shape only, with no native/server imports or dependency on existing acceptors. */
export const localStoryFlowDeliveryHeaderSchema = z
	.unknown()
	.transform((value, ctx) => {
		try {
			const copied = snapshot(value),
				json = JSON.stringify(copied);
			requireHeader(
				typeof json === "string" &&
					new TextEncoder().encode(json).length <=
						LOCAL_STORY_FLOW_DELIVERY_HEADER_POLICY.maxWireUtf8Bytes,
			);
			const parsed = body.parse(copied);
			requireHeader(sameJson(copied, parsed));
			return parsed;
		} catch {
			ctx.addIssue({
				code: "custom",
				message: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
			});
			return z.NEVER;
		}
	});
/** Shape decoding only; this does not establish DB ownership or native/PLAN admission. */
export function parseLocalStoryFlowDeliveryHeader(
	value: unknown,
): LocalStoryFlowDeliveryHeader {
	try {
		return localStoryFlowDeliveryHeaderSchema.parse(value);
	} catch {
		throw new LocalStoryFlowDeliveryHeaderError();
	}
}
