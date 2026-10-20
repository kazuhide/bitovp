"use client";

import {
	liveChannelPlanSchema,
	MAX_RUN_CAP_MARGIN_MINUTES,
} from "@bitovp/core";
import { useMemo } from "react";
import { CodesInput, Collapsible } from "@/app/vod/new/wizard-fields";
import {
	InfrastructureIdPicker,
	StaticIpIdPicker,
} from "@/components/infrastructure-pickers";
import { LiveCostEstimate } from "@/components/live-cost-estimate";
import { RegionSelect } from "@/components/region-select";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { InfoHint } from "@/components/ui/info-hint";
import { Input, SelectNative } from "@/components/ui/input";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import type {
	LiveAdInsertionState,
	LiveCacheControlState,
	LiveCacheControlValue,
	LiveEsamState,
	LiveStartState,
	LiveWizardState,
} from "./build-live-plan";
import {
	buildLiveChannelPlan,
	collapseGroup,
	streamKeyManagedByIngestPoint,
} from "./build-live-plan";

type StartSectionProps = {
	state: LiveWizardState;
	onPatch: (partial: Partial<LiveWizardState>) => void;
	/** The schedule's programEndAt when step 7 holds a valid slot — the cost
	 * estimate seeds from the REAL billable window (review-260 #125 prep:
	 * a flat 60 beside the "billing starts at creation" sentence disagreed
	 * with it for any airing that is not an hour). */
	scheduledEndAt?: string | null;
};

function numberOrUndefined(raw: string): number | undefined {
	return raw === "" ? undefined : Number(raw);
}

const AUTO_RESTART_TIMEOUTS: {
	key: keyof Pick<
		LiveStartState["autoRestart"],
		| "segmentsWrittenTimeout"
		| "bytesWrittenTimeout"
		| "framesWrittenTimeout"
		| "hlsManifestsUpdateTimeout"
		| "dashManifestsUpdateTimeout"
	>;
	labelKey: MessageKey;
	tooltipKey: MessageKey;
}[] = [
	{
		key: "segmentsWrittenTimeout",
		labelKey: "ui.segmentsWrittenTimeoutS",
		tooltipKey: "ui.restartIfNoSegmentsAreWrittenFor",
	},
	{
		key: "bytesWrittenTimeout",
		labelKey: "ui.bytesWrittenTimeoutS",
		tooltipKey: "ui.restartIfNoDataAtAllIs",
	},
	{
		key: "framesWrittenTimeout",
		labelKey: "ui.framesWrittenTimeoutS",
		tooltipKey: "ui.restartIfNoFramesAreEncodedFor",
	},
	{
		key: "hlsManifestsUpdateTimeout",
		labelKey: "ui.hlsManifestsUpdateTimeoutS",
		tooltipKey: "ui.restartIfHlsManifestsStopUpdatingFor",
	},
	{
		key: "dashManifestsUpdateTimeout",
		labelKey: "ui.dashManifestsUpdateTimeoutS",
		tooltipKey: "ui.restartIfDashManifestsStopUpdatingFor",
	},
];

const ESAM_FIELDS: {
	key: "poisEndpoint" | "acquisitionPointIdentity" | "zoneIdentity";
	labelKey: MessageKey;
	placeholder?: string;
	hintKey: MessageKey;
}[] = [
	{
		key: "poisEndpoint",
		labelKey: "ui.poisEndpoint",
		placeholder: "https://pois.example.com/esam/signalProcessingEvent",
		hintKey: "ui.signalProcessingUrlTheEncoderPostsA",
	},
	{
		key: "acquisitionPointIdentity",
		labelKey: "ui.acquisitionPointIdentity",
		hintKey: "ui.identifiesThisEncoderToThePoisScte",
	},
	{
		key: "zoneIdentity",
		labelKey: "ui.zoneIdentity",
		hintKey: "ui.optionalZoneRegionTagSentWithEvery",
	},
];

/** One Cache-Control header input; "" clears the leaf entirely. */
function CacheControlField({
	id,
	label,
	help,
	value,
	onChange,
}: {
	id: string;
	label: string;
	help: string;
	value: LiveCacheControlValue | undefined;
	onChange: (next: LiveCacheControlValue | undefined) => void;
}) {
	const { t } = useT();
	return (
		<Field label={label} htmlFor={id} help={help}>
			<Input
				id={id}
				placeholder={t("ui.publicMaxAge0NoCache")}
				value={value?.cacheControl ?? ""}
				onChange={(e) =>
					onChange(
						e.target.value === ""
							? undefined
							: { cacheControl: e.target.value },
					)
				}
			/>
		</Field>
	);
}

