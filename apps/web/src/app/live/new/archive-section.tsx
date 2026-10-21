"use client";

import type { CredentialSummaryWire } from "@bitovp/core";
import { useState } from "react";
import { audioKeys, videoKeys } from "@/app/vod/new/build-plan";
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
	liveBasePath,
} from "./build-live-plan";
import {
	liveMirrorEntries,
	liveOutputEntries,
	liveOutputOptionLabel,
} from "./live-output-model";
import { liveStorageKind as storageKind } from "./mirror-model";

type Archive = NonNullable<LiveWizardState["archive"]>;

export function LiveArchiveSection({
	state,
	credentials,
	onPatch,
}: {
	state: LiveWizardState;
	credentials: Pick<CredentialSummaryWire, "id" | "label" | "provider">[];
	onPatch: (patch: Partial<LiveWizardState>) => void;
}) {
	const { t } = useT();
	const archive = state.archive;
	//  (owner): the archive-only storage's bucket AND folder are
	// picked in the storage browser; the picked prefix becomes the archive
	// path (without its trailing slash — the path field never carries one).
	const [browse, setBrowse] = useState(false);
	const output = archive?.output;
	const vKeys = videoKeys(state.videos);
	const aKeys = audioKeys(state.audios);
	const videos = state.videos.flatMap((v, i) =>
		v.codec === "H264"
			? [
					{
						key: vKeys[i] ?? `video${i + 1}`,
						label: `H.264 ${v.height ?? ""}p`,
					},
				]
			: [],
	);
	const audios = state.audios.flatMap((a, i) =>
		a.codec === "AAC"
			? [
					{
						key: aKeys[i] ?? `audio${i + 1}`,
						label: `AAC ${a.bitrate / 1000} kbps`,
					},
				]
			: [],
	);
	const canEnable = videos.length > 0 && audios.length > 0;
	const patch = (next: Partial<Archive>) =>
		archive && onPatch({ archive: { ...archive, ...next } });
	const patchMuxing = (next: Partial<Archive["muxing"]>) =>
		archive && patch({ muxing: { ...archive.muxing, ...next } });
	const newOutput = () => ({
		...DEFAULT_LIVE_WIZARD_STATE.output,
		publicRead: false,
		basePath: "",
	});
	let availableKey = "archive-output";
	for (
		let n = 2;
		liveOutputEntries(state).some((entry) => entry.key === availableKey);
		n++
	)
		availableKey = `archive-output-${n}`;
	const separateKey = archive?.output
		? archive.muxing.destination.outputKey
		: availableKey;
	const currentDestinationAvailable =
		archive?.output ||
		(archive?.muxing.destination.outputKey === "origin" &&
			storageKind(state.output.kind)) ||
		liveMirrorEntries(state).some(
			(entry) =>
				entry.key === archive?.muxing.destination.outputKey &&
				storageKind(entry.output.kind),
		);
	return (
		<section
			className="space-y-3 border-zinc-800 border-t pt-4"
			aria-label={t("liveArchive.title")}
		>
			<div className="flex items-center gap-2">
				<label
					className="flex items-center gap-2 text-sm text-zinc-300"
					htmlFor="lw-archive-enabled"
				>
					<input
						id="lw-archive-enabled"
						type="checkbox"
						className="h-4 w-4 accent-emerald-600"
						checked={!!archive}
						disabled={!archive && !canEnable}
						onChange={(e) =>
							onPatch({
								archive: e.target.checked
									? {
											muxing: {
												key: "archive",
												kind: "MP4",
												streamKey: videos[0]?.key ?? "",
												additionalStreamKeys: [audios[0]?.key ?? ""],
												filename: "archive.mp4",
												destination: {
													outputKey: separateKey,
													path: `${liveBasePath(state)}/archive`,
													acl: "PRIVATE",
												},
											},
											output: newOutput(),
										}
									: undefined,
							})
						}
					/>
					{t("liveArchive.enable")}
				</label>
				<HelpOverlay labelFor={t("liveArchive.enable")}>
					{t("liveArchive.help")}
				</HelpOverlay>
			</div>
			{!canEnable && !archive ? (
				<p className="text-xs text-zinc-400">
					{t("liveArchive.requiresStreams")}
				</p>
			) : null}
			{archive ? (
				<>
					<div className="grid gap-3 sm:grid-cols-2">
						<Field label={t("liveArchive.video")} htmlFor="lw-archive-video">
							<SelectNative
								id="lw-archive-video"
								value={archive.muxing.streamKey}
								onChange={(e) => patchMuxing({ streamKey: e.target.value })}
							>
								<option value="">{t("liveArchive.selectStream")}</option>
								{!videos.some((v) => v.key === archive.muxing.streamKey) &&
								archive.muxing.streamKey ? (
									<option value={archive.muxing.streamKey}>
										{t("liveArchive.unavailableStream")}
									</option>
								) : null}
								{videos.map((v) => (
									<option key={v.key} value={v.key}>
										{v.label}
									</option>
								))}
							</SelectNative>
						</Field>
						<Field label={t("liveArchive.audio")} htmlFor="lw-archive-audio">
							<SelectNative
								id="lw-archive-audio"
								value={archive.muxing.additionalStreamKeys?.[0] ?? ""}
								onChange={(e) =>
									patchMuxing({ additionalStreamKeys: [e.target.value] })
								}
							>
								<option value="">{t("liveArchive.selectStream")}</option>
								{archive.muxing.additionalStreamKeys?.[0] &&
								!audios.some(
									(a) => a.key === archive.muxing.additionalStreamKeys?.[0],
								) ? (
									<option value={archive.muxing.additionalStreamKeys[0]}>
										{t("liveArchive.unavailableStream")}
									</option>
								) : null}
								{audios.map((a) => (
									<option key={a.key} value={a.key}>
										{a.label}
									</option>
								))}
							</SelectNative>
						</Field>
					</div>
					<Field
						label={t("liveArchive.destination")}
						htmlFor="lw-archive-destination"
					>
						<SelectNative
							id="lw-archive-destination"
							value={archive.muxing.destination.outputKey}
							onChange={(e) =>
								patch({
									output:
										e.target.value === separateKey ? newOutput() : undefined,
									muxing: {
										...archive.muxing,
										destination: {
											...archive.muxing.destination,
											outputKey: e.target.value,
										},
									},
								})
							}
						>
							{!currentDestinationAvailable ? (
								<option value={archive.muxing.destination.outputKey}>
									{t("liveArchive.unavailableDestination")}
								</option>
							) : null}
							<option value={separateKey}>
								{t("liveArchive.separateStorage")}
							</option>
							{storageKind(state.output.kind) ? (
								<option value="origin">{t("liveArchive.originStorage")}</option>
							) : null}
							{liveMirrorEntries(state)
								.filter((entry) => storageKind(entry.output.kind))
								.map((entry, index) => (
									<option key={entry.key} value={entry.key}>
										{liveOutputOptionLabel(
											entry,
											index === 0
												? t("liveArchive.mirrorStorage")
												: t("liveOutputs.mirrorNumber", { number: index + 1 }),
										)}
									</option>
								))}
						</SelectNative>
					</Field>
					{output ? (
						<div className="grid gap-3 sm:grid-cols-2">
							{/* Link under the select, not in the trailing slot — see the
							    mirror section (browser walk, 2026-09-11). */}
							<div className="space-y-1.5">
								<Field
									label={t("liveArchive.credential")}
									htmlFor="lw-archive-credential"
								>
									<SelectNative
										id="lw-archive-credential"
										value={output.credentialId}
										onChange={(e) => {
											if (!e.target.value) {
												patch({
													output: { ...output, credentialId: "" },
												});
												return;
											}
											const kind = liveOutputKindForProvider(
												credentials.find((c) => c.id === e.target.value)
													?.provider,
											);
											if (storageKind(kind) && kind)
												patch({
													output: {
														...output,
														kind,
														credentialId: e.target.value,
														bucket: "",
													},
												});
										}}
									>
										<option value="">{t("ui.selectCredential")}</option>
										{output.credentialId &&
										!credentials.some(
											(c) =>
												c.id === archive.output?.credentialId &&
												storageKind(liveOutputKindForProvider(c.provider)),
										) ? (
											<option value={output.credentialId}>
												{t("liveArchive.unavailableDestination")}
											</option>
										) : null}
										{credentials
											.filter((c) =>
												storageKind(liveOutputKindForProvider(c.provider)),
											)
											.map((c) => (
												<option key={c.id} value={c.id}>
													{c.label}
												</option>
											))}
									</SelectNative>
								</Field>
								<NewCredentialLink />
							</div>
							<Field
								label={t("liveArchive.bucket")}
								htmlFor="lw-archive-bucket"
							>
								<div className="flex gap-2">
									<Input
										id="lw-archive-bucket"
										value={output.bucket}
										onChange={(e) =>
											patch({
												output: { ...output, bucket: e.target.value },
											})
										}
									/>
									{output.kind !== "AKAMAI_MSL" &&
									outputKindIsBrowsable(output.kind) ? (
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
							<StoragePicker
								open={browse}
								mode="prefix"
								providers={[...BROWSABLE_STORAGE_PROVIDERS]}
								initialCredentialId={output.credentialId}
								initialBucket={output.bucket}
								onClose={() => setBrowse(false)}
								onSelect={({ credentialId, bucket, path }) => {
									const kind = liveOutputKindForProvider(
										credentials.find((c) => c.id === credentialId)?.provider,
									);
									if (kind && storageKind(kind)) {
										patch({
											output: { ...output, kind, credentialId, bucket },
											muxing: {
												...archive.muxing,
												destination: {
													...archive.muxing.destination,
													path: path.replace(/\/+$/, ""),
												},
											},
										});
									}
									setBrowse(false);
								}}
							/>
						</div>
					) : null}
					<div className="grid gap-3 sm:grid-cols-2">
						<Field
							label={t("liveArchive.path")}
							htmlFor="lw-archive-path"
							help={t("liveArchive.pathHelp")}
						>
							<Input
								id="lw-archive-path"
								value={archive.muxing.destination.path}
								onChange={(e) =>
									patchMuxing({
										destination: {
											...archive.muxing.destination,
											path: e.target.value,
										},
									})
								}
							/>
						</Field>
						<Field
							label={t("liveArchive.filename")}
							htmlFor="lw-archive-filename"
						>
							<Input
								id="lw-archive-filename"
								value={archive.muxing.filename}
								onChange={(e) => patchMuxing({ filename: e.target.value })}
							/>
						</Field>
					</div>
					<Field label={t("liveArchive.access")} htmlFor="lw-archive-access">
						<SelectNative
							id="lw-archive-access"
							value={archive.muxing.destination.acl ?? ""}
							onChange={(e) =>
								patchMuxing({
									destination: {
										...archive.muxing.destination,
										acl:
											e.target.value === "PRIVATE" ||
											e.target.value === "PUBLIC_READ"
												? e.target.value
												: undefined,
									},
								})
							}
						>
							<option value="PRIVATE">{t("liveArchive.private")}</option>
							<option value="PUBLIC_READ">{t("liveArchive.publicRead")}</option>
							<option value="">{t("liveArchive.destinationDefault")}</option>
						</SelectNative>
					</Field>
					<p className="text-xs text-zinc-400">
						{t("liveArchive.verifyAfterStop")}
					</p>
				</>
			) : null}
		</section>
	);
}
