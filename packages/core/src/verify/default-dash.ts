import type { ManifestCondition } from "../plan/manifest-options";
import {
	AUDIO_CODECS,
	type EncodingPlan,
	type PlanMuxing,
	type PlanRendition,
} from "../plan/schema";
import type { ExpectedDashPeriod } from "./expected";

type DashManifest = Extract<
	EncodingPlan["manifests"][number],
	{ kind: "DASH" }
>;
type Kind = "video" | "audio" | "text";
type Candidate = {
	rendition: PlanRendition;
	muxing: PlanMuxing;
	kind: Kind;
	encrypted: boolean;
	perTitle: boolean;
};
type Match = true | false | "unknown";

function kindOf(rendition: PlanRendition): Kind {
	if (AUDIO_CODECS.has(rendition.codec)) return "audio";
	return rendition.codec === "WEBVTT" || rendition.codec === "IMSC"
		? "text"
		: "video";
}

function compatible(muxing: PlanMuxing, manifest: DashManifest): boolean {
	if (manifest.profile === "ON_DEMAND")
		return (
			(muxing.kind === "MP4" && muxing.manifestType === "DASH_ON_DEMAND") ||
			(muxing.kind === "WEBM" && !!muxing.progressive)
		);
	return (
		["FMP4", "CMAF", "WEBM", "CHUNKED_TEXT", "TEXT"].includes(muxing.kind) &&
		!(muxing.kind === "WEBM" && muxing.progressive)
	);
}

function matchCondition(
	candidate: Candidate,
	condition: ManifestCondition | undefined,
	unverified: Set<string>,
): Match {
	if (!condition) return true;
	if (condition.type !== "CONDITION") {
		const childReasons = new Set<string>();
		const values = condition.conditions.map((child) =>
			matchCondition(candidate, child, childReasons),
		);
		const result =
			condition.type === "AND"
				? values.includes(false)
					? false
					: values.includes("unknown")
						? "unknown"
						: true
				: values.includes(true)
					? true
					: values.includes("unknown")
						? "unknown"
						: false;
		if (result === "unknown")
			for (const reason of childReasons) unverified.add(reason);
		return result;
	}
	const { attribute, operator, value } = condition;
	const { rendition, muxing, kind } = candidate;
	const family = attribute.split(".")[0];
	if (
		["video", "audio", "subtitle"].includes(family ?? "") &&
		family !== (kind === "text" ? "subtitle" : kind)
	)
		return false;
	let actual: string | number | undefined;
	switch (attribute) {
		case "video.codec":
		case "audio.codec":
			actual = rendition.codec;
			break;
		case "video.height":
			actual =
				!candidate.perTitle && "height" in rendition
					? (rendition.height ?? undefined)
					: undefined;
			break;
		case "video.width":
			actual =
				!candidate.perTitle && "width" in rendition
					? (rendition.width ?? undefined)
					: undefined;
			break;
		case "video.bitrate":
		case "audio.bitrate":
			actual =
				!candidate.perTitle && "bitrate" in rendition
					? (rendition.bitrate ?? undefined)
					: undefined;
			break;
		case "subtitle.format":
			actual = rendition.codec;
			break;
		case "subtitle.language":
			actual = "language" in rendition ? rendition.language : undefined;
			break;
		case "muxing.type":
			actual =
				muxing.kind === "WEBM" && muxing.progressive
					? "PROGRESSIVE_WEBM"
					: muxing.kind;
			break;
		case "drm.type":
			actual = !candidate.encrypted
				? "NoDrm"
				: value === "NoDrm" && ["==", "!="].includes(operator)
					? "Encrypted"
					: undefined;
			break;
		case "audio.language":
			actual = undefined;
			break;
	}
	if (actual === undefined) {
		unverified.add(`${attribute} depends on source or runtime metadata`);
		return "unknown";
	}
	const target = typeof actual === "number" ? Number(value) : value;
	if (
		typeof target === "number" &&
		(!value.trim() || !Number.isFinite(target))
	) {
		unverified.add(`${attribute} has a nonnumeric comparison value`);
		return "unknown";
	}
	if (typeof actual !== typeof target) return "unknown";
	switch (operator) {
		case "==":
			return actual === target;
		case "!=":
			return actual !== target;
		case ">":
			return actual > target;
		case ">=":
			return actual >= target;
		case "<":
			return actual < target;
		case "<=":
			return actual <= target;
	}
}

