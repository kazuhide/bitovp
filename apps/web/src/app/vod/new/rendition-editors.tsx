"use client";

import {
	AV1_DYNAMIC_RANGE_FORMATS,
	type CredentialSummaryWire,
} from "@bitovp/core";
import { Button } from "@/components/ui/button";
import { Field, FieldRowAction } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { NewCredentialLink } from "@/components/ui/new-credential-link";
import { useT } from "@/lib/i18n/context";
import type {
	WizardAv1Options,
	WizardColorConfig,
	WizardDashAdaptationSet,
	WizardH264Options,
	WizardH265Options,
	WizardLoudnessControl,
	WizardManifests,
	WizardNexGuard,
	WizardRenditionExtras,
	WizardVp9Options,
} from "./build-plan";
import { BurnInSrtEditor } from "./burn-in-srt-editor";
import { CODEC_OPTIONS } from "./codec-options";
import { HevcV2QualityEditor } from "./hevc-v2-quality-editor";
import { HlsVideoUriField } from "./hls-video-uri-field";
import {
	Collapsible,
	type OptionFieldSpec,
	OptionsGrid,
	RowRemoveButton,
} from "./wizard-fields";

/**
 * Per-codec Advanced editors + the shared "Placement & extras" editor.
 * Field lists mirror the schema's optional surface 1:1 (API-parity rule)
 * — anything unset emits nothing.
 */

const COLOR_FIELDS: OptionFieldSpec[] = [
	{
		key: "colorSpace",
		labelKey: "wizard.colorSpace",
		control: { options: CODEC_OPTIONS.ColorSpace },
	},
	{
		key: "colorPrimaries",
		labelKey: "wizard.colorPrimaries",
		control: { options: CODEC_OPTIONS.ColorPrimaries },
	},
	{
		key: "colorTransfer",
		labelKey: "wizard.colorTransfer",
		control: { options: CODEC_OPTIONS.ColorTransfer },
	},
	{
		key: "copyColorPrimariesFlag",
		labelKey: "wizard.copyPrimaries",
		control: "bool",
	},
	{
		key: "copyColorTransferFlag",
		labelKey: "wizard.copyTransfer",
		control: "bool",
	},
	{
		key: "copyColorSpaceFlag",
		labelKey: "wizard.copyColorSpace",
		control: "bool",
	},
	{
		key: "copyChromaLocationFlag",
		labelKey: "wizard.copyChromaLoc",
		control: "bool",
	},
	{
		key: "copyColorRangeFlag",
		labelKey: "wizard.copyColorRange",
		control: "bool",
	},
];

export function ColorConfigEditor({
	idBase,
	value,
	onChange,
}: {
	idBase: string;
	value: WizardColorConfig | undefined;
	onChange: (next: WizardColorConfig | undefined) => void;
}) {
	const { t } = useT();
	return (
		<Collapsible summary={t("wizard.colorConfig")}>
			<OptionsGrid
				idBase={idBase}
				value={value ?? {}}
				fields={COLOR_FIELDS}
				onChange={(next) => onChange(next)}
			/>
		</Collapsible>
	);
}

const H26X_PICTURE_FIELDS: OptionFieldSpec[] = [
	{ key: "minGop", labelKey: "wizard.minGopFrames", control: "num" },
	{ key: "maxGop", labelKey: "wizard.maxGopFrames", control: "num" },
	{ key: "openGop", labelKey: "wizard.openGop", control: "bool" },
	{
		key: "sampleAspectRatioNumerator",
		labelKey: "wizard.sarNumerator",
		control: "num",
	},
	{
		key: "sampleAspectRatioDenominator",
		labelKey: "wizard.sarDenominator",
		control: "num",
	},
];
const DAR_FIELDS: OptionFieldSpec[] = [
	{ key: "numerator", labelKey: "wizard.darNumerator", control: "num" },
	{ key: "denominator", labelKey: "wizard.darDenominator", control: "num" },
];

function DisplayAspectRatioEditor({
	idBase,
	value,
	onChange,
}: {
	idBase: string;
	value: WizardH264Options["displayAspectRatio"];
	onChange: (ratio: WizardH264Options["displayAspectRatio"]) => void;
}) {
	const { t } = useT();
	return (
		<Collapsible summary={t("wizard.displayAspectRatio")}>
			<OptionsGrid
				idBase={`${idBase}-dar`}
				value={value ?? {}}
				fields={DAR_FIELDS}
				onChange={(next) =>
					onChange(
						next.numerator !== undefined || next.denominator !== undefined
							? next
							: undefined,
					)
				}
			/>
		</Collapsible>
	);
}

