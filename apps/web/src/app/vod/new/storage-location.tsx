"use client";

import {
	CREDENTIAL_PROVIDER_LABELS,
	type CredentialProviderId,
	type CredentialSummaryWire,
} from "@bitovp/core";
import { useState } from "react";
import { RegionSelect } from "@/components/region-select";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { NewCredentialLink } from "@/components/ui/new-credential-link";
import { useT } from "@/lib/i18n/context";
import { GCE_REGIONS } from "@/lib/infrastructure/schemas";

/**
 * Credential + location (bucket/container/host + path) for one input/output.
 *
 * Two layouts:
 * - Classic (output): an upfront credential select that also picks the storage
 *   kind. Selecting an S3 credential opens the picker (the parent wires that),
 *   now pre-scoped to that credential so it isn't re-asked.
 * - browseOwnsCredential (input files): Browse asks for credential + object in
 *   one step, so nothing is asked twice. A manual fallback (for placeholder
 *   paths) folds the credential select inline. Non-browsable kinds stay manual
 *   either way.
 * - alwaysShowCredential : keeps the credential
 *   select rendered even before anything is entered. Both halves of the old
 *   sentence here — "no upfront credential select" and "the kind is chosen per
 *   row" — became false when the source step's kind select was deleted and the
 *   credential became the only control (review-147 caught the stale doc).
 */
export function GcsRegionControl({
	idBase,
	kind,
	value,
	onChange,
}: {
	idBase: string;
	kind: string;
	value?: string;
	onChange: (region: string | undefined) => void;
}) {
	const { t } = useT();
	if (kind !== "GCS" && kind !== "GCS_SERVICE_ACCOUNT") return null;
	return (
		<details className="mt-2 text-xs text-zinc-300">
			<summary className="cursor-pointer">
				{t("wizard.gcsRegion")}
				{value ? ` · ${value}` : ""}
			</summary>
			<div className="mt-2">
				<Field
					label={t("wizard.gcsRegion")}
					htmlFor={`${idBase}-gcs-region`}
					help={t("wizard.gcsRegionHint")}
				>
					<RegionSelect
						id={`${idBase}-gcs-region`}
						value={value ?? ""}
						regions={GCE_REGIONS}
						onChange={(region) => onChange(region || undefined)}
					/>
				</Field>
			</div>
		</details>
	);
}

