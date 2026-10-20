import {
	hlsPlaylistWritePath,
	isHlsVideoFilename,
} from "../plan/hls-video-uri";
import type { PlanIssue } from "../plan/validate";
import { liveHlsEntryUris, selectLiveManifestMuxings } from "./compiler";
import type { LiveChannelPlan } from "./schema";

export function checkLiveHlsVideoUris(plan: LiveChannelPlan): PlanIssue[] {
	const issues: PlanIssue[] = [];
	if (!plan.renditions.some((r) => r.hlsVariantUri !== undefined))
		return issues;
	for (const [index, rendition] of plan.renditions.entries()) {
		if (rendition.hlsVariantUri === undefined) continue;
		const path = `renditions[${index}].hlsVariantUri`;
		if (rendition.codec !== "H264" && rendition.codec !== "H265")
			issues.push({
				code: "LIVE_HLS_VIDEO_URI_NON_VIDEO",
				level: "error",
				path,
				message:
					"Video playlist URI is available only on supported Live video renditions.",
			});
		else if (!isHlsVideoFilename(rendition.hlsVariantUri))
			issues.push({
				code: "LIVE_HLS_VIDEO_URI_PATTERN",
				level: "error",
				path,
				message:
					"Live video playlist URI must be a flat .m3u8 filename without pattern tokens.",
			});
	}
	const uris = liveHlsEntryUris(plan);
	const writers = new Map<
		string,
		{ manifest: string; master: boolean; explicit: boolean }
	>();
	for (const manifest of plan.liveManifests) {
		if (manifest.kind !== "HLS") continue;
		const key = JSON.stringify([
			manifest.destination.outputKey,
			hlsPlaylistWritePath(manifest.destination.path, manifest.manifestName),
		]);
		writers.set(key, { manifest: manifest.key, master: true, explicit: false });
	}
	for (const [index, manifest] of plan.liveManifests.entries()) {
		if (manifest.kind !== "HLS") continue;
		for (const { rendition } of selectLiveManifestMuxings(plan, manifest)) {
			const uri = uris.get(rendition.key);
			if (uri === undefined) continue;
			const child = JSON.stringify([
				manifest.destination.outputKey,
				hlsPlaylistWritePath(manifest.destination.path, uri),
			]);
			const previous = writers.get(child);
			const explicit = rendition.hlsVariantUri !== undefined;
			// The existing per-manifest collision rail covers two selected child writers.
			if (
				previous &&
				(previous.master || previous.manifest !== manifest.key) &&
				(previous.explicit || explicit)
			)
				issues.push({
					code: "LIVE_HLS_URI_COLLISION",
					level: "error",
					path: `liveManifests[${index}]`,
					message: `Video playlist "${uri}" overlaps another HLS playlist at the same output destination. Use distinct filenames or manifest directories.`,
				});
			else if (!previous)
				writers.set(child, { manifest: manifest.key, master: false, explicit });
		}
	}
	return issues;
}
