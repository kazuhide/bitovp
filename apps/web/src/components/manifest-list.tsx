"use client";

import type { ManifestPlaybackLink } from "@bitovp/core";
import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";
import { playbackReasonMessage } from "@/lib/playback-reason";

type ManifestListProps = {
	links: ManifestPlaybackLink[];
	/**
	 * Which links may be played, by key. The caller decides — `playableLinks`
	 * applies the C1/ACL/SMOOTH rules — so this component never has to know them.
	 */
	playableKeys: ReadonlySet<string>;
	/** Omitted where there is no enlarged view to open (the live channel page). */
	onPlay?: (link: ManifestPlaybackLink) => void;
	/** Anchor id for a page's section nav ; omit elsewhere. */
	headingId?: string;
};

/**
 * Every manifest a job or channel writes, with its URL or origin path, a Copy
 * button, and — when it cannot be played — the reason.
 *
 * Shared because the live channel page had none of it. It rendered only the
 * inline player, so when nothing was playable an operator got no URL, no path
 * and no reason — and per design §19.3 that is every channel authored before the
 * live wizard gained its ACL field. The stated goal of that section was "'live
 * playback does not work' cannot be mistaken for a player bug", which a unit test
 * asserted and the UI did not deliver.
 *
 * One component rather than two so the pages cannot drift on which reasons they
 * show.
 */
export function ManifestList({
	links,
	playableKeys,
	onPlay,
	headingId,
}: ManifestListProps) {
	const { t } = useT();
	if (links.length === 0) {
		return null;
	}
	return (
		<>
			<h2
				id={headingId}
				className="mt-6 scroll-mt-12 font-medium text-sm text-zinc-200"
			>
				{t("jobDetail.manifests")}
			</h2>
			<ul className="mt-2 space-y-2">
				{links.map((link) => (
					<li
						key={link.key}
						className="rounded-md border border-zinc-800 px-3 py-2"
					>
						<div className="flex items-center gap-3">
							<Badge>{link.kind}</Badge>
							<span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300">
								{link.url ?? link.path}
							</span>
							<CopyButton
								value={link.url ?? link.path}
								label={t(
									link.url
										? "jobDetail.copyManifestUrl"
										: "jobDetail.copyManifestPath",
									{ kind: link.kind, value: link.url ?? link.path },
								)}
							>
								{t("common.copy")}
							</CopyButton>
							{onPlay && playableKeys.has(link.key) ? (
								<Button
									variant="secondary"
									size="sm"
									onClick={() => onPlay(link)}
								>
									{t("jobDetail.play")}
								</Button>
							) : null}
						</div>
						{link.reason ? (
							<p className="mt-1 text-xs text-zinc-500">
								{t(
									playbackReasonMessage(link.reason).key,
									playbackReasonMessage(link.reason).values,
								)}
								{/* The one reason whose remedy is a single field on a
								    single settings row gets the way there. Margin, not a
								    JSX spacer, between two Japanese runs. */}
								{link.reason.code === "MSL_EDGE_URL_NOT_CONFIGURED" ? (
									<Link
										href="/settings/credentials"
										className="ml-1 text-emerald-400 hover:underline"
									>
										{t("playback.openCredentialSettings")}
									</Link>
								) : null}
							</p>
						) : null}
					</li>
				))}
			</ul>
		</>
	);
}
