"use client";

import type { CredentialSummaryWire } from "@bitovp/core";
import { DrmRowEditor } from "@/app/vod/new/drm-row-editor";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { buildLiveChannelPlan, type LiveWizardState } from "./build-live-plan";
import {
	type LiveDrm,
	liveDrmEditorRow,
	updateLiveDrmMetadata,
} from "./drm-model";
import { liveOutputEntries, liveOutputOptionLabel } from "./live-output-model";

export function createLiveEncryptionModel(
	state: LiveWizardState,
	onPatch: (patch: Partial<LiveWizardState>) => void,
) {
	const clear = buildLiveChannelPlan({ ...state, drm: undefined });
	const rows = state.drm ?? [];
	const outputs = liveOutputEntries(state);
	const update = (index: number, row: LiveDrm) =>
		onPatch({ drm: rows.map((r, i) => (i === index ? row : r)) });
	const add = (muxingKey: string, kind: LiveDrm["kind"]) => {
		const muxing = clear.muxings.find((m) => m.key === muxingKey);
		if (!muxing?.destination) return;
		const common = {
			key: `${muxingKey}-${kind.toLowerCase()}`,
			muxingKey,
			credentialId: "",
			destination: muxing.destination,
		};
		const row: LiveDrm =
			kind === "CENC"
				? { ...common, kind, kid: "" }
				: kind === "FAIRPLAY"
					? { ...common, kind, iv: "", uri: "" }
					: {
							...common,
							kind,
							systemIds: ["edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"],
						};
		const first = rows.length === 0;
		onPatch({
			drm: [...rows, row],
			...(first
				? {
						manifests: {
							...state.manifests,
							hls: { ...state.manifests.hls, drmKind: kind },
							dash: { ...state.manifests.dash, drmKind: kind },
							additionalHls: state.manifests.additionalHls?.map((m) => ({
								...m,
								drmKind: kind,
							})),
							additionalDash: state.manifests.additionalDash?.map((m) => ({
								...m,
								drmKind: kind,
							})),
						},
					}
				: {}),
		});
	};
	const remove = (index: number) => {
		const next = rows.filter((_, i) => i !== index);
		const kind = rows[index]?.kind;
		const noKind = next.every((d) => d.kind !== kind);
		const reset = <T extends { drmKind?: LiveDrm["kind"] }>(m: T): T =>
			noKind && m.drmKind === kind ? { ...m, drmKind: undefined } : m;
		onPatch({
			drm: next.length ? next : undefined,
			manifests: {
				...state.manifests,
				hls: reset(state.manifests.hls),
				dash: reset(state.manifests.dash),
				additionalHls: state.manifests.additionalHls?.map(reset),
				additionalDash: state.manifests.additionalDash?.map(reset),
			},
		});
	};
	const copyToOthers = (row: LiveDrm) => {
		const next = rows.filter((d) => d.kind !== row.kind);
		for (const muxing of clear.muxings) {
			if (
				!muxing.destination ||
				!(row.kind === "FAIRPLAY" ? ["FMP4", "TS"] : ["FMP4"]).includes(
					muxing.kind,
				)
			)
				continue;
			next.push({
				...row,
				key: `${muxing.key}-${row.kind.toLowerCase()}`,
				muxingKey: muxing.key,
				destination:
					rows.find((d) => d.muxingKey === muxing.key && d.kind === row.kind)
						?.destination ?? muxing.destination,
			});
		}
		onPatch({ drm: next });
	};
	const setWriteClear = (muxingKey: string, enabled: boolean) =>
		onPatch({
			unencryptedMuxingKeys: enabled
				? [...(state.unencryptedMuxingKeys ?? []), muxingKey]
				: state.unencryptedMuxingKeys?.filter((key) => key !== muxingKey),
		});
	return {
		clear,
		rows,
		outputs,
		update,
		add,
		remove,
		copyToOthers,
		writeClearKeys: state.unencryptedMuxingKeys ?? [],
		setWriteClear,
	};
}

export type LiveEncryptionModel = ReturnType<typeof createLiveEncryptionModel>;

