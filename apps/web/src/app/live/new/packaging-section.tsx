"use client";

import type { CredentialSummaryWire } from "@bitovp/core";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { LiveArchiveSection } from "./archive-section";
import type { LiveWizardState } from "./build-live-plan";
import { LiveEncryptionSection } from "./encryption-section";

export function LivePackagingSection({
	state,
	credentials,
	onPatch,
}: {
	state: LiveWizardState;
	credentials: CredentialSummaryWire[];
	onPatch: (partial: Partial<LiveWizardState>) => void;
}) {
	const { t } = useT();
	return (
		<div className="space-y-6">
			<Field
				label={t("wizard.segmentLengthS")}
				htmlFor="lw-seglen"
				help={t("ui.sharedByEveryMuxingFeedsTheC8")}
			>
				<Input
					id="lw-seglen"
					type="number"
					className="w-32"
					value={state.segmentLength}
					onChange={(event) =>
						onPatch({ segmentLength: Math.max(0, Number(event.target.value)) })
					}
				/>
			</Field>
			<LiveEncryptionSection
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
