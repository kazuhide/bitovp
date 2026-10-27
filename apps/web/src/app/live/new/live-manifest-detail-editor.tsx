"use client";

import type {
	LiveDashDetailedOptions,
	LiveHlsDetailedOptions,
} from "@bitovp/core";
import {
	ManifestDetailEditor,
	type ManifestResources,
} from "@/app/vod/new/manifest-detail-editor";
import {
	Collapsible,
	type OptionFieldSpec,
	OptionsGrid,
} from "@/app/vod/new/wizard-fields";
import { useT } from "@/lib/i18n/context";
import {
	buildLiveChannelPlan,
	type LiveDashManifestState,
	type LiveHlsManifestState,
	type LiveWizardState,
} from "./build-live-plan";

const versions = [
	"HLS_V3",
	"HLS_V4",
	"HLS_V5",
	"HLS_V6",
	"HLS_V7",
	"HLS_V8",
] as const;
const versionFields: OptionFieldSpec[] = [
	{
		key: "masterVersion",
		labelKey: "wizard.masterVersion",
		control: { options: versions },
	},
	{
		key: "mediaVersion",
		labelKey: "wizard.mediaVersion",
		control: { options: versions },
	},
];
type Props = { idBase: string; state: LiveWizardState } & (
	| {
			kind: "HLS";
			value: LiveHlsManifestState;
			onChange: (value: LiveHlsManifestState) => void;
	  }
	| {
			kind: "DASH";
			value: LiveDashManifestState;
			onChange: (value: LiveDashManifestState) => void;
	  }
);
export function LiveManifestDetailEditor(props: Props) {
	const { t } = useT();
	const plan = buildLiveChannelPlan(props.state);
	const resources: ManifestResources = {
		muxings: plan.muxings
			.filter((muxing) =>
				props.kind === "HLS"
					? muxing.kind === "FMP4" || muxing.kind === "TS"
					: muxing.kind === "FMP4" || muxing.kind === "CMAF",
			)
			.map((muxing) => ({
				value: muxing.key,
				label: `${muxing.name || muxing.streamKey} · ${muxing.kind}`,
			})),
		drm: (plan.drm ?? []).map((drm) => ({
			value: drm.key,
			label: `${drm.kind} · ${drm.muxingKey}`,
		})),
		keyframes: [],
		sprites: [],
		encodings: [{ value: "default", label: plan.name }],
	};
	return (
		<Collapsible summary={t("manifestDetail.title")} deferContent>
			{props.kind === "HLS" ? (
				<OptionsGrid
					idBase={`${props.idBase}-versions`}
					value={props.value}
					fields={versionFields}
					onChange={(next: LiveHlsManifestState) => props.onChange(next)}
				/>
			) : null}
			<ManifestDetailEditor
				kind={props.kind}
				idBase={props.idBase}
				live
				value={props.value.detailed ?? {}}
				resources={resources}
				onChange={(detailed) => {
					if (props.kind === "HLS")
						props.onChange({
							...props.value,
							detailed: detailed as LiveHlsDetailedOptions,
						});
					else
						props.onChange({
							...props.value,
							detailed: detailed as LiveDashDetailedOptions,
						});
				}}
			/>
		</Collapsible>
	);
}