const H264_FIELDS: OptionFieldSpec[] = [
	...H26X_PICTURE_FIELDS,
	{ key: "crf", labelKey: "wizard.crf", control: "num" },
	{ key: "minBitrate", labelKey: "wizard.minBitrateBps", control: "num" },
	{ key: "maxBitrate", labelKey: "wizard.maxBitrateBps", control: "num" },
	{ key: "bufsize", labelKey: "wizard.bufsizeBits", control: "num" },
	{
		key: "profile",
		labelKey: "wizard.profile",
		control: { options: ["BASELINE", "MAIN", "HIGH", "HIGH422"] },
	},
	{
		key: "level",
		labelKey: "wizard.level",
		control: { options: CODEC_OPTIONS.LevelH264 },
	},
	{ key: "rate", labelKey: "wizard.frameRateFps", control: "num" },
	{
		key: "minKeyframeInterval",
		labelKey: "wizard.minKeyframeInterval",
		control: "num",
	},
	{
		key: "maxKeyframeInterval",
		labelKey: "wizard.maxKeyframeInterval",
		control: "num",
	},
	{ key: "refFrames", labelKey: "wizard.referenceFrames", control: "num" },
	{ key: "bframes", labelKey: "wizard.bFrames", control: "num" },
	{ key: "cabac", labelKey: "wizard.cabac", control: "bool" },
	{
		key: "adaptiveSpatialTransform",
		labelKey: "wizard.adaptiveSpatialTransform",
		control: "bool",
	},
	{
		key: "weightedPredictionPFrames",
		labelKey: "wizard.weightedPredictionP",
		control: { options: ["DISABLED", "SIMPLE", "SMART"] },
	},
	{ key: "slices", labelKey: "wizard.slices", control: "num" },
	{
		key: "trellis",
		labelKey: "wizard.trellis",
		control: { options: CODEC_OPTIONS.H264Trellis },
	},
	{
		key: "mvSearchRangeMax",
		labelKey: "wizard.mvSearchRangeMax",
		control: "num",
	},
	{ key: "rcLookahead", labelKey: "wizard.rcLookahead", control: "num" },
	{
		key: "subMe",
		labelKey: "wizard.subMe",
		control: { options: CODEC_OPTIONS.H264SubMe },
	},
	{
		key: "motionEstimationMethod",
		labelKey: "wizard.motionEstimation",
		control: { options: CODEC_OPTIONS.H264MotionEstimationMethod },
	},
	{
		key: "sceneCutThreshold",
		labelKey: "wizard.sceneCutThreshold",
		control: "num",
	},
	{
		key: "adaptiveQuantizationMode",
		labelKey: "wizard.aqMode",
		control: { options: CODEC_OPTIONS.AdaptiveQuantMode },
	},
	{
		key: "adaptiveQuantizationStrength",
		labelKey: "wizard.aqStrength",
		control: "num",
	},
	{
		key: "mvPredictionMode",
		labelKey: "wizard.mvPredictionMode",
		control: { options: CODEC_OPTIONS.MvPredictionMode },
	},
	{
		key: "psyRateDistortionOptimization",
		labelKey: "wizard.psyRdo",
		control: "num",
	},
	{ key: "psyTrellis", labelKey: "wizard.psyTrellis", control: "num" },
];

const H265_FIELDS: OptionFieldSpec[] = [
	...H26X_PICTURE_FIELDS,
	{ key: "bframes", labelKey: "wizard.bFrames", control: "num" },
	{ key: "refFrames", labelKey: "wizard.referenceFrames", control: "num" },
	{ key: "qp", labelKey: "wizard.qp", control: "num" },
	{ key: "qpMax", labelKey: "wizard.qpMax", control: "num" },
	{ key: "strictCbr", labelKey: "wizard.strictCbr", control: "bool" },
	{ key: "crf", labelKey: "wizard.crf", control: "num" },
	{ key: "minBitrate", labelKey: "wizard.minBitrateBps", control: "num" },
	{
		key: "level",
		labelKey: "wizard.level",
		control: { options: CODEC_OPTIONS.LevelH265 },
	},
	{
		key: "profile",
		labelKey: "wizard.profile",
		control: { options: ["MAIN", "MAIN10"] },
	},
	{
		key: "rate",
		labelKey: "wizard.frameRateFps",
		control: "num",
		nullable: true,
		hintKey: "wizard.perTitleSamplesPinRateToNull",
	},
	{ key: "maxBitrate", labelKey: "wizard.maxBitrateBps", control: "num" },
	{ key: "bufsize", labelKey: "wizard.bufsizeBits", control: "num" },
	{
		key: "dynamicRangeFormat",
		labelKey: "wizard.dynamicRangeFormat",
		control: {
			options: [
				"DOLBY_VISION",
				"DOLBY_VISION_PROFILE_5",
				"DOLBY_VISION_PROFILE_8_1",
				"HDR10",
				"HLG",
				"SDR",
			],
		},
	},
	{ key: "levelHighTier", labelKey: "wizard.levelHighTier", control: "bool" },
	{
		key: "minKeyframeInterval",
		labelKey: "wizard.minKeyframeInterval",
		control: "num",
	},
	{
		key: "maxKeyframeInterval",
		labelKey: "wizard.maxKeyframeInterval",
		control: "num",
	},
	{ key: "rcLookahead", labelKey: "wizard.rcLookahead", control: "num" },
	{ key: "subMe", labelKey: "wizard.subMeNumeric", control: "num" },
	{
		key: "maxCtuSize",
		labelKey: "wizard.maxCtuSize",
		control: { options: CODEC_OPTIONS.MaxCtuSize },
	},
	{
		key: "motionSearch",
		labelKey: "wizard.motionSearch",
		control: { options: CODEC_OPTIONS.MotionSearch },
	},
	{
		key: "tuIntraDepth",
		labelKey: "wizard.tuIntraDepth",
		control: { options: CODEC_OPTIONS.TuIntraDepth },
	},
	{
		key: "tuInterDepth",
		labelKey: "wizard.tuInterDepth",
		control: { options: CODEC_OPTIONS.TuInterDepth },
	},
	{
		key: "weightPredictionOnPSlice",
		labelKey: "wizard.weightPredictionP",
		control: "bool",
	},
	{
		key: "weightPredictionOnBSlice",
		labelKey: "wizard.weightPredictionB",
		control: "bool",
	},
	{
		key: "sceneCutThreshold",
		labelKey: "wizard.sceneCutThreshold",
		control: "num",
	},
	{
		key: "motionSearchRange",
		labelKey: "wizard.motionSearchRange",
		control: "num",
	},
	{
		key: "adaptiveQuantizationMode",
		labelKey: "wizard.aqMode",
		control: { options: CODEC_OPTIONS.AdaptiveQuantMode },
	},
	{
		key: "adaptiveQuantizationStrength",
		labelKey: "wizard.aqStrength",
		control: "num",
	},
	{
		key: "psyRateDistortionOptimization",
		labelKey: "wizard.psyRdo",
		control: "num",
	},
	{
		key: "psyRateDistortionOptimizedQuantization",
		labelKey: "wizard.psyRdoq",
		control: "num",
	},
	{ key: "qpMin", labelKey: "wizard.qpMin", control: "num" },
	{ key: "sao", labelKey: "wizard.sao", control: "bool" },
];

const H265_HDR10_FIELDS: OptionFieldSpec[] = [
	{ key: "hdr", labelKey: "wizard.hdr", control: "bool" },
	{
		key: "masterDisplay",
		labelKey: "wizard.masterDisplay",
		control: "text",
		hintKey: "wizard.gBRWpLMasteringMetadata",
	},
	{ key: "maxContentLightLevel", labelKey: "wizard.maxcll", control: "num" },
	{
		key: "maxPictureAverageLightLevel",
		labelKey: "wizard.maxfall",
		control: "num",
	},
	{
		key: "pixelFormat",
		labelKey: "wizard.pixelFormat",
		control: { options: CODEC_OPTIONS.PixelFormat },
		hintKey: "wizard.yuv420p10leForMain10Hdr10",
	},
];

