import type { z } from "zod";
import { joinFilePath } from "../plan/compiler";
import { qcMirrorMuxingKind } from "../plan/qc-mirror";
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
import { enumerateQcMirrors } from "../vmaf/targets";
import type {
	LibraryFileKind,
	libraryFileOutputSchema,
	libraryPlaybackLinkSchema,
} from "./contracts";

/** Library snapshots retain progressive file alternatives alongside their manifests. */
export function libraryPlaybackLinks(
	plan: EncodingPlan,
	credentials: readonly ({ id: string } & PublicUrlCredential)[],
): z.infer<typeof libraryPlaybackLinkSchema>[] {
	const links: z.infer<typeof libraryPlaybackLinkSchema>[] = plan.qc?.only
		? []
		: manifestPlaybackLinks(plan, credentials);
	for (const {
		key,
		kind,
		label,
		path,
		output,
		destination,
	} of progressiveOutputs(plan)) {
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
			key,
			kind,
			label,
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
	for (const { key, kind, path, output } of progressiveOutputs(plan)) {
		if (!output) continue;
		const source = vmafSourceFor(output);
		if (!source.streamable) continue;
		files.push({
			key,
			kind,
			credentialId: source.credentialId,
			bucket: source.bucket,
			path,
		});
		if (files.length === 100) break;
	}
	return files;
}

function* progressiveOutputs(plan: EncodingPlan) {
	if (plan.qc?.only) {
		for (const { rendition, destination, path } of enumerateQcMirrors(plan)) {
			if (
				rendition.mode !== "STANDARD" ||
				plan.muxings.some(
					(muxing) =>
						muxing.streamKey === rendition.key &&
						plan.drm.some((drm) => drm.muxingKey === muxing.key),
				) ||
				/[{}]/.test(path)
			)
				continue;
			const output = plan.outputs.find(
				(item) => item.key === destination.outputKey,
			);
			const kind: LibraryFileKind = qcMirrorMuxingKind(rendition.codec);
			yield {
				key: `qc-${kind.toLowerCase()}:${rendition.key}`,
				kind,
				label: `${rendition.name ?? rendition.streamName ?? rendition.key} ${kind}`,
				path,
				output,
				destination,
			};
		}
		return;
	}

	for (const muxing of plan.muxings) {
		if (
			(muxing.kind !== "MP4" &&
				!(muxing.kind === "WEBM" && muxing.progressive === true)) ||
			!muxing.destination ||
			plan.drm.some((drm) => drm.muxingKey === muxing.key)
		)
			continue;
		const kind: LibraryFileKind = muxing.kind === "WEBM" ? "WEBM" : "MP4";
		const filename = muxing.filename ?? "output.webm";
		if (!(kind === "WEBM" ? /\.webm$/i : /\.mp4$/i).test(filename)) continue;
		const streams = [
			muxing.streamKey,
			...("additionalStreamKeys" in muxing
				? (muxing.additionalStreamKeys ?? [])
				: []),
		];
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
		const path = joinFilePath(muxing.destination.path, filename);
		// Per-title template coordinates are not actual objects until resolved.
		if (/[{}]/.test(path)) continue;
		const output = plan.outputs.find(
			(item) => item.key === muxing.destination?.outputKey,
		);
		yield {
			key: `${kind.toLowerCase()}:${muxing.key}`,
			kind,
			label: muxing.name ?? filename,
			path,
			output,
			destination: muxing.destination,
		};
	}
}
