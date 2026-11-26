import { type CompiledOperation, relativeSegmentPath } from "../plan/compiler";
import { manifestMediaReachable } from "../plan/manifest-reference-validation";
import type { PlanIssue } from "../plan/validate";
import type { LiveChannelPlan, LiveManifestPlan } from "./schema";

type Source = Pick<LiveChannelPlan, "dvbSubtitles">;
export type LiveDvbTrack = NonNullable<Source["dvbSubtitles"]>[number];
export function dvbTracksForManifest(
	plan: Source,
	manifest: Pick<LiveManifestPlan, "kind" | "drmKind">,
) {
	if (manifest.drmKind) return [];
	return (plan.dvbSubtitles ?? []).filter(
		(track) => manifest.kind === "DASH" || track.packaging === "CHUNKED_TEXT",
	);
}
export const dvbUri = (track: LiveDvbTrack) => `subtitles_${track.key}.m3u8`;
export const dvbSegmentNaming = (track: LiveDvbTrack) =>
	track.packaging === "FMP4" ? "segment_%number%.m4s" : "segment_%number%.vtt";
export const dvbGroup = (
	manifest: Extract<LiveManifestPlan, { kind: "HLS" }>,
) =>
	manifest.detailed?.additionalMedia?.find((m) => m.type === "VTT")?.groupId ??
	"subtitles";

export function liveDvbIssues(plan: LiveChannelPlan): PlanIssue[] {
	if (!plan.dvbSubtitles?.length) return [];
	const issues: PlanIssue[] = [];
	const keys = new Set<string>();
	const positions = new Set(
		plan.ingest.map((i) => JSON.stringify([i.inputPath, i.position])),
	);
	const detail = (path: string, message: string) =>
		issues.push({
			code: "LIVE_DVB_SUBTITLE_INVALID",
			level: "error",
			path,
			message,
		});
	const names = new Map<string, Set<string>>();
	for (const manifest of plan.liveManifests)
		if (manifest.kind === "HLS" && !manifest.drmKind)
			names.set(
				manifest.key,
				new Set(
					(manifest.detailed?.additionalMedia ?? []).flatMap((media) =>
						media.type === "VTT" ? [media.name] : [],
					),
				),
			);
	for (const [i, track] of (plan.dvbSubtitles ?? []).entries()) {
		const path = `dvbSubtitles[${i}]`;
		if (keys.has(track.key))
			detail(`${path}.key`, "Choose a distinct subtitle track key");
		keys.add(track.key);
		const position = JSON.stringify([track.inputPath, track.position]);
		if (positions.has(position))
			detail(
				`${path}.position`,
				"This absolute stream position already supplies another track",
			);
		positions.add(position);
		if (["RTMP", "REDUNDANT_RTMP"].includes(plan.liveInput.kind))
			detail(
				"liveInput.kind",
				"DVB bitmap subtitles need a transport-stream feed over SRT, Zixi or HLS",
			);
		const targets = [
			track.destination.outputKey,
			...(plan.deliveryMirrors ?? []).map((m) => m.outputKey),
		];
		if (
			targets.some(
				(key) =>
					!plan.outputs.some(
						(o) =>
							o.key === key &&
							!["MOQ", "LIVE_MEDIA_INGEST", "AKAMAI_MSL"].includes(o.kind),
					),
			)
		)
			detail(`${path}.destination`, "Publish OCR subtitles to file storage");
		const manifests = plan.liveManifests.filter(
			(m) =>
				!m.drmKind && (m.kind === "DASH" || track.packaging === "CHUNKED_TEXT"),
		);
		if (!manifests.length)
			detail(
				`${path}.packaging`,
				"Choose a clear DASH manifest for fMP4 WebVTT, or clear HLS or DASH for chunked WebVTT.",
			);
		for (const manifest of manifests) {
			const groupNames = names.get(manifest.key);
			if (groupNames?.has(track.label))
				detail(
					`${path}.label`,
					"Each subtitle track in the HLS group needs a distinct name",
				);
			groupNames?.add(track.label);
			if (
				!manifestMediaReachable(plan, track.destination, manifest.destination)
			)
				detail(
					`${path}.destination`,
					"Every selected manifest must be able to read the subtitle output",
				);
		}
	}
	return issues;
}

