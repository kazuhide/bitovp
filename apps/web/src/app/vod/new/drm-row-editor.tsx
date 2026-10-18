"use client";

import type { CredentialSummaryWire } from "@bitovp/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { NewCredentialLink } from "@/components/ui/new-credential-link";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import type { WizardDrmRow } from "./build-plan";
import { CodesInput, RowRemoveButton } from "./wizard-fields";

/**
 * Editor for ONE DRM row, embedded under the packaging output (muxing) it
 * encrypts — so it carries no muxing selector; the muxing key is its context.
 * The 16-byte content key is VAULT material (DRM_CENC credential) and never a
 * form field — only public manifest metadata (kid, PSSH, license URLs,
 * FairPlay iv/uri) lives in the plan. ivSize is auto-paired per C9.
 */
export function blankDrmRow(
	kind: WizardDrmRow["kind"],
	muxingKey: string,
): WizardDrmRow {
	if (kind === "SPEKE")
		return {
			kind,
			muxingKey,
			credentialId: "",
			systemIds: ["edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"],
		};
	return kind === "CENC"
		? { kind, muxingKey, credentialId: "", kid: "" }
		: { kind, muxingKey, credentialId: "", iv: "", uri: "" };
}

/** A DRM row paired with its index back into state.drm[]. */
export type DrmEntry = { row: WizardDrmRow; index: number };

/** Encryption rows targeting one packaging output (muxing), index-tagged. */
export function drmEntriesFor(
	rows: WizardDrmRow[],
	muxingKey: string,
): DrmEntry[] {
	return rows.flatMap((row, index) =>
		row.muxingKey === muxingKey ? [{ row, index }] : [],
	);
}

/**
 * Rows whose muxingKey matches no current output — orphaned when a rendition
 * was renamed/removed after the row was added. Surfaced for re-pointing rather
 * than hidden (a hidden row still fails the preview as an unresolved ref).
 */
export function orphanDrmEntries(
	rows: WizardDrmRow[],
	validKeys: Set<string>,
): DrmEntry[] {
	return rows.flatMap((row, index) =>
		validKeys.has(row.muxingKey) ? [] : [{ row, index }],
	);
}

