"use client";

import { DEFAULT_FEATURE_FLAGS, type FeatureFlags } from "@bitovp/core";
import { createContext, type ReactNode, useContext } from "react";

/**
 * : the flags are resolved on the SERVER (root layout) and handed
 * down, so the nav never flashes a QC entry that then disappears and no client
 * fetch waterfall stands between a page and knowing what exists.
 *
 * The default value is the same DEFAULT_FEATURE_FLAGS the server falls back to,
 * which makes a component rendered outside the provider (a unit test, a
 * storybook-style harness) behave like a fresh deployment rather than throw.
 */
const FeatureFlagsContext = createContext<FeatureFlags>(DEFAULT_FEATURE_FLAGS);

export function FeatureFlagsProvider({
	flags,
	children,
}: {
	flags: FeatureFlags;
	children: ReactNode;
}) {
	return (
		<FeatureFlagsContext.Provider value={flags}>
			{children}
		</FeatureFlagsContext.Provider>
	);
}

export function useFeatureFlags(): FeatureFlags {
	return useContext(FeatureFlagsContext);
}

/** Sugar for the one flag every QC surface asks about. */
export function useQcVmafEnabled(): boolean {
	return useFeatureFlags().qcVmaf;
}
