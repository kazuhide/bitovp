"use client";

import type { CredentialSummaryWire } from "@bitovp/core";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";
import type { LiveWizardState } from "./build-live-plan";
import { addLiveMirror } from "./live-output-actions";
import { liveMirrorEntries, liveOutputReferenced } from "./live-output-model";
import { LiveMirrorSection } from "./mirror-section";

export function LiveMirrorListSection({
	state,
	credentials,
	onPatch,
}: {
	state: LiveWizardState;
	credentials: Pick<CredentialSummaryWire, "id" | "label" | "provider">[];
	onPatch: (patch: Partial<LiveWizardState>) => void;
}) {
	const { t } = useT();
	return (
		<div className="space-y-3">
			<LiveMirrorSection
				state={state}
				credentials={credentials}
				onPatch={onPatch}
				disableRemoval={liveOutputReferenced(
					state,
					state.mirrorKey ?? "mirror-1",
				)}
			/>
			{(state.additionalMirrors ?? []).map((entry, index) => {
				const referenced = liveOutputReferenced(state, entry.key);
				const remove = () =>
					onPatch({
						additionalMirrors: state.additionalMirrors?.filter(
							(candidate) => candidate.key !== entry.key,
						),
					});
				return (
					<div key={entry.key}>
						<LiveMirrorSection
							state={{
								...state,
								mirror: entry.output,
								additionalMirrors: undefined,
							}}
							credentials={credentials}
							idPrefix={`lw-extra-mirror-${entry.key}`}
							title={t("liveOutputs.mirrorNumber", { number: index + 2 })}
							disableRemoval={referenced}
							onRemove={remove}
							onPatch={(patch) => {
								const mirror = patch.mirror;
								if (!mirror) return remove();
								onPatch({
									additionalMirrors: state.additionalMirrors?.map(
										(candidate) =>
											candidate.key === entry.key
												? { ...candidate, output: mirror }
												: candidate,
									),
								});
							}}
						/>
					</div>
				);
			})}
			{liveMirrorEntries(state).length ? (
				<Button
					variant="secondary"
					size="sm"
					onClick={() => onPatch(addLiveMirror(state))}
				>
					{t("liveOutputs.addMirror")}
				</Button>
			) : null}
		</div>
	);
}
