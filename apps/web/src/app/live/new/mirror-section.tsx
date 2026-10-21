"use client";

import type { CredentialSummaryWire } from "@bitovp/core";
import { useState } from "react";
import {
	BROWSABLE_STORAGE_PROVIDERS,
	liveOutputKindForProvider,
	outputKindIsBrowsable,
} from "@/app/vod/new/stream-model";
import { StoragePicker } from "@/components/storage-picker";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input, SelectNative } from "@/components/ui/input";
import { NewCredentialLink } from "@/components/ui/new-credential-link";
import { useT } from "@/lib/i18n/context";
import {
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "./build-live-plan";
import { liveMirrorProblem, liveStorageKind } from "./mirror-model";

export function LiveMirrorSection({
	state,
	credentials,
	onPatch,
	idPrefix = "lw-mirror",
	title,
	disableRemoval = false,
	onRemove,
}: {
	state: LiveWizardState;
	credentials: Pick<CredentialSummaryWire, "id" | "label" | "provider">[];
	onPatch: (patch: Partial<LiveWizardState>) => void;
	idPrefix?: string;
	title?: string;
	disableRemoval?: boolean;
	onRemove?: () => void;
}) {
	const { t } = useT();
	const mirror = state.mirror;
	//  (owner): the bucket is picked in the same storage browser the
	// primary output uses. The mirror writes the primary's paths and ACL
	// (liveMirror.help), so only credential, kind and bucket are taken.
	const [browse, setBrowse] = useState(false);
	const choices = credentials.filter((c) =>
		liveStorageKind(liveOutputKindForProvider(c.provider)),
	);
	const available =
		mirror &&
		choices.some(
			(c) =>
				c.id === mirror.credentialId &&
				liveOutputKindForProvider(c.provider) === mirror.kind,
		);
	const problem = liveMirrorProblem(state, credentials);
	return (
		<section
			aria-label={title ?? t("liveMirror.title")}
			className="space-y-3 border-zinc-800 border-t pt-4"
		>
			<div className="flex items-center gap-2">
				<label
					htmlFor={`${idPrefix}-enabled`}
					className="flex items-center gap-2 text-sm text-zinc-300"
				>
					<input
						id={`${idPrefix}-enabled`}
						type="checkbox"
						className="h-4 w-4 accent-emerald-600"
						checked={!!mirror}
						disabled={!!mirror && disableRemoval}
						onChange={(e) =>
							onPatch({
								mirror: e.target.checked
									? { ...DEFAULT_LIVE_WIZARD_STATE.output, basePath: "" }
									: undefined,
							})
						}
					/>
					{t("liveMirror.enable")}
				</label>
				<HelpOverlay labelFor={t("liveMirror.enable")}>
					{t("liveMirror.help")}
				</HelpOverlay>
			</div>
			{disableRemoval ? (
				<p className="text-xs text-zinc-400">{t("liveOutputs.referenced")}</p>
			) : null}
			{mirror ? (
				<>
					<div className="grid gap-3 sm:grid-cols-2">
						{/* The link sits UNDER the select, as the primary output's does:
						    in Field's trailing slot its width squeezed the select to a
						    bare chevron on ordinary widths (browser walk, 2026-09-11). */}
						<div className="space-y-1.5">
							<Field
								label={t("liveArchive.credential")}
								htmlFor={`${idPrefix}-credential`}
							>
								<SelectNative
									id={`${idPrefix}-credential`}
									value={mirror.credentialId}
									onChange={(e) => {
										if (!e.target.value) {
											onPatch({ mirror: { ...mirror, credentialId: "" } });
											return;
										}
										const kind = liveOutputKindForProvider(
											choices.find((c) => c.id === e.target.value)?.provider,
										);
										if (kind && liveStorageKind(kind))
											onPatch({
												mirror: {
													...mirror,
													kind,
													credentialId: e.target.value,
													bucket: "",
												},
											});
									}}
								>
									<option value="">{t("ui.selectCredential")}</option>
									{mirror.credentialId && !available ? (
										<option value={mirror.credentialId}>
											{t("liveMirror.unavailable")}
										</option>
									) : null}
									{choices.map((c) => (
										<option key={c.id} value={c.id}>
											{c.label}
										</option>
									))}
								</SelectNative>
							</Field>
							<NewCredentialLink />
						</div>
						<Field
							label={
								mirror.kind === "AZURE" ? t("ui.container") : t("ui.bucket")
							}
							htmlFor={`${idPrefix}-bucket`}
						>
							<div className="flex gap-2">
								<Input
									id={`${idPrefix}-bucket`}
									value={mirror.bucket}
									onChange={(e) =>
										onPatch({ mirror: { ...mirror, bucket: e.target.value } })
									}
								/>
								{mirror.kind !== "AKAMAI_MSL" &&
								outputKindIsBrowsable(mirror.kind) ? (
									<Button
										variant="secondary"
										size="sm"
										onClick={() => setBrowse(true)}
									>
										{t("ui.browse")}
									</Button>
								) : null}
							</div>
						</Field>
					</div>
					<Field
						label={t("liveOutputs.resourceName")}
						htmlFor={`${idPrefix}-name`}
					>
						<Input
							id={`${idPrefix}-name`}
							value={mirror.name}
							onChange={(e) =>
								onPatch({ mirror: { ...mirror, name: e.target.value } })
							}
						/>
					</Field>
					<StoragePicker
						open={browse}
						mode="prefix"
						providers={[...BROWSABLE_STORAGE_PROVIDERS]}
						initialCredentialId={mirror.credentialId}
						initialBucket={mirror.bucket}
						onClose={() => setBrowse(false)}
						onSelect={({ credentialId, bucket }) => {
							// The kind follows the SELECTED credential (never a
							// hard-coded S3), exactly as the primary output's picker.
							const kind = liveOutputKindForProvider(
								credentials.find((c) => c.id === credentialId)?.provider,
							);
							if (kind && liveStorageKind(kind)) {
								onPatch({ mirror: { ...mirror, kind, credentialId, bucket } });
							}
							setBrowse(false);
						}}
					/>
					{problem ? (
						<p role="alert" className="text-xs text-amber-400">
							{t(problem)}
						</p>
					) : null}
				</>
			) : null}
			{onRemove ? (
				<Button
					variant="ghost"
					size="sm"
					disabled={disableRemoval}
					onClick={onRemove}
				>
					{t("liveOutputs.removeMirror")}
				</Button>
			) : null}
		</section>
	);
}
