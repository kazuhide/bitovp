import {
	createLocalStoryLegacyLedgerCacheRecipe,
	LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY,
	type LocalStoryLegacyLedgerCacheOptions,
	LocalStoryLegacyLedgerError,
	type LocalStoryLegacyLedgerExpected,
} from "@bitovp/core/local-story-flow-server";
import { MediaOperationError } from "./process";

/** The policy values and old keys are unchanged; shared code performs their pure validation. */
export const LOCAL_STORY_LEDGER_VALIDATION_POLICY =
	LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY.validationPolicyVersions.V4;
export const LOCAL_STORY_LEGACY_V3_LEDGER_VALIDATION_POLICY =
	LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY.validationPolicyVersions.V3;
export const LOCAL_STORY_LEGACY_V2_LEDGER_VALIDATION_POLICY =
	LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY.validationPolicyVersions.V2;
export const LOCAL_STORY_LEGACY_LEDGER_VALIDATION_POLICY =
	LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY.validationPolicyVersions.V1;

type LedgerCacheOptions = LocalStoryLegacyLedgerExpected & {
	validationPolicyVersion: string;
};
function legacy<T>(work: () => T): T {
	try {
		return work();
	} catch (error) {
		if (error instanceof LocalStoryLegacyLedgerError)
			throw new MediaOperationError(error.code);
		throw error;
	}
}
function cache(options: LocalStoryLegacyLedgerCacheOptions) {
	const recipe = legacy(() => createLocalStoryLegacyLedgerCacheRecipe(options));
	return {
		key: recipe.key,
		stageInput: recipe.stageInput,
		parse: (value: unknown) => legacy(() => recipe.parse(value)),
		pointer: (prompt: string) => legacy(() => recipe.pointer(prompt)),
	};
}
/** The pointer still requires a cache-only stage read and current source validation. */
export function createLocalStoryLedgerCache(options: LedgerCacheOptions) {
	return cache({ ...options, version: "V4" });
}
export function createLegacyV3LocalStoryLedgerCache(
	options: Omit<LedgerCacheOptions, "validationPolicyVersion">,
) {
	return cache({ ...options, version: "V3" });
}
export function createLegacyV2LocalStoryLedgerCache(
	options: Omit<LedgerCacheOptions, "validationPolicyVersion">,
) {
	return cache({ ...options, version: "V2" });
}
export function createLegacyLocalStoryLedgerCache(
	options: Omit<LedgerCacheOptions, "validationPolicyVersion">,
) {
	return cache({ ...options, version: "V1" });
}