export function StorageLocation({
	idBase,
	credentials,
	selectable,
	browsable,
	browseOwnsCredential = false,
	showCredential = true,
	credentialLabelText,
	alwaysShowCredential = false,
	extraOptions = [],
	credentialId,
	showBucket = true,
	bucket,
	bucketLabel,
	bucketHelp,
	bucketPlaceholder,
	showPath = true,
	path,
	pathLabel,
	pathPlaceholder,
	pathHint,
	pathHelp,
	onCredentialChange,
	onChange,
	onBrowse,
}: {
	idBase: string;
	credentials: CredentialSummaryWire[];
	selectable: (provider: string) => boolean;
	/** S3 → the picker can browse it; Azure/HTTPS/SFTP are manual-only. */
	browsable: boolean;
	/** Sources layout: Browse owns credential selection (no upfront select). */
	browseOwnsCredential?: boolean;
	showCredential?: boolean;
	/* Override the credential label to name its delivery mirror and provider; repeated generic labels cannot distinguish stacked destinations. */
	credentialLabelText?: string;
	/**
	 * Render the credential select even before anything is entered. For a step
	 * where this select is the ONLY storage control, collapsing to a lone
	 * Browse button hides the choice the operator came to make.
	 */
	alwaysShowCredential?: boolean;
	/**
	 * Selectable entries that are NOT credentials — today only the source
	 * step's credential-less HTTPS input. Rendered under their own heading so
	 * the list never implies they are credentials.
	 */
	extraOptions?: { value: string; label: string }[];
	credentialId: string;
	showBucket?: boolean;
	bucket: string;
	bucketLabel: string;
	/** Click-to-open help beside the bucket label . */
	bucketHelp?: string;
	bucketPlaceholder?: string;
	showPath?: boolean;
	path: string;
	pathLabel: string;
	pathPlaceholder?: string;
	pathHint?: string;
	/** Long-form path semantics — renders as the Field's click-help (#129). */
	pathHelp?: string;
	onCredentialChange: (id: string) => void;
	onChange: (patch: { bucket?: string; path?: string }) => void;
	onBrowse: () => void;
}) {
	const { t } = useT();
	const [manual, setManual] = useState(false);
	const hasLocation = bucket !== "" || path !== "";
	const credentialed = credentialId !== "" || !showCredential;
	// A location only counts as "browsed" once a credential backs it (or the
	// kind is credential-less). Without this guard, a preset that prefills
	// bucket/path while clearing the credential would flip to the summary and
	// hide the fields the user still needs to fill in.
	const browsed = browsable && credentialed && hasLocation;
	const summary = browsed && !manual;
	// Browse-owns-credential, nothing entered yet: a single Browse button is the
	// whole control (the picker asks for the credential, once).
	// `alwaysShowCredential` opts out of the browse-only collapse. The source
	// step needs it (review-147): the storage-KIND select used to sit outside
	// this component and was the always-visible part, so deleting it left a
	// fresh row with NO storage control at all — Browse and a grey "Enter
	// manually" link, with HTTPS (and every credential) hidden behind a link
	// that reads as "type the bucket by hand".
	const browseOnly =
		browsable &&
		browseOwnsCredential &&
		!alwaysShowCredential &&
		!summary &&
		!hasLocation &&
		!manual;
	// The credential select sits upfront in the classic layout; in the
	// browse-owns layout it only appears inline as the manual fallback.
	const inlineCredential = browsable && browseOwnsCredential;
	const credentialLabel =
		credentials.find((c) => c.id === credentialId)?.label ?? credentialId;

	const credentialField = showCredential ? (
		<>
			<Field
				label={credentialLabelText ?? t("wizard.credential")}
				htmlFor={`${idBase}-cred`}
				help={
					browsable && !browseOwnsCredential
						? t("wizard.selectingAnS3CredentialOpensTheBrowser")
						: undefined
				}
			>
				<SelectNative
					id={`${idBase}-cred`}
					value={credentialId}
					onChange={(e) => {
						// Classic (upfront) select: clear manual so the location the picker
						// then resolves shows as a summary. Inline fallback: it's part of
						// manual entry, so keep the fields open.
						setManual(inlineCredential);
						onCredentialChange(e.target.value);
					}}
				>
					<option value="">{t("wizard.selectCredential")}</option>
					{credentials.map((c) => (
						<option key={c.id} value={c.id} disabled={!selectable(c.provider)}>
							{/*
							 * The provider's LABEL, not its enum. This used to read
							 * "(AKAMAI_OBJECT_STORAGE)" — a wire value shown to an
							 * operator, and not the name the credentials screen uses
							 * for the same thing.
							 *
							 * It matters more now that this select is the only
							 * storage control on the source step (owner, 2026-08-20):
							 * the kind is DERIVED from the credential, so the
							 * credential has to say what it is. Provider rather than
							 * kind on purpose — `GENERIC_S3` collapses Akamai, OCI and
							 * plain S3-compatible into one word, so the kind would
							 * tell the operator less than the provider does.
							 */}
							{c.label} (
							{CREDENTIAL_PROVIDER_LABELS[c.provider as CredentialProviderId]})
						</option>
					))}
					{extraOptions.length > 0 ? (
						<optgroup label={t("wizard.noCredentialNeeded")}>
							{extraOptions.map((o) => (
								<option key={o.value} value={o.value}>
									{o.label}
								</option>
							))}
						</optgroup>
					) : null}
				</SelectNative>
			</Field>
			<NewCredentialLink />
		</>
	) : null;

	return (
		<div className="space-y-2">
			{!inlineCredential ? credentialField : null}

			{summary ? (
				<div className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2">
					{/* min-w-0 flex-1 truncate + title: a deep object key is one
					    unbroken mono token whose min-content otherwise inflates
					    the wizard's 1fr grid track and pushes the plan-preview
					    rail off the page (UI loop 2026-08-21, measured). */}
					<span
						title={`${bucket}${path ? ` / ${path}` : ""}`}
						className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300"
					>
						<span aria-hidden="true">📁</span>{" "}
						{showCredential && credentialId ? `${credentialLabel} · ` : ""}
						{bucket}
						{path ? ` / ${path}` : ""}
					</span>
					<div className="ml-auto flex items-center gap-2">
						<Button variant="secondary" size="sm" onClick={onBrowse}>
							{t("wizard.change")}
						</Button>
						<button
							type="button"
							className="text-xs text-zinc-500 underline hover:text-zinc-300"
							onClick={() => setManual(true)}
						>
							{t("wizard.enterManually")}
						</button>
					</div>
				</div>
			) : browseOnly ? (
				<div className="flex items-center gap-2">
					<Button variant="secondary" size="sm" onClick={onBrowse}>
						{t("wizard.browseStorage")}
					</Button>
					<button
						type="button"
						className="text-xs text-zinc-500 underline hover:text-zinc-300"
						onClick={() => setManual(true)}
					>
						{t("wizard.enterManually")}
					</button>
				</div>
			) : (
				<>
					{inlineCredential ? credentialField : null}
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						{showBucket ? (
							<Field
								label={bucketLabel}
								htmlFor={`${idBase}-bucket`}
								help={bucketHelp}
							>
								<Input
									id={`${idBase}-bucket`}
									placeholder={bucketPlaceholder}
									value={bucket}
									onChange={(e) => {
										setManual(true);
										onChange({ bucket: e.target.value });
									}}
								/>
							</Field>
						) : null}
						{showPath ? (
							<Field
								label={pathLabel}
								htmlFor={`${idBase}-path`}
								hint={pathHint}
								help={pathHelp}
							>
								<Input
									id={`${idBase}-path`}
									placeholder={pathPlaceholder}
									value={path}
									onChange={(e) => {
										setManual(true);
										onChange({ path: e.target.value });
									}}
								/>
							</Field>
						) : null}
					</div>
					{browsable ? (
						<div className="flex items-center gap-2">
							<Button variant="secondary" size="sm" onClick={onBrowse}>
								{t("wizard.browseStorage")}
							</Button>
							{hasLocation ? (
								<button
									type="button"
									className="text-xs text-zinc-500 underline hover:text-zinc-300"
									onClick={() => setManual(false)}
								>
									{t("wizard.showSummary")}
								</button>
							) : null}
						</div>
					) : null}
				</>
			)}
		</div>
	);
}
