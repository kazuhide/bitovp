"use client";
import { AUDIO_MIX_LAYOUTS, type MediaFilter } from "@bitovp/core";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { MixSources } from "./mix-sources";

type Filter = Extract<MediaFilter, { kind: "AUDIO_MIX" }>;

export function AudioMixFilterEditor({
	id,
	filter,
	onChange,
}: {
	id: string;
	filter: Filter;
	onChange: (filter: Filter) => void;
}) {
	const { t } = useT();
	const channels = filter.audioMixChannels;
	const setChannels = (audioMixChannels: Filter["audioMixChannels"]) =>
		onChange({ ...filter, audioMixChannels });
	return (
		<>
			<Field label={t("audioMix.layout")} htmlFor={`${id}-layout`}>
				<SelectNative
					id={`${id}-layout`}
					value={filter.channelLayout}
					onChange={(e) =>
						onChange({
							...filter,
							channelLayout: e.target.value as Filter["channelLayout"],
						})
					}
				>
					{AUDIO_MIX_LAYOUTS.map((layout) => (
						<option key={layout} value={layout}>
							{layout}
						</option>
					))}
				</SelectNative>
			</Field>
			<div className="col-span-full grid gap-3">
				{channels.map((channel, index) => (
					<fieldset
						key={channel.channelNumber}
						className="grid gap-2 rounded border p-3"
					>
						<legend>
							{t("audioMix.output")} {channel.channelNumber}
						</legend>
						<MixSources
							id={`${id}-mix-${channel.channelNumber}`}
							values={channel.sourceChannels}
							onChange={(sourceChannels) =>
								setChannels(
									channels.map((item, i) =>
										index === i ? { ...item, sourceChannels } : item,
									),
								)
							}
						/>
						<Button
							variant="ghost"
							size="sm"
							disabled={channels.length === 1}
							onClick={() =>
								setChannels(
									channels
										.filter((_, i) => i !== index)
										.map((item) => ({
											...item,
											channelNumber:
												item.channelNumber > channel.channelNumber
													? item.channelNumber - 1
													: item.channelNumber,
										})),
								)
							}
						>
							{t("audioMix.remove")}
						</Button>
					</fieldset>
				))}
				<Button
					variant="secondary"
					size="sm"
					onClick={() =>
						setChannels([
							...channels,
							{
								channelNumber: channels.length,
								sourceChannels: [
									{ type: "CHANNEL_NUMBER", channelNumber: channels.length },
								],
							},
						])
					}
				>
					{t("audioMix.add")}
				</Button>
			</div>
		</>
	);
}
