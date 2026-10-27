import type { CompiledOperation } from "./compiler";
import { defaultManifestSelection } from "./default-manifest-selection";
import type { HlsCustomTag } from "./manifest-options";
import { AUDIO_CODECS, type EncodingPlan } from "./schema";

export type ManifestDetailContext = Pick<
	EncodingPlan,
	"renditions" | "muxings" | "drm" | "sprites" | "encodings"
>;

type DashManifest = Extract<
	EncodingPlan["manifests"][number],
	{ kind: "DASH" }
>;
export type DetailedManifest =
	| Exclude<EncodingPlan["manifests"][number], { kind: "DASH" }>
	| (Omit<DashManifest, "drmKind"> & {
			drmKind?: "CENC" | "FAIRPLAY" | "SPEKE";
	  });

/** Extends the existing automatic trees without changing their default shape. */
export function applyManifestDetails(
	plan: ManifestDetailContext,
	manifest: DetailedManifest,
	operations: CompiledOperation[],
	encodingStepFor: (renditionKey: string) => string,
): CompiledOperation[] {
	if (manifest.kind === "SMOOTH") return operations;
	const root = operations[0];
	if (!root) return operations;
	const d = manifest.detailed;
	if (manifest.generationMode === "DEFAULT") {
		const encoding = defaultManifestSelection(plan).renditions[0];
		return [
			{
				...root,
				payload: {
					...root.payload,
					generationMode: "DEFAULT",
					...(manifest.kind === "HLS"
						? {
								channelsAttributeForAudio:
									manifest.detailed?.channelsAttributeForAudio,
								targetDurationRoundingMode:
									manifest.detailed?.targetDurationRoundingMode,
							}
						: {
								...dashGlobals(manifest.detailed),
								version: "V2",
								...(manifest.defaultPeriods
									? {
											periods: manifest.defaultPeriods.map((period) => ({
												adaptationSets: period.adaptationSets,
											})),
										}
									: {}),
							}),
				},
				refs: {
					...root.refs,
					...(manifest.kind === "DASH" && manifest.defaultPeriods
						? Object.fromEntries(
								manifest.defaultPeriods.map((period, index) => [
									`periodEncodingIds:${index}`,
									period.encodingKeys.map((key) =>
										key === "default" && !plan.encodings?.length
											? "encoding"
											: `encoding:${key}`,
									),
								]),
							)
						: {
								encodingId: encoding
									? encodingStepFor(encoding.key)
									: "encoding",
							}),
				},
			},
		];
	}
	if (
		!d &&
		!(
			manifest.kind === "DASH" &&
			manifest.adaptationSets?.some(
				(set) =>
					set.roles ||
					set.labels ||
					set.accessibilities ||
					set.customAttributes,
			)
		)
	)
		return operations;
	const progressive = new Set(
		manifest.kind === "DASH"
			? (manifest.detailed?.additionalRepresentations ?? [])
					.filter((rep) => rep.type === "PROGRESSIVE_WEBM")
					.map((rep) => rep.muxingKey)
			: [],
	);
	const ops = operations
		.filter(
			(op) =>
				!(
					op.kind.startsWith("CREATE_DASH_REPRESENTATION_") &&
					typeof op.refs.muxingId === "string" &&
					progressive.has(op.refs.muxingId.replace(/^muxing:/, ""))
				),
		)
		.map((op) => ({ ...op, payload: { ...op.payload }, refs: { ...op.refs } }));
	if (manifest.kind === "HLS") {
		const detail = manifest.detailed;
		if (!detail) return ops;
		Object.assign(rootPayload(ops), {
			...(detail.channelsAttributeForAudio
				? { channelsAttributeForAudio: detail.channelsAttributeForAudio }
				: {}),
			...(detail.targetDurationRoundingMode
				? { targetDurationRoundingMode: detail.targetDurationRoundingMode }
				: {}),
		});
		for (const op of ops) {
			if (op.kind === "CREATE_HLS_AUDIO_MEDIA")
				Object.assign(op.payload, detail.audioMedia);
			if (op.kind === "CREATE_HLS_SUBTITLES_MEDIA")
				Object.assign(op.payload, detail.subtitleMedia);
			if (
				op.kind === "CREATE_HLS_STREAM_INFO" ||
				op.kind === "CREATE_HLS_PER_TITLE_VARIANTS"
			) {
				Object.assign(op.payload, detail.streams);
				if (detail.streams?.audioGroups) delete op.payload.audio;
				if (!op.payload.subtitles) {
					const subtitle = detail.additionalMedia?.find(
						(m) => m.type === "VTT",
					);
					if (subtitle) op.payload.subtitles = subtitle.groupId;
				}
			}
		}
		const {
			startSegmentNumber: _subtitleStart,
			endSegmentNumber: _subtitleEnd,
			...externalSubtitleAttributes
		} = detail.subtitleMedia ?? {};
		for (const [index, media] of (detail.additionalMedia ?? []).entries()) {
			const { type, customTags, ...fields } = media;
			const step = `hls-media:${manifest.key}:additional-${index}`;
			const refs: CompiledOperation["refs"] = { manifestId: root.step };
			const payload: Record<string, unknown> = {
				...(type === "VTT" ? externalSubtitleAttributes : {}),
				...fields,
			};
			if (type !== "VTT") {
				const muxing = plan.muxings.find((m) => m.key === media.muxingKey);
				if (!muxing)
					throw new Error(`Unknown HLS media muxing ${media.muxingKey}`);
				const drm = media.drmKey
					? plan.drm.find((drm) => drm.key === media.drmKey)
					: manifest.drmKind
						? plan.drm.find(
								(drm) =>
									drm.muxingKey === media.muxingKey &&
									drm.kind === manifest.drmKind,
							)
						: undefined;
				Object.assign(refs, {
					encodingId: encodingStepFor(muxing.streamKey),
					muxingId: `muxing:${muxing.key}`,
					streamId: `stream:${muxing.streamKey}`,
					...(drm ? { drmId: `drm:${drm.key}` } : {}),
				});
				payload.segmentPath = relativeDirectory(
					drm?.destination.path ?? muxing.destination?.path ?? "",
					manifest.destination.path,
				);
				delete payload.muxingKey;
				delete payload.drmKey;
			}
			ops.push({
				step,
				kind:
					type === "VIDEO"
						? "CREATE_HLS_VIDEO_MEDIA"
						: type === "VTT"
							? "CREATE_HLS_VTT_MEDIA"
							: "CREATE_HLS_CLOSED_CAPTIONS_MEDIA",
				payload,
				refs,
			});
			appendTags(
				ops,
				manifest.key,
				step,
				root.step,
				"MEDIA",
				customTags ?? [],
				"entry",
			);
		}
		for (const op of [...ops]) {
			if (
				op.kind === "CREATE_HLS_AUDIO_MEDIA" ||
				op.kind === "CREATE_HLS_SUBTITLES_MEDIA" ||
				op.kind === "CREATE_HLS_VTT_MEDIA" ||
				op.kind === "CREATE_HLS_VIDEO_MEDIA" ||
				op.kind === "CREATE_HLS_CLOSED_CAPTIONS_MEDIA"
			)
				appendTags(
					ops,
					manifest.key,
					op.step,
					root.step,
					"MEDIA",
					detail.mediaCustomTags ?? [],
				);
			if (op.kind === "CREATE_HLS_STREAM_INFO")
				appendTags(
					ops,
					manifest.key,
					op.step,
					root.step,
					"STREAM",
					detail.streamCustomTags ?? [],
				);
			if (
				op.kind === "CREATE_HLS_PER_TITLE_VARIANTS" &&
				detail.streamCustomTags?.length
			) {
				op.payload.customTags = detail.streamCustomTags.map(
					({ ...tag }) => tag,
				);
				for (const [index, tag] of detail.streamCustomTags.entries())
					if (tag.positionMode === "KEYFRAME")
						op.refs[`customTagKeyframeId:${index}`] =
							`keyframe:${tag.keyframeKey}`;
			}
		}
		return ops;
	}
	const detail = manifest.detailed;
	Object.assign(rootPayload(ops), dashGlobals(detail));
	const period = ops.find((op) => op.kind === "CREATE_DASH_PERIOD");
	if (period && detail?.period) {
		const { customXmlElements, ...fields } = detail.period;
		Object.assign(period.payload, fields);
		for (const [index, data] of (customXmlElements ?? []).entries())
			ops.push({
				step: `${period.step}:xml:${index}`,
				kind: "CREATE_DASH_PERIOD_XML",
				payload: { data },
				refs: { manifestId: root.step, periodId: period.step },
			});
	}
	for (const op of ops) {
		const type =
			op.kind === "CREATE_DASH_ADAPTATION_SET_VIDEO"
				? "videoAdaptationSet"
				: op.kind === "CREATE_DASH_ADAPTATION_SET_AUDIO"
					? "audioAdaptationSet"
					: op.kind === "CREATE_DASH_ADAPTATION_SET_SUBTITLE"
						? "subtitleAdaptationSet"
						: undefined;
		if (type) {
			Object.assign(op.payload, detail?.[type]);
			const explicit = manifest.adaptationSets?.find(
				(set) => op.step === `${root.step}:aset-${set.key}`,
			);
			if (explicit) {
				const { key: _key, type: _type, label: _label, ...attrs } = explicit;
				Object.assign(op.payload, attrs);
			}
		}
		const muxingRef = op.refs.muxingId;
		if (
			typeof muxingRef !== "string" ||
			!op.kind.startsWith("CREATE_DASH_REPRESENTATION_")
		)
			continue;
		const selected = detail?.representations?.find(
			(r) => muxingRef === `muxing:${r.muxingKey}`,
		);
		if (!selected) continue;
		const {
			muxingKey: _muxingKey,
			dependencyMuxingKey,
			startKeyframeKey,
			endKeyframeKey,
			contentProtection,
			drmRepresentation,
			...values
		} = selected;
		Object.assign(op.payload, values);
		if (startKeyframeKey)
			op.refs.startKeyframeId = `keyframe:${startKeyframeKey}`;
		if (endKeyframeKey) op.refs.endKeyframeId = `keyframe:${endKeyframeKey}`;
		if (dependencyMuxingKey)
			op.refs.dependencyId = `${root.step}:rep:${dependencyMuxingKey}`;
		if (drmRepresentation) {
			const drm = plan.drm.find(
				(d) =>
					`muxing:${d.muxingKey}` === muxingRef &&
					(!manifest.drmKind || d.kind === manifest.drmKind),
			);
			if (drm) {
				op.refs.drmId = `drm:${drm.key}`;
				op.payload.segmentPath = relativeDirectory(
					drm.destination.path,
					manifest.destination.path,
				);
			}
		}
		let protection = ops.find(
			(child) =>
				child.kind === "CREATE_DASH_CONTENT_PROTECTION" &&
				child.refs.representationId === op.step,
		);
		if (!protection && drmRepresentation && op.refs.drmId) {
			protection = {
				step: `${op.step}:drm`,
				kind: "CREATE_DASH_CONTENT_PROTECTION",
				payload: {},
				refs: {
					...Object.fromEntries(
						[
							"manifestId",
							"periodId",
							"adaptationSetId",
							"encodingId",
							"muxingId",
							"drmId",
						].flatMap((key) => (op.refs[key] ? [[key, op.refs[key]]] : [])),
					),
					representationId: op.step,
				},
			};
			ops.push(protection);
		}
		if (protection) {
			if (dependencyMuxingKey)
				protection.refs.dependencyId = `${root.step}:rep:${dependencyMuxingKey}`;
			if (contentProtection === "ADAPTATION_SET") {
				delete protection.refs.representationId;
				protection.payload.representationKind = "ADAPTATION_SET";
			} else if (op.kind === "CREATE_DASH_REPRESENTATION_CMAF")
				protection.payload.representationKind = "CMAF";
			else if (drmRepresentation)
				protection.payload.representationKind = "FMP4_DRM";
		}
	}
	for (const [index, representation] of (
		detail?.additionalRepresentations ?? []
	).entries()) {
		const setStep = `${root.step}:additional-aset:${index}`;
		const { type, ...fields } = representation;
		const payload: Record<string, unknown> = { ...fields };
		let audio = false;
		const refs: CompiledOperation["refs"] = {
			manifestId: root.step,
			periodId: period?.step ?? `${root.step}:period`,
			adaptationSetId: setStep,
		};
		const attrs = {
			...(type === "VTT" ? detail?.subtitleAdaptationSet : {}),
			...Object.fromEntries(
				["labels", "roles", "customAttributes", "accessibilities"]
					.filter((key) => key in fields)
					.map((key) => [key, payload[key]]),
			),
		};
		for (const key of Object.keys(attrs)) delete payload[key];
		if (type === "SPRITE") {
			const sprite = plan.sprites.find(
				(s) => s.key === representation.spriteKey,
			);
			if (!sprite)
				throw new Error(`Unknown sprite ${representation.spriteKey}`);
			Object.assign(refs, {
				encodingId: encodingStepFor(sprite.streamKey),
				streamId: `stream:${sprite.streamKey}`,
				spriteId: `sprite:${sprite.key}`,
			});
			payload.segmentPath = relativeDirectory(
				sprite.destination.path,
				manifest.destination.path,
			);
			delete payload.spriteKey;
		} else if (type === "PROGRESSIVE_WEBM") {
			const muxing = plan.muxings.find(
				(m) => m.key === representation.muxingKey,
			);
			if (muxing?.kind !== "WEBM" || !muxing.progressive)
				throw new Error(
					"Progressive WebM representation needs a progressive WebM muxing",
				);
			audio = AUDIO_CODECS.has(
				plan.renditions.find((r) => r.key === muxing.streamKey)?.codec ?? "",
			);
			Object.assign(refs, {
				encodingId: encodingStepFor(muxing.streamKey),
				muxingId: `muxing:${muxing.key}`,
				...(representation.dependencyMuxingKey
					? {
							dependencyId: `${root.step}:rep:${representation.dependencyMuxingKey}`,
						}
					: {}),
			});
			payload.filePath = relativePath(
				`${(muxing.destination?.path ?? "").replace(/\/$/, "")}/${muxing.filename ?? "output.webm"}`,
				manifest.destination.path,
			);
			delete payload.muxingKey;
			delete payload.dependencyMuxingKey;
		}
		ops.push({
			step: setStep,
			kind:
				type === "SPRITE"
					? "CREATE_DASH_ADAPTATION_SET_IMAGE"
					: type === "VTT"
						? "CREATE_DASH_ADAPTATION_SET_SUBTITLE"
						: audio
							? "CREATE_DASH_ADAPTATION_SET_AUDIO"
							: "CREATE_DASH_ADAPTATION_SET_VIDEO",
			payload: {
				...attrs,
				...(type === "VTT"
					? { lang: representation.lang }
					: audio
						? { lang: manifest.audioLanguage }
						: {}),
			},
			refs: {
				manifestId: root.step,
				periodId: refs.periodId ?? `${root.step}:period`,
			},
		});
		delete payload.lang;
		ops.push({
			step: `${root.step}:additional-rep:${index}`,
			kind:
				type === "SPRITE"
					? "CREATE_DASH_REPRESENTATION_SPRITE"
					: type === "VTT"
						? "CREATE_DASH_REPRESENTATION_VTT"
						: "CREATE_DASH_REPRESENTATION_PROGRESSIVE_WEBM",
			payload,
			refs,
		});
	}
	// Dependencies can point to a later row; retain a stable topological order.
	return orderDependencies(ops);
}

