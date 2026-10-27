"use client";
import type { DashDetailedOptions, HlsDetailedOptions } from "@bitovp/core";
import { defaultHlsManualSelectors } from "@bitovp/core";
import { Field } from "@/components/ui/field";
import { SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type {
	WizardDashOptions,
	WizardHlsOptions,
	WizardState,
} from "./build-plan";
import { buildPlan } from "./build-plan";
import { DefaultPeriodsEditor } from "./manifest-default-periods-editor";
import {
	adaptation,
	type Bag,
	dashFields,
	dashGlobalFields,
	hlsFields,
	hlsGlobalFields,
	type ManifestResources,
	type Spec,
} from "./manifest-detail-fields";
import { ObjectFields } from "./manifest-field-editor";
import { Collapsible } from "./wizard-fields";

export type { ManifestResources } from "./manifest-detail-fields";

export function manifestResources(state: WizardState): ManifestResources {
	const plan = buildPlan(state);
	return {
		muxings: plan.muxings.map((m) => ({
			value: m.key,
			label: `${m.name || m.streamKey} · ${m.kind}`,
		})),
		keyframes: (plan.keyframes ?? []).map((k) => ({
			value: k.key,
			label: `${k.time} s`,
		})),
		sprites: (plan.sprites ?? []).map((s) => ({
			value: s.key,
			label: s.name || s.filename,
		})),
		drm: (plan.drm ?? []).map((d) => ({
			value: d.key,
			label: `${d.kind} · ${d.muxingKey}`,
		})),
		encodings: plan.encodings?.length
			? plan.encodings.map((e) => ({ value: e.key, label: e.name }))
			: [{ value: "default", label: plan.name }],
	};
}

/** Mode changes never erase shared rendition settings needed by another manual manifest. */
export function defaultHlsConflicts(
	state: WizardState,
	manifestKey: string,
): string[] {
	return defaultHlsManualSelectors(buildPlan(state), manifestKey)
		.filter((selector) => !selector.usedByManual)
		.map((selector) => `${selector.renditionKey}.${selector.field}`);
}

type AdvancedProps = {
	idBase: string;
	resources: ManifestResources;
	defaultHlsConflicts?: readonly string[];
} & (
	| {
			kind: "HLS";
			value: WizardHlsOptions;
			onChange: (value: WizardHlsOptions) => void;
	  }
	| {
			kind: "DASH";
			value: WizardDashOptions;
			onChange: (value: WizardDashOptions) => void;
	  }
);
export function ManifestAdvancedEditor(props: AdvancedProps) {
	const { t } = useT();
	const isDefault = props.value.generationMode === "DEFAULT";
	const incompatibleNames =
		props.kind === "HLS" && Boolean(props.defaultHlsConflicts?.length);
	return (
		<Collapsible summary={t("manifestDetail.title")} deferContent>
			<Field
				label={t("manifestDetail.generation")}
				htmlFor={`${props.idBase}-generation`}
				hint={
					props.kind === "HLS"
						? t(
								incompatibleNames
									? "manifestDetail.defaultHlsConflict"
									: "manifestDetail.defaultHlsSelection",
							)
						: undefined
				}
			>
				<SelectNative
					id={`${props.idBase}-generation`}
					value={props.value.generationMode ?? "MANUAL"}
					onChange={(event) => {
						const generationMode =
							event.target.value === "DEFAULT" ? "DEFAULT" : undefined;
						if (generationMode === "DEFAULT" && incompatibleNames) return;
						if (props.kind === "HLS")
							props.onChange(
								generationMode === "DEFAULT"
									? {
											acl: props.value.acl,
											generationMode,
											masterVersion: props.value.masterVersion,
											mediaVersion: props.value.mediaVersion,
											omitMasterVersion: props.value.omitMasterVersion,
											omitMediaVersion: props.value.omitMediaVersion,
											detailed: {
												channelsAttributeForAudio:
													props.value.detailed?.channelsAttributeForAudio,
												targetDurationRoundingMode:
													props.value.detailed?.targetDurationRoundingMode,
											},
										}
									: { ...props.value, generationMode },
							);
						else
							props.onChange(
								generationMode === "DEFAULT"
									? {
											acl: props.value.acl,
											generationMode,
											onDemand: props.value.onDemand,
											detailed: Object.fromEntries(
												dashGlobalFields.map((field) => [
													field.name,
													props.value.detailed?.[
														field.name as keyof DashDetailedOptions
													],
												]),
											) as DashDetailedOptions,
										}
									: {
											...props.value,
											generationMode,
											defaultPeriods: undefined,
										},
							);
					}}
				>
					<option value="MANUAL">{t("manifestDetail.manual")}</option>
					<option value="DEFAULT" disabled={incompatibleNames}>
						{t("manifestDetail.default")}
					</option>
				</SelectNative>
			</Field>
			<ManifestDetailEditor
				idBase={props.idBase}
				kind={props.kind}
				resources={props.resources}
				globalOnly={isDefault}
				value={props.value.detailed ?? {}}
				onChange={(detailed) => {
					if (props.kind === "HLS")
						props.onChange({
							...props.value,
							detailed: detailed as HlsDetailedOptions,
						});
					else
						props.onChange({
							...props.value,
							detailed: detailed as DashDetailedOptions,
						});
				}}
			/>
			{props.kind === "DASH" && isDefault ? (
				<DefaultPeriodsEditor
					idBase={`${props.idBase}-periods`}
					resources={props.resources}
					value={props.value.defaultPeriods ?? []}
					onChange={(defaultPeriods) =>
						props.onChange({ ...props.value, defaultPeriods })
					}
				/>
			) : null}
		</Collapsible>
	);
}
export function ManifestDetailEditor({
	kind,
	idBase,
	value,
	onChange,
	resources,
	globalOnly = false,
	live = false,
}: {
	kind: "HLS" | "DASH";
	idBase: string;
	value: HlsDetailedOptions | DashDetailedOptions;
	onChange: (value: HlsDetailedOptions | DashDetailedOptions) => void;
	resources: ManifestResources;
	globalOnly?: boolean;
	live?: boolean;
}) {
	const fields =
		kind === "HLS"
			? globalOnly
				? hlsGlobalFields
				: hlsFields
			: globalOnly
				? dashGlobalFields
				: dashFields;
	return (
		<ObjectFields
			idBase={idBase}
			value={value}
			onChange={onChange}
			resources={resources}
			fields={live ? liveFields(fields) : fields}
		/>
	);
}

/** The same named controls are shared by explicit adaptation sets. */
export function AdaptationDetailEditor({
	idBase,
	value,
	onChange,
	resources,
}: {
	idBase: string;
	value: Bag;
	onChange: (value: Bag) => void;
	resources: ManifestResources;
}) {
	return (
		<ObjectFields
			idBase={idBase}
			value={value}
			onChange={onChange}
			resources={resources}
			fields={adaptation}
		/>
	);
}

function liveFields(fields: Spec[], parent?: string): Spec[] {
	return fields.flatMap((field) =>
		field.resource === "keyframes" ||
		field.resource === "sprites" ||
		(parent === "subtitleMedia" &&
			["startSegmentNumber", "endSegmentNumber"].includes(field.name))
			? []
			: [
					{
						...field,
						...(field.name === "positionMode"
							? { values: ["TIME", "SEGMENT"] }
							: field.name === "type" &&
									field.values?.includes("PROGRESSIVE_WEBM")
								? { values: ["VTT"] }
								: {}),
						...(field.fields
							? { fields: liveFields(field.fields, field.name) }
							: {}),
					},
				],
	);
}
