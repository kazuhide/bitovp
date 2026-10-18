import type { z } from "zod";
import { joinFilePath } from "../plan/compiler";
import type { EncodingPlan } from "../plan/schema";
import {
	manifestPlaybackLinks,
	planOutputBucket,
} from "../playback/manifest-links";
import {
	type PublicUrlCredential,
	publicObjectUrl,
} from "../playback/public-url";
import { vmafSourceFor } from "../vmaf/streamable-io";
import type {
	libraryFileOutputSchema,
	libraryPlaybackLinkSchema,
} from "./contracts";

/** Library snapshots retain public MP4 alternatives alongside their manifests. */
export function libraryPlaybackLinks(
	plan: EncodingPlan,
	credentials: readonly ({ id: string } & PublicUrlCredential)[],
): z.infer<typeof libraryPlaybackLinkSchema>[] {
	const links: z.infer<typeof libraryPlaybackLinkSchema>[] =
		manifestPlaybackLinks(plan, credentials);
	for (const { muxing, path, output, destination } of mp4Outputs(plan)) {
		const derived = publicObjectUrl({
			credential:
				output && "credentialId" in output
					? credentials.find((item) => item.id === output.credentialId)
					: undefined,
			bucket: output ? planOutputBucket(output) : null,
			key: path,
			acl: destination.acl,
		});
		links.push({
			key: `mp4:${muxing.key}`,
			kind: "MP4",
			label: muxing.name ?? muxing.filename,
			path,
			...derived,
		});
	}
	return links;
}

/** Exact, server-only object coordinates; never credential configuration or secrets. */
export function libraryFileOutputs(
	plan: EncodingPlan,
): z.infer<typeof libraryFileOutputSchema>[] {
	const files: z.infer<typeof libraryFileOutputSchema>[] = [];
	for (const { muxing, path, output } of mp4Outputs(plan)) {
		if (!output) continue;
		const source = vmafSourceFor(output);
		if (!source.streamable) continue;
		files.push({
			key: `mp4:${muxing.key}`,
			kind: "MP4",
			credentialId: source.credentialId,
			bucket: source.bucket,
			path,
		});
		if (files.length === 100) break;
	}
	return files;
}

function* mp4Outputs(plan: EncodingPlan) {
	for (const muxing of plan.muxings) {
		if (
			muxing.kind !== "MP4" ||
			!muxing.destination ||
			!/\.mp4$/i.test(muxing.filename) ||
			plan.drm.some((drm) => drm.muxingKey === muxing.key)
		)
			continue;
		const streams = [muxing.streamKey, ...(muxing.additionalStreamKeys ?? [])];
		const video = plan.renditions.filter(
			(rendition) =>
				streams.includes(rendition.key) &&
				["H264", "H265", "VP9", "AV1"].includes(rendition.codec),
		);
		if (
			!video.length ||
			video.some(
				(rendition) => "mode" in rendition && rendition.mode !== "STANDARD",
			)
		)
			continue;
		const path = joinFilePath(muxing.destination.path, muxing.filename);
		// Per-title template coordinates are not actual objects until resolved.
		if (/[{}]/.test(path)) continue;
		const output = plan.outputs.find(
			(item) => item.key === muxing.destination?.outputKey,
		);
		yield { muxing, path, output, destination: muxing.destination };
	}
}
