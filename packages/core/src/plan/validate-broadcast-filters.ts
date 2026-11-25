import { inputStreamAncestry } from "./input-stream-graph";
import { layoutChannelCount } from "./media-filters";
import { AUDIO_CODECS, type EncodingPlan } from "./schema";
import type { PlanIssue } from "./validate";

const minimumVersions = {
	CONFORM: [2, 28, 0],
	INTERLACE: [1, 53, 0],
	ENHANCED_WATERMARK: [1, 47, 3],
	DOLBY_LOUDNESS: [2, 282, 0],
	ENHANCED_DEINTERLACE: [2, 56, 0],
} as const;

function checkEncoderVersion(
	kind: keyof typeof minimumVersions,
	version: string,
	path: string,
): PlanIssue | undefined {
	const minimum = minimumVersions[kind];
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match)
		return {
			code: "PLAN_FILTER_ENCODER_VERSION_UNRESOLVED",
			level: "warning",
			path,
			message: `${kind} requires Encoder ${minimum.join(".")} or newer. The selected version ${version} is resolved by the provider.`,
		};
	const [major, minor, patch] = match.slice(1).map(Number) as [
		number,
		number,
		number,
	];
	if ((major - minimum[0] || minor - minimum[1] || patch - minimum[2]) < 0)
		return {
			code: "PLAN_FILTER_ENCODER_VERSION",
			level: "error",
			path,
			message: `${kind} requires Encoder ${minimum.join(".")} or newer; selected ${version}.`,
		};
	return undefined;
}

export function validateBroadcastFilters(plan: EncodingPlan): PlanIssue[] {
	const issues: PlanIssue[] = [];
	const filters = new Map(plan.filters.map((f) => [f.key, f]));
	const conformRates = new Map<string | undefined, number>();
	for (const rendition of plan.renditions) {
		for (const attachment of rendition.filters ?? []) {
			const f = filters.get(attachment.filterKey);
			if (f?.kind === "CONFORM")
				conformRates.set(rendition.encodingKey, f.targetFps);
		}
	}
	// The encoder applies the filter after merging multiple source tracks. A
	// single physical track instead takes its input-mix branch and skips the
	// rendition filter, even when several output channels select that track.
	const sourceTracks = new Map(
		plan.ingest.map((s) => [
			s.key,
			JSON.stringify([s.inputKey, s.inputPath, s.selectionMode, s.position]),
		]),
	);
	const singleTrackMixes = new Set(
		plan.audioMixStreams
			.filter(
				(mix) =>
					new Set(
						mix.audioMixChannels.map(
							(c) => sourceTracks.get(c.sourceKey) ?? c.sourceKey,
						),
					).size === 1,
			)
			.map((mix) => mix.key),
	);
	for (const [index, rendition] of plan.renditions.entries()) {
		const path = `renditions[${index}].filters`;
		const attached = (rendition.filters ?? []).flatMap((a) => {
			const f = filters.get(a.filterKey);
			return f ? [f] : [];
		});
		const target = conformRates.get(rendition.encodingKey);
		if (target !== undefined) {
			const rates = attached.filter((f) => f.kind === "CONFORM");
			const rate =
				"rate" in rendition && !AUDIO_CODECS.has(rendition.codec)
					? rendition.rate
					: undefined;
			if (
				rendition.codec === "WEBVTT" ||
				rendition.codec === "IMSC" ||
				rendition.burnInSrt ||
				rates.length !== 1 ||
				rates[0]?.targetFps !== target ||
				(rate != null && Math.abs(Math.fround(rate) - target) > 1e-7)
			)
				issues.push({
					level: "error",
					code: "PLAN_CONFORM_FILTER",
					path,
					message:
						"Conform requires exactly one filter with the same target FPS on every stream in the encoding and a matching configured video frame rate. Captions and subtitle streams are incompatible.",
				});
		}
		const seen = new Set<string>();
		for (const f of attached) {
			if (
				f.kind === "ENHANCED_DEINTERLACE" ||
				f.kind === "DOLBY_LOUDNESS" ||
				f.kind === "CONFORM" ||
				f.kind === "INTERLACE" ||
				f.kind === "ENHANCED_WATERMARK"
			) {
				const owner = plan.encodings?.find(
					(e) => e.key === rendition.encodingKey,
				);
				const issue = checkEncoderVersion(
					f.kind,
					owner?.encoderVersion ?? plan.bitmovin.encoderVersion,
					path,
				);
				if (issue) issues.push(issue);
			}
			if (f.kind !== "AUDIO_MIX" && f.kind !== "DOLBY_LOUDNESS") continue;
			const error = (message: string) =>
				issues.push({
					code: "PLAN_AUDIO_FILTER",
					level: "error",
					path,
					message,
				});
			if (seen.has(f.kind))
				error(`Attach at most one ${f.kind} filter to each rendition.`);
			seen.add(f.kind);
			if (f.kind === "DOLBY_LOUDNESS") {
				if (plan.generation.audioVideoSyncMode || plan.kantar)
					error(
						"Dolby Loudness cannot be used with explicit audio/video sync or Kantar watermarking.",
					);
			} else {
				if (
					singleTrackMixes.size &&
					inputStreamAncestry(plan, rendition.ingestKey)?.some((k) =>
						singleTrackMixes.has(k),
					)
				)
					error(
						"The encoder skips the rendition Audio Mix filter when the input mix reads a single source track. Apply the channel map in the input mix.",
					);
				if (
					"channelLayout" in rendition &&
					rendition.channelLayout &&
					rendition.channelLayout !== "NONE"
				) {
					const layout = rendition.channelLayout
						.replace(/^X?CL_/, "")
						.replace(/(\d)_(\d)/, "$1.$2");
					const count = layoutChannelCount(layout);
					if (
						f.channelLayout === "NONE"
							? count !== undefined && f.audioMixChannels.length !== count
							: layout !== f.channelLayout
					)
						error(
							`Audio Mix layout ${f.channelLayout} must match rendition layout ${layout}.`,
						);
				}
			}
		}
	}
	return issues;
}
