"use client";

import type { CredentialSummaryWire } from "@bitovp/core";
import { useState } from "react";
import { CopyableId } from "@/components/copyable-id";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailPopover } from "@/components/ui/detail-popover";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import {
	collectCredentialRefs,
	collectPlaceholders,
	countPendingPlaceholders,
	type ImportedPlan,
	isPlaceholderCredentialId,
	listStorageRefs,
	parseImportedPlan,
	replaceCredentialId,
	replacePlaceholder,
	withStorageLocation,
} from "./plan-import";

/**
 * "Before you start" checklist for a loaded sample preset. Golden plans
 * carry placeholder vault UUIDs, sample buckets and <INSERT_*>/{YOUR *}
 * paths — this panel swaps them in place (every edit re-runs the import
 * parser so the validation rail and previews stay truthful). Submission
 * remains gated by the existing validation + account selection below.
 */
export function PresetChecklist({
	imported,
	credentials,
	onUpdate,
}: {
	imported: ImportedPlan;
	credentials: CredentialSummaryWire[];
	onUpdate: (next: ImportedPlan) => void;
}) {
	const { t } = useT();
	const raw = imported.raw;
	const credentialRefs = collectCredentialRefs(raw);
	const placeholders = collectPlaceholders(raw);
	const storageRefs = listStorageRefs(raw);
	// Same count that gates the Start button — badge and gate never disagree.
	const pending = countPendingPlaceholders(raw);
	const ready = pending === 0;

	const apply = (next: Record<string, unknown>) => {
		const result = parseImportedPlan(JSON.stringify(next), t);
		if (result.ok) {
			onUpdate(result.imported);
		}
	};

	return (
		<section
			aria-label={t("wizard.presetChecklist")}
			className="space-y-4 rounded-lg border border-amber-900/60 bg-zinc-950 p-4"
		>
			<div className="flex items-center gap-2">
				<div className="flex items-center gap-2">
					<h2 className="font-medium text-sm text-zinc-200">
						{t("wizard.beforeYouStartPresetChecklist")}
					</h2>
					<HelpOverlay labelFor={t("wizard.beforeYouStartPresetChecklist")}>
						{t("wizard.presetsAreThePythonSampleGoldenPlans")}
					</HelpOverlay>
				</div>
				{ready ? (
					<Badge tone="ok">{t("wizard.placeholdersResolved")}</Badge>
				) : (
					<Badge tone="error">
						{t("wizardX.toResolveCount", { count: pending })}
					</Badge>
				)}
			</div>

			<div className="space-y-2">
				<h3 className="font-medium text-xs text-zinc-300">
					{t("wizard.credentials")}
				</h3>
				{credentialRefs.length === 0 ? (
					<p className="text-xs text-zinc-500">
						{t("wizard.thisPlanReferencesNoVaultCredentials")}
					</p>
				) : (
					credentialRefs.map((ref) => {
						const selectable = (provider: string) =>
							ref.providers.length === 0 || ref.providers.includes(provider);
						const selectId = `preset-cred-${ref.id}`;
						return (
							<div
								key={ref.id}
								className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 p-2"
							>
								{/* The FULL id, copyable — a truncated UUID cannot be matched
								    against the operator's own vault (ux inventory #16). */}
								<CopyableId value={ref.id} />
								{isPlaceholderCredentialId(ref.id) ? (
									<Badge tone="error">{t("wizard.placeholder")}</Badge>
								) : (
									<Badge tone="ok">{t("wizard.set")}</Badge>
								)}
								<span className="text-[11px] text-zinc-500">
									{ref.contexts.join(", ")}
								</span>
								<label htmlFor={selectId} className="sr-only">
									{t("wizardX.replacementCredentialFor", { id: ref.id })}
								</label>
								<SelectNative
									id={selectId}
									className="ml-auto w-56"
									value=""
									onChange={(e) => {
										if (e.target.value !== "") {
											apply(replaceCredentialId(raw, ref.id, e.target.value));
										}
									}}
								>
									<option value="">
										{t("wizard.replaceWithVaultCredential")}
									</option>
									{credentials.map((credential) => (
										<option
											key={credential.id}
											value={credential.id}
											disabled={!selectable(credential.provider)}
										>
											{credential.label} ({credential.provider})
										</option>
									))}
								</SelectNative>
							</div>
						);
					})
				)}
			</div>

			<div className="space-y-2">
				<h3 className="font-medium text-xs text-zinc-300">
					{t("wizard.buckets")}
				</h3>
				{storageRefs.map((ref) => {
					const inputId = `preset-${ref.section}-${ref.index}-location`;
					return (
						<div
							key={`${ref.section}-${ref.index}`}
							className="flex flex-wrap items-center gap-2"
						>
							<span className="w-40 text-[11px] text-zinc-500">
								{ref.section}[{ref.index}] · {ref.key} ({ref.kind})
							</span>
							{ref.location === null ? (
								<span className="text-[11px] text-zinc-500">
									{t("wizard.hostPortLiveInTheSftpCredential")}
								</span>
							) : (
								<>
									<label htmlFor={inputId} className="sr-only">
										{t("wizardX.locationLabelForSection", {
											label: t(
												ref.kind === "AZURE"
													? "wizard.container"
													: ref.kind === "HTTPS"
														? "wizard.host"
														: "wizard.bucket",
											),
											section: ref.section,
											index: ref.index,
										})}
									</label>
									<Input
										id={inputId}
										className="w-72"
										value={ref.location}
										onChange={(e) =>
											apply(
												withStorageLocation(
													raw,
													ref.section,
													ref.index,
													e.target.value,
												),
											)
										}
									/>
								</>
							)}
						</div>
					);
				})}
			</div>

			{placeholders.length > 0 ? (
				<div className="space-y-2">
					<h3 className="font-medium text-xs text-zinc-300">
						{t("wizard.placeholderPaths")}
					</h3>
					<p className="text-xs text-zinc-500">
						{t("wizardX.placeholderTokensHint", {
							height: "{height}",
							bitrate: "{bitrate}",
							uuid: "{uuid}",
						})}
					</p>
					{placeholders.map((placeholder) => (
						<PlaceholderRow
							key={placeholder.token}
							token={placeholder.token}
							paths={placeholder.paths}
							onReplace={(replacement) =>
								apply(replacePlaceholder(raw, placeholder.token, replacement))
							}
						/>
					))}
				</div>
			) : null}
		</section>
	);
}

