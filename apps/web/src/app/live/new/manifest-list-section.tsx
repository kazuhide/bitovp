"use client";

import { outputStorageKeys, planOutputSchema } from "@bitovp/core";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import {
	buildLiveChannelPlan,
	type LiveHlsManifestState,
	type LiveWizardState,
	liveManifestDestination,
} from "./build-live-plan";
import { addLiveManifest } from "./live-output-actions";
import { liveMirrorEntries, liveOutputEntries } from "./live-output-model";
import { LiveManifestsSection } from "./manifests-section";

type Identity = Pick<LiveHlsManifestState, "name" | "destination">;

function manifestOutputEntries(state: LiveWizardState) {
	const plan = buildLiveChannelPlan(state);
	const outputs = plan.outputs.flatMap((output) => {
		const parsed = planOutputSchema.safeParse(output);
		return parsed.success ? [parsed.data] : [];
	});
	const delivery = { outputs, deliveryMirrors: plan.deliveryMirrors };
	const mediaTargets = outputStorageKeys(delivery, "origin");
	const mirrors = new Set(liveMirrorEntries(state).map((entry) => entry.key));
	// Wizard-authored segmented media shares origin and the delivery mirrors.
	return liveOutputEntries(state).filter(
		(entry) =>
			entry.key === "origin" ||
			mirrors.has(entry.key) ||
			(outputs.some((output) => output.key === entry.key) &&
				[...outputStorageKeys(delivery, entry.key)].every((target) =>
					mediaTargets.has(target),
				)),
	);
}

function ManifestDestination({
	state,
	outputEntries,
	value,
	prefix,
	onPatch,
}: {
	state: LiveWizardState;
	outputEntries: ReturnType<typeof liveOutputEntries>;
	value: Identity;
	prefix: string;
	onPatch: (patch: Partial<Identity>) => void;
}) {
	const { t } = useT();
	const destination = value.destination ?? liveManifestDestination(state);
	const patchDestination = (patch: Partial<typeof destination>) =>
		onPatch({ destination: { ...destination, ...patch } });
	return (
		<div className="grid gap-3 sm:grid-cols-2">
			<Field label={t("liveOutputs.resourceName")} htmlFor={`${prefix}-name`}>
				<Input
					id={`${prefix}-name`}
					value={value.name ?? ""}
					onChange={(e) => onPatch({ name: e.target.value })}
				/>
			</Field>
			<Field
				label={t("liveOutputs.destination")}
				htmlFor={`${prefix}-destination`}
			>
				<SelectNative
					id={`${prefix}-destination`}
					value={destination.outputKey}
					onChange={(e) => patchDestination({ outputKey: e.target.value })}
				>
					{!outputEntries.some(
						(entry) => entry.key === destination.outputKey,
					) ? (
						<option value={destination.outputKey} disabled>
							{t("liveArchive.unavailableDestination")} ({destination.outputKey}
							)
						</option>
					) : null}
					{outputEntries.map((entry) => (
						<option key={entry.key} value={entry.key}>
							{entry.output.name ||
								(entry.key === "origin"
									? t("liveArchive.originStorage")
									: entry.key)}
						</option>
					))}
				</SelectNative>
			</Field>
			<Field label={t("liveOutputs.path")} htmlFor={`${prefix}-path`}>
				<Input
					id={`${prefix}-path`}
					value={destination.path}
					onChange={(e) => patchDestination({ path: e.target.value })}
				/>
			</Field>
			<Field label={t("liveOutputs.access")} htmlFor={`${prefix}-access`}>
				<SelectNative
					id={`${prefix}-access`}
					value={destination.acl ?? ""}
					onChange={(e) =>
						patchDestination({
							acl:
								e.target.value === "PRIVATE" || e.target.value === "PUBLIC_READ"
									? e.target.value
									: undefined,
						})
					}
				>
					<option value="">{t("liveArchive.destinationDefault")}</option>
					<option value="PRIVATE">{t("liveArchive.private")}</option>
					<option value="PUBLIC_READ">{t("liveArchive.publicRead")}</option>
				</SelectNative>
			</Field>
		</div>
	);
}

export function LiveManifestListSection({
	state,
	onPatch,
}: {
	state: LiveWizardState;
	onPatch: (patch: Partial<LiveWizardState>) => void;
}) {
	const { t } = useT();
	const outputEntries = manifestOutputEntries(state);
	return (
		<div className="space-y-4">
			<LiveManifestsSection state={state} onPatch={onPatch} />
			{(["HLS", "DASH"] as const).map((kind) => {
				const primary =
					kind === "HLS" ? state.manifests.hls : state.manifests.dash;
				return primary.enabled ? (
					<details
						key={kind}
						className="space-y-3 rounded-md border border-zinc-800 p-3"
					>
						<summary className="cursor-pointer text-sm">
							{t("liveOutputs.primaryDestination", { kind })}
						</summary>
						<ManifestDestination
							state={state}
							outputEntries={outputEntries}
							value={primary}
							prefix={`lw-${kind}-destination`}
							onPatch={(patch) =>
								onPatch({
									manifests: {
										...state.manifests,
										[kind === "HLS" ? "hls" : "dash"]: { ...primary, ...patch },
									},
								})
							}
						/>
					</details>
				) : null;
			})}
			{(["HLS", "DASH"] as const).map((kind) => {
				const property = kind === "HLS" ? "additionalHls" : "additionalDash";
				const entries = state.manifests[property] ?? [];
				return (
					<div key={kind} className="space-y-3">
						{entries.map((entry, index) => {
							const key = entry.key ?? `${kind}-${index + 2}`;
							const prefix = `lw-manifest-${key}`;
							const replace = (patch: Partial<typeof entry>) =>
								onPatch({
									manifests: {
										...state.manifests,
										[property]: entries.map((candidate) =>
											candidate === entry
												? { ...candidate, ...patch }
												: candidate,
										),
									},
								});
							return (
								<section
									key={key}
									aria-label={t("liveOutputs.manifestNumber", {
										kind,
										number: index + 2,
									})}
									className="space-y-3 rounded-md border border-zinc-800 p-3"
								>
									<div className="flex items-center justify-between gap-2">
										<h3 className="font-medium text-sm">
											{entry.name ||
												t("liveOutputs.manifestNumber", {
													kind,
													number: index + 2,
												})}
										</h3>
										<Button
											variant="ghost"
											size="sm"
											onClick={() =>
												onPatch({
													manifests: {
														...state.manifests,
														[property]: entries.filter(
															(candidate) => candidate !== entry,
														),
													},
												})
											}
										>
											{t(
												kind === "HLS"
													? "liveOutputs.removeHls"
													: "liveOutputs.removeDash",
											)}
										</Button>
									</div>
									<ManifestDestination
										state={state}
										outputEntries={outputEntries}
										value={entry}
										prefix={prefix}
										onPatch={replace}
									/>
									<LiveManifestsSection
										state={{
											...state,
											manifests: {
												...state.manifests,
												[kind === "HLS" ? "hls" : "dash"]: entry,
											},
										}}
										manifestKind={kind}
										idPrefix={prefix}
										onPatch={(patch) => {
											const next =
												kind === "HLS"
													? patch.manifests?.hls
													: patch.manifests?.dash;
											if (next) replace(next);
										}}
									/>
								</section>
							);
						})}
						<Button
							variant="secondary"
							size="sm"
							onClick={() => onPatch(addLiveManifest(state, kind))}
						>
							{t(kind === "HLS" ? "liveOutputs.addHls" : "liveOutputs.addDash")}
						</Button>
					</div>
				);
			})}
		</div>
	);
}
