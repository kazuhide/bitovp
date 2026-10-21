import {
	outputFileKeys,
	outputFilePath,
	staticMuxingOutputFiles,
} from "../plan/output-files";
import type { PlanIssue } from "../plan/validate";
import { liveHlsEntryUris, selectLiveManifestMuxings } from "./compiler";
import type { LiveChannelPlan } from "./schema";

/** Reserve files on their actual storage targets, including delivery mirrors. */
export function liveManifestPathIssues(plan: LiveChannelPlan): PlanIssue[] {
	const issues: PlanIssue[] = [];
	const reservations = new Map<string, string>();
	const uris = liveHlsEntryUris(plan);
	const reserve = (
		destination: { outputKey: string; path: string },
		filename: string,
		owner: string,
		path: string,
	) => {
		const file = outputFilePath(destination.path, filename);
		for (const token of outputFileKeys(plan, { destination, filename })) {
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
	for (const file of staticMuxingOutputFiles(plan))
		reserve(file.destination, file.filename, file.owner, file.path);
	return issues;
}
