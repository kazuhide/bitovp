"use client";

import type { PlayerClientConfig } from "@bitovp/core";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { useT } from "@/lib/i18n/context";
import type { PlaybackControl } from "../jobs/[id]/playback-control";
import { PlaybackSurface } from "../jobs/[id]/playback-surface";
import { type OutputLink, outputSides } from "./output-selection";
import {
	type AudioSide,
	type PlaybackOutputs,
	type SynchronizedState,
	synchronizePlayback,
} from "./synchronize-playback";

export type ComparisonOutput = {
	jobId: string;
	heading: ReactNode;
	link: OutputLink;
};
const waiting: SynchronizedState = {
	time: 0,
	duration: 0,
	intent: false,
	status: "waiting",
};
const selectStyle =
	"min-w-0 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 focus-visible:outline-2 focus-visible:outline-emerald-500";

export function SynchronizedPlayback({
	outputs,
	player,
}: {
	outputs: PlaybackOutputs<ComparisonOutput>;
	player?: PlayerClientConfig;
}) {
	const { t } = useT();
	const count = outputs.length;
	const sides = outputSides(count);
	const [controls, setControls] = useState<(PlaybackControl | null)[]>([]);
	const controlCallbacks = useMemo(
		() =>
			Array.from(
				{ length: count },
				(_, index) => (value: PlaybackControl | null) =>
					setControls((old) =>
						old[index] === value
							? old
							: Array.from({ length: count }, (_, slot) =>
									slot === index ? value : (old[slot] ?? null),
								),
					),
			),
		[count],
	);
	const [state, setState] = useState(waiting);
	const [audio, setAudio] = useState<AudioSide>("left");
	const audioRef = useRef(audio);
	const connection = useRef<ReturnType<typeof synchronizePlayback> | null>(
		null,
	);
	useEffect(() => {
		const [first, second, third] = controls;
		if (!first || !second || (count === 3 && !third)) {
			setState(waiting);
			return;
		}
		const sync = synchronizePlayback(
			count === 3 && third ? [first, second, third] : [first, second],
			() => setState(connection.current?.read() ?? waiting),
		);
		connection.current = sync;
		sync.audio(audioRef.current);
		setState(sync.read());
		return () => {
			connection.current = null;
			sync.dispose();
		};
	}, [controls, count]);
	useEffect(() => {
		audioRef.current = audio;
		connection.current?.audio(audio);
	}, [audio]);
	return (
		<div data-testid="synchronized-outputs" className="mt-4 space-y-3">
			<div
				className={`grid min-w-0 grid-cols-1 gap-4 ${count === 3 ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}
			>
				{outputs.map((output, index) => {
					const control = controls[index];
					const side = sides[index] ?? "right";
					const qualities = control?.qualities() ?? [];
					return (
						<section
							key={side}
							data-testid={`output-${side}`}
							className="min-w-0 space-y-2"
						>
							{output.heading}
							<PlaybackSurface
								url={output.link.url}
								kind={output.link.kind}
								player={player}
								controls={false}
								onControl={controlCallbacks[index]}
								diagnose={{
									scope: "vod",
									id: output.jobId,
									manifestKey: output.link.key,
								}}
							/>
							<label className="flex items-center gap-2 text-xs text-zinc-400">
								{t("outputCompare.quality")}
								<select
									aria-label={`${t("outputCompare.quality")} ${t(`outputCompare.${side}`)}`}
									className={selectStyle}
									value={control?.read().qualityId ?? ""}
									disabled={qualities.length === 0}
									onChange={(event) => {
										connection.current?.pause();
										control?.selectQuality(event.target.value);
										setState(connection.current?.read() ?? waiting);
									}}
								>
									<option value="">{t("outputCompare.auto")}</option>
									{qualities.map((quality) => (
										<option key={quality.id} value={quality.id}>
											{t("outputCompare.fixed", { height: quality.height })}
										</option>
									))}
								</select>
							</label>
						</section>
					);
				})}
			</div>
			<div className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-800 px-3 py-2">
				<Button
					size="sm"
					disabled={
						!connection.current || (!state.intent && state.status === "waiting")
					}
					onClick={() => {
						if (state.intent) connection.current?.pause();
						else void connection.current?.play();
					}}
				>
					{t(
						state.intent
							? count === 3
								? "outputCompare.pauseAll"
								: "outputCompare.pause"
							: count === 3
								? "outputCompare.playAll"
								: "outputCompare.play",
					)}
				</Button>
				<input
					type="range"
					aria-label={t("outputCompare.seek")}
					className="min-w-24 flex-1 accent-emerald-500"
					min={0}
					max={state.duration || 0}
					step={0.01}
					value={Math.min(state.time, state.duration)}
					disabled={!state.duration || state.status === "failed"}
					onChange={(event) =>
						connection.current?.seek(Number(event.target.value))
					}
				/>
				<output className="text-xs text-zinc-300 tabular-nums">{`${state.time.toFixed(2)} / ${state.duration.toFixed(2)}`}</output>
				<label className="flex items-center gap-2 text-xs text-zinc-400">
					{t("outputCompare.audio")}
					<select
						aria-label={t("outputCompare.audio")}
						className={selectStyle}
						value={audio}
						onChange={(event) => setAudio(event.target.value as AudioSide)}
					>
						{([...sides, "muted"] as const).map((side) => (
							<option key={side} value={side}>
								{t(`outputCompare.${side}`)}
							</option>
						))}
					</select>
				</label>
				<p
					role={state.status === "failed" ? "alert" : "status"}
					className={`text-xs ${state.status === "failed" ? "text-amber-400" : "text-zinc-400"}`}
				>
					{t(
						state.status === "waiting" && count === 3
							? "outputCompare.waitingAll"
							: `outputCompare.${state.status}`,
					)}
				</p>
				<InfoHint
					text={t("outputCompare.syncNotice")}
					labelFor={t("outputCompare.title")}
				/>
			</div>
		</div>
	);
}
