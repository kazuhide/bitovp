import type { LocalStoryFlowTaskPolicyParts } from "../content-production/local-story-workflow";
import { mediaTaskIdentitySchema } from "../content-production/schema";
import { canonicalEditingJson } from "./automatic-binding";
import { validateLocalStoryFlowWorkflowIdentityForModelPin } from "./local-story-flow-stages";

export type LocalStoryFlowTaskPolicyPartName = Exclude<
	keyof LocalStoryFlowTaskPolicyParts,
	"version"
>;
export type LocalStoryFlowPolicyCatalogResolution =
	| {
			status: "SUPPORTED";
			catalogVersion: "local-story-flow-policy-catalog-v1";
			policies: Readonly<LocalStoryFlowTaskPolicyParts>;
			generationPolicyFingerprint: string;
	  }
	| {
			status: "UNAVAILABLE";
			missing: readonly LocalStoryFlowTaskPolicyPartName[];
	  };
export class LocalStoryFlowPolicyCatalogError extends Error {
	readonly code = "LOCAL_STORY_ARTIFACT_UNVERIFIED";
	constructor() {
		super("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		this.name = "LocalStoryFlowPolicyCatalogError";
	}
}
function requireCatalog(value: unknown): asserts value {
	if (!value) throw new LocalStoryFlowPolicyCatalogError();
}
/** Actual full engine/publication/terminal/delivery integration does not exist yet. */
export function getCompiledLocalStoryFlowPolicyCatalog(): LocalStoryFlowPolicyCatalogResolution {
	return Object.freeze({
		status: "UNAVAILABLE",
		missing: Object.freeze([
			"engineValidationPolicyHash",
			"deliveryPolicyHash",
		] as const),
	});
}
function identityData(input: unknown): unknown {
	let nodes = 0,
		bytes = 0;
	const active = new Set<object>(),
		encoder = new TextEncoder();
	const text = (value: string) => {
		requireCatalog(value.length <= 65_536);
		bytes += encoder.encode(value).length;
		requireCatalog(bytes <= 65_536);
		return value;
	};
	const copy = (value: unknown, depth: number): unknown => {
		requireCatalog(++nodes <= 512 && depth <= 16);
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "string") return text(value);
		if (typeof value === "number") {
			requireCatalog(Number.isFinite(value));
			return value;
		}
		requireCatalog(
			typeof value === "object" && value !== null && !active.has(value),
		);
		const array = Array.isArray(value);
		requireCatalog(
			Object.getPrototypeOf(value) ===
				(array ? Array.prototype : Object.prototype) &&
				Object.getOwnPropertySymbols(value).length === 0,
		);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		active.add(value);
		try {
			if (array) {
				const length = descriptors.length;
				requireCatalog(
					length &&
						"value" in length &&
						!length.enumerable &&
						Number.isSafeInteger(length.value) &&
						length.value >= 0 &&
						length.value <= 512 &&
						Object.keys(descriptors).length === length.value + 1,
				);
				return Array.from({ length: length.value }, (_, index) => {
					const d = descriptors[String(index)];
					requireCatalog(
						d?.enumerable && "value" in d && d.value !== undefined,
					);
					return copy(d.value, depth + 1);
				});
			}
			return Object.fromEntries(
				Object.entries(descriptors).map(([key, d]) => {
					requireCatalog(d.enumerable && "value" in d && d.value !== undefined);
					return [text(key), copy(d.value, depth + 1)];
				}),
			);
		} finally {
			active.delete(value);
		}
	};
	return copy(input, 0);
}
/** Original task pin only; never START/PLAN parts, current connection or caller policy overrides. */
export function resolveLocalStoryFlowPolicyCatalogForTaskIdentity(
	taskIdentity: unknown,
): LocalStoryFlowPolicyCatalogResolution {
	try {
		const copied = identityData(taskIdentity),
			identity = mediaTaskIdentitySchema.parse(copied);
		requireCatalog(
			canonicalEditingJson(identity) === canonicalEditingJson(copied),
		);
		requireCatalog(
			identity.localStoryModel &&
				identity.localStoryWorkflow &&
				identity.generationPolicyFingerprint,
		);
		requireCatalog(
			canonicalEditingJson(identity.localStoryModel) ===
				canonicalEditingJson(identity.localStoryWorkflow.baseModel),
		);
		validateLocalStoryFlowWorkflowIdentityForModelPin(
			identity.localStoryWorkflow,
			{
				profile: identity.localStoryModel.profile,
				configId: identity.localStoryModel.configId,
			},
			"FLOW",
		);
	} catch {
		throw new LocalStoryFlowPolicyCatalogError();
	}
	// Zero actually complete versions are registered. Missing latest parts do
	// not recognize any original fingerprint. A future real registration must
	// supply that version's actual parts and validator, independent of latest.
	throw new LocalStoryFlowPolicyCatalogError();
}
