"use client";
import {
	AUDIO_MIX_CHANNEL_TYPES,
	AUDIO_MIX_LAYOUTS,
	type AudioMixChannel,
	type AudioMixStream,
	audioMixPreset,
} from "@bitovp/core";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type { WizardState } from "./build-plan";
import type { SourceOption } from "./rendition-editors";
import { Collapsible } from "./wizard-fields";

/** Keep intermediate decimals and empty values intact while editing. */
function Gain({
	value,
	onChange,
	id,
}: {
	value: number | undefined;
	onChange: (value: number | undefined) => void;
	id: string;
}) {
	const [draft, setDraft] = useState<string>();
	return (
		<Input
			id={id}
			type="text"
			inputMode="decimal"
			value={draft ?? (value === undefined ? "" : String(value))}
			placeholder="1"
			onChange={(e) => setDraft(e.target.value)}
			onBlur={() => {
				if (draft !== undefined) {
					const text = draft.trim();
					const next = Number(text);
					if (!text || Number.isFinite(next)) onChange(text ? next : undefined);
				}
				setDraft(undefined);
			}}
		/>
	);
}
export function AudioMixEditor({
	state,
	index,
	sourceOptions,
	onPatch,
}: {
	state: WizardState;
	index: number;
	sourceOptions: SourceOption[];
	onPatch: (patch: Partial<WizardState>) => void;
}) {
	const { t } = useT();
	const audio = state.audios[index];
	const sources = state.sources ?? {};
	const mixes = sources.audioMixStreams ?? [];
	const mix = mixes.find((s) => s.key === audio?.extras?.source);
	if (!audio) return null;
	const options = sourceOptions
		.map((o) => (o.value ? o : { ...o, value: "audio" }))
		.filter(
			(o) =>
				!mixes.some((s) => s.key === o.value) &&
				!(sources.tracks ?? []).some(
					(s) => s.key === o.value && s.selectionMode === "VIDEO_RELATIVE",
				) &&
				!(sources.dolbyStreams ?? []).some(
					(s) => s.key === o.value && s.kind !== "ATMOS",
				),
		);
	const first =
		mix?.audioMixChannels[0]?.sourceKey ??
		options.find((o) => o.value === (audio.extras?.source ?? "audio"))?.value ??
		options[0]?.value ??
		"audio";
	const save = (next: AudioMixStream, stereo = false) =>
		onPatch({
			sources: {
				...sources,
				audioMixStreams: mix
					? mixes.map((s) => (s.key === mix.key ? next : s))
					: [...mixes, next],
			},
			audios: state.audios.map((a, i) =>
				i === index
					? {
							...a,
							...(stereo ? { channelLayout: "CL_STEREO" } : {}),
							extras: { ...a.extras, source: next.key },
						}
					: a,
			),
		});
	const patchChannel = (i: number, patch: Partial<AudioMixChannel>) => {
		if (mix)
			save({
				...mix,
				audioMixChannels: mix.audioMixChannels.map((c, j) =>
					i === j ? { ...c, ...patch } : c,
				),
			});
	};
	const id = `wz-a-${index}-mix`;
	const types = (value: string) => (
		<>
			{!AUDIO_MIX_CHANNEL_TYPES.includes(
				value as (typeof AUDIO_MIX_CHANNEL_TYPES)[number],
			) && <option value={value}>{value}</option>}
			{AUDIO_MIX_CHANNEL_TYPES.map((type) => (
				<option key={type} value={type}>
					{type}
				</option>
			))}
		</>
	);
	const start = (preset: "swap" | "mono" | "downmix" | "custom") => {
		if (preset === "mono" && options.length < 2) return;
		const keys = [
			"video",
			"audio",
			...(sources.tracks ?? []).map((s) => s.key),
			...(sources.fileStreams ?? []).map((s) => s.key),
			...(sources.dolbyStreams ?? []).map((s) => s.key),
			...(sources.trimmingStreams ?? []).map((s) => s.key),
			...(sources.concatenationStreams ?? []).map((s) => s.key),
			...mixes.map((s) => s.key),
		];
		let n = 1;
		while (keys.includes(`audioMix${n}`)) n++;
		save(
			{
				key: mix?.key ?? `audioMix${n}`,
				channelLayout: "STEREO",
				audioMixChannels: audioMixPreset(
					preset,
					first,
					mix?.audioMixChannels.find((c) => c.sourceKey !== first)?.sourceKey ??
						options.find((o) => o.value !== first)?.value ??
						first,
				),
				encodingKey: mix?.encodingKey ?? audio.extras?.encodingKey,
			},
			true,
		);
	};
	return (
		<Collapsible
			summary={`${t("audioMix.title")}${mix ? ` · ${mix.channelLayout ?? t("audioMix.unset")} · ${mix.audioMixChannels.map((c) => `${c.outputChannelNumber ?? c.outputChannelType} ← ${c.sourceChannels.map((s) => s.channelNumber ?? s.type).join(" + ")}`).join(" / ")}` : ""}`}
		>
			<Field label={t("audioMix.preset")} htmlFor={`${id}-preset`}>
				<SelectNative
					id={`${id}-preset`}
					value=""
					onChange={(e) => {
						if (e.target.value)
							start(e.target.value as "swap" | "mono" | "downmix" | "custom");
					}}
				>
					<option value="">{t("audioMix.preset")}</option>
					{(["swap", "mono", "downmix", "custom"] as const).map((p) => (
						<option
							key={p}
							value={p}
							disabled={p === "mono" && options.length < 2}
						>
							{t(`audioMix.${p}`)}
						</option>
					))}
				</SelectNative>
			</Field>
			{options.length < 2 && (
				<p className="text-xs text-zinc-500">{t("audioMix.twoSources")}</p>
			)}
			{mix && (
				<>
					<Field
						label={t("audioMix.layout")}
						htmlFor={`${id}-layout`}
						help={t("audioMix.hint")}
					>
						<SelectNative
							id={`${id}-layout`}
							value={mix.channelLayout ?? ""}
							onChange={(e) =>
								save({
									...mix,
									channelLayout: (e.target.value ||
										undefined) as AudioMixStream["channelLayout"],
								})
							}
						>
							<option value="">{t("audioMix.unset")}</option>
							{AUDIO_MIX_LAYOUTS.map((layout) => (
								<option key={layout} value={layout}>
									{layout}
								</option>
							))}
						</SelectNative>
					</Field>
					{mix.audioMixChannels.map((channel, i) => (
						<div key={i} className="space-y-2 border-t border-zinc-800 pt-3">
							<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
								<Field
									label={t("audioMix.output")}
									htmlFor={`${id}-${i}-output`}
								>
									<SelectNative
										id={`${id}-${i}-output`}
										value={channel.outputChannelType}
										onChange={(e) =>
											patchChannel(i, {
												outputChannelType: e.target
													.value as AudioMixChannel["outputChannelType"],
												outputChannelNumber:
													e.target.value === "CHANNEL_NUMBER" ? 0 : undefined,
											})
										}
									>
										{types(channel.outputChannelType)}
									</SelectNative>
								</Field>
								<Field
									label={t("audioMix.source")}
									htmlFor={`${id}-${i}-source`}
								>
									<SelectNative
										id={`${id}-${i}-source`}
										value={channel.sourceKey}
										onChange={(e) =>
											patchChannel(i, { sourceKey: e.target.value })
										}
									>
										{!options.some((o) => o.value === channel.sourceKey) && (
											<option value={channel.sourceKey}>
												{t("audioMix.unknown")} · {channel.sourceKey}
											</option>
										)}
										{options.map((o) => (
											<option key={o.value} value={o.value}>
												{o.label}
											</option>
										))}
									</SelectNative>
								</Field>
								{channel.outputChannelType === "CHANNEL_NUMBER" && (
									<Field
										label={t("audioMix.number")}
										htmlFor={`${id}-${i}-number`}
									>
										<Input
											id={`${id}-${i}-number`}
											type="number"
											min={0}
											step={1}
											value={channel.outputChannelNumber ?? ""}
											onChange={(e) =>
												patchChannel(i, {
													outputChannelNumber:
														e.target.value === ""
															? undefined
															: Number(e.target.value),
												})
											}
										/>
									</Field>
								)}
							</div>
							{channel.sourceChannels.map((source, j) => {
								const patch = (next: Partial<typeof source>) =>
									patchChannel(i, {
										sourceChannels: channel.sourceChannels.map((s, k) =>
											k === j ? { ...s, ...next } : s,
										),
									});
								return (
									<div
										key={j}
										className="grid grid-cols-2 gap-2 sm:grid-cols-4"
									>
										<Field
											label={t("audioMix.channel")}
											htmlFor={`${id}-${i}-${j}-type`}
										>
											<SelectNative
												id={`${id}-${i}-${j}-type`}
												value={source.type}
												onChange={(e) =>
													patch({
														type: e.target.value as typeof source.type,
														channelNumber:
															e.target.value === "CHANNEL_NUMBER"
																? 0
																: undefined,
													})
												}
											>
												{types(source.type)}
											</SelectNative>
										</Field>
										{source.type === "CHANNEL_NUMBER" && (
											<Field
												label={t("audioMix.number")}
												htmlFor={`${id}-${i}-${j}-number`}
											>
												<Input
													id={`${id}-${i}-${j}-number`}
													type="number"
													min={0}
													step={1}
													value={source.channelNumber ?? ""}
													onChange={(e) =>
														patch({
															channelNumber:
																e.target.value === ""
																	? undefined
																	: Number(e.target.value),
														})
													}
												/>
											</Field>
										)}
										<Field
											label={t("audioMix.gain")}
											htmlFor={`${id}-${i}-${j}-gain`}
										>
											<Gain
												id={`${id}-${i}-${j}-gain`}
												value={source.gain}
												onChange={(gain) => patch({ gain })}
											/>
										</Field>
										<Button
											variant="ghost"
											size="sm"
											disabled={channel.sourceChannels.length === 1}
											onClick={() =>
												patchChannel(i, {
													sourceChannels: channel.sourceChannels.filter(
														(_, k) => k !== j,
													),
												})
											}
										>
											{t("audioMix.remove")}
										</Button>
									</div>
								);
							})}
							<div className="flex flex-wrap gap-2">
								<Button
									variant="secondary"
									size="sm"
									onClick={() =>
										patchChannel(i, {
											sourceChannels: [
												...channel.sourceChannels,
												channel.sourceChannels[0]?.type === "CHANNEL_NUMBER"
													? { type: "CHANNEL_NUMBER", channelNumber: 0 }
													: { type: "CENTER" },
											],
										})
									}
								>
									{t("audioMix.addSource")}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									disabled={mix.audioMixChannels.length === 1}
									onClick={() =>
										save({
											...mix,
											audioMixChannels: mix.audioMixChannels.filter(
												(_, j) => j !== i,
											),
										})
									}
								>
									{t("audioMix.remove")}
								</Button>
							</div>
						</div>
					))}
					<div className="flex flex-wrap gap-2">
						<Button
							variant="secondary"
							size="sm"
							onClick={() =>
								save({
									...mix,
									audioMixChannels: [
										...mix.audioMixChannels,
										{
											sourceKey: first,
											outputChannelType: "CENTER",
											sourceChannels: [
												mix.audioMixChannels[0]?.sourceChannels[0]?.type ===
												"CHANNEL_NUMBER"
													? { type: "CHANNEL_NUMBER", channelNumber: 0 }
													: { type: "CENTER" },
											],
										},
									],
								})
							}
						>
							{t("audioMix.add")}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								const referenced =
									state.audios.some(
										(a, i) => i !== index && a.extras?.source === mix.key,
									) ||
									(sources.trimmingStreams ?? []).some(
										(s) => s.sourceKey === mix.key,
									) ||
									(sources.concatenationStreams ?? []).some((s) =>
										s.sources.some((c) => c.sourceKey === mix.key),
									) ||
									mixes.some(
										(s) =>
											s.key !== mix.key &&
											s.audioMixChannels.some((c) => c.sourceKey === mix.key),
									);
								onPatch({
									sources: {
										...sources,
										audioMixStreams: referenced
											? mixes
											: mixes.filter((s) => s.key !== mix.key),
									},
									audios: state.audios.map((a, i) =>
										i === index
											? {
													...a,
													extras: {
														...a.extras,
														source: mix.audioMixChannels[0]?.sourceKey,
													},
												}
											: a,
									),
								});
							}}
						>
							{t("audioMix.disable")}
						</Button>
					</div>
				</>
			)}
		</Collapsible>
	);
}
