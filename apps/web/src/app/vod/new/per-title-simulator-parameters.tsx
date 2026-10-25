"use client";

import type { PerTitleProposal } from "@bitovp/core";
import { useId } from "react";
import { useT } from "@/lib/i18n/context";
import {
	getPerTitleSetting,
	perTitleGlobalFields,
	perTitleStreamFields,
} from "./per-title-simulator-tuning";
import { perTitleStreamLabel } from "./per-title-stream-mode";

const texts = {
	en: {
		title: "Calculated Per-Title settings",
		streams: "Streams",
		mode: "Mode",
		dimensions: "Dimensions (px)",
		unset: "Unset",
		irrelevant: "Not applicable",
		invalid: "Invalid",
		included: "Included",
		empty: "No streams",
	},
	ja: {
		title: "計算後のPer-Title設定",
		streams: "ストリーム",
		mode: "モード",
		dimensions: "寸法 (px)",
		unset: "未設定",
		irrelevant: "対象外",
		invalid: "無効な値",
		included: "指定あり",
		empty: "ストリームなし",
	},
};

const codecKeys = {
	H264: "h264Configuration",
	H265: "h265Configuration",
	H265V2: "h265V2Configuration",
	VP9: "vp9Configuration",
	AV1: "av1Configuration",
};
const settingKeys = [
	"minBitrate",
	"maxBitrate",
	"bitrateSelectionMode",
	"lowComplexityBoundaryForMaxBitrate",
	"highComplexityBoundaryForMaxBitrate",
] as const;

