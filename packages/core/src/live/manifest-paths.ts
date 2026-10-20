import type { PlanIssue } from "../plan/validate";
import { liveHlsEntryUris, selectLiveManifestMuxings } from "./compiler";
import type { LiveChannelPlan } from "./schema";

/** Reserve files on their actual storage targets, including delivery mirrors. */
export function liveManifestPathIssues(plan: LiveChannelPlan): PlanIssue[] {
	const issues: PlanIssue[] = [];
	const outputs = new Map(plan.outputs.map((output) => [output.key, output]));
	const reservations = new Map<string, string>();
	const uris = liveHlsEntryUris(plan);
	const reserve = (
		destination: { outputKey: string; path: string },
		filename: string,
		owner: string,
		path: string,
		mirrored = true,
	) => {
		const targets = new Set([
			destination.outputKey,
			...(mirrored
				? (plan.deliveryMirrors ?? []).map((mirror) => mirror.outputKey)
				: []),
		]);
		for (const key of targets) {
			const output = outputs.get(key);
			if (!output) continue;
			const identity = [
				output.kind,
				"credentialId" in output ? output.credentialId : "",
				"bucket" in output
					? output.bucket
					: "container" in output
						? output.container
						: "",
			];
			const file = [destination.path, filename]
				.join("/")
				.split("/")
				.filter(Boolean)
				.join("/");
			const token = JSON.stringify([identity, file]);
			const previous = reservations.get(token);
			if (previous && previous !== owner)
				issues.push({
					code: "LIVE_OUTPUT_NAMESPACE_COLLISION",
					level: "error",
					path,
					message: `Live output file "${file}" is written by both ${previous} and ${owner}. Use distinct manifest folders or filenames.`,
				});
			else reservations.set(token, owner);
		}
	};
	for (const [index, manifest] of plan.liveManifests.entries()) {
		const owner = `manifest "${manifest.key}"`;
		const path = `liveManifests[${index}].destination`;
		reserve(manifest.destination, manifest.manifestName, owner, path);
		if (manifest.kind === "HLS") {
			for (const { muxing, rendition } of selectLiveManifestMuxings(
				plan,
				manifest,
			)) {
				const uri = uris.get(rendition.key);
				if (uri)
					reserve(
						manifest.destination,
						uri,
						`playlist "${muxing.key}" in ${owner}`,
						path,
					);
			}
		}
	}
	for (const [index, muxing] of plan.muxings.entries()) {
		if (muxing.kind === "MP4" && muxing.destination)
			reserve(
				muxing.destination,
				muxing.filename,
				`archive "${muxing.key}"`,
				`muxings[${index}].destination`,
				false,
			);
		if (
			(muxing.kind === "FMP4" ||
				(muxing.kind === "CMAF" && !muxing.initSegmentNameTemplate)) &&
			muxing.destination
		)
			reserve(
				muxing.destination,
				muxing.initSegmentName,
				`muxing "${muxing.key}"`,
				`muxings[${index}].destination`,
			);
	}
	return issues;
}
