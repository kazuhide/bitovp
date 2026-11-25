"use client";
import { AUDIO_MIX_CHANNEL_TYPES, type AudioMixChannel } from "@bitovp/core";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";

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
export function ChannelTypeOptions({ value }: { value: string }) {
	return (
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
}

type Source = AudioMixChannel["sourceChannels"][number];

export function MixSources({
	id,
	values,
	onChange,
}: {
	id: string;
	values: Source[];
	onChange: (values: Source[]) => void;
}) {
	const { t } = useT();
	return (
		<>
			{values.map((source, index) => {
				const prefix = `${id}-${index}`;
				const patch = (change: Partial<Source>) =>
					onChange(
						values.map((item, i) =>
							i === index ? { ...item, ...change } : item,
						),
					);
				return (
					<div key={index} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
						<Field label={t("audioMix.channel")} htmlFor={`${prefix}-type`}>
							<SelectNative
								id={`${prefix}-type`}
								value={source.type}
								onChange={(event) => {
									const type = event.target.value as Source["type"];
									patch({
										type,
										channelNumber: type === "CHANNEL_NUMBER" ? 0 : undefined,
									});
								}}
							>
								<ChannelTypeOptions value={source.type} />
							</SelectNative>
						</Field>
						{source.type === "CHANNEL_NUMBER" && (
							<Field label={t("audioMix.number")} htmlFor={`${prefix}-number`}>
								<Input
									id={`${prefix}-number`}
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
						<Field label={t("audioMix.gain")} htmlFor={`${prefix}-gain`}>
							<Gain
								id={`${prefix}-gain`}
								value={source.gain}
								onChange={(gain) => patch({ gain })}
							/>
						</Field>
						<Button
							variant="ghost"
							size="sm"
							disabled={values.length === 1}
							onClick={() => onChange(values.filter((_, i) => i !== index))}
						>
							{t("audioMix.remove")}
						</Button>
					</div>
				);
			})}
			<Button
				variant="secondary"
				size="sm"
				onClick={() =>
					onChange([
						...values,
						values[0]?.type === "CHANNEL_NUMBER"
							? { type: "CHANNEL_NUMBER", channelNumber: 0 }
							: { type: "CENTER" },
					])
				}
			>
				{t("audioMix.addSource")}
			</Button>
		</>
	);
}