/** Reupload interval row with the explicit-null "never" checkbox. */
function ReuploadRow({
	id,
	label,
	tooltip,
	value,
	onChange,
}: {
	id: string;
	label: string;
	tooltip?: string;
	value: number | null | undefined;
	onChange: (next: number | null | undefined) => void;
}) {
	const { t } = useT();
	return (
		<Field
			label={label}
			htmlFor={id}
			help={[tooltip, t("ui.k30sUnsetApiDefaultNeverSendsAn")]
				.filter(Boolean)
				.join(" ")}
		>
			<div className="flex items-center gap-3">
				<Input
					id={id}
					type="number"
					className="w-32"
					disabled={value === null}
					value={typeof value === "number" ? value : ""}
					onChange={(e) => onChange(numberOrUndefined(e.target.value))}
				/>
				<label className="flex items-center gap-2 text-xs text-zinc-400">
					<input
						type="checkbox"
						className="h-3.5 w-3.5 accent-emerald-600"
						checked={value === null}
						onChange={(e) => onChange(e.target.checked ? null : undefined)}
					/>
					{t("ui.neverReUploadNull")}
				</label>
			</div>
		</Field>
	);
}

export function LiveStartSection({
	state,
	onPatch,
	scheduledEndAt,
}: StartSectionProps) {
	const { t } = useT();
	const start = state.start;
	const patchStart = (partial: Partial<LiveStartState>) =>
		onPatch({ start: { ...start, ...partial } });
	const patchAutoRestart = (partial: Partial<LiveStartState["autoRestart"]>) =>
		patchStart({ autoRestart: { ...start.autoRestart, ...partial } });
	const patchAutoShutdown = (
		partial: Partial<LiveStartState["autoShutdown"]>,
	) => patchStart({ autoShutdown: { ...start.autoShutdown, ...partial } });
	// P5 PR-3 signaling groups: every patch collapses the group to undefined once
	// its last field is cleared, so a filled-then-emptied form emits no plan key.
	const esam = start.esam;
	const patchEsam = (partial: Partial<LiveEsamState>) =>
		patchStart({ esam: collapseGroup({ ...esam, ...partial }) });
	const adInsertion = start.adInsertion;
	const patchAdInsertion = (partial: Partial<LiveAdInsertionState>) =>
		patchStart({ adInsertion: collapseGroup({ ...adInsertion, ...partial }) });
	const cacheControl = start.cacheControl;
	const patchCacheControl = (partial: Partial<LiveCacheControlState>) =>
		patchStart({
			cacheControl: collapseGroup({ ...cacheControl, ...partial }),
		});
	const patchCacheHls = (
		partial: Partial<NonNullable<LiveCacheControlState["hls"]>>,
	) =>
		patchCacheControl({
			hls: collapseGroup({ ...cacheControl?.hls, ...partial }),
		});
	const patchCacheDash = (
		partial: Partial<NonNullable<LiveCacheControlState["dash"]>>,
	) =>
		patchCacheControl({
			dash: collapseGroup({ ...cacheControl?.dash, ...partial }),
		});
	const patchCacheSegments = (
		partial: Partial<NonNullable<LiveCacheControlState["segments"]>>,
	) =>
		patchCacheControl({
			segments: collapseGroup({ ...cacheControl?.segments, ...partial }),
		});
	// Infrastructure (Cloud Connect) — mirrors the VOD Encoding-options group:
	// both fields required together (schema), both-empty collapses to undefined
	// so default plans emit no bitmovin.infrastructure key.
	const infrastructure = state.infrastructure;
	const patchInfrastructure = (
		partial: Partial<NonNullable<LiveWizardState["infrastructure"]>>,
	) => {
		const next = {
			infrastructureId: infrastructure?.infrastructureId ?? "",
			cloudRegion: infrastructure?.cloudRegion ?? "",
			...partial,
		};
		const cleared = next.infrastructureId === "" && next.cloudRegion === "";
		onPatch({
			infrastructure: cleared ? undefined : next,
			// C18 auto-switch (C1 precedent, mirrors the VOD wizard): Cloud
			// Connect requires the channel's TOP-LEVEL cloudRegion EXTERNAL.
			...(!cleared && state.cloudRegion !== "EXTERNAL"
				? { cloudRegion: "EXTERNAL" }
				: {}),
		});
	};

	return (
		<div className="space-y-4">
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
				{streamKeyManagedByIngestPoint(state) ? (
					<Field label={t("ui.streamKey")} htmlFor="lw-streamkey-managed">
						<p
							id="lw-streamkey-managed"
							className="text-sm text-zinc-400"
							data-testid="lw-streamkey-managed"
						>
							{t("ui.streamKeyManagedByStaticPoint")}
						</p>
					</Field>
				) : (
					<Field
						label={t("ui.streamKey")}
						htmlFor="lw-streamkey"
						help={t("ui.lettersOnlyAZAZ3")}
					>
						<Input
							id="lw-streamkey"
							placeholder="myStreamKey"
							value={start.streamKey}
							onChange={(e) => patchStart({ streamKey: e.target.value })}
						/>
					</Field>
				)}
				<Field
					label={t("ui.liveEncodingMode")}
					htmlFor="lw-encmode"
					help={t("ui.onlyValidWhenNoCodecConfigSets")}
				>
					<SelectNative
						id="lw-encmode"
						value={start.liveEncodingMode}
						onChange={(e) =>
							patchStart({
								liveEncodingMode: e.target
									.value as LiveStartState["liveEncodingMode"],
							})
						}
					>
						<option value="">{t("ui.default")}</option>
						<option value="STANDARD">STANDARD</option>
						<option value="SINGLE_PASS">SINGLE_PASS</option>
						<option value="TWO_PASS">TWO_PASS</option>
						<option value="THREE_PASS">THREE_PASS</option>
					</SelectNative>
				</Field>
			</div>

			<div className="rounded-md border border-zinc-800 p-3">
				<div className="flex items-center gap-1.5">
					<h3 className="font-medium text-xs text-zinc-300">
						{t("ui.autoRestart")}
					</h3>
					<HelpOverlay
						label={t("uiX.moreInformationFor", { label: t("ui.autoRestart") })}
					>
						{t("ui.everyTimeoutHasAnApiMinimumOf")}
					</HelpOverlay>
				</div>
				<div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
					{AUTO_RESTART_TIMEOUTS.map((timeout) => (
						<Field
							key={timeout.key}
							label={t(timeout.labelKey)}
							htmlFor={`lw-ar-${timeout.key}`}
							hint="≥30s"
							tooltip={t(timeout.tooltipKey)}
						>
							<Input
								id={`lw-ar-${timeout.key}`}
								type="number"
								value={start.autoRestart[timeout.key] ?? ""}
								onChange={(e) =>
									patchAutoRestart({
										[timeout.key]: numberOrUndefined(e.target.value),
									})
								}
							/>
						</Field>
					))}
					<Field
						label={t("ui.scheduleExpression")}
						htmlFor="lw-ar-schedule"
						help={[t("uiX.restartOnFixedSchedule"), t("uiX.unixCrontabExample")]
							.filter(Boolean)
							.join(" ")}
					>
						<Input
							id="lw-ar-schedule"
							value={start.autoRestart.scheduleExpression}
							onChange={(e) =>
								patchAutoRestart({ scheduleExpression: e.target.value })
							}
						/>
					</Field>
				</div>
				<div className="mt-3 flex items-center gap-2">
					<label
						htmlFor="lw-ar-onerror"
						className="flex items-center gap-2 text-sm text-zinc-300"
					>
						<input
							id="lw-ar-onerror"
							type="checkbox"
							className="h-4 w-4 accent-emerald-600"
							checked={start.autoRestart.restartOnEncoderError === true}
							onChange={(e) =>
								patchAutoRestart({ restartOnEncoderError: e.target.checked })
							}
						/>
						{t("ui.restartOnEncoderError")}
					</label>
					<InfoHint
						text={t("ui.automaticallyRestartWhenTheEncodingHitsAn")}
						label={t("ui.restartOnEncoderErrorMoreInformation")}
					/>
				</div>
			</div>

			<div className="rounded-md border border-zinc-800 p-3">
				<div className="flex items-center gap-1.5">
					<h3 className="font-medium text-xs text-zinc-300">
						{t("ui.autoShutdown")}
					</h3>
					<HelpOverlay
						label={t("uiX.moreInformationFor", { label: t("ui.autoShutdown") })}
					>
						{t("ui.independentOfAutoRestartARestartDoes")}
					</HelpOverlay>
				</div>
				<div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-4">
					<Field
						label={`${t("ui.bytesReadTimeoutS")} (≥30)`}
						htmlFor="lw-as-bytes"
						help={[
							t("uiX.shutDownNoInput"),
							t("ui.shutDownAfterNoInputBytesFor"),
						]
							.filter(Boolean)
							.join(" ")}
					>
						<Input
							id="lw-as-bytes"
							type="number"
							min={30}
							value={start.autoShutdown.bytesReadTimeoutSeconds ?? ""}
							onChange={(e) =>
								patchAutoShutdown({
									bytesReadTimeoutSeconds: numberOrUndefined(e.target.value),
								})
							}
						/>
					</Field>
					<Field
						label={`${t("ui.streamTimeoutMin")} (≥5)`}
						htmlFor="lw-as-stream"
						help={[
							t("uiX.shutDownTotalRuntime"),
							t("ui.maximumOverallStreamDuration"),
						]
							.filter(Boolean)
							.join(" ")}
					>
						<Input
							id="lw-as-stream"
							type="number"
							min={5}
							value={start.autoShutdown.streamTimeoutMinutes ?? ""}
							onChange={(e) =>
								patchAutoShutdown({
									streamTimeoutMinutes: numberOrUndefined(e.target.value),
								})
							}
						/>
					</Field>
					<Field
						label={`${t("ui.firstConnectTimeoutMin")} (≥5)`}
						htmlFor="lw-as-first"
						help={[
							t("uiX.shutDownNeverConnects"),
							t("ui.shutDownIfNoEncoderEverConnects"),
						]
							.filter(Boolean)
							.join(" ")}
					>
						<Input
							id="lw-as-first"
							type="number"
							min={5}
							value={
								start.autoShutdown.waitingForFirstConnectTimeoutMinutes ?? ""
							}
							onChange={(e) =>
								patchAutoShutdown({
									waitingForFirstConnectTimeoutMinutes: numberOrUndefined(
										e.target.value,
									),
								})
							}
						/>
					</Field>
				</div>
			</div>

			<div className="rounded-md border border-zinc-800 p-3">
				<div className="flex items-center gap-1.5">
					<h3 className="font-medium text-xs text-zinc-300">
						{t("ui.reUploadSettings")}
					</h3>
					<HelpOverlay
						label={t("uiX.moreInformationFor", {
							label: t("ui.reUploadSettings"),
						})}
					>
						{t("ui.hlsManifestIntervalIsDeliberatelyAbsentThe")}
					</HelpOverlay>
				</div>
				<div className="mt-3 space-y-3">
					<ReuploadRow
						id="lw-ru-dash"
						label={t("ui.dashManifestIntervalS")}
						tooltip={t("uiX.dashRepushTooltip")}
						value={start.reupload.dashManifestInterval}
						onChange={(dashManifestInterval) =>
							patchStart({
								reupload: { ...start.reupload, dashManifestInterval },
							})
						}
					/>
					<ReuploadRow
						id="lw-ru-init"
						label={t("ui.muxingInitFileIntervalS")}
						tooltip={t("uiX.initRepushTooltip")}
						value={start.reupload.muxingInitFileInterval}
						onChange={(muxingInitFileInterval) =>
							patchStart({
								reupload: { ...start.reupload, muxingInitFileInterval },
							})
						}
					/>
				</div>
			</div>

			<div className="rounded-md border border-zinc-800 p-3">
				<h3 className="font-medium text-xs text-zinc-300">
					{t("ui.encodingPlacementAdvanced")}
				</h3>
				<div className="mt-3 space-y-3">
					<Field
						label={t("ui.staticIpId")}
						htmlFor="lw-staticip"
						help={t("ui.reservedInSettingsInfrastructureConsumedWhen")}
					>
						<StaticIpIdPicker
							inputId="lw-staticip"
							value={state.staticIpId ?? ""}
							onChange={(staticIpId) =>
								onPatch({ staticIpId: staticIpId || undefined })
							}
							bitmovinAccountId={state.accountId || undefined}
						/>
					</Field>
					<Field
						label={t("ui.labels")}
						htmlFor="lw-labels"
						help={t("ui.commaSeparatedEncodingLabelsTagsThatGroup")}
					>
						<CodesInput
							id="lw-labels"
							placeholder={t("ui.campaignAUhd")}
							value={state.labels}
							onChange={(labels) => onPatch({ labels })}
						/>
					</Field>
					<Collapsible
						summary={t("ui.infrastructureAdvanced")}
						help={t("ui.pinThisEncodingOntoACloudConnect2")}
					>
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<Field label={t("ui.infrastructureId")} htmlFor="lw-infra-id">
								<InfrastructureIdPicker
									inputId="lw-infra-id"
									value={infrastructure?.infrastructureId ?? ""}
									onChange={(infrastructureId) =>
										patchInfrastructure({ infrastructureId })
									}
									bitmovinAccountId={state.accountId || undefined}
								/>
							</Field>
							<Field
								label={t("ui.infrastructureRegion")}
								htmlFor="lw-infra-region"
							>
								<RegionSelect
									id="lw-infra-region"
									value={infrastructure?.cloudRegion ?? ""}
									onChange={(cloudRegion) =>
										patchInfrastructure({ cloudRegion })
									}
								/>
							</Field>
						</div>
					</Collapsible>
				</div>
			</div>

			<Collapsible summary={t("ui.signalingDeliveryAdvanced")}>
				<div className="rounded-md border border-zinc-800 p-3">
					<h4 className="font-medium text-xs text-zinc-300">
						{t("ui.esamPoisScte250")}
					</h4>
					<p className="mt-1 text-[11px] text-zinc-500">
						{t("ui.outOfBandAdSignalingTheEncoder")}
					</p>
					<div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
						{ESAM_FIELDS.map((field) => (
							<Field
								key={field.key}
								label={t(field.labelKey)}
								htmlFor={`lw-esam-${field.key}`}
								help={t(field.hintKey)}
							>
								<Input
									id={`lw-esam-${field.key}`}
									placeholder={field.placeholder}
									value={esam?.[field.key] ?? ""}
									onChange={(e) =>
										patchEsam({ [field.key]: e.target.value || undefined })
									}
								/>
							</Field>
						))}
						<Field
							label={t("ui.adAvailOffsetMs")}
							htmlFor="lw-esam-offset"
							help={t("ui.millisecondsAddedToTheStreamtimePtsOf")}
						>
							<Input
								id="lw-esam-offset"
								type="number"
								value={esam?.adAvailOffset ?? ""}
								onChange={(e) =>
									patchEsam({
										adAvailOffset: numberOrUndefined(e.target.value),
									})
								}
							/>
						</Field>
						<Field
							label={t("ui.poisCredentialId")}
							htmlFor="lw-esam-cred"
							help={t("ui.poisEndpointVaultCredentialUsernamePasswordI")}
						>
							<Input
								id="lw-esam-cred"
								placeholder="00000000-0000-4000-8000-000000000000"
								value={esam?.poisCredentialId ?? ""}
								onChange={(e) =>
									patchEsam({ poisCredentialId: e.target.value || undefined })
								}
							/>
						</Field>
					</div>
				</div>

				<div className="rounded-md border border-zinc-800 p-3">
					<h4 className="font-medium text-xs text-zinc-300">
						{t("ui.adInsertion")}
					</h4>
					<div className="mt-3 flex items-center gap-2">
						<label
							htmlFor="lw-ai-esam-mediapoint"
							className="flex items-center gap-2 text-sm text-zinc-300"
						>
							<input
								id="lw-ai-esam-mediapoint"
								type="checkbox"
								className="h-4 w-4 accent-emerald-600"
								checked={adInsertion?.enableEsamMediaPointInsertion === true}
								onChange={(e) =>
									patchAdInsertion({
										enableEsamMediaPointInsertion: e.target.checked
											? true
											: undefined,
									})
								}
							/>
							{t("ui.enableEsamMediaPointInsertion")}
						</label>
						<InfoHint
							text={t("ui.gateForInsertingEsamMediaPointsWhile")}
							label={t("ui.esamMediaPointInsertionMoreInformation")}
						/>
					</div>
					<div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
						<Field
							label={t("ui.clockSynchronizationMode")}
							htmlFor="lw-ai-clock"
							help={t("ui.c19WhenAnHlsManifestSetsA")}
						>
							<SelectNative
								id="lw-ai-clock"
								value={adInsertion?.clockSynchronizationMode ?? ""}
								onChange={(e) =>
									patchAdInsertion({
										clockSynchronizationMode:
											(e.target
												.value as LiveAdInsertionState["clockSynchronizationMode"]) ||
											undefined,
									})
								}
							>
								<option value="">{t("ui.default")}</option>
								<option value="SYSTEM_CLOCK">SYSTEM_CLOCK</option>
								<option value="EMBEDDED">EMBEDDED</option>
							</SelectNative>
						</Field>
					</div>
				</div>

				<div className="rounded-md border border-zinc-800 p-3">
					<h4 className="font-medium text-xs text-zinc-300">
						{t("ui.cacheControl")}
					</h4>
					<p className="mt-1 text-[11px] text-zinc-500">
						{t("ui.perArtifact")} <code>{t("ui.cacheControl")}</code>{" "}
						{t("uiX.cacheControlHint")}
					</p>
					<div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
						<CacheControlField
							id="lw-cc-hls-multi"
							label={t("ui.hlsMultiVariantPlaylist")}
							help={t("ui.theMasterM3u8UsuallyShortLivedRendition")}
							value={cacheControl?.hls?.multiVariantPlaylist}
							onChange={(multiVariantPlaylist) =>
								patchCacheHls({ multiVariantPlaylist })
							}
						/>
						<CacheControlField
							id="lw-cc-hls-variant"
							label={t("ui.hlsVariantPlaylist")}
							help={t("ui.perRenditionMediaPlaylistsRefreshedEverySegm")}
							value={cacheControl?.hls?.variantPlaylist}
							onChange={(variantPlaylist) => patchCacheHls({ variantPlaylist })}
						/>
						<CacheControlField
							id="lw-cc-dash-timeline"
							label={t("ui.dashTimelineManifest")}
							help={t("ui.mpdWrittenForSegmenttimelineRepresentations")}
							value={cacheControl?.dash?.timelineManifest}
							onChange={(timelineManifest) =>
								patchCacheDash({ timelineManifest })
							}
						/>
						<CacheControlField
							id="lw-cc-dash-template"
							label={t("ui.dashTemplateManifest")}
							help={t("ui.mpdWrittenForSegmenttemplateRepresentations")}
							value={cacheControl?.dash?.templateManifest}
							onChange={(templateManifest) =>
								patchCacheDash({ templateManifest })
							}
						/>
						<CacheControlField
							id="lw-cc-seg-init"
							label={t("ui.initSegment")}
							help={t("ui.fmp4InitMp4ImmutableForTheLife")}
							value={cacheControl?.segments?.initSegment}
							onChange={(initSegment) => patchCacheSegments({ initSegment })}
						/>
						<CacheControlField
							id="lw-cc-seg-media"
							label={t("ui.mediaSegment")}
							help={t("ui.eachMediaSegmentImmutableOnceWritten")}
							value={cacheControl?.segments?.mediaSegment}
							onChange={(mediaSegment) => patchCacheSegments({ mediaSegment })}
						/>
					</div>
				</div>
			</Collapsible>

			{/* Cost estimate : pure client arithmetic over the
			    account's rate card for a hypothetical duration — renders only
			    when the in-progress state already builds a valid plan. */}
			<EstimateBlock state={state} scheduledEndAt={scheduledEndAt ?? null} />
		</div>
	);
}

