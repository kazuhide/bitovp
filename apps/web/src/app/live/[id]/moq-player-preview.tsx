"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import { loadMoqPlayer } from "@/lib/moq-player/loader";
import { createMoqPlayback } from "@/lib/moq-player/session";
import {
	type MoqPlaybackDescriptor,
	parseMoqPlaybackDescriptor,
} from "@/lib/moq-player/types";
import {
	EMPTY_MOQ_VIDEO_STATISTICS,
	type MoqVideoStatistics,
} from "@/lib/moq-player/video-statistics";
import { MoqPlayerStatistics } from "./moq-player-statistics";

type Props = {
	channelId: string;
	runId: string;
	active: boolean;
	standalone?: boolean;
};
type Phase =
	| "idle"
	| "loading"
	| "waiting"
	| "frames"
	| "stopped"
	| "unavailable"
	| "failed";
type Attempt = {
	abort: AbortController;
	session?: ReturnType<typeof createMoqPlayback>;
};

export function MoqPlayerPreview(props: Props) {
	return (
		<MoqPlaybackAttempt key={`${props.channelId}:${props.runId}`} {...props} />
	);
}
function MoqPlaybackAttempt({
	channelId,
	runId,
	active,
	standalone = false,
}: Props) {
	const { t } = useT();
	const host = useRef<HTMLElement>(null);
	const current = useRef<Attempt | undefined>(undefined);
	const generation = useRef(0);
	const [phase, setPhase] = useState<Phase>("idle");
	const [statistics, setStatistics] = useState<MoqVideoStatistics>(
		EMPTY_MOQ_VIDEO_STATISTICS,
	);
	const [configuration, setConfiguration] = useState<
		MoqPlaybackDescriptor["resource"]["metadata"] | null
	>(null);
	const [relay, setRelay] = useState<MoqPlaybackDescriptor["relay"]>();
	const close = useCallback(() => {
		generation.current++;
		const attempt = current.current;
		current.current = undefined;
		attempt?.abort.abort();
		return attempt?.session?.dispose() ?? Promise.resolve();
	}, []);
	useEffect(() => {
		if (!active) {
			void close().catch(() => {});
			setPhase("stopped");
			setStatistics(EMPTY_MOQ_VIDEO_STATISTICS);
		}
		return () => {
			void close().catch(() => {});
		};
	}, [active, close]);
	async function play() {
		if (!active || !host.current) return;
		const startedAt = performance.now();
		void close().catch(() => {});
		setStatistics(EMPTY_MOQ_VIDEO_STATISTICS);
		setConfiguration(null);
		setRelay(undefined);
		if (typeof Reflect.get(window, "WebTransport") !== "function") {
			setPhase("unavailable");
			return;
		}
		const attempt: Attempt = { abort: new AbortController() };
		current.current = attempt;
		const owned = () =>
			current.current === attempt && !attempt.abort.signal.aborted;
		setPhase("loading");
		try {
			const raw = await apiFetch<unknown>(
				`/api/live-channels/${channelId}/runs/${runId}/moq-playback`,
				{ cache: "no-store", signal: attempt.abort.signal },
			);
			if (!owned()) return;
			const descriptor = parseMoqPlaybackDescriptor(raw, runId);
			setConfiguration(descriptor.resource.metadata);
			setRelay(descriptor.relay);
			const factory = await loadMoqPlayer();
			if (!owned() || !host.current) return;
			attempt.session = createMoqPlayback(
				factory,
				descriptor,
				host.current,
				() => {
					if (owned()) setPhase("frames");
				},
				() => {
					if (owned()) {
						setPhase("failed");
						setStatistics(EMPTY_MOQ_VIDEO_STATISTICS);
					}
				},
				{
					startedAt,
					onStatistics: (value) => {
						if (owned()) setStatistics(value);
					},
				},
			);
			await attempt.session.ready;
			if (owned())
				setPhase((value) =>
					value === "frames" || value === "failed" ? value : "waiting",
				);
		} catch (error) {
			if (!owned()) return;
			void close().catch(() => {});
			setStatistics(EMPTY_MOQ_VIDEO_STATISTICS);
			setPhase(
				typeof error === "object" &&
					error !== null &&
					"status" in error &&
					error.status === 503
					? "unavailable"
					: "failed",
			);
		}
	}
	async function stop() {
		const disposal = close();
		setStatistics(EMPTY_MOQ_VIDEO_STATISTICS);
		const ownGeneration = generation.current;
		setPhase("loading");
		try {
			await disposal;
			if (generation.current === ownGeneration) setPhase("stopped");
		} catch {
			if (generation.current === ownGeneration) setPhase("failed");
		}
	}
	const busy = phase === "loading" || phase === "waiting" || phase === "frames";
	return (
		<div className="space-y-2" data-moq-preview={runId}>
			<div className="flex flex-wrap items-center gap-2">
				<span className="rounded border border-zinc-700 px-2 py-1 font-medium text-xs text-zinc-200">
					MoQ / Web X
				</span>
				<Button
					size="sm"
					disabled={!active || busy}
					onClick={() => void play()}
				>
					{t("moqPlayback.play")}
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={!busy}
					onClick={() => void stop()}
				>
					{t("moqPlayback.stop")}
				</Button>
				<span
					role={phase === "failed" ? "alert" : "status"}
					aria-live="polite"
					className={
						phase === "failed"
							? "text-xs text-red-300"
							: "text-xs text-zinc-400"
					}
				>
					{t(`moqPlayback.${phase}`)}
				</span>
				{!standalone ? (
					<Link
						href={`/live/${channelId}/runs/${runId}/moq`}
						className="text-xs text-zinc-300 underline underline-offset-2"
					>
						{t("moqPlayback.openPlayer")}
					</Link>
				) : null}
			</div>
			<section
				ref={host}
				aria-label={t("moqPlayback.title")}
				className="aspect-video w-full overflow-hidden rounded-md border border-zinc-800 bg-black [&_video]:h-full [&_video]:w-full [&_video]:object-contain"
			/>
			<MoqPlayerStatistics
				statistics={statistics}
				configuration={configuration}
				relay={relay}
			/>
		</div>
	);
}
