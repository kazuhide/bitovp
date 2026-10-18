"use client";

import type { CredentialSummaryWire } from "@bitovp/core";
import { SRT_LISTENER_PORTS } from "@bitovp/core";
import { STATIC_INGEST_URL } from "@/app/live/feeders/feeder-shared";
import { RowRemoveButton } from "@/app/vod/new/wizard-fields";
import { Button } from "@/components/ui/button";
import { Field, FieldRowAction } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { NewCredentialLink } from "@/components/ui/new-credential-link";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import type {
	LiveInputKind,
	LiveSrtBackupRow,
	LiveWizardState,
} from "./build-live-plan";
import { staticPointFallbackName } from "./build-live-plan";

type InputSectionProps = {
	state: LiveWizardState;
	credentials: CredentialSummaryWire[];
	onPatch: (partial: Partial<LiveWizardState>) => void;
};

const INPUT_KINDS: {
	value: LiveInputKind;
	labelKey: MessageKey;
	hintKey: MessageKey;
}[] = [
	{
		value: "RTMP",
		labelKey: "ui.rtmp",
		hintKey: "ui.accountDefaultRtmpInputResolvedByListing",
	},
	{
		value: "REDUNDANT_RTMP",
		labelKey: "ui.redundantRtmp",
		hintKey: "ui.multipleIngestPointsWithAutomaticFailover",
	},
	{
		value: "SRT",
		labelKey: "ui.srt",
		hintKey: "ui.listenerBitmovinListensOrCallerBitmovinDials",
	},
	{ value: "ZIXI", labelKey: "ui.zixi", hintKey: "ui.zixiBroadcasterPull" },
	{
		value: "HLS",
		labelKey: "ui.hlsPull",
		hintKey: "ui.bitmovinPullsAnHlsSourceUrl",
	},
];

function numberOrUndefined(raw: string): number | undefined {
	return raw === "" ? undefined : Number(raw);
}

