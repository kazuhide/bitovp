import {
	outputFileKeys,
	outputFilePath,
	staticMuxingOutputFiles,
} from "../plan/output-files";
import type { PlanIssue } from "../plan/validate";
import { liveHlsEntryUris, selectLiveManifestMuxings } from "./compiler";
import type { LiveChannelPlan } from "./schema";

/** Match provider-expanded names while treating every other character literally. */
function segmentPathPattern(
	pattern: string,
	literalCharacterLimit: number,
): RegExp {
	const source = pattern
		.split(/(%[a-zA-Z]+%|\{(?:segment_)?rand_chars(?::[1-9]\d*)?\})/g)
		.map((part) => {
			if (part === "%number%") return "\\d+";
			if (/^%[a-zA-Z]+%$/.test(part)) return "[^/]+";
			const random = /^\{(?:segment_)?rand_chars(?::([1-9]\d*))?\}$/.exec(part);
			if (random) {
				const length = Number(random[1] ?? 32);
				// Longer tokens cannot match any reserved filename; avoid unbounded quantifiers.
				return length > literalCharacterLimit
					? "(?!)"
					: `[A-Za-z0-9]{${length}}`;
			}
			return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		})
		.join("");
	return new RegExp(`^${source}$`);
}

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
	const literalFiles = [...reservations].map(([token, owner]) => ({
		...(JSON.parse(token) as { storage: string; path: string }),
		owner,
	}));
	const literalCharacterLimit = literalFiles.reduce(
		(longest, file) => Math.max(longest, file.path.length),
		0,
	);
	// A segment may use any extension, so a dynamic name can also overwrite an
	// init file, playlist or archive. Check the physical targets already reserved.
	for (const [index, muxing] of plan.muxings.entries()) {
		if (muxing.kind === "MP4" || !muxing.destination) continue;
		const filename = muxing.segmentNamingTemplate ?? muxing.segmentNaming;
		if (!/[%{]/.test(filename)) continue;
		for (const token of outputFileKeys(plan, {
			destination: muxing.destination,
			filename,
		})) {
			const dynamic: { storage: string; path: string } = JSON.parse(token);
			const pattern = segmentPathPattern(dynamic.path, literalCharacterLimit);
			for (const literal of literalFiles) {
				if (literal.storage !== dynamic.storage || !pattern.test(literal.path))
					continue;
				issues.push({
					code: "LIVE_OUTPUT_NAMESPACE_COLLISION",
					level: "error",
					path: `muxings[${index}].${muxing.segmentNamingTemplate ? "segmentNamingTemplate" : "segmentNaming"}`,
					message: `Live segment pattern "${filename}" can overwrite output file "${literal.path}" owned by ${literal.owner}. Use distinct output filenames or folders.`,
				});
			}
		}
	}
	return issues;
}
