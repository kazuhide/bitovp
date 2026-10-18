"use client";

import type {
	ManifestPlaybackLink,
	PlayerClientConfig,
	SceneAnalysisDocument,
} from "@bitovp/core";
import { useState } from "react";
import { ManifestList } from "@/components/manifest-list";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";
import { PlayerPreview } from "./player-preview";

type PreviewRailProps = {
	player?: PlayerClientConfig;
	sceneAnalysis?: SceneAnalysisDocument;
	seekRequest?: { seconds: number; requestId: number };
	analyticsMeta?: {
		videoId: string;
		title?: string;
		customData5?: string;
	};
	jobId: string;
	/** Every manifest the job writes — playable or not (the list shows reasons). */
	links: ManifestPlaybackLink[];
	/** Which of them may be played; the caller owns the C1/ACL/SMOOTH rules. */
	playable: ManifestPlaybackLink[];
	playableKeys: ReadonlySet<string>;
	/** A live channel's running preview (the "still running" badge). */
	live: boolean;
	/** rev433: the job has not finished — the rail says so instead of playing. */
	pending?: boolean;
	/** Open the enlarged dialog on a link. Absent ⇒ no dialog on this page. */
	onPlay?: (link: ManifestPlaybackLink) => void;
	/** Hidden while the enlarged dialog is open — one player at a time. */
	showPlayer: boolean;
};

/**
 * The right rail: a compact player over the manifest list.
 *
 * Why compact rather than the full-width panel it replaces. The preview's only
 * job is to show the stream actually decoding , and a
 * 380px rail still gives a 16:9 surface ~214px tall — enough to see that. What
 * the page was missing is the whole left column: the ladder, the input files, the
 * storage paths. Trading player width for that is the point of the layout, and
 * nothing is lost because the enlarged dialog already exists — the rail just
 * makes it reachable explicitly rather than only by clicking a list row.
 *
 * Two invariants carried over unchanged, both already pinned by tests:
 * only ONE player mounts at a time (`showPlayer` goes false while the dialog
 * is open, so the two never buffer in parallel), and switching manifests remounts
 * `PlaybackSurface` via `key` inside `PlayerPreview` (hls.js/Shaka both hold the
 * media element; swapping the source under a live instance sticks the buffer).
 */
export function PreviewRail({
	jobId,
	links,
	playable,
	playableKeys,
	live,
	pending = false,
	onPlay,
	showPlayer,
	player,
	sceneAnalysis,
	seekRequest,
	analyticsMeta,
}: PreviewRailProps) {
	const { t } = useT();
	/**
	 * The rail owns which manifest is showing, so Enlarge can open THAT one.
	 *
	 * Previously `PlayerPreview` held the index privately and Enlarge used
	 * `playable[0]`: switch the preview to DASH, click Enlarge, get HLS — a
	 * different stream than the one on screen, with nothing saying so. The PR
	 * comment here claimed they were "the same link", which held only until the
	 * operator switched (review question C, proven by asserting the URL the dialog's
	 * player received rather than what the page printed).
	 */
	/**
	 * Nothing at all for a job with no manifests.
	 *
	 * Both children self-suppress on empty, which left an `<aside aria-label>`
	 * wrapping literally nothing: an empty complementary region announced to
	 * screen readers, and a grid cell spending `gap-8` on it. Measured on a DRAFT
	 * job as `aside.innerHTML === ""` (review finding).
	 */
	const [selected, setSelected] = useState(0);
	if (links.length === 0 && playable.length === 0) {
		return null;
	}
	if (playable.length === 0 && pending) {
		// The PLAYER waits for FINISHED; the manifest list does not — its URLs
		// are copyable and a link's refusal reason (a config defect) will not
		// resolve itself at FINISHED, so the operator sees it now.
		return (
			<aside
				aria-label={t("playback.railLabel")}
				className="lg:self-start rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400"
			>
				<p>{t("playback.previewAfterFinish")}</p>
				<div className="mt-3">
					<ManifestList links={links} playableKeys={playableKeys} />
				</div>
			</aside>
		);
	}
	const index = selected < playable.length ? selected : 0;
	const showing = playable[index];
	return (
		<aside
			/*
			 * Labelled for what the region CONTAINS, not just its first child. It
			 * previously reused "Playback preview" — the same name as the `<section>`
			 * inside it, so two nested named regions carried one name, and the label
			 * under-described an aside that also holds the manifest list (review
			 * finding).
			 */
			aria-label={t("playback.railLabel")}
			/*
			 * `lg:self-start` looks like a no-op — `align-self` applies to grid/flex
			 * items and this is a block child of the column wrapper — but the sticky
			 * DEPENDS on it: the wrapper stretches, which gives the sticky child travel
			 * room. Moving it to the wrapper to "fix" it collapses the wrapper and
			 * kills the sticky (review catch). Left deliberately, documented so the
			 * next person does not tidy it away.
			 */
			className="lg:sticky lg:top-4 lg:self-start"
		>
			{/*
			 * Skip link, because the rail is first in the document.
			 *
			 * Mobile wants the player first and gets it. Desktop shows the detail on
			 * the left, so a keyboard or screen-reader user traverses the player and the
			 * whole manifest list before reaching the job's own content — and that
			 * worsens once the rendition/input/storage panels land.
			 *
			 * Review suggested `lg:order-last` instead of `lg:col-start-2` to fix it,
			 * but CSS `order` reorders only the VISUAL box, never the accessibility
			 * tree; assistive technology follows document order either way. That is the
			 * same mismatch as the `order-first` version this layout already rejected,
			 * so the swap would relocate the problem rather than remove it. A skip link
			 * is the mechanism actually designed for "bypass this block", and it works
			 * at both breakpoints without choosing one over the other.
			 */}
			<a
				href="#job-detail-content"
				className="sr-only focus:not-sr-only focus:mb-2 focus:inline-block focus:rounded focus:bg-zinc-800 focus:px-2 focus:py-1 focus:text-sm focus:text-zinc-100"
			>
				{t("playback.skipToDetail")}
			</a>
			{showPlayer ? (
				<PlayerPreview
					player={player}
					sceneAnalysis={sceneAnalysis}
					seekRequest={seekRequest}
					analyticsMeta={analyticsMeta}
					jobId={jobId}
					links={playable}
					live={live}
					selected={index}
					onSelect={setSelected}
				/>
			) : null}
			{/*
			 * The explicit way into the big view. It exists because shrinking the
			 * inline player would otherwise cost something: the dialog was previously
			 * reachable only from a manifest row's Play button, which reads as "start
			 * playing" rather than "see it larger". Enlarges the manifest currently
			 * SHOWING, which is why the rail owns the selection.
			 */}
			{onPlay && showing ? (
				<div className="mt-2">
					<Button variant="ghost" size="sm" onClick={() => onPlay(showing)}>
						{t("playback.enlarge")}
					</Button>
				</div>
			) : null}
			<ManifestList
				links={links}
				playableKeys={playableKeys}
				{...(onPlay ? { onPlay } : {})}
			/>
		</aside>
	);
}