export function InputSection({
	state,
	credentials,
	onPatch,
}: InputSectionProps) {
	const { t } = useT();
	const srtCredentials = credentials.filter(
		(c) => c.provider === "SRT_PASSPHRASE",
	);
	const zixiCredentials = credentials.filter((c) => c.provider === "ZIXI");
	const missingCredential = (id: string, choices: CredentialSummaryWire[]) =>
		id && !choices.some((credential) => credential.id === id) ? (
			<option value={id}>
				{id} {t("wizardX.missingParen")}
			</option>
		) : null;
	const srt = state.srt;
	const redundant = state.redundantRtmp;

	const patchSrt = (partial: Partial<LiveWizardState["srt"]>) =>
		onPatch({ srt: { ...srt, ...partial } });
	const patchRedundant = (partial: Partial<LiveWizardState["redundantRtmp"]>) =>
		onPatch({ redundantRtmp: { ...redundant, ...partial } });
	const patchBackup = (index: number, partial: Partial<LiveSrtBackupRow>) => {
		const next = [...srt.backups];
		const current = next[index];
		if (!current) {
			return;
		}
		next[index] = { ...current, ...partial };
		patchSrt({ backups: next });
	};
	/**
	 * Mode switch with the LISTENER port rail: the main input avoids stale
	 * ports via separate listenerPort/callerPort fields, but a backup row has
	 * one `port` — so switching to LISTENER snaps an out-of-range port to
	 * 2089 (the add-row default). The LISTENER select must never render with
	 * a value that matches none of its options.
	 */
	const patchBackupMode = (index: number, mode: "LISTENER" | "CALLER") => {
		const current = srt.backups[index];
		if (!current) {
			return;
		}
		const portValid = SRT_LISTENER_PORTS.includes(
			current.port as (typeof SRT_LISTENER_PORTS)[number],
		);
		patchBackup(index, {
			mode,
			...(mode === "LISTENER" && !portValid ? { port: 2089 } : {}),
		});
	};

	return (
		<div className="space-y-4">
			<Field
				label={t("ui.inputKind")}
				htmlFor="lw-input-kind"
				{...(() => {
					const hintKey = INPUT_KINDS.find(
						(k) => k.value === state.inputKind,
					)?.hintKey;
					return hintKey ? { hint: t(hintKey) } : {};
				})()}
			>
				<SelectNative
					id="lw-input-kind"
					value={state.inputKind}
					onChange={(e) =>
						onPatch({ inputKind: e.target.value as LiveInputKind })
					}
				>
					{INPUT_KINDS.map((kind) => (
						<option key={kind.value} value={kind.value}>
							{t(kind.labelKey)}
						</option>
					))}
				</SelectNative>
			</Field>

			{state.inputKind === "RTMP" ? (
				<div className="space-y-3">
					<p className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-400">
						{t("ui.usesTheAccountSDefaultRtmpInput")}
					</p>
					<Field
						label={t("ui.rtmpInputId")}
						htmlFor="lw-rtmp-input-id"
						help={t("ui.optionalEmptyTheAccountDefaultResolveBy")}
					>
						<Input
							id="lw-rtmp-input-id"
							placeholder="00000000-0000-4000-8000-000000000000"
							value={state.rtmp.inputId}
							onChange={(e) =>
								onPatch({ rtmp: { ...state.rtmp, inputId: e.target.value } })
							}
						/>
					</Field>
				</div>
			) : null}

			{state.inputKind === "REDUNDANT_RTMP" ? (
				<div className="space-y-3">
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<Field
							label={t("ui.inputName")}
							htmlFor="lw-rr-name"
							help={t("uiX.emptyRedundantRtmpInput")}
						>
							<Input
								id="lw-rr-name"
								value={redundant.name}
								onChange={(e) => patchRedundant({ name: e.target.value })}
							/>
						</Field>
						<Field
							label={t("ui.delayThresholdS")}
							htmlFor="lw-rr-delay"
							help={t("ui.secondsWithoutSignalBeforeSwitchingIngestPoi")}
						>
							<Input
								id="lw-rr-delay"
								type="number"
								value={redundant.delayThreshold ?? ""}
								onChange={(e) =>
									patchRedundant({
										delayThreshold: numberOrUndefined(e.target.value),
									})
								}
							/>
						</Field>
					</div>
					<fieldset>
						<legend className="font-medium text-xs text-zinc-300">
							{t("ui.ingestPointsExactlyOneModeTheSdk")}
						</legend>
						<div className="mt-2 flex gap-4">
							{(
								[
									["DYNAMIC", t("ui.dynamicRtmpEncoderIpApplication")],
									[
										"STATIC",
										t("ui.staticRtmpsIngest", { url: STATIC_INGEST_URL }),
									],
								] as const
							).map(([mode, label]) => (
								<label
									key={mode}
									className="flex items-center gap-2 text-sm text-zinc-300"
								>
									<input
										type="radio"
										name="lw-rr-mode"
										className="h-4 w-4 accent-emerald-600"
										checked={redundant.pointsMode === mode}
										onChange={() => patchRedundant({ pointsMode: mode })}
									/>
									{label}
								</label>
							))}
						</div>
					</fieldset>
					{redundant.pointsMode === "DYNAMIC" ? (
						<div className="space-y-2">
							{redundant.ingestPoints.map((point, index) => (
								<div key={index} className="flex items-start gap-2">
									<div className="flex-1">
										<Field
											label={t("uiX.namedNField", {
												item: t("uiX.ingestPoint"),
												n: index + 1,
												field: t("uiX.applicationName"),
											})}
											htmlFor={`lw-rr-app-${index}`}
										>
											<Input
												id={`lw-rr-app-${index}`}
												placeholder="liveA"
												value={point.applicationName}
												onChange={(e) => {
													const next = [...redundant.ingestPoints];
													next[index] = {
														...point,
														applicationName: e.target.value,
													};
													patchRedundant({ ingestPoints: next });
												}}
											/>
										</Field>
									</div>
									<div className="flex-1">
										<Field
											label={t("ui.streamKey")}
											htmlFor={`lw-rr-key-${index}`}
										>
											<Input
												id={`lw-rr-key-${index}`}
												value={point.streamKey}
												onChange={(e) => {
													const next = [...redundant.ingestPoints];
													next[index] = { ...point, streamKey: e.target.value };
													patchRedundant({ ingestPoints: next });
												}}
											/>
										</Field>
									</div>
									<FieldRowAction>
										<RowRemoveButton
											label={t("uiX.removeNamedN", {
												item: t("uiX.ingestPoint"),
												n: index + 1,
											})}
											onClick={() =>
												patchRedundant({
													ingestPoints: redundant.ingestPoints.filter(
														(_, i) => i !== index,
													),
												})
											}
										/>
									</FieldRowAction>
								</div>
							))}
							<Button
								variant="secondary"
								size="sm"
								onClick={() =>
									patchRedundant({
										ingestPoints: [
											...redundant.ingestPoints,
											{ applicationName: "", streamKey: "" },
										],
									})
								}
							>
								{t("ui.addIngestPoint")}
							</Button>
						</div>
					) : (
						<div className="space-y-2">
							{redundant.staticIngestPoints.map((point, index) => (
								<div key={index} className="flex items-start gap-2">
									<div className="flex-1">
										<Field
											label={t("uiX.namedNField", {
												item: t("uiX.staticPoint"),
												n: index + 1,
												field: t("uiX.nameField"),
											})}
											htmlFor={`lw-rr-sname-${index}`}
										>
											<Input
												id={`lw-rr-sname-${index}`}
												value={point.name}
												onChange={(e) => {
													const next = [...redundant.staticIngestPoints];
													next[index] = { ...point, name: e.target.value };
													patchRedundant({ staticIngestPoints: next });
												}}
											/>
										</Field>
									</div>
									<div className="flex-1">
										<Field
											label={t("ui.streamKeyConfig")}
											htmlFor={`lw-rr-skc-${index}`}
											help={t("ui.generateCreatesOneAssignUsesAnAccount")}
										>
											<SelectNative
												id={`lw-rr-skc-${index}`}
												value={point.streamKeyType}
												onChange={(e) => {
													const next = [...redundant.staticIngestPoints];
													next[index] = {
														...point,
														streamKeyType: e.target
															.value as typeof point.streamKeyType,
													};
													patchRedundant({ staticIngestPoints: next });
												}}
											>
												<option value="">{t("ui.none2")}</option>
												<option value="GENERATE">GENERATE</option>
												<option value="ASSIGN">ASSIGN</option>
											</SelectNative>
										</Field>
									</div>
									{point.streamKeyType === "ASSIGN" ? (
										<div className="flex-1">
											<Field
												label={t("ui.streamkeyId")}
												htmlFor={`lw-rr-skid-${index}`}
											>
												<Input
													id={`lw-rr-skid-${index}`}
													value={point.streamKeyId}
													onChange={(e) => {
														const next = [...redundant.staticIngestPoints];
														next[index] = {
															...point,
															streamKeyId: e.target.value,
														};
														patchRedundant({ staticIngestPoints: next });
													}}
												/>
											</Field>
										</div>
									) : null}
									<FieldRowAction>
										<RowRemoveButton
											label={t("uiX.removeNamedN", {
												item: t("uiX.staticPoint"),
												n: index + 1,
											})}
											onClick={() =>
												patchRedundant({
													staticIngestPoints:
														redundant.staticIngestPoints.filter(
															(_, i) => i !== index,
														),
												})
											}
										/>
									</FieldRowAction>
								</div>
							))}
							<Button
								variant="secondary"
								size="sm"
								onClick={() =>
									patchRedundant({
										staticIngestPoints: [
											...redundant.staticIngestPoints,
											{
												// Born named  — an empty name prunes
												// to absent and is a measured code-1000 refusal.
												name: staticPointFallbackName(
													redundant.staticIngestPoints.length,
												),
												streamKeyType: "",
												streamKeyId: "",
											},
										],
									})
								}
							>
								{t("ui.addStaticPoint")}
							</Button>
						</div>
					)}
				</div>
			) : null}

			{state.inputKind === "SRT" ? (
				<div className="space-y-3">
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<Field
							label={t("ui.inputName")}
							htmlFor="lw-srt-name"
							help={t("uiX.emptySrtInput")}
						>
							<Input
								id="lw-srt-name"
								value={srt.name}
								onChange={(e) => patchSrt({ name: e.target.value })}
							/>
						</Field>
						<Field
							label={t("ui.mode")}
							htmlFor="lw-srt-mode"
							help={
								srt.mode === "LISTENER"
									? t("ui.bitmovinListensYourEncoderCallsTheEncoder")
									: t("ui.bitmovinDialsYourSourceHost")
							}
						>
							<SelectNative
								id="lw-srt-mode"
								value={srt.mode}
								onChange={(e) =>
									patchSrt({ mode: e.target.value as "LISTENER" | "CALLER" })
								}
							>
								<option value="LISTENER">LISTENER</option>
								<option value="CALLER">CALLER</option>
							</SelectNative>
						</Field>
					</div>
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
						{srt.mode === "CALLER" ? (
							<>
								<Field label={t("ui.sourceHost")} htmlFor="lw-srt-host">
									<Input
										id="lw-srt-host"
										placeholder="203.0.113.10"
										value={srt.host}
										onChange={(e) => patchSrt({ host: e.target.value })}
									/>
								</Field>
								<Field label={t("ui.sourcePort")} htmlFor="lw-srt-cport">
									<Input
										id="lw-srt-cport"
										type="number"
										value={srt.callerPort ?? ""}
										onChange={(e) =>
											patchSrt({
												callerPort: numberOrUndefined(e.target.value),
											})
										}
									/>
								</Field>
							</>
						) : (
							<Field
								label={t("ui.listenerPort")}
								htmlFor="lw-srt-lport"
								help={t("ui.srtListenerPortsAreRestrictedTo2088")}
							>
								<SelectNative
									id="lw-srt-lport"
									value={srt.listenerPort}
									onChange={(e) =>
										patchSrt({ listenerPort: Number(e.target.value) })
									}
								>
									{SRT_LISTENER_PORTS.map((port) => (
										<option key={port} value={port}>
											{port}
										</option>
									))}
								</SelectNative>
							</Field>
						)}
						<Field
							label={t("ui.latencyMs")}
							htmlFor="lw-srt-latency"
							help={t("ui.maxAcceptedTransmissionLatencyBothPartiesMax")}
						>
							<Input
								id="lw-srt-latency"
								type="number"
								value={srt.latency ?? ""}
								onChange={(e) =>
									patchSrt({ latency: numberOrUndefined(e.target.value) })
								}
							/>
						</Field>
					</div>
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<Field
							label={t("ui.passphraseCredential")}
							htmlFor="lw-srt-cred"
							help={t("ui.vaultSrtPassphraseRefThePassphraseItself")}
						>
							<SelectNative
								id="lw-srt-cred"
								value={srt.credentialId}
								onChange={(e) => patchSrt({ credentialId: e.target.value })}
							>
								<option value="">{t("ui.noPassphrase")}</option>
								{missingCredential(srt.credentialId, srtCredentials)}
								{srtCredentials.map((c) => (
									<option key={c.id} value={c.id}>
										{c.label}
									</option>
								))}
							</SelectNative>
						</Field>
						{srt.credentialId ? (
							<Field
								label={t("ui.keyLength")}
								htmlFor="lw-srt-keylen"
								help={t("ui.mustMatchTheVaultedPassphrase12816")}
							>
								<SelectNative
									id="lw-srt-keylen"
									value={srt.keyLength}
									onChange={(e) =>
										patchSrt({
											keyLength: Number(e.target.value) as 128 | 256,
										})
									}
								>
									<option value={128}>{t("ui.k128Aes128")}</option>
									<option value={256}>{t("ui.k256Aes256")}</option>
								</SelectNative>
							</Field>
						) : null}
					</div>
					<Field
						label={t("ui.path")}
						htmlFor="lw-srt-path"
						help={t("ui.optionalStreamPathId")}
					>
						<Input
							id="lw-srt-path"
							value={srt.path}
							onChange={(e) => patchSrt({ path: e.target.value })}
						/>
					</Field>

					<div className="rounded-md border border-zinc-800 p-3">
						<div className="flex items-center justify-between">
							<h3 className="font-medium text-xs text-zinc-300">
								{t("ui.backupSrtInputsFailover")}
							</h3>
							<Button
								variant="secondary"
								size="sm"
								onClick={() =>
									patchSrt({
										backups: [
											...srt.backups,
											{
												mode: "LISTENER",
												host: "",
												port: 2089,
												credentialId: "",
												keyLength: 256,
											},
										],
									})
								}
							>
								{t("ui.addBackup")}
							</Button>
						</div>
						{srt.backups.length > 0 ? (
							<div className="mt-2 space-y-3">
								<Field
									label={t("ui.failoverDelayThresholdS")}
									htmlFor="lw-srt-bdelay"
									help={t("ui.secondsWithoutSignalBeforeSwitchingToA")}
								>
									<Input
										id="lw-srt-bdelay"
										type="number"
										value={srt.backupDelayThreshold ?? ""}
										onChange={(e) =>
											patchSrt({
												backupDelayThreshold: numberOrUndefined(e.target.value),
											})
										}
									/>
								</Field>
								{srt.backups.map((backup, index) => (
									<div key={index} className="flex flex-wrap items-start gap-2">
										<Field
											label={t("uiX.namedNField", {
												item: t("uiX.backup"),
												n: index + 1,
												field: t("uiX.modeField"),
											})}
											htmlFor={`lw-srt-b-${index}-mode`}
										>
											<SelectNative
												id={`lw-srt-b-${index}-mode`}
												className="w-32"
												value={backup.mode}
												onChange={(e) =>
													patchBackupMode(
														index,
														e.target.value as "LISTENER" | "CALLER",
													)
												}
											>
												<option value="LISTENER">LISTENER</option>
												<option value="CALLER">CALLER</option>
											</SelectNative>
										</Field>
										{backup.mode === "CALLER" ? (
											<div className="min-w-40 flex-1">
												<Field
													label={t("ui.host")}
													htmlFor={`lw-srt-b-${index}-host`}
												>
													<Input
														id={`lw-srt-b-${index}-host`}
														value={backup.host}
														onChange={(e) =>
															patchBackup(index, { host: e.target.value })
														}
													/>
												</Field>
											</div>
										) : null}
										{backup.mode === "LISTENER" ? (
											<Field
												label={t("ui.port")}
												htmlFor={`lw-srt-b-${index}-port`}
											>
												<SelectNative
													id={`lw-srt-b-${index}-port`}
													className="w-28"
													value={backup.port ?? 2089}
													onChange={(e) =>
														patchBackup(index, {
															port: Number(e.target.value),
														})
													}
												>
													{SRT_LISTENER_PORTS.map((port) => (
														<option key={port} value={port}>
															{port}
														</option>
													))}
												</SelectNative>
											</Field>
										) : (
											<Field
												label={t("ui.port")}
												htmlFor={`lw-srt-b-${index}-port`}
											>
												<Input
													id={`lw-srt-b-${index}-port`}
													type="number"
													className="w-28"
													value={backup.port ?? ""}
													onChange={(e) =>
														patchBackup(index, {
															port: numberOrUndefined(e.target.value),
														})
													}
												/>
											</Field>
										)}
										<Field
											label={t("uiX.namedNField", {
												item: t("uiX.backup"),
												n: index + 1,
												field: t("ui.path"),
											})}
											htmlFor={`lw-srt-b-${index}-path`}
											help={t("ui.optionalStreamPathId")}
										>
											<Input
												id={`lw-srt-b-${index}-path`}
												className="w-44"
												value={backup.path ?? ""}
												onChange={(e) =>
													patchBackup(index, { path: e.target.value })
												}
											/>
										</Field>
										<Field
											label={t("ui.passphraseCredential")}
											htmlFor={`lw-srt-b-${index}-cred`}
										>
											<SelectNative
												id={`lw-srt-b-${index}-cred`}
												className="w-44"
												value={backup.credentialId}
												onChange={(e) =>
													patchBackup(index, {
														credentialId: e.target.value,
													})
												}
											>
												<option value="">{t("ui.noPassphrase")}</option>
												{missingCredential(backup.credentialId, srtCredentials)}
												{srtCredentials.map((c) => (
													<option key={c.id} value={c.id}>
														{c.label}
													</option>
												))}
											</SelectNative>
										</Field>
										{backup.credentialId ? (
											<Field
												label={t("ui.keyLength")}
												htmlFor={`lw-srt-b-${index}-keylen`}
											>
												<SelectNative
													id={`lw-srt-b-${index}-keylen`}
													className="w-28"
													value={backup.keyLength}
													onChange={(e) =>
														patchBackup(index, {
															keyLength: Number(e.target.value) as 128 | 256,
														})
													}
												>
													<option value={128}>128</option>
													<option value={256}>256</option>
												</SelectNative>
											</Field>
										) : null}
										<FieldRowAction>
											<RowRemoveButton
												label={t("uiX.removeNamedN", {
													item: t("uiX.backup"),
													n: index + 1,
												})}
												onClick={() =>
													patchSrt({
														backups: srt.backups.filter((_, i) => i !== index),
													})
												}
											/>
										</FieldRowAction>
									</div>
								))}
							</div>
						) : (
							<p className="mt-2 text-xs text-zinc-500">
								{t("ui.noBackupsTheSingleSrtConnectionIs")}
							</p>
						)}
					</div>
				</div>
			) : null}

			{state.inputKind === "ZIXI" ? (
				<div className="space-y-3">
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<Field
							label={t("ui.inputName")}
							htmlFor="lw-zixi-name"
							help={t("uiX.emptyZixiInput")}
						>
							<Input
								id="lw-zixi-name"
								value={state.zixi.name}
								onChange={(e) =>
									onPatch({ zixi: { ...state.zixi, name: e.target.value } })
								}
							/>
						</Field>
						<Field label={t("ui.host")} htmlFor="lw-zixi-host">
							<Input
								id="lw-zixi-host"
								placeholder={t("ui.zixiFeederExampleCom")}
								value={state.zixi.host}
								onChange={(e) =>
									onPatch({ zixi: { ...state.zixi, host: e.target.value } })
								}
							/>
						</Field>
					</div>
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<Field label={t("ui.port")} htmlFor="lw-zixi-port">
							<Input
								id="lw-zixi-port"
								type="number"
								value={state.zixi.port ?? ""}
								onChange={(e) =>
									onPatch({
										zixi: {
											...state.zixi,
											port: numberOrUndefined(e.target.value),
										},
									})
								}
							/>
						</Field>
						<Field label={t("ui.stream")} htmlFor="lw-zixi-stream">
							<Input
								id="lw-zixi-stream"
								value={state.zixi.stream}
								onChange={(e) =>
									onPatch({
										zixi: { ...state.zixi, stream: e.target.value },
									})
								}
							/>
						</Field>
					</div>
					<Field
						label={t("ui.zixiCredential")}
						htmlFor="lw-zixi-cred"
						help={t("ui.vaultZixiRefPasswordAndOrDecryption")}
					>
						<SelectNative
							id="lw-zixi-cred"
							value={state.zixi.credentialId}
							onChange={(e) =>
								onPatch({
									zixi: { ...state.zixi, credentialId: e.target.value },
								})
							}
						>
							<option value="">{t("ui.selectCredential")}</option>
							{missingCredential(state.zixi.credentialId, zixiCredentials)}
							{zixiCredentials.map((c) => (
								<option key={c.id} value={c.id}>
									{c.label}
								</option>
							))}
						</SelectNative>
					</Field>
					<NewCredentialLink />
					<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
						<Field label={t("ui.latencyMs")} htmlFor="lw-zixi-latency">
							<Input
								id="lw-zixi-latency"
								type="number"
								value={state.zixi.latency ?? ""}
								onChange={(e) =>
									onPatch({
										zixi: {
											...state.zixi,
											latency: numberOrUndefined(e.target.value),
										},
									})
								}
							/>
						</Field>
						<Field label={t("ui.minBitrateBps")} htmlFor="lw-zixi-minbr">
							<Input
								id="lw-zixi-minbr"
								type="number"
								value={state.zixi.minBitrate ?? ""}
								onChange={(e) =>
									onPatch({
										zixi: {
											...state.zixi,
											minBitrate: numberOrUndefined(e.target.value),
										},
									})
								}
							/>
						</Field>
						<Field
							label={t("ui.decryptionType")}
							htmlFor="lw-zixi-dec"
							help={t("ui.sdkPassthroughEGAes128")}
						>
							<Input
								id="lw-zixi-dec"
								value={state.zixi.decryptionType}
								onChange={(e) =>
									onPatch({
										zixi: { ...state.zixi, decryptionType: e.target.value },
									})
								}
							/>
						</Field>
					</div>
				</div>
			) : null}

			{state.inputKind === "HLS" ? (
				<div className="space-y-3">
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<Field
							label={t("ui.inputName")}
							htmlFor="lw-hls-name"
							help={t("uiX.emptyHlsInput")}
						>
							<Input
								id="lw-hls-name"
								value={state.hlsIn.name}
								onChange={(e) =>
									onPatch({ hlsIn: { ...state.hlsIn, name: e.target.value } })
								}
							/>
						</Field>
						<Field
							label={t("ui.adMarkersSource")}
							htmlFor="lw-hls-markers"
							help={t("ui.whereScte35MarkersAreReadFrom")}
						>
							<SelectNative
								id="lw-hls-markers"
								value={state.hlsIn.adMarkersSource}
								onChange={(e) =>
									onPatch({
										hlsIn: {
											...state.hlsIn,
											adMarkersSource: e.target
												.value as LiveWizardState["hlsIn"]["adMarkersSource"],
										},
									})
								}
							>
								<option value="">{t("ui.default")}</option>
								<option value="MANIFEST">MANIFEST</option>
								<option value="SEGMENTS">SEGMENTS</option>
							</SelectNative>
						</Field>
					</div>
					<Field label={t("ui.sourceUrl")} htmlFor="lw-hls-url">
						<Input
							id="lw-hls-url"
							placeholder="https://origin.example.com/live/stream.m3u8"
							value={state.hlsIn.url}
							onChange={(e) =>
								onPatch({ hlsIn: { ...state.hlsIn, url: e.target.value } })
							}
						/>
					</Field>
				</div>
			) : null}
		</div>
	);
}