export function DrmRowEditor({
	idBase,
	row,
	drmCredentials,
	onChange,
	onRemove,
}: {
	idBase: string;
	row: WizardDrmRow;
	drmCredentials: CredentialSummaryWire[];
	onChange: (next: WizardDrmRow) => void;
	onRemove: () => void;
}) {
	const { t } = useT();
	const [inlineOpen, setInlineOpen] = useState(false);
	if (row.kind === "SPEKE")
		return (
			<SpekeRowEditor
				idBase={idBase}
				row={row}
				credentials={drmCredentials}
				onChange={onChange}
				onRemove={onRemove}
			/>
		);
	return (
		<div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
			<div className="flex items-center gap-2">
				<span className="rounded bg-zinc-800 px-2 py-1 font-mono text-xs text-zinc-300">
					{row.kind}
				</span>
				<span className="text-xs text-zinc-500">
					{t("wizardX.keyColon")} {row.muxingKey || "—"}-
					{row.kind === "CENC" ? "cenc" : "fairplay"}
				</span>
				<div className="ml-auto">
					<RowRemoveButton
						label={t("wizard.removeEncryption")}
						onClick={onRemove}
					/>
				</div>
			</div>
			<Field
				label={t("wizard.contentKeyVault")}
				htmlFor={`${idBase}-cred`}
				help={t("wizard.drmCencCredentialTheKeyItselfNever")}
			>
				<div className="flex gap-2">
					<SelectNative
						id={`${idBase}-cred`}
						value={row.credentialId}
						onChange={(e) => onChange({ ...row, credentialId: e.target.value })}
					>
						<option value="">{t("wizard.selectCredential")}</option>
						{drmCredentials
							.filter((credential) => credential.provider === "DRM_CENC")
							.map((credential) => (
								<option key={credential.id} value={credential.id}>
									{credential.label}
								</option>
							))}
					</SelectNative>
					<RoleAccess control="vod.new.drm-credentials">
						<span className="contents">
							<NewCredentialLink />
							<Button
								type="button"
								variant="secondary"
								size="sm"
								aria-expanded={inlineOpen}
								onClick={() => setInlineOpen((v) => !v)}
							>
								{t("wizard.enterKeyDirectly")}
							</Button>
						</span>
					</RoleAccess>
				</div>
			</Field>
			{inlineOpen ? (
				<RoleAccess control="vod.new.drm-credentials">
					<InlineKeyEntry
						idBase={idBase}
						onCreated={(id) => {
							onChange({ ...row, credentialId: id });
							setInlineOpen(false);
						}}
					/>
				</RoleAccess>
			) : null}
			{row.kind === "CENC" ? (
				<>
					<Field
						label={t("wizard.kid32HexChars")}
						htmlFor={`${idBase}-kid`}
						help={t("wizard.kidIsPublicNeverPasteTheContent")}
					>
						<Input
							id={`${idBase}-kid`}
							className="font-mono"
							value={row.kid}
							onChange={(e) => onChange({ ...row, kid: e.target.value })}
						/>
					</Field>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<Field
							label={t("wizard.encryptionMode")}
							htmlFor={`${idBase}-mode`}
							help={t("wizardX.c9PairsIvSize", {
								pairing:
									row.encryptionMode === "CBC"
										? t("ui.cbcIv16Bytes")
										: t("ui.ctrIv8Bytes"),
							})}
						>
							<SelectNative
								id={`${idBase}-mode`}
								value={row.encryptionMode ?? ""}
								onChange={(e) =>
									onChange({
										...row,
										encryptionMode:
											e.target.value === ""
												? undefined
												: (e.target.value as "CTR" | "CBC"),
									})
								}
							>
								<option value="">{t("wizard.apiDefaultCtr")}</option>
								<option value="CTR">CTR</option>
								<option value="CBC">CBC</option>
							</SelectNative>
						</Field>
						<Field
							label={t("wizard.widevinePssh")}
							htmlFor={`${idBase}-wv`}
							help={t("wizard.base64PublicManifestMetadata")}
						>
							<Input
								id={`${idBase}-wv`}
								className="font-mono"
								value={row.widevinePssh ?? ""}
								onChange={(e) =>
									onChange({
										...row,
										widevinePssh: e.target.value || undefined,
									})
								}
							/>
						</Field>
						<Field label={t("wizard.playreadyLaUrl")} htmlFor={`${idBase}-la`}>
							<Input
								id={`${idBase}-la`}
								value={row.playReadyLaUrl ?? ""}
								onChange={(e) =>
									onChange({
										...row,
										playReadyLaUrl: e.target.value || undefined,
									})
								}
							/>
						</Field>
						<Field label={t("wizard.playreadyPssh")} htmlFor={`${idBase}-prp`}>
							<Input
								id={`${idBase}-prp`}
								className="font-mono"
								value={row.playReadyPssh ?? ""}
								onChange={(e) =>
									onChange({
										...row,
										playReadyPssh: e.target.value || undefined,
									})
								}
							/>
						</Field>
						<Field
							label={t("wizard.fairplayIv32Hex")}
							htmlFor={`${idBase}-fpiv`}
						>
							<Input
								id={`${idBase}-fpiv`}
								className="font-mono"
								value={row.fairPlayIv ?? ""}
								onChange={(e) =>
									onChange({
										...row,
										fairPlayIv: e.target.value || undefined,
									})
								}
							/>
						</Field>
						<Field
							label={t("wizard.fairplayUri")}
							htmlFor={`${idBase}-fpuri`}
							help={t("wizard.skdLicenseTokenUri")}
						>
							<Input
								id={`${idBase}-fpuri`}
								value={row.fairPlayUri ?? ""}
								onChange={(e) =>
									onChange({
										...row,
										fairPlayUri: e.target.value || undefined,
									})
								}
							/>
						</Field>
					</div>
				</>
			) : (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<Field
						label={t("wizard.iv32HexChars")}
						htmlFor={`${idBase}-iv`}
						help={t("wizard.publicInitializationVectorTheKeyStaysIn")}
					>
						<Input
							id={`${idBase}-iv`}
							className="font-mono"
							value={row.iv}
							onChange={(e) => onChange({ ...row, iv: e.target.value })}
						/>
					</Field>
					<Field
						label={t("wizard.licenseUri")}
						htmlFor={`${idBase}-uri`}
						help={t("wizard.skdLicenseTokenUri")}
					>
						<Input
							id={`${idBase}-uri`}
							value={row.uri}
							onChange={(e) => onChange({ ...row, uri: e.target.value })}
						/>
					</Field>
				</div>
			)}
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<Field
					label={t("wizard.destinationPath")}
					htmlFor={`${idBase}-path`}
					help={t("wizard.relativeToBaseEmptyTheMuxingS")}
				>
					<Input
						id={`${idBase}-path`}
						value={row.path ?? ""}
						onChange={(e) =>
							onChange({
								...row,
								path: e.target.value === "" ? undefined : e.target.value,
							})
						}
					/>
				</Field>
			</div>
		</div>
	);
}

