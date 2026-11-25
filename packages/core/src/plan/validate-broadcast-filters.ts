import { inputStreamAncestry } from "./input-stream-graph";
import { AUDIO_CODECS, type EncodingPlan } from "./schema";
import type { PlanIssue } from "./validate";

const minimumVersions = {
	CONFORM: [2, 28, 0],
	INTERLACE: [1, 53, 0],
	ENHANCED_WATERMARK: [1, 47, 3],
	DOLBY_LOUDNESS: [2, 282, 0],
	ENHANCED_DEINTERLACE: [2, 56, 0],
} as const;

// A NONE stream filter becomes FFmpeg's numbered "Nc" pan layout. These
// canonical layouts determine speaker positions as well as the channel count.
const defaultMixLayoutsByCount: Readonly<Record<number, string>> = {
	1: "MONO",
	2: "STEREO",
	3: "2.1",
	4: "4.0",
	5: "5.0_BACK",
	6: "5.1_BACK",
	7: "6.1",
	8: "7.1",
	16: "HEXADECAGONAL",
	24: "22.2",
};

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
	const atmosInputs = new Set(
		plan.dolbyStreams
			.filter((stream) => stream.kind === "ATMOS")
			.map((stream) => stream.key),
	);
	const ingests = new Map(plan.ingest.map((s) => [s.key, s]));
	const potentiallySingleTrack = new Set(
		plan.audioMixStreams
			.filter((mix) => {
				const keys = [...new Set(mix.audioMixChannels.map((c) => c.sourceKey))];
				const tracks = keys.flatMap((k) => {
					const track = ingests.get(k);
					return track ? [track] : [];
				});
				// Two selectors of different kinds can resolve to the very same source
				// track. A distinct input/file or differing positions in a common
				// explicit coordinate system guarantee a multi-track merge.
				const files = new Set(
					tracks.map((t) => JSON.stringify([t.inputKey, t.inputPath])),
				);
				if (files.size > 1) return false;
				const absolute = new Set(
					tracks
						.filter((t) => t.selectionMode === "POSITION_ABSOLUTE")
						.map((t) => t.position),
				);
				const relative = new Set(
					tracks
						.filter((t) => t.selectionMode === "AUDIO_RELATIVE")
						.map((t) => t.position),
				);
				if (absolute.size > 1 || relative.size > 1) return false;
				const [absolutePosition] = absolute;
				const [relativePosition] = relative;
				return (
					absolutePosition === undefined ||
					relativePosition === undefined ||
					absolutePosition >= relativePosition
				);
			})
			.map((m) => m.key),
	);
	const cuts = new Map(
		plan.trimmingStreams.map((t) => [
			t.key,
			t.kind === "TIME_BASED"
				? [t.kind, t.duration]
				: t.kind === "TIMECODE_TRACK"
					? [t.kind, t.startTimeCode, t.endTimeCode]
					: [t.kind, t.startPicTiming, t.endPicTiming],
		]),
	);
	const joins = new Map(plan.concatenationStreams.map((c) => [c.key, c]));
	const incompatibleConcatenations = new Set<string | undefined>();
	for (const encoding of conformRates.keys()) {
		const renditions = plan.renditions.filter(
			(r) => r.encodingKey === encoding,
		);
		if (!renditions.some((r) => joins.has(r.ingestKey))) continue;
		const shapes = new Set<string>();
		for (const r of renditions) {
			const join = joins.get(r.ingestKey);
			if (join) {
				if (join.sources.length === 1) incompatibleConcatenations.add(encoding);
				const parts = join.sources
					.map((part, i) => ({
						position: part.position ?? i,
						cut: cuts.get(part.sourceKey) ?? ["INGEST"],
					}))
					.sort((a, b) => a.position - b.position);
				shapes.add(JSON.stringify(parts));
			} else if (cuts.has(r.ingestKey) || ingests.has(r.ingestKey))
				shapes.add("direct");
		}
		if (shapes.size > 1) incompatibleConcatenations.add(encoding);
	}
	for (const [index, rendition] of plan.renditions.entries()) {
		const path = `renditions[${index}].filters`;
		const attached = (rendition.filters ?? []).flatMap((a) => {
			const f = filters.get(a.filterKey);
			return f ? [f] : [];
		});
		// Audio Mix is performed by the input transmuxer; gain and loudness
		// processing happen downstream even if their attachment position is lower.
		const attachments = rendition.filters ?? [];
		const mix = attachments.find(
			(a) => filters.get(a.filterKey)?.kind === "AUDIO_MIX",
		);
		if (
			mix &&
			attachments.some((a) => {
				const kind = filters.get(a.filterKey)?.kind;
				return (
					a.position < mix.position &&
					(kind === "AUDIO_VOLUME" ||
						kind === "EBU_R128_SINGLE_PASS" ||
						kind === "DOLBY_LOUDNESS")
				);
			})
		)
			issues.push({
				code: "PLAN_AUDIO_FILTER",
				level: "error",
				path,
				message:
					"Place Audio Mix before volume and loudness filters to match the encoder’s processing order.",
			});
		const kinds = new Set(attached.map((f) => f.kind));
		if (kinds.has("DEINTERLACE") && kinds.has("ENHANCED_DEINTERLACE"))
			issues.push({
				code: "PLAN_DEINTERLACE_CONFLICT",
				level: "error",
				path,
				message:
					"Choose either Deinterlace or Enhanced Deinterlace for this stream.",
			});
		if (incompatibleConcatenations.has(rendition.encodingKey))
			issues.push({
				code: "PLAN_CONFORM_CONCATENATION",
				level: "error",
				path,
				message:
					"Conform requires matching multi-entry concatenations in each encoding: use matching part counts, positions, trim types and trim settings, or reference a single trimmed clip directly.",
			});
		const target = conformRates.get(rendition.encodingKey);
		const ancestry =
			target !== undefined || mix
				? inputStreamAncestry(plan, rendition.ingestKey)
				: undefined;
		const usesAtmosInput =
			rendition.codec === "DOLBY_ATMOS" ||
			ancestry?.some((key) => atmosInputs.has(key));
		if (target !== undefined) {
			const rates = attached.filter((f) => f.kind === "CONFORM");
			const rate =
				"rate" in rendition && !AUDIO_CODECS.has(rendition.codec)
					? rendition.rate
					: undefined;
			if (
				rendition.codec === "WEBVTT" ||
				rendition.codec === "IMSC" ||
				usesAtmosInput ||
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
						"Conform requires exactly one filter with the same target FPS on every stream in the encoding and a matching configured video frame rate. Captions, subtitle streams and Dolby Atmos file inputs are incompatible.",
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
				if (kinds.has("AUDIO_VOLUME") || kinds.has("EBU_R128_SINGLE_PASS"))
					error(
						"Dolby Loudness bypasses the Audio Volume and EBU R128 single-pass filters. Choose one loudness workflow for this rendition.",
					);
				if (plan.generation.audioVideoSyncMode || plan.kantar)
					error(
						"Dolby Loudness cannot be used with explicit audio/video sync or Kantar watermarking.",
					);
			} else {
				if (usesAtmosInput)
					error("Audio Mix cannot be applied to a Dolby Atmos file input.");
				if (
					potentiallySingleTrack.size &&
					ancestry?.some((k) => potentiallySingleTrack.has(k))
				)
					error(
						"These input selectors can resolve to a single source track, where the encoder skips the rendition Audio Mix filter. Apply the mapping in the input mix or select distinct source tracks.",
					);
				const mixLayout =
					f.channelLayout === "NONE"
						? defaultMixLayoutsByCount[f.audioMixChannels.length]
						: f.channelLayout;
				if (!mixLayout) {
					error(
						"Audio Mix has no default speaker layout for this number of output channels. Choose an available layout or change the channel count.",
					);
					continue;
				}
				if (
					"channelLayout" in rendition &&
					rendition.channelLayout &&
					rendition.channelLayout !== "NONE"
				) {
					const layout = rendition.channelLayout
						.replace(/^X?CL_/, "")
						.replace(/(\d)_(\d)/, "$1.$2");
					if (layout !== mixLayout)
						error(
							`Audio Mix layout ${f.channelLayout} must match rendition layout ${layout}.`,
						);
				}
			}
		}
	}
	return issues;
}
