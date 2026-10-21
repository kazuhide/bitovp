import { hlsLegSelected } from "./hls-legs";
import { hlsChildEntries, hlsIframeUris } from "./hls-media-defaults";
import { HLS_VIDEO_GROUP_TOKEN, isHlsVideoFilename } from "./hls-video-uri";
import {
	outputFileKeys,
	staticManifestOutputFiles,
	staticMuxingOutputFiles,
} from "./output-files";
import type { EncodingPlan } from "./schema";
import type { PlanIssue } from "./validate";

export function checkHlsVideoUris(plan: EncodingPlan): PlanIssue[] {
	const issues: PlanIssue[] = [];
	const overrides = plan.renditions.filter(
		(r) => r.hlsVariantUri !== undefined,
	);
	if (!overrides.length) return issues;
	const add = (code: string, path: string, message: string) =>
		issues.push({
			code: `PLAN_HLS_VIDEO_URI_${code}`,
			level: "error",
			path,
			message,
		});
	for (const [index, rendition] of plan.renditions.entries()) {
		const uri = rendition.hlsVariantUri;
		if (uri === undefined) continue;
		const path = `renditions[${index}].hlsVariantUri`;
		if (!["H264", "H265", "VP9", "AV1"].includes(rendition.codec)) {
			add(
				"NON_VIDEO",
				path,
				"Video playlist URI is available only on video renditions.",
			);
			continue;
		}
		if ("mode" in rendition && rendition.mode.startsWith("PER_TITLE")) {
			add(
				"PER_TITLE",
				path,
				"Video playlist URI is unavailable for Per-Title; keep its bitrate-derived naming.",
			);
			continue;
		}
		for (const manifest of plan.manifests) {
			if (
				manifest.kind !== "HLS" ||
				!plan.muxings.some(
					(m) =>
						m.streamKey === rendition.key &&
						hlsLegSelected(m.kind, manifest.videoMuxingKind),
				)
			)
				continue;
			const token = uri.includes(HLS_VIDEO_GROUP_TOKEN);
			if (manifest.variantsPerAudioGroup && !token)
				add(
					"GROUP_REQUIRED",
					path,
					"Use {group} in the video playlist URI when variants are created per audio group.",
				);
			if (!manifest.variantsPerAudioGroup && token)
				add(
					"GROUP_UNAVAILABLE",
					path,
					"The {group} token requires variants per audio group.",
				);
			for (const entry of hlsChildEntries(plan, manifest)) {
				if (
					entry.renditionKey === rendition.key &&
					!isHlsVideoFilename(entry.uri)
				)
					add(
						"GROUP_UNSAFE",
						path,
						"The expanded video playlist URI must be a safe flat .m3u8 filename.",
					);
			}
		}
	}
	const writers = new Map<string, string>();
	const write = (
		destination: { outputKey: string; path: string },
		uri: string,
		owner: string,
		path: string,
	) => {
		for (const key of outputFileKeys(plan, { destination, filename: uri })) {
			const previous = writers.get(key);
			if (previous && previous !== owner)
				add(
					"COLLISION",
					path,
					`Video playlist "${uri}" overlaps another output file at the same storage destination. Use distinct filenames or manifest directories.`,
				);
			else if (!previous) writers.set(key, owner);
		}
	};
	// A different DRM segment directory does not change the playlist destination.
	for (const file of [
		...staticManifestOutputFiles(plan),
		...staticMuxingOutputFiles(plan),
	])
		write(file.destination, file.filename, file.owner, file.path);
	for (const [index, manifest] of plan.manifests.entries()) {
		if (manifest.kind !== "HLS") continue;
		for (const entry of hlsChildEntries(plan, manifest))
			write(
				manifest.destination,
				entry.uri,
				`${manifest.key}:${entry.kind}:${entry.muxingKey}:${entry.group ?? ""}`,
				`manifests[${index}]`,
			);
		for (const [muxingKey, filename] of hlsIframeUris(plan, manifest))
			write(
				manifest.destination,
				filename,
				`${manifest.key}:iframe:${muxingKey}`,
				`manifests[${index}]`,
			);
	}
	return issues;
}
