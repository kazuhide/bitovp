"use client";

import type { LocalStoryTrailerIntent } from "@bitovp/core";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { SelectNative, Textarea } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { parseTrailerBrief } from "./trailer-brief";

const copy = {
	ja: {
		open: "指示から予告編を作る",
		close: "通常の編集案に戻る",
		unavailable: "予告編の作成にはローカルストーリー解析が必要です。",
		prompt: "予告編の指示",
		example: "予告編を30秒で作って。ネタバレを避けて。",
		review: "編集条件を確認",
		purpose: "用途",
		trailer: "予告編",
		durationMode: "尺の指定",
		target: "目標",
		upTo: "指定秒数以内",
		exact: "指定秒数ちょうど",
		disclosure: "明かしてよい範囲",
		setup: "導入のみ",
		question: "導入と未解決の問いまで",
		errors: {
			TRAILER_REQUIRED: "予告編を作る指示を入力してください。",
			DURATION_REQUIRED: "予告編の尺を秒で指定してください。",
			INVALID_DURATION: "尺は1〜180秒をフレーム単位で指定してください。",
			UNSUPPORTED:
				"予告編、秒数、ネタバレの回避や導入の範囲を指定してください。",
		},
	},
	en: {
		open: "Plan a trailer",
		close: "Return to standard editing",
		unavailable: "Trailer planning requires local story analysis.",
		prompt: "Trailer instructions",
		example: "Make a 30-second trailer. Avoid spoilers.",
		review: "Review editing instructions",
		purpose: "Purpose",
		trailer: "Trailer",
		durationMode: "Duration rule",
		target: "Target",
		upTo: "At most the requested duration",
		exact: "Exact duration",
		disclosure: "Disclosure",
		setup: "Setup only",
		question: "Setup and an open question",
		errors: {
			TRAILER_REQUIRED: "Ask for a trailer.",
			DURATION_REQUIRED: "Specify the trailer duration in seconds.",
			INVALID_DURATION:
				"Enter a duration from 1 to 180 seconds in whole-frame increments.",
			UNSUPPORTED:
				"Specify a trailer, its duration in seconds, and whether to keep to the setup or avoid spoilers.",
		},
	},
};

export function TrailerBriefEditor({
	active,
	intent,
	available,
	disabled,
	onActiveChange,
	onIntentChange,
	onDurationChange,
}: {
	active: boolean;
	intent?: LocalStoryTrailerIntent;
	available: boolean;
	disabled: boolean;
	onActiveChange(active: boolean): void;
	onIntentChange(intent: LocalStoryTrailerIntent | undefined): void;
	onDurationChange(seconds: string): void;
}) {
	const c = copy[useT().locale],
		id = useId();
	const [prompt, setPrompt] = useState("");
	const [error, setError] = useState("");
	const locked = disabled || !available;
	return (
		<div className="space-y-3" id="trailer-brief">
			<Button
				type="button"
				variant="secondary"
				aria-expanded={active}
				aria-controls={id}
				aria-describedby={!available ? `${id}-available` : undefined}
				disabled={disabled || (!active && !available)}
				onClick={() => {
					setError("");
					onActiveChange(!active);
				}}
			>
				{active ? c.close : c.open}
			</Button>
			{!available && (
				<p id={`${id}-available`} className="text-sm text-zinc-400">
					{c.unavailable}
				</p>
			)}
			<div id={id} hidden={!active} className="space-y-3">
				<Field
					label={c.prompt}
					htmlFor={`${id}-prompt`}
					error={error || undefined}
				>
					<Textarea
						id={`${id}-prompt`}
						rows={2}
						maxLength={512}
						placeholder={c.example}
						value={prompt}
						disabled={locked}
						aria-invalid={Boolean(error)}
						onChange={(event) => {
							setPrompt(event.target.value);
							setError("");
							onIntentChange(undefined);
						}}
					/>
				</Field>
				<Button
					type="button"
					variant="secondary"
					disabled={locked || !prompt.trim()}
					onClick={() => {
						const result = parseTrailerBrief(prompt);
						if (!result.ok) {
							setError(c.errors[result.reason]);
							onIntentChange(undefined);
							return;
						}
						setError("");
						onDurationChange(String(result.seconds));
						onIntentChange(result.intent);
					}}
				>
					{c.review}
				</Button>
				{intent && (
					<div className="grid items-end gap-3 rounded-md border border-zinc-800 p-3 sm:grid-cols-[auto_1fr_1fr]">
						<dl className="text-sm">
							<dt className="text-zinc-400">{c.purpose}</dt>
							<dd className="font-medium">{c.trailer}</dd>
						</dl>
						<Field label={c.durationMode} htmlFor={`${id}-duration-mode`}>
							<SelectNative
								id={`${id}-duration-mode`}
								disabled={locked}
								value={intent.durationMode}
								onChange={(event) => {
									const { value } = event.target;
									if (
										value === "TARGET" ||
										value === "UP_TO" ||
										value === "EXACT"
									)
										onIntentChange({ ...intent, durationMode: value });
								}}
							>
								<option value="TARGET">{c.target}</option>
								<option value="UP_TO">{c.upTo}</option>
								<option value="EXACT">{c.exact}</option>
							</SelectNative>
						</Field>
						<Field label={c.disclosure} htmlFor={`${id}-disclosure`}>
							<SelectNative
								id={`${id}-disclosure`}
								disabled={locked}
								value={intent.disclosure}
								onChange={(event) => {
									const { value } = event.target;
									if (value === "SETUP_ONLY" || value === "SETUP_AND_QUESTION")
										onIntentChange({ ...intent, disclosure: value });
								}}
							>
								<option value="SETUP_ONLY">{c.setup}</option>
								<option value="SETUP_AND_QUESTION">{c.question}</option>
							</SelectNative>
						</Field>
					</div>
				)}
			</div>
		</div>
	);
}
