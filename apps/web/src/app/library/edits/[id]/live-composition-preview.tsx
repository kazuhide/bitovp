"use client";

import type { EditDocument } from "@bitovp/core";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";
import type { EditingMediaView } from "@/lib/library-editing";
import { timelineTimecode } from "../timeline-model";
import { useLiveCompositionPreview } from "./use-live-composition-preview";

export type LiveCompositionPreviewProps = {
	document: EditDocument;
	media: EditingMediaView;
	frame: number;
	onFrameChange: (frame: number) => void;
	blocked: boolean;
	pauseSignal?: number;
	seekSignal?: number;
};

export function LiveCompositionPreview(props: LiveCompositionPreviewProps) {
	const { t } = useT();
	const {
		video,
		canvas,
		controller,
		plan,
		snapshot: state,
	} = useLiveCompositionPreview(props);
	const disabled = props.blocked || !plan || state.phase === "error";
	const toggle = () => {
		if (!disabled) controller.current?.toggle();
	};
	const status = !plan
		? "liveUnavailable"
		: state.phase === "error"
			? "liveError"
			: state.phase === "loading"
				? "liveLoading"
				: state.phase === "buffering"
					? "liveBuffering"
					: null;
	return (
		<section className="min-w-0 space-y-3" aria-label={t("editing.liveTitle")}>
			<h2 className="font-semibold">{t("editing.liveTitle")}</h2>
			<div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(14rem,20rem)] md:items-center">
				<div className="min-w-0">
					<button
						type="button"
						aria-label={t("editing.liveTitle")}
						disabled={disabled}
						className="relative mx-auto block w-full overflow-hidden rounded-md bg-black p-0 focus-visible:outline-2 focus-visible:outline-emerald-400"
						style={{
							aspectRatio: `${props.document.canvas.width}/${props.document.canvas.height}`,
							maxWidth: `${(40 * props.document.canvas.width) / props.document.canvas.height}vh`,
						}}
						onClick={toggle}
						onKeyDown={(event) => {
							if (event.altKey || event.ctrlKey || event.metaKey || disabled)
								return;
							const key = event.key;
							if (
								![" ", "ArrowLeft", "ArrowRight", "Home", "End"].includes(key)
							)
								return;
							event.preventDefault();
							if (key === " ") toggle();
							else if (key === "Home") controller.current?.seek(0);
							else if (key === "End")
								controller.current?.seek((plan?.total ?? 1) - 1);
							else controller.current?.step(key === "ArrowLeft" ? -1 : 1);
						}}
					>
						<video
							ref={video}
							data-testid="live-preview-video"
							src={props.media.url ?? undefined}
							muted
							playsInline
							preload="auto"
							tabIndex={-1}
							aria-hidden="true"
							className="absolute inset-0 h-full w-full"
						/>
						<canvas
							ref={canvas}
							data-testid="live-preview-canvas"
							width={props.document.canvas.width}
							height={props.document.canvas.height}
							className="absolute inset-0 h-full w-full bg-black"
						/>
						{status && (
							<span
								aria-hidden="true"
								className="absolute inset-0 flex items-center justify-center bg-black/80 p-4 text-center text-sm"
							>
								{t(`editing.${status}`)}
							</span>
						)}
					</button>
				</div>
				<div className="min-w-0 space-y-3">
					{status && (
						<p
							className="sr-only"
							role={state.phase === "error" ? "alert" : "status"}
						>
							{t(`editing.${status}`)}
						</p>
					)}
					<div className="flex flex-wrap items-center justify-center gap-2">
						<Button
							size="sm"
							variant="secondary"
							disabled={disabled}
							onClick={() => controller.current?.seek(0)}
							aria-label={t("editing.liveStart")}
						>
							|‹
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={disabled}
							onClick={() => controller.current?.step(-1)}
							aria-label={t("editing.livePreviousFrame")}
						>
							‹
						</Button>
						<Button size="sm" disabled={disabled} onClick={toggle}>
							{t(state.playing ? "editing.livePause" : "editing.livePlay")}
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={disabled}
							onClick={() => controller.current?.step(1)}
							aria-label={t("editing.liveNextFrame")}
						>
							›
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={disabled}
							onClick={() => controller.current?.seek((plan?.total ?? 1) - 1)}
							aria-label={t("editing.liveEnd")}
						>
							›|
						</Button>
					</div>
					<output
						className="block text-center text-xs tabular-nums"
						aria-live="off"
					>
						{t("editing.livePosition", {
							time: timelineTimecode(state.frame),
							duration: timelineTimecode(plan?.total ?? 0),
							frame: state.frame,
						})}
					</output>
					<div className="flex flex-wrap items-center justify-center gap-3 text-xs">
						<label className="flex items-center gap-2">
							<input
								type="checkbox"
								checked={state.loop}
								disabled={props.blocked || !plan}
								onChange={(event) =>
									controller.current?.setLoop(event.target.checked)
								}
							/>
							{t("editing.liveLoop")}
						</label>
						<label className="flex items-center gap-2">
							{t("editing.liveSpeed")}
							<select
								className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1"
								value={state.rate}
								disabled={props.blocked || !plan}
								onChange={(event) =>
									controller.current?.setRate(Number(event.target.value))
								}
							>
								{[0.5, 1, 2].map((rate) => (
									<option key={rate} value={rate}>
										{rate}×
									</option>
								))}
							</select>
						</label>
						<Button
							size="sm"
							variant="secondary"
							disabled={!plan}
							aria-pressed={!state.muted}
							onClick={() => controller.current?.setMuted(!state.muted)}
						>
							{t(state.muted ? "editing.liveUnmute" : "editing.liveMute")}
						</Button>
					</div>
					{state.clipMuted && (
						<p className="text-center text-xs text-zinc-400">
							{t("editing.liveClipMuted")}
						</p>
					)}
					{state.phase === "error" && (
						<Button
							variant="secondary"
							disabled={props.blocked}
							onClick={() => controller.current?.retry()}
						>
							{t("editing.liveRetry")}
						</Button>
					)}
					{props.blocked && (
						<p className="text-xs text-zinc-400">{t("editing.liveBlocked")}</p>
					)}
					<p className="text-xs text-zinc-400">{t("editing.liveHelp")}</p>
				</div>
			</div>
		</section>
	);
}