export function compileDvbStreams(plan: LiveChannelPlan): CompiledOperation[] {
	const ops: CompiledOperation[] = [];
	for (const track of plan.dvbSubtitles ?? []) {
		const stem = `dvb:${track.key}`;
		const dest = track.destination;
		const mirrors = (plan.deliveryMirrors ?? [])
			.filter((m) => m.outputKey !== dest.outputKey)
			.map((m) => `output:${m.outputKey}`);
		ops.push(
			{
				step: `${stem}:input`,
				kind: "CREATE_DVB_SUBTITLE_INPUT_STREAM",
				payload: {
					selectionMode: "POSITION_ABSOLUTE",
					position: track.position,
					inputPath: track.inputPath,
				},
				refs: {
					encodingId: "encoding",
					inputId: `live-input:${plan.liveInput.key}`,
				},
			},
			{
				step: `${stem}:codec`,
				kind: "CREATE_CODEC_WEBVTT",
				payload: { name: track.label },
				refs: {},
			},
			{
				step: `${stem}:stream`,
				kind: "CREATE_STREAM",
				payload: { name: track.label, mode: "STANDARD" },
				refs: {
					encodingId: "encoding",
					codecConfigId: `${stem}:codec`,
					inputStreamId: `${stem}:input`,
				},
			},
			{
				step: `${stem}:muxing`,
				kind:
					track.packaging === "FMP4"
						? "CREATE_MUXING_FMP4"
						: "CREATE_MUXING_CHUNKED_TEXT",
				payload: {
					segmentLength: track.segmentLength,
					segmentNaming: dvbSegmentNaming(track),
					...(track.packaging === "FMP4"
						? { initSegmentName: "init.mp4" }
						: {}),
					outputPath: dest.path,
					...(dest.acl ? { acl: dest.acl } : {}),
				},
				refs: {
					encodingId: "encoding",
					streamId: `${stem}:stream`,
					outputId: `output:${dest.outputKey}`,
					...(mirrors.length ? { mirrorOutputIds: mirrors } : {}),
				},
			},
		);
	}
	return ops;
}

export function compileDvbManifest(
	plan: LiveChannelPlan,
	manifest: LiveManifestPlan,
	ordinary: CompiledOperation[],
): CompiledOperation[] {
	const tracks = dvbTracksForManifest(plan, manifest);
	if (!tracks.length) return ordinary;
	const ops = ordinary.map((op) =>
		manifest.kind === "HLS" && op.kind === "CREATE_HLS_STREAM_INFO"
			? { ...op, payload: { ...op.payload, subtitles: dvbGroup(manifest) } }
			: op,
	);
	const manifestId = `manifest:${manifest.key}`,
		periodId = `${manifestId}:period`;
	for (const track of tracks) {
		const prefix = `dvb:${track.key}`,
			muxingId = `${prefix}:muxing`,
			step = `${manifestId}:${prefix}`;
		const segmentPath = relativeSegmentPath(
			track.destination.path,
			manifest.destination.path,
		);
		if (manifest.kind === "HLS") {
			ops.push({
				step,
				kind: "CREATE_HLS_SUBTITLES_MEDIA",
				payload: {
					name: track.label,
					language: track.language,
					groupId: dvbGroup(manifest),
					uri: dvbUri(track),
					segmentPath,
				},
				refs: {
					manifestId,
					encodingId: "encoding",
					streamId: `${prefix}:stream`,
					muxingId,
				},
			});
		} else {
			const adaptationSetId = `${step}:set`;
			ops.push(
				{
					step: adaptationSetId,
					kind: "CREATE_DASH_ADAPTATION_SET_SUBTITLE",
					payload: { lang: track.language, labels: [{ value: track.label }] },
					refs: { manifestId, periodId },
				},
				{
					step: `${step}:rep`,
					kind:
						track.packaging === "FMP4"
							? "CREATE_DASH_REPRESENTATION_FMP4"
							: "CREATE_DASH_REPRESENTATION_CHUNKED_TEXT",
					payload: {
						type: manifest.representationType,
						...(track.packaging === "FMP4"
							? { mode: "TEMPLATE_REPRESENTATION" }
							: {}),
						segmentPath,
					},
					refs: {
						manifestId,
						periodId,
						adaptationSetId,
						encodingId: "encoding",
						muxingId,
					},
				},
			);
		}
	}
	return ops;
}