/**
 * : direct key entry — the operator types the 16-byte key; we
 * AUTO-CREATE a DRM_CENC credential (AES-256-GCM at rest, write-only
 * display) and assign it, so the plan keeps carrying a REFERENCE and the
 * schema's secrets-never-ride-a-plan rule survives untouched. The key
 * never enters wizard state, plan JSON, preview or snapshots.
 */
function InlineKeyEntry({
	idBase,
	onCreated,
}: {
	idBase: string;
	onCreated: (credentialId: string) => void;
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const [key, setKey] = useState("");
	const [label, setLabel] = useState("");
	const valid = /^[0-9a-fA-F]{32}$/.test(key);
	const create = useMutation({
		mutationFn: async () => {
			return apiFetch<{ id: string }>("/api/credentials", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					label: label.trim() || t("wizard.inlineKeyDefaultLabel"),
					provider: "DRM_CENC",
					config: {},
					secret: { key },
				}),
			});
		},
		onSuccess: async (created) => {
			setKey("");
			await queryClient.invalidateQueries({ queryKey: ["credentials"] });
			onCreated(created.id);
		},
	});
	return (
		<RoleAccess control="vod.new.drm-credentials">
			<div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
				<Field
					label={t("wizard.contentKey32Hex")}
					htmlFor={`${idBase}-inline-key`}
					help={t("wizard.inlineKeyStoredEncrypted")}
				>
					<Input
						id={`${idBase}-inline-key`}
						type="password"
						autoComplete="off"
						spellCheck={false}
						value={key}
						onChange={(e) => setKey(e.target.value.trim())}
					/>
				</Field>
				<Field label={t("common.name")} htmlFor={`${idBase}-inline-label`}>
					<Input
						id={`${idBase}-inline-label`}
						placeholder={t("wizard.inlineKeyDefaultLabel")}
						value={label}
						onChange={(e) => setLabel(e.target.value)}
					/>
				</Field>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						size="sm"
						disabled={!valid || create.isPending}
						onClick={() => create.mutate()}
					>
						{create.isPending ? t("common.saving") : t("wizard.saveKeyAndUse")}
					</Button>
					{key !== "" && !valid ? (
						<p className="text-red-400 text-xs">
							{t("wizard.contentKeyMustBe32Hex")}
						</p>
					) : null}
					{create.isError ? (
						<p role="alert" className="text-red-400 text-xs">
							{String((create.error as Error).message)}
						</p>
					) : null}
				</div>
			</div>
		</RoleAccess>
	);
}

