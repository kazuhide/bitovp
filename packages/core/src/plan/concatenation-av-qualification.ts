import { AUDIO_CODECS, type EncodingPlan } from "./schema";
import type { PlanIssue } from "./validate";

type Programme = { id: number; concatenated: boolean };
const videoCodecs = new Set(["H264", "H265", "VP9", "AV1"]);

/** A successful independent CPU preview does not qualify a different cloud AV
 * concatenation programme. The observed encoder pairs positions across tracks;
 * equal totals (or even equal per-position durations) do not establish support.
 * Keep the edit intact and withhold unqualified submissions before billing. */
export function checkConcatenationAvQualification(
	plan: EncodingPlan,
): PlanIssue[] {
	if (!plan.concatenationStreams.length) return [];
	const memo = new Map<string, Programme | undefined>();
	// Intern node descriptions using child IDs, not expanded descendant strings:
	// repeated/nested concatenations must not expand exponentially in validation.
	const descriptions = new Map<string, number>();
	const intern = (description: unknown, concatenated: boolean): Programme => {
		const signature = JSON.stringify(description);
		let id = descriptions.get(signature);
		if (id === undefined) {
			id = descriptions.size;
			descriptions.set(signature, id);
		}
		return { id, concatenated };
	};
	const programme = (
		key: string,
		seen = new Set<string>(),
	): Programme | undefined => {
		if (seen.has(key)) return undefined;
		if (memo.has(key)) return memo.get(key);
		const next = new Set(seen).add(key);
		const parent = (source: string) => programme(source, next);
		let result: Programme | undefined;
		const leaf =
			plan.ingest.find((item) => item.key === key) ??
			plan.fileStreams.find((item) => item.key === key) ??
			plan.dolbyStreams.find((item) => item.key === key);
		const trim = plan.trimmingStreams.find((item) => item.key === key);
		const concat = plan.concatenationStreams.find((item) => item.key === key);
		const mix = plan.audioMixStreams.find((item) => item.key === key);
		if (leaf) {
			const input = plan.inputs.find((item) => item.key === leaf.inputKey);
			if (input) {
				const { key: _key, name: _name, ...locator } = input;
				// Video/audio selectors and track positions can differ in one file.
				const path =
					"videoInputPath" in leaf ? leaf.videoInputPath : leaf.inputPath;
				result = intern(["source", locator, path], false);
			}
		} else if (trim) {
			const source = parent(trim.sourceKey);
			if (source) {
				const {
					key: _key,
					sourceKey: _source,
					encodingKey: _encoding,
					...range
				} = trim;
				result = intern(["trim", range, source.id], source.concatenated);
			}
		} else if (concat) {
			const parts = concat.sources
				.map((part, index) => ({ ...part, position: part.position ?? index }))
				.sort((a, b) => a.position - b.position);
			const sources = parts.map((part) => parent(part.sourceKey));
			if (sources.every((source) => source !== undefined))
				result = intern(
					[
						"concat",
						parts.map((part, index) => [
							part.position,
							part.isMain === true,
							part.aspectMode ?? "PAD",
							part.paddingBefore ?? null,
							part.paddingAfter ?? null,
							sources[index]?.id,
						]),
					],
					true,
				);
		} else if (mix) {
			const sources = mix.audioMixChannels.map((channel) =>
				parent(channel.sourceKey),
			);
			if (sources.length && sources.every((source) => source !== undefined)) {
				const first = sources[0];
				if (first)
					result = sources.every((source) => source.id === first.id)
						? first
						: intern(
								["mix", sources.map((source) => source.id)],
								sources.some((source) => source.concatenated),
							);
			}
		}
		// Unknown/cyclic graphs remain subject to the existing graph errors.
		memo.set(key, result);
		return result;
	};
	const videos = plan.renditions
		.filter((rendition) => videoCodecs.has(rendition.codec))
		.map((rendition) => ({
			rendition,
			programme: programme(rendition.ingestKey),
		}));
	return plan.renditions.flatMap((audio, index): PlanIssue[] => {
		if (!AUDIO_CODECS.has(audio.codec)) return [];
		const sound = programme(audio.ingestKey);
		if (!sound) return [];
		const different = videos.find(
			({ rendition, programme: picture }) =>
				(rendition.encodingKey ?? "") === (audio.encodingKey ?? "") &&
				picture &&
				(picture.concatenated || sound.concatenated) &&
				picture.id !== sound.id,
		);
		return different
			? [
					{
						code: "PLAN_CONCATENATION_AV_UNQUALIFIED",
						level: "error",
						path: `renditions[${index}].ingestKey`,
						message:
							"Separate audio/video concatenation programmes with different sources, trims, positions or padding are not qualified for cloud encoding. Use matching source/cut programmes, or supply a physical file with the combined edited audio and video. Independent editing and CPU preview remain available.",
					},
				]
			: [];
	});
}
