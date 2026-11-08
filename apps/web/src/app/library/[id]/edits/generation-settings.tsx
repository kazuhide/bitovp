"use client";
import type { GenerationTaskParameters } from "@bitovp/core";
import { useId } from "react";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import {
	EditingDetails,
	EditingHelp,
	EditingHelpText,
} from "../../editing-help";
import { useProductionCopy } from "./production-copy";

export type GenerationSettingsValue = Omit<
	GenerationTaskParameters,
	| "contentId"
	| "targetDurationFrames"
	| "transcriptionTaskId"
	| "trackingTaskId"
	| "renderMode"
	| "draftPolicyVersion"
>;
export function wholeFramesForDuration(value: string) {
	const seconds = value.trim() ? Number(value) : Number.NaN;
	const frames = seconds * 30;
	return Number.isFinite(seconds) &&
		seconds >= 1 &&
		seconds <= 180 &&
		Math.abs(frames - Math.round(frames)) < 0.0000001
		? Math.round(frames)
		: null;
}
export function GenerationSettings({
	value,
	disabled,
	onChange,
	hasAudio,
	allowPresentation = false,
	allowLocalStory = false,
	allowJapaneseCaptions = false,
}: {
	value: GenerationSettingsValue;
	disabled: boolean;
	onChange(value: GenerationSettingsValue): void;
	hasAudio?: boolean;
	allowPresentation?: boolean;
	allowLocalStory?: boolean;
	allowJapaneseCaptions?: boolean;
}) {
	const c = useProductionCopy(),
		id = useId(),
		localStoryAllowed = allowPresentation && allowLocalStory,
		autoFraming = value.presentation?.videoFit === "AUTO",
		preserveSource =
			value.presentation?.fallbackFraming === "PRESERVE_SOURCE_V1",
		staticFraming =
			preserveSource ||
			value.presentation?.fallbackFraming === "AISA_STATIC_V1";
	return (
		<div className="space-y-4">
			<Field
				label={c.policy}
				htmlFor={`${id}-policy`}
				help={
					<EditingHelpText>
						{localStoryAllowed && <p>{c.policyLocalStoryHelp}</p>}
						{allowPresentation && <p>{c.policyAutoHelp}</p>}
						<p>{c.policyHelp}</p>
					</EditingHelpText>
				}
			>
				<SelectNative
					id={`${id}-policy`}
					value={value.policy}
					disabled={disabled}
					onChange={(e) => {
						const policy =
							e.target.value === "LOCAL_STORY" && localStoryAllowed
								? "LOCAL_STORY"
								: e.target.value === "AUTO" && allowPresentation
									? "AUTO"
									: e.target.value === "DURATION"
										? "DURATION"
										: "COHESION";
						onChange({
							...value,
							policy,
							query:
								policy === "AUTO" || policy === "LOCAL_STORY"
									? undefined
									: value.query,
							storyMode:
								policy === "LOCAL_STORY"
									? (value.storyMode ?? "AUTO")
									: undefined,
						});
					}}
				>
					{localStoryAllowed && (
						<option value="LOCAL_STORY">{c.localStorySelection}</option>
					)}
					{allowPresentation && (
						<option value="AUTO">{c.automaticSelection}</option>
					)}
					<option value="COHESION">{c.cohesion}</option>
					<option value="DURATION">{c.duration}</option>
				</SelectNative>
			</Field>
			{localStoryAllowed && value.policy === "LOCAL_STORY" && (
				<Field
					label={c.storyMode}
					htmlFor={`${id}-story-mode`}
					help={
						<EditingHelpText>
							<p>{c.storyModeHelp}</p>
						</EditingHelpText>
					}
				>
					<SelectNative
						id={`${id}-story-mode`}
						value={value.storyMode ?? "AUTO"}
						disabled={disabled}
						onChange={(event) =>
							onChange({
								...value,
								storyMode:
									event.target.value === "FLOW"
										? "FLOW"
										: event.target.value === "THEME"
											? "THEME"
											: "AUTO",
							})
						}
					>
						<option value="AUTO">{c.storyAuto}</option>
						<option value="FLOW">{c.storyFlow}</option>
						<option value="THEME">{c.storyTheme}</option>
					</SelectNative>
				</Field>
			)}
			<EditingDetails summary={c.policyDetails}>
				{localStoryAllowed && (
					<section className="space-y-1">
						<h3 className="font-medium text-zinc-300">
							{c.localStorySelection}
						</h3>
						<p>{c.policyLocalStoryDetails}</p>
					</section>
				)}
				{allowPresentation && (
					<section className="space-y-1">
						<h3 className="font-medium text-zinc-300">
							{c.automaticSelection}
						</h3>
						<p>{c.policyAutoDetails}</p>
					</section>
				)}
				<section className="space-y-1">
					<h3 className="font-medium text-zinc-300">{c.cohesion}</h3>
					<p>{c.policyCohesionDetails}</p>
				</section>
				<section className="space-y-1">
					<h3 className="font-medium text-zinc-300">{c.duration}</h3>
					<p>{c.policyDurationDetails}</p>
				</section>
				<section className="space-y-1">
					<h3 className="font-medium text-zinc-300">{c.policySharedTitle}</h3>
					<p>{c.policySharedDetails}</p>
					<p>{c.policySpeechDetails}</p>
				</section>
			</EditingDetails>
			{allowPresentation && (
				<div className="grid gap-4 sm:grid-cols-2">
					<Field
						label={c.videoFit}
						htmlFor={`${id}-video-fit`}
						help={
							<EditingHelpText>
								{autoFraming ? (
									<>
										<p>
											{preserveSource ? c.videoPreserveHelp : c.videoAutoHelp}
										</p>
										<p>
											{preserveSource
												? c.videoPreserveBackgroundHelp
												: c.videoAutoFallbackHelp}
										</p>
									</>
								) : (
									<p>
										{preserveSource
											? c.videoPreserveSummary
											: c.videoFitSummary}
									</p>
								)}
							</EditingHelpText>
						}
					>
						<SelectNative
							id={`${id}-video-fit`}
							value={value.presentation?.videoFit ?? "FILL"}
							disabled={disabled}
							onChange={(event) =>
								onChange({
									...value,
									presentation: {
										version: "portrait-layout-v1",
										...(value.presentation?.fallbackFraming
											? { fallbackFraming: value.presentation.fallbackFraming }
											: {}),
										captionPlacement:
											value.presentation?.captionPlacement ?? "OVERLAY",
										videoFit:
											event.target.value === "AUTO"
												? "AUTO"
												: event.target.value === "FIT"
													? "FIT"
													: "FILL",
									},
								})
							}
						>
							<option value="AUTO">
								{preserveSource ? c.videoPreserveAuto : c.videoAuto}
							</option>
							<option value="FILL">
								{preserveSource ? c.videoPreserveFill : c.videoFill}
							</option>
							<option value="FIT">
								{preserveSource ? c.videoPreserveContain : c.videoContain}
							</option>
						</SelectNative>
					</Field>
					<Field
						label={c.captionPlacement}
						htmlFor={`${id}-caption-placement`}
						help={
							<EditingHelpText>
								<p>{c.captionPlacementSummary}</p>
							</EditingHelpText>
						}
					>
						<SelectNative
							id={`${id}-caption-placement`}
							value={value.presentation?.captionPlacement ?? "OVERLAY"}
							disabled={disabled}
							onChange={(event) =>
								onChange({
									...value,
									presentation: {
										version: "portrait-layout-v1",
										...(value.presentation?.fallbackFraming
											? { fallbackFraming: value.presentation.fallbackFraming }
											: {}),
										videoFit: value.presentation?.videoFit ?? "FILL",
										captionPlacement:
											event.target.value === "BANDS" ? "BANDS" : "OVERLAY",
									},
								})
							}
						>
							<option value="OVERLAY">{c.captionOverlay}</option>
							<option value="BANDS">{c.captionBands}</option>
						</SelectNative>
					</Field>
				</div>
			)}
			{allowPresentation && (
				<EditingDetails summary={c.presentationDetails}>
					<section className="space-y-1">
						<h3 className="font-medium text-zinc-300">{c.videoFit}</h3>
						{autoFraming ? (
							<>
								<p>
									{preserveSource ? c.videoPreserveDetails : c.videoAutoDetails}
								</p>
								<p>{c.videoAutoBandsHelp}</p>
							</>
						) : staticFraming ? (
							<>
								<p>{c.videoStaticHelp}</p>
								<p>{c.videoStaticReferenceHelp}</p>
							</>
						) : (
							<p>{c.videoFitHelp}</p>
						)}
					</section>
					<section className="space-y-1">
						<h3 className="font-medium text-zinc-300">{c.captionPlacement}</h3>
						<p>{c.captionPlacementHelp}</p>
					</section>
				</EditingDetails>
			)}
			{value.policy !== "AUTO" &&
				value.policy !== "STORY" &&
				value.policy !== "LOCAL_STORY" && (
					<Field
						label={c.query}
						htmlFor={`${id}-query`}
						help={
							<EditingHelpText>
								<p>{c.queryHelp}</p>
							</EditingHelpText>
						}
					>
						<Input
							id={`${id}-query`}
							maxLength={512}
							value={value.query ?? ""}
							disabled={disabled || value.policy === "DURATION"}
							onChange={(e) => onChange({ ...value, query: e.target.value })}
						/>
					</Field>
				)}
			<div className="grid gap-4 sm:grid-cols-2">
				<Field label={c.template} htmlFor={`${id}-template`}>
					<SelectNative
						id={`${id}-template`}
						value={value.templateId}
						disabled={disabled}
						onChange={(e) =>
							onChange({
								...value,
								templateId:
									e.target.value === "square-clean"
										? "square-clean"
										: e.target.value === "landscape-clean"
											? "landscape-clean"
											: "portrait-clean",
							})
						}
					>
						<option value="portrait-clean">{c.portrait}</option>
						<option value="landscape-clean">{c.landscape}</option>
						<option value="square-clean">{c.square}</option>
					</SelectNative>
				</Field>
				<Field
					label={c.variants}
					htmlFor={`${id}-variants`}
					help={
						<EditingHelpText>
							<p>{c.variantsHelp}</p>
						</EditingHelpText>
					}
				>
					<SelectNative
						id={`${id}-variants`}
						value={value.variants}
						disabled={disabled}
						onChange={(e) =>
							onChange({
								...value,
								variants:
									e.target.value === "3" ? 3 : e.target.value === "2" ? 2 : 1,
							})
						}
					>
						{[1, 2, 3].map((count) => (
							<option key={count} value={count}>
								{count}
							</option>
						))}
					</SelectNative>
				</Field>
			</div>
			<div className="space-y-3">
				<Field
					label={c.captionMode}
					htmlFor={`${id}-captions`}
					help={
						<EditingHelpText>
							<p>{c.captionsHelp}</p>
							<p>{c.captionTranslationHelp}</p>
							{!allowJapaneseCaptions && (
								<p>{c.captionTranslationUnavailable}</p>
							)}
						</EditingHelpText>
					}
				>
					<SelectNative
						id={`${id}-captions`}
						value={value.captions === "AUTO" ? "ORIGINAL" : value.captions}
						disabled={disabled || hasAudio === false}
						onChange={(event) =>
							onChange({
								...value,
								captions:
									event.target.value === "JAPANESE" && allowJapaneseCaptions
										? "JAPANESE"
										: event.target.value === "ORIGINAL"
											? "ORIGINAL"
											: "OFF",
							})
						}
					>
						<option value="OFF">{c.captionsOff}</option>
						<option value="ORIGINAL">{c.captionsOriginal}</option>
						<option value="JAPANESE" disabled={!allowJapaneseCaptions}>
							{c.captionsJapanese}
						</option>
					</SelectNative>
				</Field>
				<div className="flex items-start gap-3 text-sm">
					<input
						className="mt-1 accent-emerald-600"
						type="checkbox"
						id={`${id}-tracking`}
						aria-label={c.tracking}
						checked={value.tracking}
						disabled={disabled}
						onChange={(e) => onChange({ ...value, tracking: e.target.checked })}
					/>
					<div className="flex min-w-0 items-center gap-1">
						<label htmlFor={`${id}-tracking`}>{c.tracking}</label>
						<EditingHelp label={c.tracking}>
							<p>
								{value.presentation?.videoFit === "FILL"
									? staticFraming
										? c.trackingStaticHelp
										: c.trackingFillHelp
									: preserveSource
										? c.trackingPreserveHelp
										: c.trackingHelp}
							</p>
						</EditingHelp>
					</div>
				</div>
			</div>
			<Field label={c.language} htmlFor={`${id}-language`}>
				<SelectNative
					id={`${id}-language`}
					value={value.language}
					disabled={
						disabled ||
						(value.captions === "OFF" && value.policy !== "LOCAL_STORY")
					}
					onChange={(e) =>
						onChange({
							...value,
							language:
								e.target.value === "ja"
									? "ja"
									: e.target.value === "en"
										? "en"
										: "auto",
						})
					}
				>
					<option value="auto">{c.auto}</option>
					<option value="ja">{c.japanese}</option>
					<option value="en">{c.english}</option>
				</SelectNative>
			</Field>
		</div>
	);
}