const VP9_FIELDS: OptionFieldSpec[] = [
	{
		key: "rate",
		labelKey: "wizard.frameRateFps",
		control: "num",
		nullable: true,
	},
	{ key: "cpuUsed", labelKey: "wizard.cpuUsed", control: "num" },
	{ key: "tileColumns", labelKey: "wizard.tileColumns", control: "num" },
	{ key: "qpMin", labelKey: "wizard.qpMin", control: "num" },
	{ key: "qpMax", labelKey: "wizard.qpMax", control: "num" },
	{
		key: "rateUndershootPct",
		labelKey: "wizard.rateUndershoot",
		control: "num",
	},
	{ key: "rateOvershootPct", labelKey: "wizard.rateOvershoot", control: "num" },
	{
		key: "quality",
		labelKey: "wizard.quality",
		control: { options: CODEC_OPTIONS.Vp9Quality },
	},
	{
		key: "lossless",
		labelKey: "wizard.lossless",
		control: "bool",
		nullable: true,
	},
	{
		key: "aqMode",
		labelKey: "wizard.aqMode",
		control: { options: CODEC_OPTIONS.Vp9AqMode },
	},
	{
		key: "arnrType",
		labelKey: "wizard.arnrType",
		control: { options: CODEC_OPTIONS.Vp9ArnrType },
	},
	{ key: "arnrMaxFrames", labelKey: "wizard.arnrMaxFrames", control: "num" },
	{ key: "arnrStrength", labelKey: "wizard.arnrStrength", control: "num" },
];

// AV1 (Av1VideoConfiguration) exposes only these knobs beyond bitrate/height.
// The preset select lives on the rendition row directly; these are Advanced.
const AV1_FIELDS: OptionFieldSpec[] = [
	{
		key: "dynamicRangeFormat",
		labelKey: "wizard.dynamicRangeFormat",
		control: {
			options: AV1_DYNAMIC_RANGE_FORMATS,
			labels: {
				DOLBY_VISION_PROFILE_10_0: "Dolby Vision Profile 10.0",
				DOLBY_VISION_PROFILE_10_1: "Dolby Vision Profile 10.1",
			},
		},
	},
	{
		key: "rate",
		labelKey: "wizard.frameRateFps",
		control: "num",
		nullable: true,
	},
	{
		key: "autoLevelSetup",
		labelKey: "wizard.autoLevelSetup",
		control: { options: ["ENABLED", "DISABLED"] },
	},
];

export const LOUDNESS_FIELDS: OptionFieldSpec[] = [
	{
		key: "meteringMode",
		labelKey: "wizard.meteringMode",
		control: {
			options: [
				"ITU_R_BS_1770_1",
				"ITU_R_BS_1770_2",
				"ITU_R_BS_1770_3",
				"ITU_R_BS_1770_4",
				"LEQ_A",
			],
		},
	},
	{
		key: "dialogueIntelligence",
		labelKey: "wizard.dialogueIntelligence",
		control: { options: ["ENABLED", "DISABLED"] },
	},
	{
		key: "speechThreshold",
		labelKey: "wizard.speechThreshold",
		control: "num",
	},
];

// VOD choices documented at /encoding/docs/h264-presets and /h265-presets.
// Keep an imported value visible even when it is outside the suggested VOD list.
const SHARED_VOD_PRESETS = [
	"VOD_HIGH_QUALITY",
	"VOD_STANDARD",
	"VOD_SPEED",
	"VOD_HIGH_SPEED",
	"VOD_VERYHIGH_SPEED",
	"VOD_EXTRAHIGH_SPEED",
	"VOD_SUPERHIGH_SPEED",
	"VOD_ULTRAHIGH_SPEED",
	"VOD_HARDWARE_SHORTFORM",
];

function PresetSelect({
	id,
	codec,
	value,
	onChange,
}: {
	id: string;
	codec: "H264" | "H265";
	value: string | null | undefined;
	onChange: (value: string | undefined) => void;
}) {
	const { t } = useT();
	const selected =
		value === undefined && codec === "H264"
			? "VOD_HIGH_QUALITY"
			: (value ?? "");
	const presets = [...SHARED_VOD_PRESETS];
	if (codec === "H264") presets.splice(1, 0, "VOD_QUALITY");
	return (
		<Field label={t("wizard.presetConfiguration")} htmlFor={id}>
			<SelectNative
				id={id}
				value={selected}
				onChange={(event) => onChange(event.target.value || undefined)}
			>
				<option value="">{t("wizard.noPreset")}</option>
				{selected && !presets.includes(selected) ? (
					<option value={selected}>{selected}</option>
				) : null}
				{presets.map((preset) => (
					<option key={preset} value={preset}>
						{preset}
					</option>
				))}
			</SelectNative>
		</Field>
	);
}

export function H264AdvancedEditor({
	idBase,
	value,
	allowCrf = true,
	onChange,
}: {
	idBase: string;
	value: WizardH264Options | undefined;
	allowCrf?: boolean;
	onChange: (next: WizardH264Options) => void;
}) {
	const { t } = useT();
	const options = value ?? {};
	return (
		<Collapsible summary={t("wizard.advancedH264")}>
			<PresetSelect
				id={`${idBase}-presetConfiguration`}
				codec="H264"
				value={options.presetConfiguration}
				onChange={(presetConfiguration) =>
					onChange({
						...options,
						presetConfiguration: presetConfiguration ?? null,
					})
				}
			/>
			<OptionsGrid
				idBase={idBase}
				value={options}
				fields={
					allowCrf
						? H264_FIELDS
						: H264_FIELDS.filter((field) => field.key !== "crf")
				}
				onChange={onChange}
			/>
			<DisplayAspectRatioEditor
				idBase={idBase}
				value={options.displayAspectRatio}
				onChange={(displayAspectRatio) =>
					onChange({ ...options, displayAspectRatio })
				}
			/>
			<ColorConfigEditor
				idBase={`${idBase}-color`}
				value={options.colorConfig}
				onChange={(colorConfig) => onChange({ ...options, colorConfig })}
			/>
		</Collapsible>
	);
}

