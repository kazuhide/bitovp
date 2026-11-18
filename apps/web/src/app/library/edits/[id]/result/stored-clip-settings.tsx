"use client";

import { useId } from "react";
import { useT } from "@/lib/i18n/context";
import type { StoredEditingSettings } from "@/lib/stored-editing-settings";
import { useCompositionCopy } from "../composition-copy";

export function StoredClipSettings({
	settings,
}: {
	settings?: StoredEditingSettings;
}) {
	const { t, locale } = useT();
	const composition = useCompositionCopy();
	const id = useId();
	const seconds = new Intl.NumberFormat(locale, {
		minimumFractionDigits: 3,
		maximumFractionDigits: 3,
	});
	const fps = settings ? settings.fps.num / settings.fps.den : 0;
	const fitLabel = {
		AUTO: composition.videoAuto,
		FILL: composition.videoFill,
		FIT: composition.videoContain,
	};
	function range(start: number, length: number) {
		return t("editing.exportSettings.secondsRange", {
			from: seconds.format(start),
			to: seconds.format(start + length),
		});
	}
	return (
		<section
			aria-labelledby={id}
			className="min-w-0 space-y-4 rounded-lg border border-zinc-800 bg-zinc-950/50 p-4"
		>
			<h2 id={id} className="font-semibold text-sm">
				{t("editing.exportSettings.title")}
			</h2>
			{settings ? (
				<>
					<dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
						<div>
							<dt className="text-zinc-400">
								{t("editing.exportSettings.resolution")}
							</dt>
							<dd>
								{settings.canvas.width} × {settings.canvas.height}
							</dd>
						</div>
						<div>
							<dt className="text-zinc-400">
								{t("editing.exportSettings.frameRate")}
							</dt>
							<dd>{fps} fps</dd>
						</div>
						<div>
							<dt className="text-zinc-400">
								{t("editing.exportSettings.length")}
							</dt>
							<dd>
								{t("editing.duration", {
									seconds: seconds.format(settings.durationFrames / fps),
									frames: settings.durationFrames,
								})}
							</dd>
						</div>
						<div>
							<dt className="text-zinc-400">
								{t("editing.exportSettings.captions")}
							</dt>
							<dd>
								{settings.captionCount}
								{settings.captionCount > 0 && (
									<>
										{" "}
										·{" "}
										{settings.captionDisplayLanguage === "ja"
											? composition.captionJapanese
											: composition.captionOriginal}
									</>
								)}
							</dd>
						</div>
						{settings.videoFit && (
							<div>
								<dt className="text-zinc-400">{t("editing.framing")}</dt>
								<dd>{fitLabel[settings.videoFit]}</dd>
							</div>
						)}
						{settings.captionPlacement && (
							<div>
								<dt className="text-zinc-400">
									{composition.captionPlacement}
								</dt>
								<dd>
									{settings.captionPlacement === "BANDS"
										? composition.captionBands
										: composition.captionOverlay}
								</dd>
							</div>
						)}
						{settings.audioTrackCount > 0 && (
							<div>
								<dt className="text-zinc-400">
									{t("editing.exportSettings.addedAudioTracks")}
								</dt>
								<dd>{settings.audioTrackCount}</dd>
							</div>
						)}
					</dl>
					<div className="space-y-2">
						<h3 className="font-medium text-sm">
							{t("editing.timelineTrack")}
						</h3>
						<ol className="max-h-80 divide-y divide-zinc-800 overflow-y-auto rounded-md border border-zinc-800">
							{settings.clips.map((clip, index) => {
								const length = clip.durationFrames / fps;
								return (
									<li key={clip.id} className="space-y-1 p-3 text-xs">
										<p className="font-medium">
											{t("editing.range", { number: index + 1 })}
										</p>
										<dl className="grid grid-cols-2 gap-x-3 gap-y-1">
											<dt className="text-zinc-400">
												{t("editing.exportSettings.source", {
													number: clip.sourceNumber,
												})}
											</dt>
											<dd>{range(clip.sourceInUs / 1_000_000, length)}</dd>
											<dt className="text-zinc-400">{t("editing.timeline")}</dt>
											<dd>{range(clip.timelineStartFrame / fps, length)}</dd>
											<dt className="text-zinc-400">{t("editing.framing")}</dt>
											<dd>
												{clip.videoFit
													? fitLabel[clip.videoFit]
													: clip.framing
															.map((mode) =>
																t(
																	mode === "FIT"
																		? "editing.fit"
																		: "editing.crop",
																),
															)
															.join(" · ")}
											</dd>
											<dt className="text-zinc-400">{t("editing.audio")}</dt>
											<dd>
												{t(
													clip.audio === "SOURCE"
														? "editing.sourceAudio"
														: "editing.exportSettings.muted",
												)}
											</dd>
										</dl>
									</li>
								);
							})}
						</ol>
					</div>
				</>
			) : (
				<p className="text-sm text-zinc-400">
					{t("editing.exportSettings.unavailable")}
				</p>
			)}
		</section>
	);
}