export function PerTitleParameterView({
	proposal,
}: {
	proposal: PerTitleProposal;
}) {
	const { locale } = useT();
	const text = texts[locale];
	const id = useId();
	const global = proposal.api.global;
	const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
	const numeric = (
		value: number | undefined,
		kind: "bitrate" | "ratio" | "count" | "pixel",
	) => {
		if (value === undefined) return text.unset;
		if (
			!Number.isFinite(value) ||
			(kind === "count" ? value < 0 : value <= 0) ||
			(kind !== "ratio" && !Number.isSafeInteger(value))
		)
			return text.invalid;
		return kind === "bitrate" ? format.format(value / 1000) : String(value);
	};
	const enumeration = (
		value: string | undefined,
		allowed: readonly string[],
	) =>
		value === undefined
			? text.unset
			: allowed.includes(value)
				? value
				: text.invalid;
	const forced = global.fixedResolutionAndBitrateConfiguration;
	const optionalNumeric = (value: unknown, key: string) => {
		if (value === undefined) return text.unset;
		if (typeof value !== "number" || !Number.isFinite(value))
			return text.invalid;
		if (key === "resolutionScaleFactor")
			return value >= -15 && value <= 15 ? String(value) : text.invalid;
		if (key === "autoRepresentations.adoptConfigurationThreshold")
			return value >= 0 && value <= 1 ? String(value) : text.invalid;
		if (key.includes("Factor") && value <= 0) return text.invalid;
		return String(value);
	};
	const extraGlobal = perTitleGlobalFields(proposal.codec).filter(
		(field) =>
			field.group !== "range" &&
			field.group !== "spacing" &&
			field.group !== "additional" &&
			field.key !== "autoRepresentations" &&
			getPerTitleSetting(proposal, "global", field.key) !== undefined,
	);
	const outerFields = perTitleStreamFields(proposal.codec).filter(
		(field) =>
			!settingKeys.some((key) => key === field.key) &&
			proposal.api.streams.some(
				(stream) =>
					getPerTitleSetting(proposal, "stream", field.key, stream.rowId) !==
					undefined,
			),
	);
	const pairs = [
		["minBitrate (kbps)", numeric(global.minBitrate, "bitrate")],
		["maxBitrate (kbps)", numeric(global.maxBitrate, "bitrate")],
		["minBitrateStepSize", numeric(global.minBitrateStepSize, "ratio")],
		["maxBitrateStepSize", numeric(global.maxBitrateStepSize, "ratio")],
		[
			"autoRepresentations",
			global.autoRepresentations === undefined ? text.unset : text.included,
		],
		...extraGlobal.map((field) => [
			field.key,
			optionalNumeric(
				getPerTitleSetting(proposal, "global", field.key),
				field.key,
			),
		]),
		...(forced
			? [
					[
						"forcedRenditionAboveHighestFixedRepresentation",
						numeric(
							forced.forcedRenditionAboveHighestFixedRepresentation,
							"count",
						),
					],
					[
						"forcedRenditionAboveHighestFixedRepresentationFactor",
						numeric(
							forced.forcedRenditionAboveHighestFixedRepresentationFactor,
							"ratio",
						),
					],
					[
						"forcedRenditionAboveHighestFixedRepresentationCalculationMode",
						enumeration(
							forced.forcedRenditionAboveHighestFixedRepresentationCalculationMode,
							["LAST_CALCULATED_BITRATE", "MINIMUM", "MAXIMUM", "AVERAGE"],
						),
					],
				]
			: []),
	];
	return (
		<section
			aria-labelledby={`${id}-title`}
			className="min-w-0 space-y-3 border-t border-zinc-800 pt-3 text-xs"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h3 id={`${id}-title`} className="font-medium text-zinc-200">
					{text.title}
				</h3>
				<span className="text-zinc-400">
					<span>{proposal.codec}</span> ·{" "}
					<code>{codecKeys[proposal.codec]}</code>
				</span>
			</div>
			<dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
				{pairs.map(([name, value]) => (
					<div key={name} className="min-w-0">
						<dt className="break-words text-zinc-400">{name}</dt>
						<dd className="break-words text-zinc-200 tabular-nums">{value}</dd>
					</div>
				))}
			</dl>
			{proposal.api.streams.length ? (
				<section aria-label={text.streams} className="overflow-x-auto">
					<table className="w-full border-collapse text-left">
						<caption className="sr-only">{text.streams}</caption>
						<thead className="text-zinc-400">
							<tr>
								{[text.mode, text.dimensions].map((label) => (
									<th
										key={label}
										rowSpan={2}
										scope="col"
										className="px-2 py-1 align-bottom font-medium"
									>
										{label}
									</th>
								))}
								<th
									colSpan={5}
									scope="colgroup"
									className="px-2 py-1 font-medium"
								>
									perTitleSettings.fixedResolutionAndBitrateSettings
								</th>
								{outerFields.length ? (
									<th
										colSpan={outerFields.length}
										scope="colgroup"
										className="px-2 py-1 font-medium"
									>
										perTitleSettings
									</th>
								) : null}
							</tr>
							<tr>
								{settingKeys.map((key) => (
									<th
										key={key}
										scope="col"
										className="px-2 py-1 align-bottom font-medium"
									>
										<span className="block max-w-40 break-words">
											{key}
											{key === "bitrateSelectionMode" ? "" : " (kbps)"}
										</span>
									</th>
								))}
								{outerFields.map((field) => (
									<th
										key={field.key}
										scope="col"
										className="px-2 py-1 align-bottom font-medium"
									>
										<span className="block max-w-40 break-words">
											{field.key}
										</span>
									</th>
								))}
							</tr>
						</thead>
						<tbody className="text-zinc-200 tabular-nums">
							{proposal.api.streams.map((stream, index) => (
								<tr
									key={`${stream.rowId}-${index}`}
									className="border-t border-zinc-800"
								>
									<th scope="row" className="px-2 py-2 align-top font-medium">
										<span className="block max-w-48 break-all">
											{perTitleStreamLabel(stream, locale)}
										</span>
									</th>
									<td className="whitespace-nowrap px-2 py-2 align-top">
										{numeric(stream.width, "pixel")} ×{" "}
										{numeric(stream.height, "pixel")}
									</td>
									{settingKeys.map((key) => {
										const settings = stream.perTitleSettings;
										const inactive =
											stream.mode !==
												"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" ||
											((key === "lowComplexityBoundaryForMaxBitrate" ||
												key === "highComplexityBoundaryForMaxBitrate") &&
												settings?.bitrateSelectionMode === "OPTIMIZED");
										const value = inactive
											? text.irrelevant
											: key === "bitrateSelectionMode"
												? enumeration(settings?.[key], [
														"OPTIMIZED",
														"COMPLEXITY_RANGE",
													])
												: numeric(settings?.[key], "bitrate");
										return (
											<td
												key={key}
												className="whitespace-nowrap px-2 py-2 align-top"
											>
												{value}
											</td>
										);
									})}
									{outerFields.map((field) => (
										<td key={field.key} className="px-2 py-2 align-top">
											{optionalNumeric(
												getPerTitleSetting(
													proposal,
													"stream",
													field.key,
													stream.rowId,
												),
												field.key,
											)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</section>
			) : (
				<p className="text-zinc-400">{text.empty}</p>
			)}
		</section>
	);
}
