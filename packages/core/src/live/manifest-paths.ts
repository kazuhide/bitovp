import {
	outputFileKeys,
	outputFilePath,
	staticMuxingOutputFiles,
} from "../plan/output-files";
import type { PlanIssue } from "../plan/validate";
import { liveHlsEntryUris, selectLiveManifestMuxings } from "./compiler";
import {
	filenameLanguagesOverlap,
	literalFilenameLanguage,
	outputFilenameLanguage,
} from "./filename-language";
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
	const literalFiles = [...reservations].map(([token, owner]) => {
		const address = JSON.parse(token) as { storage: string; path: string };
		return {
			...address,
			owner,
			language: literalFilenameLanguage(address.path),
		};
	});
	// A segment may use any extension, so a dynamic name can also overwrite an
	// init file, playlist or archive. Check the physical targets already reserved.
	for (const [index, muxing] of plan.muxings.entries()) {
		if (muxing.kind === "MP4") continue;
		for (const destination of [
			muxing.destination,
			...(plan.drm ?? [])
				.filter((d) => d.muxingKey === muxing.key)
				.map((d) => d.destination),
		]) {
			if (!destination) continue;
			const filename = muxing.segmentNamingTemplate || muxing.segmentNaming;
			if (!/[%{]/.test(filename)) continue;
			for (const token of outputFileKeys(plan, {
				destination,
				filename,
			})) {
				const dynamic: { storage: string; path: string } = JSON.parse(token);
				const pattern = outputFilenameLanguage(
					destination.path,
					filename,
					Boolean(muxing.segmentNamingTemplate),
				);
				for (const literal of literalFiles) {
					if (
						literal.storage !== dynamic.storage ||
						!filenameLanguagesOverlap(pattern, literal.language)
					)
						continue;
					issues.push({
						code: "LIVE_OUTPUT_NAMESPACE_COLLISION",
						level: "error",
						path: `muxings[${index}].${muxing.segmentNamingTemplate ? "segmentNamingTemplate" : "segmentNaming"}`,
						message: `Live segment pattern "${filename}" may overwrite output file "${literal.path}" owned by ${literal.owner}. Use distinct output filenames or folders.`,
					});
				}
			}
		}
	}
	return issues;
}
