import {
	liveHlsEntryUri,
	liveHlsEntryUris,
	selectLiveManifestMuxings,
} from "./compiler";
import {
	LIVE_MANIFEST_ELEMENT_BUDGET,
	type ManifestElementEstimate,
	manifestElementEstimate,
} from "./dvr";
import type { LiveChannelPlan, LiveManifestPlan } from "./schema";

type SegmentSource = Pick<LiveChannelPlan, "renditions" | "muxings">;

export type LiveManifestSegmentList = {
	identity: string;
	muxingKey: string;
	segmentLengthSec: number;
};

/** Distinct full-window segment sequences, not encoded stream or media-row counts. */
export function liveManifestSegmentLists(
	plan: SegmentSource,
	manifest: LiveManifestPlan,
): LiveManifestSegmentList[] {
	const lists = new Map<string, LiveManifestSegmentList>();
	const add = (
		identity: string,
		muxingKey: string,
		segmentLengthSec: number,
	) => {
		const existing = lists.get(identity);
		// Duplicate writers are validated separately. Keep the safer cadence here.
		if (!existing || segmentLengthSec < existing.segmentLengthSec)
			lists.set(identity, { identity, muxingKey, segmentLengthSec });
	};
	const uris = manifest.kind === "HLS" ? liveHlsEntryUris(plan) : undefined;
	for (const { muxing, rendition } of selectLiveManifestMuxings(
		plan,
		manifest,
	)) {
		add(
			manifest.kind === "HLS"
				? `playlist:${uris?.get(rendition.key) ?? liveHlsEntryUri(rendition)}`
				: `representation:${muxing.key}`,
			muxing.key,
			muxing.segmentLength,
		);
	}
	if (manifest.kind === "HLS")
		for (const media of manifest.detailed?.additionalMedia ?? []) {
			// Captions have no child URI. External VTT references one file, not a DVR list.
			if (media.type !== "VIDEO") continue;
			const muxing = plan.muxings.find((row) => row.key === media.muxingKey);
			if (muxing?.kind !== "FMP4" && muxing?.kind !== "TS") continue;
			add(`playlist:${media.uri}`, muxing.key, muxing.segmentLength);
		}
	// DASH external VTT has no segmented sequence; Live has no sprite representation.
	return [...lists.values()];
}

/** Preserve the full declared DVR window; segment-range settings never relax this guard. */
export function liveManifestElementEstimate(
	plan: SegmentSource,
	manifest: LiveManifestPlan,
): ManifestElementEstimate | undefined {
	const lists = liveManifestSegmentLists(plan, manifest);
	const timeshiftSec = manifest.timeshift;
	if (timeshiftSec === undefined || lists.length === 0) return undefined;
	const perList = lists.map((list) =>
		manifestElementEstimate({
			timeshiftSec,
			segmentLengthSec: list.segmentLengthSec,
			renditionCount: 1,
		}),
	);
	const totalElements = perList.reduce(
		(sum, list) => sum + list.totalElements,
		0,
	);
	const utilization = totalElements / LIVE_MANIFEST_ELEMENT_BUDGET;
	return {
		segmentsPerRendition: Math.max(
			...perList.map((list) => list.segmentsPerRendition),
		),
		totalElements,
		budget: LIVE_MANIFEST_ELEMENT_BUDGET,
		utilization,
		level: utilization > 1 ? "over" : utilization > 0.8 ? "warning" : "ok",
	};
}
