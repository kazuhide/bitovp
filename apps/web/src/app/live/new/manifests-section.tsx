"use client";

import type { ReactNode } from "react";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { InfoHint } from "@/components/ui/info-hint";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type {
	LiveAdMarkerOptionsState,
	LiveHlsMarkerType,
	LivePdtPlacementMode,
	LivePdtSettingsState,
	LiveWizardState,
} from "./build-live-plan";
import { collapseGroup } from "./build-live-plan";
import { DvrGauge, type DvrLeg } from "./dvr-gauge";

type ManifestsSectionProps = {
	state: LiveWizardState;
	onPatch: (partial: Partial<LiveWizardState>) => void;
	manifestKind?: "HLS" | "DASH";
	idPrefix?: string;
};

/**
 * Muxing legs a manifest would enumerate, mirroring core's
 * selectLiveManifestMuxings: HLS takes FMP4+TS (pinnable per family),
 * DASH takes FMP4/CMAF. Drives the C8 gauge so it counts exactly what the
 * validator will count.
 */
export function manifestLegs(
	state: LiveWizardState,
	kind: "HLS" | "DASH",
): DvrLeg[] {
	const videoPin = kind === "HLS" ? state.manifests.hls.videoMuxingKind : "";
	const audioPin = kind === "HLS" ? state.manifests.hls.audioMuxingKind : "";
	const legs: DvrLeg[] = [];
	for (const video of state.videos) {
		const container = video.container ?? "FMP4";
		if (kind === "HLS" && container === "CMAF") continue;
		if (kind === "DASH" && container !== "FMP4" && container !== "CMAF") {
			continue;
		}
		if (kind === "HLS" && videoPin !== "" && container !== videoPin) {
			continue;
		}
		legs.push({ segmentLengthSec: state.segmentLength });
	}
	for (const audio of state.audios) {
		const container = audio.container ?? "FMP4";
		if (kind === "HLS" && container === "CMAF") continue;
		if (kind === "DASH" && container !== "FMP4" && container !== "CMAF") {
			continue;
		}
		if (kind === "HLS" && audioPin !== "" && container !== audioPin) {
			continue;
		}
		legs.push({ segmentLengthSec: state.segmentLength });
	}
	return legs;
}

function numberOrUndefined(raw: string): number | undefined {
	return raw === "" ? undefined : Number(raw);
}

/** Placement modes whose interval the schema refine REQUIRES. */
const PDT_INTERVAL_MODES = new Set<LivePdtPlacementMode>([
	"SEGMENTS_INTERVAL",
	"SECONDS_INTERVAL",
]);

/** Canonical enum order — the emitted list is sorted so it stays stable. */
const HLS_MARKER_TYPES: LiveHlsMarkerType[] = [
	"EXT_X_CUE_OUT_IN",
	"EXT_OATCLS_SCTE35",
	"EXT_X_SPLICEPOINT_SCTE35",
	"EXT_X_DATERANGE",
	"EXT_X_SCTE35",
];

function ManifestCard({
	kind,
	selected,
	children,
}: {
	kind: "HLS" | "DASH" | "PRIMARY";
	selected?: "HLS" | "DASH";
	children: ReactNode;
}) {
	return !selected || kind === selected ? (
		<div className="rounded-md border border-zinc-800 p-3">{children}</div>
	) : null;
}