export function LiveMuxingEncryption({
	model,
	muxingKey,
	credentials,
}: {
	model: LiveEncryptionModel;
	muxingKey: string;
	credentials: CredentialSummaryWire[];
}) {
	const { t } = useT();
	const muxing = model.clear.muxings.find(
		(entry) => entry.key === muxingKey && entry.kind !== "MP4",
	);
	if (!muxing) return null;
	const entries = model.rows.flatMap((row, index) =>
		row.muxingKey === muxing.key ? [{ row, index }] : [],
	);
	const kinds =
		muxing.kind === "FMP4"
			? (["CENC", "FAIRPLAY", "SPEKE"] as const)
			: muxing.kind === "TS"
				? (["FAIRPLAY"] as const)
				: [];
	const summary = t("wizardX.encryptionDrmCount", { count: entries.length });
	return (
		<details
			className="rounded-md border border-zinc-800 bg-zinc-900/40"
			open={entries.length ? true : undefined}
		>
			<summary className="cursor-pointer select-none px-3 py-2 font-medium text-xs text-zinc-300 hover:text-zinc-100">
				{summary}
				<span className="ml-1.5 inline-flex">
					<HelpOverlay labelFor={summary}>
						{t("liveProtection.encryptionHelp")}
					</HelpOverlay>
				</span>
			</summary>
			<div className="space-y-3 border-zinc-800 border-t p-3">
				<div className="flex flex-wrap gap-2">
					{kinds.map((kind) => (
						<Button
							key={kind}
							type="button"
							size="sm"
							variant="secondary"
							disabled={entries.some(({ row }) => row.kind === kind)}
							onClick={() => model.add(muxing.key, kind)}
						>
							{t("liveProtection.add")} {kind}
						</Button>
					))}
					{muxing.kind === "CMAF" ? (
						<p className="text-xs text-zinc-400">
							{t("liveProtection.cmafHelp")}
						</p>
					) : null}
				</div>
				{entries.length ? (
					<label className="flex items-center gap-2 text-xs">
						<input
							type="checkbox"
							checked={model.writeClearKeys.includes(muxing.key)}
							onChange={(e) =>
								model.setWriteClear(muxing.key, e.target.checked)
							}
						/>
						{t("liveProtection.writeClear")}
					</label>
				) : null}
				{entries.map(({ row, index }) => (
					<div key={row.key} className="space-y-3">
						<DrmRowEditor
							idBase={`lw-drm-${index}`}
							row={liveDrmEditorRow(row)}
							drmCredentials={credentials}
							showDestination={false}
							showResourceKey={false}
							onChange={(next) =>
								model.update(index, updateLiveDrmMetadata(row, next))
							}
							onRemove={() => model.remove(index)}
						/>
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<Field
								label={t("liveOutputs.destination")}
								htmlFor={`lw-drm-${index}-destination`}
							>
								<SelectNative
									id={`lw-drm-${index}-destination`}
									value={row.destination.outputKey}
									onChange={(e) =>
										model.update(index, {
											...row,
											destination: {
												...row.destination,
												outputKey: e.target.value,
											},
										})
									}
								>
									{!model.outputs.some(
										(output) => output.key === row.destination.outputKey,
									) ? (
										<option value={row.destination.outputKey} disabled>
											{row.destination.outputKey}
										</option>
									) : null}
									{model.outputs.map((output) => (
										<option key={output.key} value={output.key}>
											{liveOutputOptionLabel(output, output.key)}
										</option>
									))}
								</SelectNative>
							</Field>
							<Field
								label={t("liveOutputs.path")}
								htmlFor={`lw-drm-${index}-path`}
							>
								<Input
									id={`lw-drm-${index}-path`}
									value={row.destination.path}
									onChange={(e) =>
										model.update(index, {
											...row,
											destination: { ...row.destination, path: e.target.value },
										})
									}
								/>
							</Field>
						</div>
						<Button
							type="button"
							size="sm"
							variant="secondary"
							className="h-auto min-h-8 max-w-full whitespace-normal py-1 text-left"
							onClick={() => model.copyToOthers(row)}
						>
							{t("liveProtection.copyToAll")}
						</Button>
					</div>
				))}
			</div>
		</details>
	);
}

export function LiveEncryptionOrphans({
	model,
}: {
	model: LiveEncryptionModel;
}) {
	const { t } = useT();
	const orphans = model.rows.flatMap((row, index) =>
		model.clear.muxings.some((muxing) => muxing.key === row.muxingKey)
			? []
			: [{ row, index }],
	);
	if (!orphans.length) return null;
	return (
		<div className="space-y-3">
			{orphans.map(({ row, index }) => (
				<div key={row.key} role="alert" className="text-sm text-red-400">
					{t("liveProtection.orphan")}{" "}
					<Button
						type="button"
						size="sm"
						variant="secondary"
						onClick={() => model.remove(index)}
					>
						{t("liveProtection.remove")}
					</Button>
				</div>
			))}
		</div>
	);
}