function EstimateBlock({
	state,
	scheduledEndAt,
}: {
	state: LiveWizardState;
	scheduledEndAt: string | null;
}) {
	const { t } = useT();
	const plan = useMemo(() => {
		const parsed = liveChannelPlanSchema.safeParse(buildLiveChannelPlan(state));
		return parsed.success ? parsed.data : null;
	}, [state]);
	if (!plan || !state.accountId) {
		return null;
	}
	return (
		<div className="rounded-md border border-zinc-800 p-3">
			<p className="text-xs text-zinc-400">{t("estimate.title")}</p>
			<p className="mt-1 text-[11px] text-zinc-600">
				{t("estimate.wizardExplainer")}
			</p>
			<div className="mt-2">
				<LiveCostEstimate
					plan={plan}
					bitmovinAccountId={state.accountId}
					// Seeded from provision(now)→programEndAt + margin when a
					// slot exists — the same arithmetic the derived cap uses
					// (#125), so the sentence above and the number agree.
					defaultMinutes={
						scheduledEndAt
							? Math.max(
									1,
									Math.ceil(
										(Date.parse(scheduledEndAt) - Date.now()) / 60_000,
									) + MAX_RUN_CAP_MARGIN_MINUTES,
								)
							: 60
					}
				/>
			</div>
		</div>
	);
}