function dashGlobals(
	detail: Extract<
		EncodingPlan["manifests"][number],
		{ kind: "DASH" }
	>["detailed"],
): Record<string, unknown> {
	if (!detail) return {};
	return Object.fromEntries(
		[
			"dashEditionCompatibility",
			"iso8601TimestampFormat",
			"minBufferTime",
			"namespaces",
			"utcTimings",
		]
			.filter((key) => detail[key as keyof typeof detail] !== undefined)
			.map((key) => [key, detail[key as keyof typeof detail]]),
	);
}
function relativePath(path: string, base: string): string {
	const a = path
		.replace(/^\/+|\/+$/g, "")
		.split("/")
		.filter(Boolean);
	const b = base
		.replace(/^\/+|\/+$/g, "")
		.split("/")
		.filter(Boolean);
	while (a.length && b.length && a[0] === b[0]) {
		a.shift();
		b.shift();
	}
	return [...b.map(() => ".."), ...a].join("/");
}
function appendTags(
	ops: CompiledOperation[],
	manifestKey: string,
	parent: string,
	manifestStep: string,
	target: "MEDIA" | "STREAM",
	tags: HlsCustomTag[],
	scope = "shared",
) {
	for (const [index, tag] of tags.entries()) {
		const { positionMode, data } = tag;
		ops.push({
			step: `hls-tag:${manifestKey}:${parent}:${scope}:${index}`,
			kind: "CREATE_HLS_CUSTOM_TAG",
			payload: {
				target,
				positionMode,
				data,
				...(positionMode === "TIME"
					? { time: tag.time }
					: positionMode === "SEGMENT"
						? { segment: tag.segment }
						: {}),
			},
			refs: {
				manifestId: manifestStep,
				[target === "MEDIA" ? "mediaId" : "streamInfoId"]: parent,
				...(positionMode === "KEYFRAME"
					? { keyframeId: `keyframe:${tag.keyframeKey}` }
					: {}),
			},
		});
	}
}
function orderDependencies(ops: CompiledOperation[]): CompiledOperation[] {
	const owned = new Set(ops.map((op) => op.step));
	const done = new Set<string>();
	const pending = [...ops];
	const sorted: CompiledOperation[] = [];
	while (pending.length) {
		const index = pending.findIndex((op) =>
			Object.values(op.refs)
				.flat()
				.every((ref) => !owned.has(ref) || done.has(ref)),
		);
		if (index < 0)
			throw new Error("Manifest representation dependencies contain a cycle");
		const next = pending.splice(index, 1)[0];
		if (next) {
			sorted.push(next);
			done.add(next.step);
		}
	}
	return sorted;
}

function rootPayload(ops: CompiledOperation[]): Record<string, unknown> {
	const root = ops[0];
	if (!root) throw new Error("Missing manifest root");
	return root.payload;
}

function relativeDirectory(path: string, base: string): string {
	const value = relativePath(path, base);
	return value ? `${value}/` : "";
}