function SpekeRowEditor({
	idBase,
	row,
	credentials,
	onChange,
	onRemove,
}: {
	idBase: string;
	row: Extract<WizardDrmRow, { kind: "SPEKE" }>;
	credentials: CredentialSummaryWire[];
	onChange: (row: WizardDrmRow) => void;
	onRemove: () => void;
}) {
	const { t } = useT();
	const known = [
		"edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",
		"9a04f079-9840-4286-ab92-e65be0885f95",
		"94ce86fb-07ff-4f43-adb8-93d2fa968ca2",
	];
	return (
		<div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
			<div className="flex items-center justify-between">
				<span className="font-mono text-xs">SPEKE</span>
				<RowRemoveButton
					label={t("wizard.removeEncryption")}
					onClick={onRemove}
				/>
			</div>
			<Field
				label={t("wizard.spekeProvider")}
				htmlFor={`${idBase}-cred`}
				tooltip={t("fields.spekeVaultHelp")}
			>
				<div className="flex gap-2">
					<SelectNative
						id={`${idBase}-cred`}
						value={row.credentialId}
						onChange={(e) => onChange({ ...row, credentialId: e.target.value })}
					>
						<option value="">{t("wizard.selectCredential")}</option>
						{credentials
							.filter((credential) => credential.provider === "DRM_SPEKE")
							.map((credential) => (
								<option key={credential.id} value={credential.id}>
									{credential.label}
								</option>
							))}
					</SelectNative>
					<RoleAccess control="vod.new.drm-credentials">
						<NewCredentialLink />
					</RoleAccess>
				</div>
			</Field>
			<Field
				label={t("wizard.spekeSystems")}
				htmlFor={`${idBase}-systems`}
				tooltip={t("wizard.spekeSystemsHelp")}
			>
				<div id={`${idBase}-systems`} className="flex flex-wrap gap-3">
					{(
						[
							["Widevine", "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"],
							["PlayReady", "9a04f079-9840-4286-ab92-e65be0885f95"],
							["FairPlay", "94ce86fb-07ff-4f43-adb8-93d2fa968ca2"],
						] as const
					).map(([name, id]) => (
						<label key={id} className="flex items-center gap-2 text-xs">
							<input
								type="checkbox"
								checked={row.systemIds.some(
									(selected) => selected.toLowerCase() === id,
								)}
								onChange={(e) =>
									onChange({
										...row,
										systemIds: e.target.checked
											? [...row.systemIds, id]
											: row.systemIds.filter(
													(selected) => selected.toLowerCase() !== id,
												),
									})
								}
							/>
							{name}
						</label>
					))}
				</div>
			</Field>
			<Field
				label={t("wizard.spekeOtherSystems")}
				htmlFor={`${idBase}-other-systems`}
			>
				<CodesInput
					id={`${idBase}-other-systems`}
					value={row.systemIds.filter(
						(id) => !known.includes(id.toLowerCase()),
					)}
					onChange={(ids) =>
						onChange({
							...row,
							systemIds: [
								...row.systemIds.filter((id) =>
									known.includes(id.toLowerCase()),
								),
								...(ids ?? []),
							],
						})
					}
					placeholder="UUID, UUID"
				/>
			</Field>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<Field
					label="Content ID"
					htmlFor={`${idBase}-content`}
					tooltip={t("wizard.spekeContentHelp")}
				>
					<Input
						id={`${idBase}-content`}
						value={row.contentId ?? ""}
						onChange={(e) =>
							onChange({ ...row, contentId: e.target.value || undefined })
						}
					/>
				</Field>
				<Field label={t("wizard.kid32HexChars")} htmlFor={`${idBase}-kid`}>
					<Input
						id={`${idBase}-kid`}
						value={row.kid ?? ""}
						onChange={(e) =>
							onChange({ ...row, kid: e.target.value || undefined })
						}
					/>
				</Field>
				<Field
					label={t("wizard.iv32HexChars")}
					htmlFor={`${idBase}-iv`}
					tooltip={t("wizard.spekeIvHelp")}
				>
					<Input
						id={`${idBase}-iv`}
						value={row.iv ?? ""}
						onChange={(e) =>
							onChange({ ...row, iv: e.target.value || undefined })
						}
					/>
				</Field>
				<Field label={t("wizard.destinationPath")} htmlFor={`${idBase}-path`}>
					<Input
						id={`${idBase}-path`}
						value={row.path ?? ""}
						onChange={(e) =>
							onChange({ ...row, path: e.target.value || undefined })
						}
					/>
				</Field>
			</div>
		</div>
	);
}