function PlaceholderRow({
	token,
	paths,
	onReplace,
}: {
	token: string;
	paths: string[];
	onReplace: (replacement: string) => void;
}) {
	const { t } = useT();
	const [value, setValue] = useState("");
	const inputId = `preset-ph-${token.replace(/[^a-zA-Z0-9]+/g, "-")}`;
	return (
		<div className="flex flex-wrap items-center gap-2">
			<code
				className="max-w-60 truncate font-mono text-[11px] text-amber-400"
				title={t("wizardX.tokenUsedAt", {
					token,
					paths: paths.join(", "),
				})}
			>
				{token}
			</code>
			{/* The paths were hover-only (a title= attribute): invisible on
			    touch, unselectable, unsearchable (ux inventory #12). Click opens
			    the real list. */}
			<DetailPopover
				summary={
					<span className="text-[11px] text-zinc-600">×{paths.length}</span>
				}
				label={t("wizardX.tokenPathsLabel", { token })}
			>
				<ul className="space-y-1">
					{paths.map((path) => (
						<li
							key={path}
							className="select-all whitespace-nowrap font-mono text-zinc-200"
						>
							{path}
						</li>
					))}
				</ul>
			</DetailPopover>
			<label htmlFor={inputId} className="sr-only">
				{t("wizardX.replacementFor", { token })}
			</label>
			<Input
				id={inputId}
				className="w-72"
				placeholder={t("wizard.realObjectPathExt")}
				value={value}
				onChange={(e) => setValue(e.target.value)}
			/>
			<Button
				variant="secondary"
				size="sm"
				disabled={value.trim() === ""}
				onClick={() => onReplace(value.trim())}
			>
				{t("wizard.apply")}
			</Button>
		</div>
	);
}