const H265V2_FIELDS: OptionFieldSpec[] = [
	{
		key: "rate",
		labelKey: "wizard.frameRateFps",
		control: "num",
		nullable: true,
	},
	{
		key: "pixelFormat",
		labelKey: "wizard.pixelFormat",
		control: { options: ["YUV420P", "YUV420P10LE"] },
	},
	{ key: "levelHighTier", labelKey: "wizard.levelHighTier", control: "bool" },
	{
		key: "dynamicRangeFormat",
		labelKey: "wizard.dynamicRangeFormat",
		control: { options: ["SDR"] },
	},
];
export function H265V2AdvancedEditor({
	idBase,
	value,
	qualityControlsAvailable,
	onChange,
}: {
	idBase: string;
	value: WizardH265Options | undefined;
	qualityControlsAvailable: boolean;
	onChange: (next: WizardH265Options) => void;
}) {
	const { t } = useT();
	const options = value ?? {};
	return (
		<Collapsible summary={t("hevcV2.advanced")}>
			<p className="text-xs text-zinc-400">SMART_PASS · VOD_HIGH_QUALITY</p>
			<OptionsGrid
				idBase={idBase}
				value={options}
				fields={H265V2_FIELDS}
				onChange={onChange}
			/>
			{qualityControlsAvailable ? (
				<HevcV2QualityEditor
					idBase={`${idBase}-quality`}
					value={options}
					onChange={onChange}
				/>
			) : null}
			<ColorConfigEditor
				idBase={`${idBase}-color`}
				value={options.colorConfig}
				onChange={(colorConfig) => onChange({ ...options, colorConfig })}
			/>
		</Collapsible>
	);
}

export function H265AdvancedEditor({
	idBase,
	value,
	allowCrf = true,
	visionMetadataKeys,
	onChange,
}: {
	idBase: string;
	value: WizardH265Options | undefined;
	allowCrf?: boolean;
	/** VISION_METADATA dolbyStream keys (separated-metadata flow). */
	visionMetadataKeys: string[];
	onChange: (next: WizardH265Options) => void;
}) {
	const { t } = useT();
	const options = value ?? {};
	const dvm = options.dolbyVisionMetadata;
	return (
		<Collapsible summary={t("wizard.advancedH265")}>
			<PresetSelect
				id={`${idBase}-presetConfiguration`}
				codec="H265"
				value={options.presetConfiguration}
				onChange={(presetConfiguration) =>
					onChange({ ...options, presetConfiguration })
				}
			/>
			<OptionsGrid
				idBase={idBase}
				value={options}
				fields={
					allowCrf
						? H265_FIELDS
						: H265_FIELDS.filter((field) => field.key !== "crf")
				}
				onChange={onChange}
			/>
			<DisplayAspectRatioEditor
				idBase={idBase}
				value={options.displayAspectRatio}
				onChange={(displayAspectRatio) =>
					onChange({ ...options, displayAspectRatio })
				}
			/>
			<Collapsible summary="HDR10">
				<OptionsGrid
					idBase={`${idBase}-hdr`}
					value={options}
					fields={H265_HDR10_FIELDS}
					onChange={onChange}
				/>
			</Collapsible>
			<ColorConfigEditor
				idBase={`${idBase}-color`}
				value={options.colorConfig}
				onChange={(colorConfig) => onChange({ ...options, colorConfig })}
			/>
			<Collapsible summary={t("wizard.dolbyVisionMetadata")}>
				{dvm ? (
					<div className="space-y-3">
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<Field
								label={t("wizard.dvProfile")}
								htmlFor={`${idBase}-dvm-profile`}
							>
								<SelectNative
									id={`${idBase}-dvm-profile`}
									value={dvm.profile}
									onChange={(e) =>
										onChange({
											...options,
											dolbyVisionMetadata: {
												...dvm,
												profile: e.target.value as typeof dvm.profile,
											},
										})
									}
								>
									{["DVHE_04", "DVHE_05", "DVHE_07", "HEV1_08", "AVC3_09"].map(
										(profile) => (
											<option key={profile} value={profile}>
												{profile}
											</option>
										),
									)}
								</SelectNative>
							</Field>
							<Field
								label={t("wizard.metadataSource")}
								htmlFor={`${idBase}-dvm-source`}
								help={t("wizard.inputStreamNeedsAVisionMetadataSidecar")}
							>
								<SelectNative
									id={`${idBase}-dvm-source`}
									value={dvm.metadataSource}
									onChange={(e) => {
										const metadataSource = e.target.value as
											| "INPUT_STREAM"
											| "EMBEDDED";
										onChange({
											...options,
											dolbyVisionMetadata: {
												...dvm,
												metadataSource,
												// EMBEDDED must not carry a sidecar key.
												metadataStreamKey:
													metadataSource === "EMBEDDED"
														? undefined
														: dvm.metadataStreamKey,
											},
										});
									}}
								>
									<option value="EMBEDDED">EMBEDDED</option>
									<option value="INPUT_STREAM">INPUT_STREAM</option>
								</SelectNative>
							</Field>
						</div>
						{dvm.metadataSource === "INPUT_STREAM" ? (
							<Field
								label={t("wizard.metadataStream")}
								htmlFor={`${idBase}-dvm-stream`}
								help={t("wizard.visionMetadataStreamsFromTheSourcesStep")}
							>
								<SelectNative
									id={`${idBase}-dvm-stream`}
									value={dvm.metadataStreamKey ?? ""}
									onChange={(e) =>
										onChange({
											...options,
											dolbyVisionMetadata: {
												...dvm,
												metadataStreamKey: e.target.value || undefined,
											},
										})
									}
								>
									<option value="">{t("wizard.selectStream")}</option>
									{visionMetadataKeys.map((key) => (
										<option key={key} value={key}>
											{key}
										</option>
									))}
								</SelectNative>
							</Field>
						) : null}
						<RowRemoveButton
							label={t("wizard.removeDolbyVisionMetadata")}
							onClick={() =>
								onChange({ ...options, dolbyVisionMetadata: undefined })
							}
						/>
					</div>
				) : (
					<Button
						variant="secondary"
						size="sm"
						onClick={() =>
							onChange({
								...options,
								dolbyVisionMetadata: {
									profile: "HEV1_08",
									metadataSource: "EMBEDDED",
								},
							})
						}
					>
						{t("wizard.attachDolbyVisionMetadata")}
					</Button>
				)}
			</Collapsible>
		</Collapsible>
	);
}

