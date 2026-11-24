"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type {
	MoqPlaybackSettings,
	MoqVideoQualitySelection,
} from "@/lib/moq-player/session";

type Props = {
	settings: MoqPlaybackSettings;
	updateSetting(key: keyof MoqPlaybackSettings, value: number): boolean;
	qualitySelection: MoqVideoQualitySelection | null;
	selectQuality(name: string): boolean;
};

export function MoqPlaybackControls({
	settings,
	updateSetting,
	qualitySelection,
	selectQuality,
}: Props) {
	const { t } = useT();
	const targetId = useId();
	const qualityId = useId();
	const errorId = useId();
	const [target, setTarget] = useState(String(settings.targetBufferMs));
	const [bufferError, setBufferError] = useState<
		"invalidTargetBuffer" | "settingFailed"
	>();
	const [adjustmentFailed, setAdjustmentFailed] = useState(false);

	return (
		<details className="col-span-full row-start-3 min-w-0 border-t border-zinc-800 px-3 py-2">
			<summary className="w-fit cursor-pointer rounded text-xs text-zinc-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500">
				{t("moqPlayback.settings")}{" "}
				<span className="ml-1 text-zinc-400 tabular-nums">
					{settings.targetBufferMs} ms
				</span>
			</summary>
			<div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-2">
				<form
					noValidate
					className="flex items-end gap-1.5"
					onSubmit={(event) => {
						event.preventDefault();
						const ms = Number(target);
						if (!target.trim() || !Number.isSafeInteger(ms) || ms < 0) {
							setBufferError("invalidTargetBuffer");
							return;
						}
						setBufferError(
							updateSetting("targetBufferMs", ms) ? undefined : "settingFailed",
						);
					}}
				>
					<label
						htmlFor={targetId}
						className="grid gap-1 text-xs text-zinc-400"
					>
						{t("moqPlayback.targetBuffer")}
						<Input
							id={targetId}
							type="number"
							min={0}
							step={1}
							inputMode="numeric"
							value={target}
							className="h-8 w-28 tabular-nums"
							aria-invalid={bufferError === "invalidTargetBuffer" || undefined}
							aria-describedby={bufferError ? errorId : undefined}
							onChange={(event) => {
								setTarget(event.target.value);
								setBufferError(undefined);
							}}
						/>
					</label>
					<Button size="sm" variant="secondary" type="submit">
						{t("moqPlayback.applySetting")}
					</Button>
				</form>
				<label className="grid gap-1 text-xs text-zinc-400">
					{t("moqPlayback.volume")}
					<span className="flex h-8 items-center gap-2">
						<input
							type="range"
							min={0}
							max={100}
							value={settings.volumePercent}
							aria-label={t("moqPlayback.volume")}
							aria-valuetext={`${settings.volumePercent}%`}
							className="h-7 w-24 accent-emerald-500 focus-visible:outline-2 focus-visible:outline-emerald-500"
							onChange={(event) =>
								setAdjustmentFailed(
									!updateSetting("volumePercent", event.target.valueAsNumber),
								)
							}
						/>
						<span aria-hidden className="w-9 text-right tabular-nums">
							{settings.volumePercent}%
						</span>
					</span>
				</label>
				{qualitySelection ? (
					<label
						htmlFor={qualityId}
						className="grid min-w-0 max-w-full gap-1 text-xs text-zinc-400"
					>
						{t("moqPlayback.videoQuality")}
						<SelectNative
							id={qualityId}
							value={qualitySelection.current ?? ""}
							className="h-8 max-w-full py-1"
							onChange={(event) =>
								setAdjustmentFailed(!selectQuality(event.target.value))
							}
						>
							<option value="" disabled>
								{t("moqPlayback.chooseQuality")}
							</option>
							{qualitySelection.options.map(({ name, width, height }) => (
								<option key={name} value={name}>
									{name}
									{width && height ? ` (${width}×${height})` : ""}
								</option>
							))}
						</SelectNative>
					</label>
				) : null}
			</div>
			{bufferError ? (
				<p role="alert" id={errorId} className="mt-1.5 text-xs text-red-300">
					{t(`moqPlayback.${bufferError}`)}
				</p>
			) : null}
			{adjustmentFailed ? (
				<p role="alert" className="mt-1.5 text-xs text-red-300">
					{t("moqPlayback.settingFailed")}
				</p>
			) : null}
		</details>
	);
}