export function LiveManifestsSection({
	state,
	onPatch,
	manifestKind,
	idPrefix = "lw",
}: ManifestsSectionProps) {
	const { t } = useT();
	const hls = state.manifests.hls;
	const dash = state.manifests.dash;
	const patchHls = (partial: Partial<typeof hls>) =>
		onPatch({ manifests: { ...state.manifests, hls: { ...hls, ...partial } } });
	const pdt = hls.programDateTimeSettings;
	const patchPdt = (partial: Partial<LivePdtSettingsState>) =>
		patchHls({
			programDateTimeSettings: collapseGroup({ ...pdt, ...partial }),
		});
	const placementMode = pdt?.placement?.mode;
	const patchPlacementMode = (raw: string) =>
		patchPdt({
			placement:
				raw === ""
					? undefined
					: {
							mode: raw as LivePdtPlacementMode,
							// The interval only means anything for the *_INTERVAL modes.
							...(PDT_INTERVAL_MODES.has(raw as LivePdtPlacementMode) &&
							pdt?.placement?.interval !== undefined
								? { interval: pdt.placement.interval }
								: {}),
						},
		});
	const markerOptions = state.adMarkerOptions;
	const patchMarkerOptions = (partial: Partial<LiveAdMarkerOptionsState>) =>
		onPatch({
			adMarkerOptions: collapseGroup({ ...markerOptions, ...partial }),
		});
	const toggleMarkerType = (type: LiveHlsMarkerType, on: boolean) => {
		const current = markerOptions?.hlsMarkerTypes ?? [];
		const next = HLS_MARKER_TYPES.filter((candidate) =>
			candidate === type ? on : current.includes(candidate),
		);
		// Empty ⇒ unset ⇒ the C14 default [EXT_X_DATERANGE] (schema .min(1)).
		patchMarkerOptions({
			hlsMarkerTypes: next.length > 0 ? next : undefined,
		});
	};
	const patchDash = (partial: Partial<typeof dash>) =>
		onPatch({
			manifests: { ...state.manifests, dash: { ...dash, ...partial } },
		});

	return (
		<div className="space-y-4">
			<ManifestCard kind="HLS" selected={manifestKind}>
				<label
					htmlFor={`${idPrefix}-hls-enabled`}
					className="flex items-center gap-2 font-medium text-sm text-zinc-200"
				>
					<input
						id={`${idPrefix}-hls-enabled`}
						type="checkbox"
						className="h-4 w-4 accent-emerald-600"
						checked={hls.enabled}
						onChange={(e) => patchHls({ enabled: e.target.checked })}
					/>
					{t("ui.hlsManifest")}
				</label>
				{hls.enabled ? (
					<div className="mt-3 space-y-3">
						<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
							<Field
								label={t("ui.manifestName")}
								htmlFor={`${idPrefix}-hls-mname`}
								help={t("uiX.emptyStreamM3u8")}
							>
								<Input
									id={`${idPrefix}-hls-mname`}
									value={hls.manifestName}
									onChange={(e) => patchHls({ manifestName: e.target.value })}
								/>
							</Field>
							<Field
								label={t("ui.timeshiftDvrWindowS")}
								htmlFor={`${idPrefix}-hls-timeshift`}
								help={t("uiX.hlsTimeshiftDefaultHelp")}
							>
								<Input
									id={`${idPrefix}-hls-timeshift`}
									type="number"
									value={hls.timeshift ?? ""}
									onChange={(e) =>
										patchHls({ timeshift: numberOrUndefined(e.target.value) })
									}
								/>
							</Field>
						</div>
						<DvrGauge
							variant="note"
							label={t("ui.hlsDvrBudgetC8")}
							tooltip={t("uiX.dvrBudgetTooltip")}
							timeshiftSec={hls.timeshift}
							legs={manifestLegs(state, "HLS")}
						/>
						<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
							<Field
								label={t("ui.liveEdgeOffsetS")}
								htmlFor={`${idPrefix}-hls-edge`}
								help={`${t("uiX.hlsLiveEdgeOffsetTooltip")} ${t("uiX.hlsLiveEdgeOffsetDefaultHint")}`}
							>
								<Input
									id={`${idPrefix}-hls-edge`}
									type="number"
									value={hls.liveEdgeOffset ?? ""}
									onChange={(e) =>
										patchHls({
											liveEdgeOffset: numberOrUndefined(e.target.value),
										})
									}
								/>
							</Field>
							<Field
								label={t("ui.audioGroupId")}
								htmlFor={`${idPrefix}-hls-group`}
								help={t("uiX.emptyAudio")}
							>
								<Input
									id={`${idPrefix}-hls-group`}
									value={hls.audioGroupId}
									onChange={(e) => patchHls({ audioGroupId: e.target.value })}
								/>
							</Field>
						</div>
						<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
							<Field
								label={t("ui.audioLanguage")}
								htmlFor={`${idPrefix}-hls-lang`}
								help={t("uiX.emptyEnLang")}
							>
								<Input
									id={`${idPrefix}-hls-lang`}
									value={hls.audioLanguage}
									onChange={(e) => patchHls({ audioLanguage: e.target.value })}
								/>
							</Field>
							<Field
								label={t("ui.videoMuxingPin")}
								htmlFor={`${idPrefix}-hls-vpin`}
								help={t("ui.pinOneFamilyWhenRenditionsCarryFmp4")}
							>
								<SelectNative
									id={`${idPrefix}-hls-vpin`}
									value={hls.videoMuxingKind}
									onChange={(e) =>
										patchHls({
											videoMuxingKind: e.target
												.value as typeof hls.videoMuxingKind,
										})
									}
								>
									<option value="">{t("ui.allLegs")}</option>
									<option value="FMP4">FMP4</option>
									<option value="TS">{t("ui.ts")}</option>
								</SelectNative>
							</Field>
							<Field
								label={t("ui.audioMuxingPin")}
								htmlFor={`${idPrefix}-hls-apin`}
								help={t("ui.sameForAudioLegs")}
							>
								<SelectNative
									id={`${idPrefix}-hls-apin`}
									value={hls.audioMuxingKind}
									onChange={(e) =>
										patchHls({
											audioMuxingKind: e.target
												.value as typeof hls.audioMuxingKind,
										})
									}
								>
									<option value="">{t("ui.allLegs")}</option>
									<option value="FMP4">FMP4</option>
									<option value="TS">{t("ui.ts")}</option>
								</SelectNative>
							</Field>
						</div>
						<Field
							label={t("wizard.closedCaptions")}
							htmlFor={`${idPrefix}-hls-captions`}
						>
							<Input
								id={`${idPrefix}-hls-captions`}
								placeholder="NONE"
								value={hls.closedCaptions ?? ""}
								onChange={(e) => patchHls({ closedCaptions: e.target.value })}
							/>
						</Field>
						<label
							htmlFor={`${idPrefix}-hls-pdt`}
							className="flex items-center gap-2 text-sm text-zinc-300"
						>
							<input
								id={`${idPrefix}-hls-pdt`}
								type="checkbox"
								className="h-4 w-4 accent-emerald-600"
								checked={hls.insertProgramDateTime}
								onChange={(e) =>
									patchHls({ insertProgramDateTime: e.target.checked })
								}
							/>
							{t("ui.insertExtXProgramDateTimeTags")}
						</label>
						<div className="rounded-md border border-zinc-800 p-3">
							<div className="flex items-center gap-1.5">
								<h4 className="font-medium text-xs text-zinc-300">
									{t("ui.programDateTimeSettings")}
								</h4>
								<HelpOverlay
									label={t("uiX.moreInformationFor", {
										label: t("ui.programDateTimeSettings"),
									})}
								>
									{t("ui.whereThePdtWallClockComesFrom")}{" "}
									<code>clockSynchronizationMode</code>{" "}
									{t("ui.whenBothAreSetMismatchedModesFail")}
								</HelpOverlay>
							</div>
							<div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
								<Field
									label={t("ui.pdtSource")}
									htmlFor={`${idPrefix}-hls-pdt-source`}
									help={t("ui.systemClockTheEncoderClockEmbeddedTimestamps")}
								>
									<SelectNative
										id={`${idPrefix}-hls-pdt-source`}
										value={pdt?.source ?? ""}
										onChange={(e) =>
											patchPdt({
												source:
													(e.target.value as LivePdtSettingsState["source"]) ||
													undefined,
											})
										}
									>
										<option value="">{t("ui.default")}</option>
										<option value="SYSTEM_CLOCK">SYSTEM_CLOCK</option>
										<option value="EMBEDDED">EMBEDDED</option>
									</SelectNative>
								</Field>
								<Field
									label={t("ui.placementMode")}
									htmlFor={`${idPrefix}-hls-pdt-mode`}
									help={t("ui.oncePerPlaylistWritesOneTagPer")}
								>
									<SelectNative
										id={`${idPrefix}-hls-pdt-mode`}
										value={placementMode ?? ""}
										onChange={(e) => patchPlacementMode(e.target.value)}
									>
										<option value="">{t("ui.default")}</option>
										<option value="ONCE_PER_PLAYLIST">ONCE_PER_PLAYLIST</option>
										<option value="SEGMENTS_INTERVAL">SEGMENTS_INTERVAL</option>
										<option value="SECONDS_INTERVAL">SECONDS_INTERVAL</option>
									</SelectNative>
								</Field>
								{placementMode && PDT_INTERVAL_MODES.has(placementMode) ? (
									<Field
										label={
											placementMode === "SEGMENTS_INTERVAL"
												? t("ui.intervalSegments")
												: t("ui.intervalSeconds")
										}
										htmlFor={`${idPrefix}-hls-pdt-interval`}
										error={
											pdt?.placement?.interval === undefined
												? t("uiX.intervalRequiredFor", { mode: placementMode })
												: undefined
										}
										help={t("ui.howOftenTheTagRepeats")}
									>
										<Input
											id={`${idPrefix}-hls-pdt-interval`}
											type="number"
											value={pdt?.placement?.interval ?? ""}
											onChange={(e) =>
												patchPdt({
													placement: {
														mode: placementMode,
														...(e.target.value === ""
															? {}
															: { interval: Number(e.target.value) }),
													},
												})
											}
										/>
									</Field>
								) : null}
							</div>
						</div>
					</div>
				) : null}
			</ManifestCard>

			<ManifestCard kind="DASH" selected={manifestKind}>
				<label
					htmlFor={`${idPrefix}-dash-enabled`}
					className="flex items-center gap-2 font-medium text-sm text-zinc-200"
				>
					<input
						id={`${idPrefix}-dash-enabled`}
						type="checkbox"
						className="h-4 w-4 accent-emerald-600"
						checked={dash.enabled}
						onChange={(e) => patchDash({ enabled: e.target.checked })}
					/>
					{t("ui.dashManifest")}
				</label>
				{dash.enabled ? (
					<div className="mt-3 space-y-3">
						<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
							<Field
								label={t("ui.manifestName")}
								htmlFor={`${idPrefix}-dash-mname`}
								help={t("uiX.emptyStreamMpd")}
							>
								<Input
									id={`${idPrefix}-dash-mname`}
									value={dash.manifestName}
									onChange={(e) => patchDash({ manifestName: e.target.value })}
								/>
							</Field>
							<Field
								label={t("ui.timeshiftDvrWindowS")}
								htmlFor={`${idPrefix}-dash-timeshift`}
								help={t("ui.emptyNoDvrWindowLiveEdgeOnly")}
							>
								<Input
									id={`${idPrefix}-dash-timeshift`}
									type="number"
									value={dash.timeshift ?? ""}
									onChange={(e) =>
										patchDash({ timeshift: numberOrUndefined(e.target.value) })
									}
								/>
							</Field>
						</div>
						<DvrGauge
							variant="note"
							label={t("ui.dashDvrBudgetC8")}
							tooltip={t("uiX.dvrBudgetTooltip")}
							timeshiftSec={dash.timeshift}
							legs={manifestLegs(state, "DASH")}
						/>
						<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
							<Field
								label={t("ui.representationType")}
								htmlFor={`${idPrefix}-dash-rep`}
								help={t("ui.segmenttemplateVsSegmenttimeline")}
							>
								<SelectNative
									id={`${idPrefix}-dash-rep`}
									value={dash.representationType}
									onChange={(e) =>
										patchDash({
											representationType: e.target
												.value as typeof dash.representationType,
										})
									}
								>
									<option value="TEMPLATE">TEMPLATE</option>
									<option value="TIMELINE">TIMELINE</option>
								</SelectNative>
							</Field>
							<Field
								label={t("ui.liveEdgeOffsetS")}
								htmlFor={`${idPrefix}-dash-edge`}
								tooltip={t("uiX.liveEdgeOffsetTooltip")}
							>
								<Input
									id={`${idPrefix}-dash-edge`}
									type="number"
									value={dash.liveEdgeOffset ?? ""}
									onChange={(e) =>
										patchDash({
											liveEdgeOffset: numberOrUndefined(e.target.value),
										})
									}
								/>
							</Field>
							<Field
								label={t("ui.audioLanguage")}
								htmlFor={`${idPrefix}-dash-lang`}
								help={t("uiX.emptyEnLang")}
							>
								<Input
									id={`${idPrefix}-dash-lang`}
									value={dash.audioLanguage}
									onChange={(e) => patchDash({ audioLanguage: e.target.value })}
								/>
							</Field>
						</div>
						<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
							<Field
								label={t("ui.suggestedPresentationDelayMs")}
								htmlFor={`${idPrefix}-dash-spd`}
								help={t("ui.unsetNotWrittenToTheMpd")}
							>
								<Input
									id={`${idPrefix}-dash-spd`}
									type="number"
									value={dash.suggestedPresentationDelay ?? ""}
									onChange={(e) =>
										patchDash({
											suggestedPresentationDelay: numberOrUndefined(
												e.target.value,
											),
										})
									}
								/>
							</Field>
							<Field
								label={t("ui.minimumUpdatePeriodMs")}
								htmlFor={`${idPrefix}-dash-mup`}
								help={t("ui.unsetApiDefaultsToTheSegmentDuration")}
							>
								<Input
									id={`${idPrefix}-dash-mup`}
									type="number"
									value={dash.minimumUpdatePeriod ?? ""}
									onChange={(e) =>
										patchDash({
											minimumUpdatePeriod: numberOrUndefined(e.target.value),
										})
									}
								/>
							</Field>
							<Field
								label={t("ui.availabilityStartTime")}
								htmlFor={`${idPrefix}-dash-astm`}
							>
								<SelectNative
									id={`${idPrefix}-dash-astm`}
									value={dash.availabilityStartTimeMode}
									onChange={(e) =>
										patchDash({
											availabilityStartTimeMode: e.target
												.value as typeof dash.availabilityStartTimeMode,
										})
									}
								>
									<option value="">{t("ui.default")}</option>
									<option value="ON_FIRST_SEGMENT">ON_FIRST_SEGMENT</option>
									<option value="ON_STREAM_INGEST">ON_STREAM_INGEST</option>
								</SelectNative>
							</Field>
						</div>
					</div>
				) : null}
			</ManifestCard>

			<ManifestCard kind="PRIMARY" selected={manifestKind}>
				<label
					htmlFor={`${idPrefix}-scte35`}
					className="flex items-center gap-2 font-medium text-sm text-zinc-200"
				>
					<input
						id={`${idPrefix}-scte35`}
						type="checkbox"
						className="h-4 w-4 accent-emerald-600"
						checked={state.scte35AdMarkers}
						onChange={(e) => onPatch({ scte35AdMarkers: e.target.checked })}
					/>
					{t("ui.enableScte35AdMarkers")}
				</label>
				<span className="mt-1 inline-flex">
					<HelpOverlay
						label={t("uiX.moreInformationFor", {
							label: t("ui.enableScte35AdMarkers"),
						})}
					>
						{t("ui.outputsScte35MarkersSoAnInserted")}{" "}
						<code>{t("ui.extXDaterange")}</code>{" "}
						{t("ui.playlistTagsAreWrittenAtTheManifest")}{" "}
						<code>{t("ui.emsg")}</code> {t("ui.carrierIsFmp4OnlyTsHasNo")}
					</HelpOverlay>
				</span>
				{state.scte35AdMarkers ? (
					<div className="mt-3 space-y-3">
						<div className="rounded-md border border-zinc-800 p-3">
							<h4 className="font-medium text-xs text-zinc-300">
								{t("uiX.hlsPlaylistMarkers")}{" "}
								<span className="font-normal text-zinc-500">
									{t("ui.defaultExtXDaterange")}
								</span>
							</h4>
							<div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
								{HLS_MARKER_TYPES.map((type) => (
									<label
										key={type}
										htmlFor={`lw-scte-type-${type}`}
										className="flex items-center gap-2 text-xs text-zinc-300"
									>
										<input
											id={`lw-scte-type-${type}`}
											type="checkbox"
											className="h-3.5 w-3.5 accent-emerald-600"
											checked={
												markerOptions?.hlsMarkerTypes?.includes(type) === true
											}
											onChange={(e) => toggleMarkerType(type, e.target.checked)}
										/>
										<code>{type}</code>
									</label>
								))}
							</div>
							<p className="mt-2 text-[11px] text-zinc-500">
								{t("ui.leaveEveryBoxClearToSendThe")}
							</p>
							<div className="mt-3 flex items-center gap-2">
								<label
									htmlFor={`${idPrefix}-scte-preannounce`}
									className="flex items-center gap-2 text-sm text-zinc-300"
								>
									<input
										id={`${idPrefix}-scte-preannounce`}
										type="checkbox"
										className="h-4 w-4 accent-emerald-600"
										checked={markerOptions?.hlsDisablePreannouncing === true}
										onChange={(e) =>
											patchMarkerOptions({
												hlsDisablePreannouncing: e.target.checked
													? true
													: undefined,
											})
										}
									/>
									{t("ui.disablePreAnnouncing")}
								</label>
								<InfoHint
									text={t("ui.byDefaultAMarkerAppearsInThe")}
									label={t("ui.disablePreAnnouncingMoreInformation")}
								/>
							</div>
						</div>
						<div className="rounded-md border border-zinc-800 p-3">
							<h4 className="font-medium text-xs text-zinc-300">
								{t("uiX.dashSignalling")}{" "}
								<span className="font-normal text-zinc-500">
									{t("ui.defaultsSinglePeriodXmlBin")}
								</span>
							</h4>
							<div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
								<Field
									label={t("ui.periodOption")}
									htmlFor={`${idPrefix}-scte-period`}
									help={t("ui.singlePeriodKeepsOneContinuousPeriodMulti")}
								>
									<SelectNative
										id={`${idPrefix}-scte-period`}
										value={markerOptions?.dashPeriodOption ?? ""}
										onChange={(e) =>
											patchMarkerOptions({
												dashPeriodOption:
													(e.target
														.value as LiveAdMarkerOptionsState["dashPeriodOption"]) ||
													undefined,
											})
										}
									>
										<option value="">{t("ui.defaultSinglePeriod")}</option>
										<option value="SINGLE_PERIOD">SINGLE_PERIOD</option>
										<option value="MULTI_PERIOD">MULTI_PERIOD</option>
									</SelectNative>
								</Field>
								<Field
									label={t("ui.eventStreamSignalling")}
									htmlFor={`${idPrefix}-scte-eventstream`}
									help={t("ui.xmlBinCarriesTheBinarySpliceInfo")}
								>
									<SelectNative
										id={`${idPrefix}-scte-eventstream`}
										value={markerOptions?.dashEventStreamSignalling ?? ""}
										onChange={(e) =>
											patchMarkerOptions({
												dashEventStreamSignalling:
													(e.target
														.value as LiveAdMarkerOptionsState["dashEventStreamSignalling"]) ||
													undefined,
											})
										}
									>
										<option value="">{t("ui.defaultXmlBin")}</option>
										<option value="XML">XML</option>
										<option value="XML_BIN">XML_BIN</option>
									</SelectNative>
								</Field>
							</div>
						</div>
					</div>
				) : null}
			</ManifestCard>

			{!manifestKind &&
			![
				hls,
				dash,
				...(state.manifests.additionalHls ?? []),
				...(state.manifests.additionalDash ?? []),
			].some((manifest) => manifest.enabled) ? (
				<p role="alert" className="text-amber-400 text-xs">
					{t("ui.aChannelWithoutAManifestHasNo")}
				</p>
			) : null}
		</div>
	);
}
