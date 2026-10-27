import type { StepLogEntry } from "./steplog";

type Body = Record<string, unknown>;
const globalHls =
	"manifestName name hlsMasterPlaylistVersion hlsMediaPlaylistVersion channelsAttributeForAudio targetDurationRoundingMode";
const globalDash =
	"manifestName name profile dashEditionCompatibility iso8601TimestampFormat minBufferTime namespaces utcTimings";
const adaptation = "roles accessibilities labels customAttributes";
const media =
	"name groupId language assocLanguage characteristics isDefault autoselect forced startSegmentNumber endSegmentNumber";
const segment = "type mode segmentPath startSegmentNumber endSegmentNumber";

/** Reconstructs API bodies from immutable executor snapshots, independently of SDK execution. */
export function manifestCurlSnapshot(
	entry: StepLogEntry,
): { request: Body; refs: StepLogEntry["refs"] } | false | undefined {
	const snapshot = bag(entry.request);
	const resolved = bag(snapshot?.refs);
	const refs: StepLogEntry["refs"] = { ...entry.refs };
	if (resolved)
		for (const [key, value] of Object.entries(resolved))
			if (
				typeof value === "string" ||
				(Array.isArray(value) && value.every((v) => typeof v === "string"))
			)
				refs[key] = value;
	const id = (key: string): string | undefined =>
		typeof resolved?.[key] === "string" ? (resolved[key] as string) : undefined;
	const pick = (fields: string): Body =>
		Object.fromEntries(
			fields
				.split(" ")
				.filter((key) => snapshot?.[key] !== undefined)
				.map((key) => [key, snapshot?.[key]]),
		);
	const bodyIds = (...keys: string[]): Body =>
		Object.fromEntries(
			keys.filter((key) => id(key) !== undefined).map((key) => [key, id(key)]),
		);
	const kind = entry.kind;
	let body: Body;
	if (kind === "CREATE_MANIFEST_HLS" || kind === "CREATE_MANIFEST_DASH") {
		if (!snapshot) return undefined;
		const outputId = id("outputId");
		if (!outputId) return false;
		body = pick(kind === "CREATE_MANIFEST_HLS" ? globalHls : globalDash);
		body.name = String(snapshot.name ?? "");
		for (const field of ["hlsMasterPlaylistVersion", "hlsMediaPlaylistVersion"])
			if (typeof body[field] === "string")
				body[field] = body[field].replace(/^HLS_V/, "");
		const mirrors = resolved?.mirrorOutputIds;
		if (
			entry.refs.mirrorOutputIds !== undefined &&
			(!Array.isArray(mirrors) ||
				mirrors.some((id) => typeof id !== "string" || !id))
		)
			return false;
		const mirrorPaths = Array.isArray(snapshot.mirrorOutputPaths)
			? snapshot.mirrorOutputPaths
			: [];
		const acl =
			typeof snapshot.acl === "string"
				? { acl: [{ permission: snapshot.acl }] }
				: {};
		body.outputs = [
			{ outputId, outputPath: snapshot.outputPath, ...acl },
			...(Array.isArray(mirrors)
				? mirrors.map((outputId, index) => ({
						outputId,
						outputPath:
							typeof mirrorPaths[index] === "string"
								? mirrorPaths[index]
								: snapshot.outputPath,
						...acl,
					}))
				: []),
		];

		if (snapshot.generationMode === "DEFAULT") {
			if (
				Array.isArray(snapshot.periods) &&
				snapshot.periods.some((_, index) => {
					const ids = resolved?.[`periodEncodingIds:${index}`];
					return (
						!Array.isArray(ids) ||
						!ids.length ||
						ids.some((id) => typeof id !== "string" || !id)
					);
				})
			)
				return false;
			if (!Array.isArray(snapshot.periods) && !id("encodingId")) return false;
			if (Array.isArray(snapshot.periods))
				body.periods = snapshot.periods.map((period, index) => ({
					...bag(period),
					encodingIds: resolved?.[`periodEncodingIds:${index}`],
				}));
			else Object.assign(body, bodyIds("encodingId"));
			if (kind === "CREATE_MANIFEST_DASH")
				body.version = snapshot.version ?? "V2";
		}
	} else if (kind === "CREATE_DASH_PERIOD") body = pick("start duration");
	else if (kind === "CREATE_DASH_PERIOD_XML") body = pick("data");
	else if (kind.startsWith("CREATE_DASH_ADAPTATION_SET_")) {
		body = {
			...pick(adaptation),
			type: kind.replace("CREATE_DASH_ADAPTATION_SET_", ""),
		};
		if (
			kind === "CREATE_DASH_ADAPTATION_SET_AUDIO" ||
			kind === "CREATE_DASH_ADAPTATION_SET_SUBTITLE"
		)
			Object.assign(body, pick("lang"));
	} else if (
		kind.startsWith("CREATE_DASH_REPRESENTATION_") &&
		kind !== "CREATE_DASH_REPRESENTATION_IMSC"
	) {
		const type = kind.replace("CREATE_DASH_REPRESENTATION_", "");
		const encrypted =
			(type === "FMP4" || type === "MP4") &&
			(id("drmId") !== undefined || entry.refs.drmId !== undefined);
		const required = [
			"manifestId",
			"periodId",
			"adaptationSetId",
			...(type === "VTT"
				? []
				: type === "SPRITE"
					? ["encodingId", "streamId", "spriteId"]
					: ["encodingId", "muxingId"]),
			...(encrypted ? ["drmId"] : []),
			...["dependencyId", "startKeyframeId", "endKeyframeId"].filter(
				(key) => entry.refs[key] !== undefined,
			),
		];
		if (required.some((key) => !id(key))) return false;
		if (
			type === "MP4" &&
			([
				"manifestId",
				"periodId",
				"adaptationSetId",
				"encodingId",
				"muxingId",
				...(encrypted ? ["drmId"] : []),
			].some((key) => !id(key)) ||
				typeof snapshot?.filePath !== "string" ||
				snapshot.filePath.length === 0)
		)
			return false;
		body = {
			typeDiscriminator: encrypted ? `DRM_${type}` : type,
			...pick(
				type === "VTT"
					? "vttUrl"
					: type === "SPRITE"
						? "segmentPath"
						: type === "PROGRESSIVE_WEBM"
							? "filePath"
							: type === "MP4"
								? "type filePath"
								: segment,
			),
			...bodyIds(
				"encodingId",
				"muxingId",
				"dependencyId",
				...(encrypted ? ["drmId"] : []),
				...(type === "SPRITE" ? ["streamId", "spriteId"] : []),
				...(["FMP4", "CMAF", "WEBM", "CHUNKED_TEXT"].includes(type)
					? ["startKeyframeId", "endKeyframeId"]
					: []),
			),
		};
	} else if (kind === "CREATE_DASH_CONTENT_PROTECTION") {
		const required = [
			"manifestId",
			"periodId",
			"adaptationSetId",
			"encodingId",
			"muxingId",
			"drmId",
			...(entry.payload.representationKind === "ADAPTATION_SET"
				? []
				: ["representationId"]),
		];
		if (required.some((key) => !id(key))) return false;
		if (
			entry.payload.representationKind !== undefined &&
			!["FMP4", "WEBM", "CMAF", "FMP4_DRM", "ADAPTATION_SET"].includes(
				String(entry.payload.representationKind),
			)
		)
			return false;
		body = {
			typeDiscriminator: "CONTENT_PROTECTION",
			...bodyIds("encodingId", "muxingId", "drmId", "dependencyId"),
		};
	} else if (
		[
			"CREATE_HLS_AUDIO_MEDIA",
			"CREATE_HLS_SUBTITLES_MEDIA",
			"CREATE_HLS_VIDEO_MEDIA",
			"CREATE_HLS_CLOSED_CAPTIONS_MEDIA",
			"CREATE_HLS_VTT_MEDIA",
		].includes(kind)
	) {
		if (
			[
				"manifestId",
				...(kind === "CREATE_HLS_VTT_MEDIA"
					? []
					: ["encodingId", "streamId", "muxingId"]),
				...(entry.refs.drmId !== undefined ? ["drmId"] : []),
			].some((key) => !id(key))
		)
			return false;
		body = {
			...pick(
				`${media} ${kind === "CREATE_HLS_VTT_MEDIA" ? "vttUrl uri" : kind === "CREATE_HLS_CLOSED_CAPTIONS_MEDIA" ? "segmentPath instreamId" : "segmentPath uri"}`,
			),
			...(kind === "CREATE_HLS_VTT_MEDIA"
				? {}
				: bodyIds("encodingId", "streamId", "muxingId", "drmId")),
		};
	} else if (kind === "CREATE_HLS_STREAM_INFO") {
		if (
			[
				"manifestId",
				"encodingId",
				"streamId",
				"muxingId",
				...(entry.refs.drmId !== undefined ? ["drmId"] : []),
			].some((key) => !id(key))
		)
			return false;
		body = {
			...pick(
				"audio audioGroups video subtitles closedCaptions segmentPath uri startSegmentNumber endSegmentNumber forceFrameRateAttribute forceVideoRangeAttribute",
			),
			...bodyIds("encodingId", "streamId", "muxingId", "drmId"),
		};
	} else if (kind === "CREATE_HLS_CUSTOM_TAG") {
		const required = [
			"manifestId",
			snapshot?.target === "MEDIA" ? "mediaId" : "streamInfoId",
			...(snapshot?.positionMode === "KEYFRAME" ? ["keyframeId"] : []),
		];
		if (required.some((key) => !id(key))) return false;
		body = {
			...pick("positionMode data time segment"),
			...bodyIds("keyframeId"),
		};
	} else return undefined;
	// Match SDK RestClient preparation without mutating persisted executor snapshots.
	const request: Body = JSON.parse(
		JSON.stringify(body, (_key, value) =>
			value == null || (Array.isArray(value) && value.length === 0)
				? undefined
				: value,
		),
	);
	return { request, refs };
}

function bag(value: unknown): Body | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Body)
		: undefined;
}
