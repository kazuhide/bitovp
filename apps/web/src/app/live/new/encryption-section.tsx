"use client";

import type { CredentialSummaryWire } from "@bitovp/core";
import { DrmRowEditor } from "@/app/vod/new/drm-row-editor";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { buildLiveChannelPlan, type LiveWizardState } from "./build-live-plan";
import {
	type LiveDrm,
	liveDrmEditorRow,
	updateLiveDrmMetadata,
} from "./drm-model";
import { liveOutputEntries, liveOutputOptionLabel } from "./live-output-model";

export function LiveEncryptionSection({
	state,
	credentials,
	onPatch,
}: {
	state: LiveWizardState;
	credentials: CredentialSummaryWire[];
	onPatch: (patch: Partial<LiveWizardState>) => void;
}) {
	const { t } = useT();
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
	return (
		<details
			className="rounded-md border border-zinc-800 p-4"
			open={rows.length ? true : undefined}
		>
			<summary className="cursor-pointer text-sm font-medium">
				{t("liveProtection.encryption")}
			</summary>
			<p className="mt-2 text-xs text-zinc-400">
				{t("liveProtection.encryptionHelp")}
			</p>
			<div className="mt-4 space-y-5">
				{clear.muxings
					.filter((m) => m.kind !== "MP4")
					.map((muxing) => {
						const rendition = clear.renditions.find(
							(r) => r.key === muxing.streamKey,
						);
						const entries = rows.flatMap((row, index) =>
							row.muxingKey === muxing.key ? [{ row, index }] : [],
						);
						return (
							<section
								key={muxing.key}
								className="space-y-3 rounded-md border border-zinc-800 p-3"
							>
								<h3 className="text-sm">
									{rendition?.codec}{" "}
									{rendition && "height" in rendition
										? `${rendition.height ?? ""}p / ${(rendition.bitrate ?? 0) / 1000} kbps`
										: rendition && "bitrate" in rendition
											? `${(rendition.bitrate ?? 0) / 1000} kbps`
											: ""}{" "}
									· {muxing.kind}
								</h3>
								<div className="flex flex-wrap gap-2">
									{(muxing.kind === "FMP4"
										? (["CENC", "FAIRPLAY", "SPEKE"] as const)
										: muxing.kind === "TS"
											? (["FAIRPLAY"] as const)
											: []
									).map((kind) => (
										<Button
											key={kind}
											type="button"
											size="sm"
											variant="secondary"
											disabled={entries.some(({ row }) => row.kind === kind)}
											onClick={() => add(muxing.key, kind)}
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
											checked={
												state.unencryptedMuxingKeys?.includes(muxing.key) ??
												false
											}
											onChange={(e) =>
												onPatch({
													unencryptedMuxingKeys: e.target.checked
														? [
																...(state.unencryptedMuxingKeys ?? []),
																muxing.key,
															]
														: state.unencryptedMuxingKeys?.filter(
																(key) => key !== muxing.key,
															),
												})
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
												update(index, updateLiveDrmMetadata(row, next))
											}
											onRemove={() => remove(index)}
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
														update(index, {
															...row,
															destination: {
																...row.destination,
																outputKey: e.target.value,
															},
														})
													}
												>
													{!outputs.some(
														(o) => o.key === row.destination.outputKey,
													) ? (
														<option value={row.destination.outputKey} disabled>
															{row.destination.outputKey}
														</option>
													) : null}
													{outputs.map((o) => (
														<option key={o.key} value={o.key}>
															{liveOutputOptionLabel(o, o.key)}
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
														update(index, {
															...row,
															destination: {
																...row.destination,
																path: e.target.value,
															},
														})
													}
												/>
											</Field>
										</div>
										<Button
											type="button"
											size="sm"
											variant="secondary"
											onClick={() => copyToOthers(row)}
										>
											{t("liveProtection.copyToAll")}
										</Button>
									</div>
								))}
							</section>
						);
					})}
				{rows
					.filter((d) => !clear.muxings.some((m) => m.key === d.muxingKey))
					.map((d) => (
						<div key={d.key} role="alert" className="text-sm text-red-400">
							{t("liveProtection.orphan")}{" "}
							<Button
								type="button"
								size="sm"
								variant="secondary"
								onClick={() => remove(rows.indexOf(d))}
							>
								{t("liveProtection.remove")}
							</Button>
						</div>
					))}
			</div>
		</details>
	);
}