export function Vp9AdvancedEditor({
	idBase,
	value,
	onChange,
}: {
	idBase: string;
	value: WizardVp9Options | undefined;
	onChange: (next: WizardVp9Options) => void;
}) {
	const { t } = useT();
	const options = value ?? {};
	return (
		<Collapsible summary={t("wizard.advancedVp9")}>
			<OptionsGrid
				idBase={idBase}
				value={options}
				fields={VP9_FIELDS}
				onChange={onChange}
			/>
			<ColorConfigEditor
				idBase={`${idBase}-color`}
				value={options.colorConfig}
				onChange={(colorConfig) => onChange({ ...options, colorConfig })}
			/>
		</Collapsible>
	);
}

export function Av1AdvancedEditor({
	idBase,
	value,
	onChange,
}: {
	idBase: string;
	value: WizardAv1Options | undefined;
	onChange: (next: WizardAv1Options) => void;
}) {
	const { t } = useT();
	const options = value ?? {};
	return (
		<Collapsible summary={t("wizard.advancedAv1")}>
			<Field
				label={t("wizard.presetConfiguration")}
				htmlFor={`${idBase}-preset`}
			>
				<SelectNative
					id={`${idBase}-preset`}
					value={options.presetConfiguration ?? ""}
					onChange={(e) =>
						onChange({
							...options,
							presetConfiguration:
								e.target.value === ""
									? undefined
									: (e.target.value as WizardAv1Options["presetConfiguration"]),
						})
					}
				>
					<option value="">{t("wizard.default")}</option>
					{["VOD_QUALITY", "VOD_STANDARD", "VOD_SPEED"].map((preset) => (
						<option key={preset} value={preset}>
							{preset}
						</option>
					))}
				</SelectNative>
			</Field>
			<OptionsGrid
				idBase={idBase}
				value={options}
				fields={AV1_FIELDS}
				onChange={onChange}
			/>
			<ColorConfigEditor
				idBase={`${idBase}-color`}
				value={options.colorConfig}
				onChange={(colorConfig) => onChange({ ...options, colorConfig })}
			/>
		</Collapsible>
	);
}

export function LoudnessEditor({
	idBase,
	value,
	onChange,
}: {
	idBase: string;
	value: WizardLoudnessControl | undefined;
	onChange: (next: WizardLoudnessControl) => void;
}) {
	const { t } = useT();
	return (
		<Collapsible summary={t("wizard.loudnessControlAtmos")}>
			<OptionsGrid
				idBase={idBase}
				value={value ?? {}}
				fields={LOUDNESS_FIELDS}
				onChange={onChange}
			/>
		</Collapsible>
	);
}

const PER_TITLE_STREAM_FIELDS: OptionFieldSpec[] = [
	{ key: "minBitrate", labelKey: "wizard.minBitrateBps", control: "num" },
	{ key: "maxBitrate", labelKey: "wizard.maxBitrateBps", control: "num" },
	{
		key: "bitrateSelectionMode",
		labelKey: "wizard.bitrateSelection",
		control: { options: ["OPTIMIZED", "COMPLEXITY_RANGE"] },
	},
	{
		key: "lowComplexityBoundaryForMaxBitrate",
		labelKey: "wizard.lowComplexityBoundary",
		control: "num",
	},
	{
		key: "highComplexityBoundaryForMaxBitrate",
		labelKey: "wizard.highComplexityBoundary",
		control: "num",
	},
];

export type SourceOption = { value: string; label: string };

/**
 * What the Manifests step declared, fed back into "Placement & extras" so
 * the HLS/DASH placement fields explain themselves: the HLS group fields
 * surface only when a master multiplies variants per audio group, and the
 * DASH set select offers the DECLARED adaptation sets instead of free text.
 */
export type ManifestPlacement = {
	/** Any included HLS manifest with variantsPerAudioGroup on. */
	variantsPerAudioGroup: boolean;
	/**
	 * Adaptation sets declared across all included DASH manifests, deduped
	 * by {key, type} — manifestKeys lists every declaring manifest so the
	 * select can say WHERE a set lives when names repeat.
	 */
	dashAdaptationSets: {
		key: string;
		type: "VIDEO" | "AUDIO";
		lang?: string;
		label?: string;
		manifestKeys: string[];
	}[];
	/**
	 * Set keys declared with DIFFERENT types across manifests — dashSetKey
	 * routing cannot tell those apart; PLAN_DASH_SET_TYPE_MISMATCH blocks
	 * them at validation, the select surfaces the rename advice early.
	 */
	conflictingDashSetKeys: string[];
};

/**
 * Derives ManifestPlacement from the Manifests-step state (pure). The
 * primary DASH manifest compiles under the fixed key "dash" (buildPlan),
 * extra manifests carry their own keys.
 */
