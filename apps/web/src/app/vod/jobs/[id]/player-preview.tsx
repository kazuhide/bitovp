"use client";

import type {
	ManifestPlaybackLink,
	PlayerClientConfig,
	SceneAnalysisDocument,
} from "@bitovp/core";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";
import { PlaybackSurface } from "./playback-surface";

type PlayerPreviewProps = {
	/**
	 *  (owner): a RUNNING live channel's preview must not start until
	 * its output is confirmed — a player mounted on a manifest without
	 * segments shows an error screen first. `false` renders a waiting note
	 * with a manual start instead of the surface; the default keeps the
	 * muted autoplay every other caller relies on.
	 */
	autoPlay?: boolean;
	player?: PlayerClientConfig;
	sceneAnalysis?: SceneAnalysisDocument;
	seekRequest?: { seconds: number; requestId: number };
	analyticsMeta?: {
		videoId: string;
		title?: string;
		customData5?: string;
	};
	/** Job id, or channel id when `scope` is "live". */
	jobId: string;
	/** Which table the CORS diagnosis should resolve the plan from. */
	scope?: "vod" | "live";
	/** Only playable links — the caller decides, `playableLinks` below. */
	links: ManifestPlaybackLink[];
	/** True while the encoding is still running (JIT default manifests). */
	live?: boolean;
	/** Controlled selection index; omit to let this component own it. */
	selected?: number;
	/** Reports a switch, so a caller's "enlarge" can follow the same link. */
	onSelect?: (index: number) => void;
};

/**
 * Which manifests a player can be pointed at right now.
 *
 * Three conditions, each with a reason:
 *
 * - a derived URL and **no** reason — a reason means the URL is copyable but
 *   not loadable (http on a https page), so previewing it would produce a
 *   failure the panel already explained;
 * - not `SMOOTH` — no in-browser Smooth playback, in either provider;
 * - the manifest exists yet. A VOD job's manifests count as existing only
 *   when the job is `FINISHED` (owner decision 2026-09-07, rev433: a
 *   just-in-time manifest of a RUNNING job is not there yet either right
 *   after creation, and the rail answered with a networkError); a LIVE
 *   channel's manifests exist exactly while it is `RUNNING`
 *   .
 */
export function playableLinks(args: {
	links: ManifestPlaybackLink[];
	status: string;
	/** A live channel: its manifests exist while RUNNING. */
	live?: boolean;
}): ManifestPlaybackLink[] {
	const exists =
		args.status === "FINISHED" ||
		(args.live === true && args.status === "RUNNING");
	if (!exists) {
		return [];
	}
	return args.links.filter(
		(link) => link.url !== null && !link.reason && link.kind !== "SMOOTH",
	);
}

/**
 * Inline playback preview on the job page: no click required, because "is this
 * output actually playable" is the question the page exists to answer and a
 * button hides the answer behind an action.
 *
 * Muted autoplay, deliberately: a panel that merely parsed the manifest proves
 * less than one visibly decoding. Muting is what makes that acceptable
 * unprompted, and only ONE surface plays at a time — the caller unmounts this
 * while the enlarged dialog is open, so the two never buffer in parallel.
 */
export function PlayerPreview({
	jobId,
	scope = "vod",
	links,
	live,
	selected: controlled,
	onSelect,
	player,
	sceneAnalysis,
	seekRequest,
	analyticsMeta,
	autoPlay = true,
}: PlayerPreviewProps) {
	const { t } = useT();
	//  (review-539 R1): a ONE-WAY latch. Once output was confirmed
	// (or the operator pressed Play), a later "unknown" — a worker restart, a
	// muted Push, a stale origin verdict — must not unmount a player that is
	// still playing at the CDN; a mounted player's own stall is the honest
	// signal. The Live detail re-keys this component per run, so a new
	// airing is gated again.
	const [started, setStarted] = useState(autoPlay);
	if (autoPlay && !started) {
		setStarted(true);
	}
	/**
	 * The selection is CONTROLLED when the caller passes it.
	 *
	 * It used to be purely internal, and that made the rail's Enlarge button open a
	 * different manifest than the one on screen: it enlarged `playable[0]` while
	 * this component had switched to DASH. Uncontrolled is kept for callers that do
	 * not need to know (the live channel page mounts this without a dialog).
	 */
	const [internal, setInternal] = useState(0);
	const selected = controlled ?? internal;
	const setSelected = (index: number) => {
		setInternal(index);
		onSelect?.(index);
	};
	if (links.length === 0) {
		return null;
	}
	// A manifest list that shrinks (a re-run, a plan edit) must not leave the
	// index pointing past the end.
	const index = selected < links.length ? selected : 0;
	const link = links[index];
	if (!link) {
		return null;
	}

	return (
		<section aria-labelledby="playback-preview-heading" className="mt-6">
			<div className="flex flex-wrap items-center gap-3">
				<h2
					id="playback-preview-heading"
					className="scroll-mt-12 font-medium text-sm text-zinc-200"
				>
					{t("playback.previewTitle")}
				</h2>
				{live ? <Badge>{t("playback.previewWhileRunning")}</Badge> : null}
			</div>
			{links.length > 1 ? (
				<div className="mt-2 flex flex-wrap gap-2">
					{links.map((candidate, i) => (
						<button
							key={candidate.key}
							type="button"
							aria-pressed={i === index}
							onClick={() => setSelected(i)}
							className={`rounded-md border px-2 py-1 text-xs ${
								i === index
									? "border-emerald-700 bg-emerald-950 text-emerald-200"
									: "border-zinc-800 text-zinc-400 hover:text-zinc-200"
							}`}
						>
							{candidate.kind} · {candidate.label}
						</button>
					))}
				</div>
			) : null}
			{/* Which manifest is playing — not its URL: the manifest list
			    below already shows that, with a Copy button. */}
			<p className="mt-2 text-xs text-zinc-500">
				{link.kind} · {link.label}
			</p>
			<div className="mt-2">
				{started ? (
					<PlaybackSurface
						player={player}
						sceneAnalysis={sceneAnalysis}
						seekRequest={seekRequest}
						analyticsMeta={analyticsMeta}
						// Remount on switch: hls.js and Shaka both hold the media
						// element, and swapping the source under a live instance is a
						// documented source of stuck buffers.
						key={link.key}
						url={link.url}
						kind={link.kind === "DASH" ? "DASH" : "HLS"}
						diagnose={{ scope, id: jobId, manifestKey: link.key }}
						autoPlay
						// A live channel's manifest 404s until the first segment lands.
						{...(scope === "live" ? { waitForFirstSegment: true } : {})}
					/>
				) : (
					<div className="flex flex-col items-start gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
						<p className="text-xs text-zinc-400">
							{t("playback.previewWaitingForOutput")}
						</p>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => setStarted(true)}
						>
							{t("playback.previewPlayNow")}
						</Button>
					</div>
				)}
			</div>
		</section>
	);
}