/** Default V2 can select a bounded set of known outputs; metadata is never invented. */
export function defaultDashPeriods(
	plan: EncodingPlan,
	manifest: DashManifest,
): ExpectedDashPeriod[] {
	const firstEncoding = plan.encodings?.[0]?.key ?? "default";
	const firstRendition = plan.renditions[0];
	const periods = manifest.defaultPeriods ?? [
		{ encodingKeys: [firstRendition?.encodingKey ?? firstEncoding] },
	];
	return periods.map((period) => {
		const unverified = new Set<string>();
		const perTitleSelection = new Map<string, boolean>();
		let knownVideo = false;
		const result: ExpectedDashPeriod = {
			counts: {
				video: { min: 0, max: 0 },
				audio: { min: 0, max: 0 },
				text: { min: 0, max: 0 },
			},
			topology: {
				video: [],
				audio: [],
				declaredVideoCodecFamilies: [],
				textCodecs: ["wvtt", "stpp"],
			},
			perTitle: false,
			unverified: [],
		};
		const candidates = plan.muxings.flatMap<Candidate>((muxing) => {
			const rendition = plan.renditions.find(
				(row) => row.key === muxing.streamKey,
			);
			if (
				!rendition ||
				!period.encodingKeys.includes(rendition.encodingKey ?? firstEncoding) ||
				!compatible(muxing, manifest)
			)
				return [];
			const perTitle =
				"mode" in rendition && rendition.mode.startsWith("PER_TITLE");
			return [
				...(muxing.destination
					? [
							{
								rendition,
								muxing,
								kind: kindOf(rendition),
								encrypted: false,
								perTitle,
							},
						]
					: []),
				...plan.drm
					.filter((row) => row.muxingKey === muxing.key)
					.map(() => ({
						rendition,
						muxing,
						kind: kindOf(rendition),
						encrypted: true,
						perTitle,
					})),
			];
		});
		for (const [conditionIndex, condition] of (period.adaptationSets?.length
			? period.adaptationSets
			: [undefined]
		).entries()) {
			const groups = new Map<
				string,
				{ candidate: Candidate; match: Match }[]
			>();
			for (const candidate of candidates) {
				const match = matchCondition(candidate, condition, unverified);
				if (match === false) continue;
				const group = groups.get(candidate.rendition.key) ?? [];
				group.push({ candidate, match });
				groups.set(candidate.rendition.key, group);
			}
			for (const group of groups.values()) {
				const first = group[0];
				if (!first) continue;
				const { kind, rendition } = first.candidate;
				const known = group.some((entry) => entry.match === true);
				const bounds = result.counts[kind];
				const flexible =
					"mode" in rendition && rendition.mode === "PER_TITLE_TEMPLATE";
				if (known && kind === "video") knownVideo = true;
				if (known && !flexible) bounds.min++;
				if (group.some((entry) => entry.candidate.perTitle)) {
					delete bounds.max;
					result.perTitle = true;
					unverified.add(
						"Per-Title representation counts depend on encoding results",
					);
					if (kind === "video")
						perTitleSelection.set(
							rendition.key,
							known || perTitleSelection.get(rendition.key) === true,
						);
				} else if (bounds.max !== undefined) bounds.max += group.length;
				if (group.length > 1)
					unverified.add(
						"Default output selection has multiple compatible containers or encryption outputs",
					);
				if (kind === "video")
					result.topology.declaredVideoCodecFamilies.push(rendition.codec);
				for (const [index, { candidate }] of group.entries()) {
					const optional = !known || index > 0;
					const renditionKey = `${rendition.key}:selection-${conditionIndex}-${index}`;
					if (kind === "video" && !candidate.perTitle) {
						result.topology.video.push({
							renditionKey,
							codec: rendition.codec,
							...("height" in rendition && rendition.height != null
								? { height: rendition.height }
								: {}),
							...("width" in rendition && rendition.width != null
								? { width: rendition.width }
								: {}),
							...("bitrate" in rendition && rendition.bitrate != null
								? { bitrate: rendition.bitrate }
								: {}),
							...(optional ? { optional: true } : {}),
						});
						if (
							!("height" in rendition) ||
							rendition.height == null ||
							!("bitrate" in rendition) ||
							rendition.bitrate == null
						)
							unverified.add(
								`Video geometry or bitrate for ${rendition.key} depends on encoding results`,
							);
					} else if (
						kind === "audio" &&
						"bitrate" in rendition &&
						rendition.bitrate != null
					)
						result.topology.audio.push({
							renditionKey,
							codec: rendition.codec,
							bitrate: rendition.bitrate,
							...(optional ? { optional: true } : {}),
						});
				}
			}
		}
		result.topology.declaredVideoCodecFamilies = [
			...new Set(result.topology.declaredVideoCodecFamilies),
		].sort();
		result.unverified = [...unverified].sort();
		if (knownVideo)
			result.counts.video.min = Math.max(1, result.counts.video.min);
		if (result.perTitle)
			result.perTitleSelection = [...perTitleSelection].map(
				([renditionKey, known]) => ({
					renditionKey,
					...(known ? {} : { conditional: true as const }),
					...(plan.renditions.some(
						(row) =>
							row.key === renditionKey &&
							"mode" in row &&
							row.mode === "PER_TITLE_TEMPLATE",
					)
						? { optional: true as const }
						: {}),
				}),
			);
		return result;
	});
}