export function manifestPlacement(
	manifests: WizardManifests,
): ManifestPlacement {
	const declared: { manifestKey: string; set: WizardDashAdaptationSet }[] = [
		...(manifests.dash
			? (manifests.dashOptions?.adaptationSets ?? []).map((set) => ({
					manifestKey: "dash",
					set,
				}))
			: []),
		...(manifests.extra ?? []).flatMap((m) =>
			m.kind === "DASH"
				? (m.dash?.adaptationSets ?? []).map((set) => ({
						manifestKey: m.key,
						set,
					}))
				: [],
		),
	];
	// Identical {key, type} pairs collapse into one option (manifest list
	// merged); the same key under different types stays two entries and is
	// flagged as a conflict below.
	const options = new Map<
		string,
		ManifestPlacement["dashAdaptationSets"][number]
	>();
	for (const { manifestKey, set } of declared) {
		const id = `${set.type}\u001f${set.key}`;
		const existing = options.get(id);
		if (existing === undefined) {
			options.set(id, {
				key: set.key,
				type: set.type,
				lang: set.lang,
				label: set.label,
				manifestKeys: [manifestKey],
			});
		} else if (!existing.manifestKeys.includes(manifestKey)) {
			existing.manifestKeys.push(manifestKey);
		}
	}
	const dashAdaptationSets = [...options.values()];
	const conflictingDashSetKeys = [
		...new Set(
			dashAdaptationSets
				.filter((a) =>
					dashAdaptationSets.some((b) => b.key === a.key && b.type !== a.type),
				)
				.map((set) => set.key),
		),
	];
	return {
		variantsPerAudioGroup:
			(manifests.hls && manifests.hlsOptions?.variantsPerAudioGroup === true) ||
			(manifests.extra ?? []).some(
				(m) => m.kind === "HLS" && m.hls?.variantsPerAudioGroup === true,
			),
		dashAdaptationSets,
		conflictingDashSetKeys,
	};
}

