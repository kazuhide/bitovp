import { outputFileKeys, outputFilePath } from "../plan/output-files";
import type { PlanIssue } from "../plan/validate";
import { liveHlsEntryUris, selectLiveManifestMuxings } from "./compiler";
import { dvbTracksForManifest, dvbUri } from "./dvb-subtitles";
import {
	filenameLanguagesOverlap,
	literalFilenameLanguage,
	outputFilenameLanguage,
} from "./filename-language";
import { liveOutputWriters } from "./protection";
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
			for (const track of dvbTracksForManifest(plan, manifest))
				reserve(
					manifest.destination,
					dvbUri(track),
					`${owner} DVB subtitles ${track.key}`,
					path,
				);
			for (const [mediaIndex, media] of (
				manifest.detailed?.additionalMedia ?? []
			).entries())
				if (media.type !== "CLOSED_CAPTIONS")
					reserve(
						manifest.destination,
						media.uri,
						`${owner} additional media ${mediaIndex}`,
						`liveManifests[${index}].detailed.additionalMedia[${mediaIndex}].uri`,
					);
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
	const writers = liveOutputWriters(plan);
	for (const { files, destination, owner, path } of writers)
		for (const file of files)
			if (!file.policyTokens && !file.randomTokens)
				reserve(destination, file.pattern, owner, `${path}.destination`);
	const literalFiles = [...reservations].map(([token, owner]) => {
		const address = JSON.parse(token) as { storage: string; path: string };
		return {
			...address,
			owner,
			language: literalFilenameLanguage(address.path),
		};
	});
	// Dynamic segment or init templates can overwrite a literal file of any kind.
	// Compare their physical targets without expanding tokens in literal fields.
	for (const { files, destination, source } of writers) {
		for (const filename of files) {
			if (!filename.policyTokens && !filename.randomTokens) continue;
			const pattern = outputFilenameLanguage(
				destination.path,
				filename.pattern,
				filename,
			);
			for (const token of outputFileKeys(plan, {
				destination,
				filename: filename.pattern,
			})) {
				const dynamic: { storage: string; path: string } = JSON.parse(token);
				for (const literal of literalFiles) {
					if (
						literal.storage !== dynamic.storage ||
						!filenameLanguagesOverlap(pattern, literal.language)
					)
						continue;
					issues.push({
						code: "LIVE_OUTPUT_NAMESPACE_COLLISION",
						level: "error",
						path: `${source}.${filename.field}`,
						message: `Live output filename "${filename.pattern}" may overwrite output file "${literal.path}" owned by ${literal.owner}. Use distinct output filenames or folders.`,
					});
				}
			}
		}
	}
	return issues;
}
