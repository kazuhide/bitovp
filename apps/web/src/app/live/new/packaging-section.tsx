"use client";

import type { CredentialSummaryWire } from "@bitovp/core";
import { LiveArchiveSection } from "./archive-section";
import type { LiveWizardState } from "./build-live-plan";
import { LiveMuxingsSection } from "./muxings-section";

export function LivePackagingSection({
	state,
	credentials,
	onPatch,
}: {
	state: LiveWizardState;
	credentials: CredentialSummaryWire[];
	onPatch: (partial: Partial<LiveWizardState>) => void;
}) {
	return (
		<div className="space-y-6">
			<LiveMuxingsSection
				state={state}
				credentials={credentials}
				onPatch={onPatch}
			/>
			<LiveArchiveSection
				state={state}
				credentials={credentials}
				onPatch={onPatch}
			/>
		</div>
	);
}