export function ExtrasEditor({
	fixedMode = false,
	idBase,
	family,
	extras,
	onChange,
	sourceOptions,
	encodingKeys,
	filterKeys,
	onDefineDeinterlace,
	inputFiles = [],
	videoWidth,
	onVideoWidthChange,
	nexguardCredentials,
}: {
	idBase: string;
	family: "video" | "audio" | "subtitle";
	fixedMode?: boolean;
	extras: WizardRenditionExtras | undefined;
	onChange: (next: WizardRenditionExtras) => void;
	sourceOptions: SourceOption[];
	encodingKeys: string[];
	filterKeys: string[];
	/**
	 * (b): define-and-attach in ONE gesture — the parent appends a
	 * plan-level DEINTERLACE filter and returns its key; this editor attaches
	 * it immediately. Absent on non-video families.
	 */
	onDefineDeinterlace?: () => string;
	inputFiles?: { key: string; label: string }[];
	videoWidth?: number;
	onVideoWidthChange?: (width: number | undefined) => void;
	nexguardCredentials: CredentialSummaryWire[];
}) {
	const { t } = useT();
	const value = extras ?? {};
	return (
		<Collapsible summary={t("wizard.placementExtras")}>
			{family === "video" && onVideoWidthChange ? (
				<Field label={t("liveWizard.outputWidth")} htmlFor={`${idBase}-width`}>
					<Input
						id={`${idBase}-width`}
						type="number"
						min={1}
						step={1}
						value={videoWidth ?? ""}
						onChange={(e) =>
							onVideoWidthChange(
								e.target.value === "" ? undefined : Number(e.target.value),
							)
						}
					/>
				</Field>
			) : null}
			<Field
				label={t("wizard.sourceStream")}
				htmlFor={`${idBase}-source`}
				help={t("wizard.ingestTrackFileStreamOrDolbyStream")}
			>
				<SelectNative
					id={`${idBase}-source`}
					value={value.source ?? ""}
					onChange={(e) =>
						onChange({ ...value, source: e.target.value || undefined })
					}
				>
					{value.source &&
					!sourceOptions.some((option) => option.value === value.source) ? (
						<option value={value.source}>
							{value.source} {t("wizardX.missingParen")}
						</option>
					) : null}
					{sourceOptions.map((option) => (
						<option key={option.value || "(implicit)"} value={option.value}>
							{option.label}
						</option>
					))}
				</SelectNative>
			</Field>
			{encodingKeys.length > 0 ? (
				<Field
					label={t("wizard.encoding")}
					htmlFor={`${idBase}-enc`}
					help={t("wizard.partitionedPlansMustAssignEveryRenditionTo")}
				>
					<SelectNative
						id={`${idBase}-enc`}
						value={value.encodingKey ?? ""}
						onChange={(e) =>
							onChange({ ...value, encodingKey: e.target.value || undefined })
						}
					>
						<option value="">{t("wizard.unassigned")}</option>
						{encodingKeys.map((key) => (
							<option key={key} value={key}>
								{key}
							</option>
						))}
					</SelectNative>
				</Field>
			) : null}
			{family === "video" ? (
				<>
					<Field
						label={t("wizard.streamMode")}
						htmlFor={`${idBase}-mode`}
						help={t("wizard.perTitleTemplatesLeaveBitrateToThe")}
					>
						<SelectNative
							id={`${idBase}-mode`}
							value={value.mode ?? "STANDARD"}
							onChange={(e) =>
								onChange({
									...value,
									mode:
										e.target.value === "STANDARD"
											? undefined
											: (e.target.value as WizardRenditionExtras["mode"]),
								})
							}
						>
							<option value="STANDARD">STANDARD</option>
							<option value="PER_TITLE_TEMPLATE" disabled={fixedMode}>
								PER_TITLE_TEMPLATE
							</option>
							<option
								value="PER_TITLE_TEMPLATE_FIXED_RESOLUTION"
								disabled={fixedMode}
							>
								PER_TITLE_TEMPLATE_FIXED_RESOLUTION
							</option>
							<option
								value="PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE"
								disabled={fixedMode}
							>
								PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE
							</option>
						</SelectNative>
					</Field>
					{value.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" ? (
						<Collapsible summary={t("wizard.perTitleFixedResolutionBitrate")}>
							<OptionsGrid
								idBase={`${idBase}-pts`}
								value={value.perTitleSettings ?? {}}
								fields={PER_TITLE_STREAM_FIELDS}
								onChange={(perTitleSettings) =>
									onChange({ ...value, perTitleSettings })
								}
							/>
						</Collapsible>
					) : null}
				</>
			) : null}
			{family === "video" ? (
				<BurnInSrtEditor
					idBase={idBase}
					value={value.burnInSrt}
					inputFiles={inputFiles}
					onChange={(burnInSrt) => onChange({ ...value, burnInSrt })}
				/>
			) : null}
			<Collapsible summary={t("wizard.nexguardWatermarking")}>
				{value.nexguard ? (
					<div className="space-y-3">
						<Field
							label={t("wizard.nexguardLicense")}
							htmlFor={`${idBase}-ng-cred`}
							help={t("wizard.vaultCredentialTheLicenseItselfNeverEnters")}
						>
							<SelectNative
								id={`${idBase}-ng-cred`}
								value={value.nexguard.credentialId}
								onChange={(e) =>
									onChange({
										...value,
										nexguard: value.nexguard
											? { ...value.nexguard, credentialId: e.target.value }
											: undefined,
									})
								}
							>
								<option value="">{t("wizard.selectCredential")}</option>
								{nexguardCredentials.map((credential) => (
									<option key={credential.id} value={credential.id}>
										{credential.label}
									</option>
								))}
							</SelectNative>
							<NewCredentialLink />
						</Field>
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
							<Field
								label={t("wizard.watermarkType")}
								htmlFor={`${idBase}-ng-type`}
							>
								<SelectNative
									id={`${idBase}-ng-type`}
									value={value.nexguard.watermarkType}
									onChange={(e) =>
										onChange({
											...value,
											nexguard: value.nexguard
												? {
														...value.nexguard,
														watermarkType: e.target.value as
															| "OTT"
															| "DUPLICATED",
													}
												: undefined,
										})
									}
								>
									<option value="OTT">OTT</option>
									<option value="DUPLICATED">DUPLICATED</option>
								</SelectNative>
							</Field>
							<Field
								label={t("wizard.preset2")}
								htmlFor={`${idBase}-ng-preset`}
							>
								<Input
									id={`${idBase}-ng-preset`}
									value={value.nexguard.preset}
									onChange={(e) =>
										onChange({
											...value,
											nexguard: value.nexguard
												? { ...value.nexguard, preset: e.target.value }
												: undefined,
										})
									}
								/>
							</Field>
							<Field
								label={t("wizard.strength")}
								htmlFor={`${idBase}-ng-strength`}
							>
								<SelectNative
									id={`${idBase}-ng-strength`}
									value={value.nexguard.strength ?? ""}
									onChange={(e) =>
										onChange({
											...value,
											nexguard: value.nexguard
												? {
														...value.nexguard,
														strength:
															e.target.value === ""
																? undefined
																: (e.target
																		.value as WizardNexGuard["strength"]),
													}
												: undefined,
										})
									}
								>
									<option value="">{t("wizard.default")}</option>
									{[
										"LIGHTEST",
										"LIGHTER",
										"DEFAULT",
										"STRONGER",
										"STRONGEST",
									].map((strength) => (
										<option key={strength} value={strength}>
											{strength}
										</option>
									))}
								</SelectNative>
							</Field>
						</div>
						<RowRemoveButton
							label={t("wizard.removeNexguardWatermarking")}
							onClick={() => onChange({ ...value, nexguard: undefined })}
						/>
					</div>
				) : (
					<Button
						variant="secondary"
						size="sm"
						onClick={() =>
							onChange({
								...value,
								nexguard: {
									credentialId: "",
									watermarkType: "OTT",
									preset: "",
								},
							})
						}
					>
						{t("wizard.addNexguardWatermarking")}
					</Button>
				)}
			</Collapsible>
			<Collapsible summary={t("wizard.filtersDeinterlace")}>
				<p className="text-xs text-zinc-500">
					{t("wizard.attachmentOrderMattersPositionIsTheCreate")}
				</p>
				{onDefineDeinterlace ? (
					<Button
						type="button"
						variant="secondary"
						size="sm"
						onClick={() => {
							const key = onDefineDeinterlace();
							onChange({
								...value,
								filters: [
									...(value.filters ?? []),
									{ filterKey: key, position: value.filters?.length ?? 0 },
								],
							});
						}}
					>
						{t("wizard.defineAndAttachDeinterlace")}
					</Button>
				) : null}
				{(value.filters ?? []).map((attachment, index) => (
					<div key={index} className="flex items-start gap-2">
						<Field
							label={t("wizard.filter")}
							htmlFor={`${idBase}-flt-${index}`}
						>
							<SelectNative
								id={`${idBase}-flt-${index}`}
								value={attachment.filterKey}
								onChange={(e) => {
									const filters = [...(value.filters ?? [])];
									filters[index] = {
										...attachment,
										filterKey: e.target.value,
									};
									onChange({ ...value, filters });
								}}
							>
								<option value="">{t("wizard.selectFilter")}</option>
								{attachment.filterKey &&
								!filterKeys.includes(attachment.filterKey) ? (
									<option value={attachment.filterKey}>
										{attachment.filterKey} {t("wizardX.missingParen")}
									</option>
								) : null}
								{filterKeys.map((key) => (
									<option key={key} value={key}>
										{key}
									</option>
								))}
							</SelectNative>
						</Field>
						<Field
							label={t("wizard.position")}
							htmlFor={`${idBase}-fltpos-${index}`}
						>
							<Input
								id={`${idBase}-fltpos-${index}`}
								type="number"
								value={attachment.position}
								onChange={(e) => {
									const filters = [...(value.filters ?? [])];
									filters[index] = {
										...attachment,
										position: Math.max(
											0,
											Math.round(Number(e.target.value) || 0),
										),
									};
									onChange({ ...value, filters });
								}}
							/>
						</Field>
						<FieldRowAction>
							<RowRemoveButton
								label={t("wizardX.removeFilterAttachmentN", { n: index + 1 })}
								onClick={() =>
									onChange({
										...value,
										filters: (value.filters ?? []).filter(
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
						onChange({
							...value,
							filters: [
								...(value.filters ?? []),
								{
									filterKey: filterKeys[0] ?? "",
									position: value.filters?.length ?? 0,
								},
							],
						})
					}
				>
					{t("wizard.attachFilter")}
				</Button>
			</Collapsible>
		</Collapsible>
	);
}

/**
 * Per-rendition manifest placement (DASH adaptation-set routing + HLS
 * variant label / EXT-X-MEDIA entry). Lives in the Manifests step, not the
 * Ladder: these are manifest-level constructs (the Dolby DV/HDR10/SDR presets
 * use them to keep ladders apart), not stream/codec settings.
 */
export function RenditionPlacement({
	idBase,
	family,
	value,
	placement,
	onChange,
}: {
	idBase: string;
	family: "video" | "audio" | "subtitle";
	fixedMode?: boolean;
	value: WizardRenditionExtras;
	placement: ManifestPlacement;
	onChange: (next: WizardRenditionExtras) => void;
}) {
	const { t } = useT();
	return (
		<>
			{placement.dashAdaptationSets.length > 0 ||
			value.dashSetKey !== undefined ? (
				<Field
					label={t("wizard.dashAdaptationSet")}
					htmlFor={`${idBase}-dashset`}
					help={t("wizard.routesThisRenditionIntoTheMatchingSet")}
				>
					<SelectNative
						id={`${idBase}-dashset`}
						value={value.dashSetKey ?? ""}
						onChange={(e) =>
							onChange({ ...value, dashSetKey: e.target.value || undefined })
						}
					>
						<option value="">{t("wizard.implicitSet")}</option>
						{placement.dashAdaptationSets.map((set) => (
							<option key={`${set.type}-${set.key}`} value={set.key}>
								{set.key} — manifest{set.manifestKeys.length > 1 ? "s" : ""}{" "}
								{set.manifestKeys.join(", ")} ({set.type}
								{set.lang ? `, ${set.lang}` : ""}
								{set.label ? `, ${set.label}` : ""})
							</option>
						))}
						{value.dashSetKey !== undefined &&
						!placement.dashAdaptationSets.some(
							(set) => set.key === value.dashSetKey,
						) ? (
							<option value={value.dashSetKey}>
								{value.dashSetKey} {t("wizardX.notDeclaredParen")}
							</option>
						) : null}
					</SelectNative>
					{placement.conflictingDashSetKeys.map((key) => (
						<p key={key} role="alert" className="text-amber-400 text-xs">
							{t("wizardX.setKeyConflictingTypes", { key })}
						</p>
					))}
				</Field>
			) : (
				<p className="text-xs text-zinc-600">
					{t("wizard.dashAdaptationSetRoutingAppearsHereOnce")}
				</p>
			)}
			{family === "video" ? (
				<HlsVideoUriField
					id={`${idBase}-hls-video-uri`}
					value={value.hlsVariantUri}
					perTitle={value.mode?.startsWith("PER_TITLE")}
					onChange={(hlsVariantUri) => onChange({ ...value, hlsVariantUri })}
				/>
			) : null}
			<HlsPlacementBlock
				idBase={idBase}
				family={family}
				value={value}
				prominent={placement.variantsPerAudioGroup}
				onChange={onChange}
			/>
		</>
	);
}

/**
 * HLS audio-group placement (variant label + EXT-X-MEDIA entry). Only
 * multi-audio-group masters need these, so the block stays collapsed under
 * "Advanced placement" until a manifest turns variantsPerAudioGroup on —
 * then it surfaces with instructions instead of leaving the user guessing
 * (the fields previously sat unexplained in the extras grid).
 */
function HlsPlacementBlock({
	idBase,
	family,
	value,
	prominent,
	onChange,
}: {
	idBase: string;
	family: "video" | "audio" | "subtitle";
	fixedMode?: boolean;
	value: WizardRenditionExtras;
	prominent: boolean;
	onChange: (next: WizardRenditionExtras) => void;
}) {
	const { t } = useT();
	const fields = (
		<>
			<Field
				label={t("wizard.hlsVariantLabel")}
				htmlFor={`${idBase}-hlsvariant`}
				help={
					family === "video"
						? t("wizard.namesThisLadderSVariantEntriesWhen")
						: t("wizard.variantLabelsMostlyBelongOnVideoRenditions")
				}
			>
				<Input
					id={`${idBase}-hlsvariant`}
					value={value.hlsVariantLabel ?? ""}
					onChange={(e) =>
						onChange({
							...value,
							hlsVariantLabel: e.target.value || undefined,
						})
					}
				/>
			</Field>
			<div className="space-y-2">
				<p className="text-xs text-zinc-500">
					{t("ui.hlsMediaEntryWritesAnExtX")}
				</p>
				{value.hlsMedia ? (
					<div className="space-y-3">
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
							{(["groupId", "name", "uri"] as const).map((key) => (
								<Field
									key={key}
									label={t("wizardX.mediaKey", { key })}
									htmlFor={`${idBase}-media-${key}`}
								>
									<Input
										id={`${idBase}-media-${key}`}
										value={value.hlsMedia?.[key] ?? ""}
										onChange={(e) =>
											onChange({
												...value,
												hlsMedia: value.hlsMedia
													? { ...value.hlsMedia, [key]: e.target.value }
													: undefined,
											})
										}
									/>
								</Field>
							))}
						</div>
						<div className="flex gap-6">
							{(["isDefault", "autoselect"] as const).map((key) => (
								<label
									key={key}
									className="flex items-center gap-2 text-xs text-zinc-300"
								>
									<input
										type="checkbox"
										className="h-3.5 w-3.5 accent-emerald-600"
										checked={value.hlsMedia?.[key] ?? false}
										onChange={(e) =>
											onChange({
												...value,
												hlsMedia: value.hlsMedia
													? { ...value.hlsMedia, [key]: e.target.checked }
													: undefined,
											})
										}
									/>
									{key}
								</label>
							))}
						</div>
						<RowRemoveButton
							label={t("wizard.removeHlsMediaEntry")}
							onClick={() => onChange({ ...value, hlsMedia: undefined })}
						/>
					</div>
				) : (
					<Button
						variant="secondary"
						size="sm"
						onClick={() =>
							onChange({
								...value,
								hlsMedia: { groupId: "", name: "", uri: "" },
							})
						}
					>
						{t("wizard.addHlsMediaEntry")}
					</Button>
				)}
			</div>
		</>
	);

	if (prominent) {
		return (
			<div className="space-y-3 rounded-md border border-emerald-900/50 bg-emerald-950/10 p-3">
				<p className="text-xs text-emerald-300/90">
					{t("wizard.aManifestInThisPlanMultipliesHls")}
				</p>
				{fields}
			</div>
		);
	}
	return (
		<Collapsible summary={t("wizard.advancedPlacementHlsAudioGroups")}>
			<p className="text-xs text-zinc-500">
				{t("wizard.onlyNeededForMultiAudioGroupHls")}
			</p>
			{fields}
		</Collapsible>
	);
}
