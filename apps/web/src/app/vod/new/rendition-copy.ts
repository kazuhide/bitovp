import {
	audioKeys,
	audioMuxingRelPath,
	subtitleKeys,
	videoKeys,
	videoMuxingRelPath,
	type WizardAudioRendition,
	type WizardMuxing,
	type WizardState,
	type WizardVideoRendition,
	wizardAudioLegs,
} from "./build-plan";
import { copiedHlsVideoUri } from "./hls-video-uri-copy";

/** Preserve nested codec/input/filter settings without sharing mutable objects. */
export function copyRendition<
	T extends { extras?: { key?: string; hlsVariantUri?: string } },
>(
	rendition: T,
	key: string,
	reservedUris: Iterable<string | undefined> = [],
	groups: Iterable<string> = [],
): T {
	const copy = structuredClone(rendition);
	copy.extras = { ...copy.extras, key };
	if (copy.extras.hlsVariantUri !== undefined)
		copy.extras.hlsVariantUri = copiedHlsVideoUri(
			copy.extras.hlsVariantUri,
			key,
			reservedUris,
			groups,
		);
	return copy;
}

function derivedOutputPaths(state: WizardState) {
	const vKeys = videoKeys(state.videos);
	const aKeys = audioKeys(state.audios);
	return new Map([
		...state.videos.map(
			(video, index) =>
				[vKeys[index], videoMuxingRelPath(video, vKeys[index] ?? "")] as const,
		),
		...state.audios.map(
			(audio, index) =>
				[aKeys[index], audioMuxingRelPath(audio, aKeys[index] ?? "")] as const,
		),
		...subtitleKeys(state.subtitles ?? []).map(
			(key) => [key, `subtitles/${key}`] as const,
		),
	]);
}

type ManagedPath = { path?: string; autoPath?: string };
type OutputPath = {
	path: string;
	row?: ManagedPath;
	videoIndex?: number;
	drmMuxingKey?: string;
};

const pathRoot = (path: string) => path.split("/").slice(0, 2).join("/");

/** Relative destinations emitted by the wizard, including non-video outputs. */
function outputPaths(state: WizardState): OutputPath[] {
	const derived = derivedOutputPaths(state);
	const paths: OutputPath[] = [];
	const drm = state.drm ?? [];
	const drmKeys = new Set(drm.map((row) => row.muxingKey));
	const vKeys = videoKeys(state.videos);
	const addLeg = (
		key: string,
		leg: WizardMuxing | undefined,
		videoIndex?: number,
		defaultKind: WizardMuxing["kind"] = "FMP4",
	) => {
		const kind = leg?.kind ?? defaultKind;
		if (
			leg?.path !== undefined ||
			!drmKeys.has(leg?.key ?? key) ||
			kind === "TEXT" ||
			kind === "CHUNKED_TEXT"
		) {
			paths.push({
				path: leg?.path ?? derived.get(key) ?? "",
				row: leg,
				videoIndex,
			});
		}
	};
	state.videos.forEach((video, index) => {
		const key = vKeys[index] ?? `v${video.height}`;
		for (const leg of [video.muxing, ...(video.extraMuxings ?? [])])
			addLeg(key, leg, index);
	});
	for (const { key, leg } of wizardAudioLegs(state)) addLeg(key, leg);
	const qcOnly = state.qc?.only && (state.qc.vmaf || state.qc.psnr);
	if (qcOnly) return paths;
	const sKeys = subtitleKeys(state.subtitles ?? []);
	state.subtitles?.forEach((subtitle, index) => {
		addLeg(
			sKeys[index] ?? "vtt",
			subtitle.muxing,
			undefined,
			subtitle.codec === "IMSC" ? "TEXT" : "CHUNKED_TEXT",
		);
	});
	for (const row of drm)
		paths.push({
			path: row.path ?? derived.get(row.muxingKey) ?? "",
			row,
			drmMuxingKey: row.muxingKey,
		});
	for (const row of [...(state.thumbnails ?? []), ...(state.sprites ?? [])])
		paths.push({ path: row.path ?? "" });
	if (state.startOptions?.aiSceneAnalysis)
		paths.push({ path: state.startOptions.aiSceneAnalysis.path });
	if (
		state.manifests.hls ||
		state.manifests.dash ||
		(state.manifests.extra?.length ?? 0) > 0
	)
		paths.push({ path: "" });
	return paths;
}

/** Freeze identities AND derived destinations before adding an identical rung. */
function prepareLadder(state: WizardState) {
	const vKeys = videoKeys(state.videos);
	const aKeys = audioKeys(state.audios);
	const derivedPaths = derivedOutputPaths(state);
	// buildPlan derives DRM destinations from the pre-edit rendition key.
	// Pin those paths too, so freezing a sibling cannot relocate its encrypted output.
	const drm = state.drm?.map((row) =>
		row.path !== undefined
			? row
			: {
					...row,
					path: derivedPaths.get(row.muxingKey) ?? "",
					...(vKeys.includes(row.muxingKey)
						? { autoPath: derivedPaths.get(row.muxingKey) }
						: {}),
				},
	);
	const reserved = new Set([
		...vKeys,
		...aKeys,
		...subtitleKeys(state.subtitles ?? []),
		...state.inputFiles.flatMap((file) => [file.key, file.inputKey]),
		"origin",
		...state.additionalOutputs.map((_, index) => `mirror-${index + 1}`),
		...(state.thumbnails ?? []).map((item) => item.key),
		...(state.sprites ?? []).map((item) => item.key),
		...(state.manifests.extra ?? []).map((manifest) => manifest.key),
		...Object.values(state.sources ?? {}).flatMap((collection) =>
			Array.isArray(collection)
				? collection.map((resource) => resource.key)
				: [],
		),
		...(state.filters ?? []).map((filter) => filter.key),
		...(state.drm ?? []).flatMap((row) => [
			row.key ?? `${row.muxingKey}-${row.kind.toLowerCase()}`,
			row.muxingKey,
		]),
	]);
	const paths = new Set(
		outputPaths(state).flatMap(({ path }) => [path, pathRoot(path)]),
	);
	const audioLegs = wizardAudioLegs(state);
	const freeze = <T extends WizardVideoRendition | WizardAudioRendition>(
		rendition: T,
		key: string,
		path: string,
		isAudio = false,
	): T => {
		const pinLeg = (leg: WizardMuxing | undefined, primary: boolean) => {
			const muxingKey = leg?.key ?? key;
			const drmOwned = state.drm?.some((row) => row.muxingKey === muxingKey);
			const emitted =
				!isAudio ||
				audioLegs.some(
					(item) =>
						item.key === key && item.primary === primary && item.leg === leg,
				);
			reserved.add(muxingKey);
			// Keep omitted outputs omitted: a path would opt bundled audio back
			// into standalone delivery or enable clear output beside its DRM.
			return drmOwned || !emitted || leg?.path !== undefined
				? leg
				: { ...leg, path, ...(!isAudio ? { autoPath: path } : {}) };
		};
		return {
			...rendition,
			extras: { ...rendition.extras, key },
			muxing: pinLeg(rendition.muxing, true),
			...(rendition.extraMuxings
				? {
						extraMuxings: rendition.extraMuxings.map(
							(leg) => pinLeg(leg, false) ?? leg,
						),
					}
				: {}),
		};
	};
	const videos = state.videos.map((video, index) => {
		const key = vKeys[index] ?? `v${index + 1}`;
		return {
			...freeze(video, key, videoMuxingRelPath(video, key)),
			autoKey:
				video.extras?.key === undefined || video.autoKey === video.extras.key
					? key
					: undefined,
		};
	});
	const audios = state.audios.map((audio, index) => {
		const key = aKeys[index] ?? `a${index + 1}`;
		return freeze(audio, key, audioMuxingRelPath(audio, key), true);
	});
	for (const subtitle of state.subtitles ?? []) {
		if (subtitle.muxing?.key !== undefined) reserved.add(subtitle.muxing.key);
	}
	const uris = new Set([
		state.manifests.hlsOptions?.audioMediaUri,
		...audios.map((audio) => audio.extras?.hlsMedia?.uri),
		...videos.map((video) => video.extras?.hlsMedia?.uri),
		...videos.map((video) => video.extras?.hlsVariantUri),
		...(state.subtitles ?? []).map((subtitle) => subtitle.uri),
		"stream.m3u8",
		...(state.manifests.extra ?? []).flatMap((manifest) =>
			manifest.kind === "HLS"
				? [manifest.manifestName, manifest.hls?.audioMediaUri]
				: [],
		),
	]);
	const groups = [
		...new Set(
			audios.flatMap((audio) =>
				audio.extras?.hlsMedia ? [audio.extras.hlsMedia.groupId] : [],
			),
		),
	];
	return { videos, audios, reserved, paths, uris, groups, drm };
}

function unique(base: string, taken: Set<string | undefined>): string {
	let key = base;
	for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
	taken.add(key);
	return key;
}

function duplicate<T extends WizardVideoRendition | WizardAudioRendition>(
	source: T,
	kind: "video" | "audio",
	context: ReturnType<typeof prepareLadder>,
	baseKey?: string,
): T {
	let base = baseKey ?? source.extras?.key;
	if (base === undefined) {
		let n = 1;
		const prefix = kind === "video" ? "v" : "a";
		while (context.reserved.has(`${prefix}${n}`)) n++;
		base = `${prefix}${n}`;
	}
	const key = unique(base, context.reserved);
	const copy = copyRendition(source, key, context.uris, context.groups);
	if (copy.extras?.hlsVariantUri) context.uris.add(copy.extras.hlsVariantUri);
	const path = unique(`${kind}/${key}`, context.paths);
	const sourcePath =
		kind === "video"
			? videoMuxingRelPath(
					source as WizardVideoRendition,
					source.extras?.key ?? key,
				)
			: audioMuxingRelPath(
					source as WizardAudioRendition,
					source.extras?.key ?? key,
				);
	const withPlaceholders = (base: string, original: string) => {
		const placeholders = [...new Set(original.match(/\{[^{}]+\}/g) ?? [])];
		return placeholders.length > 0
			? unique(`${base}/${placeholders.join("_")}`, context.paths)
			: base;
	};
	const muxing = (
		leg: WizardMuxing | undefined,
		index: number,
	): WizardMuxing => {
		const newKey =
			index === 0 ? key : unique(`${key}-mux${index + 1}`, context.reserved);
		const legPath =
			index === 0
				? path
				: unique(
						`${path}/${(leg?.kind ?? "FMP4").toLowerCase()}-${index + 1}`,
						context.paths,
					);
		const newPath = withPlaceholders(legPath, leg?.path ?? sourcePath);
		const bound = (context.drm ?? []).filter(
			(row) => row.muxingKey === (leg?.key ?? source.extras?.key),
		);
		for (const row of bound) {
			const drmPath = withPlaceholders(
				unique(`${legPath}/${row.kind.toLowerCase()}`, context.paths),
				row.path ?? sourcePath,
			);
			context.drm?.push({
				...structuredClone(row),
				key: unique(`${newKey}-${row.kind.toLowerCase()}`, context.reserved),
				muxingKey: newKey,
				path: drmPath,
				autoPath: kind === "video" ? drmPath : undefined,
			});
		}
		const copyLeg: WizardMuxing = {
			...leg,
			key: newKey,
			path: newPath,
			autoPath: kind === "video" ? newPath : undefined,
		};
		// Retain the source's intentional clear-output policy. Otherwise only DRM
		// receives an output; an explicit muxing path would override drmOwned.
		if (bound.length > 0 && leg?.path === undefined) {
			delete copyLeg.path;
			delete copyLeg.autoPath;
		}
		return copyLeg;
	};
	copy.muxing = muxing(copy.muxing, 0);
	if (copy.extraMuxings)
		copy.extraMuxings = copy.extraMuxings.map((leg, index) =>
			muxing(leg, index + 1),
		);
	if (copy.extras?.hlsMedia) {
		const uri = copy.extras.hlsMedia.uri;
		const dot = uri.lastIndexOf(".");
		const hasExtension = dot > uri.lastIndexOf("/");
		const stem = `${hasExtension ? uri.slice(0, dot) : uri}-${key}`;
		const extension = hasExtension ? uri.slice(dot) : "";
		let candidate = `${stem}${extension}`;
		for (let n = 2; context.uris.has(candidate); n++)
			candidate = `${stem}-${n}${extension}`;
		copy.extras.hlsMedia.uri = candidate;
		// Keep the existing group's default track, rather than declaring two defaults.
		if (copy.extras.hlsMedia.isDefault) copy.extras.hlsMedia.isDefault = false;
	}
	return copy;
}

export function addVodVideo(
	state: WizardState,
	sourceIndex?: number,
): Pick<WizardState, "videos" | "audios" | "drm"> {
	const context = prepareLadder(state);
	const source: WizardVideoRendition = context.videos[sourceIndex ?? -1] ?? {
		height: 720,
		bitrate: 1_500_000,
	};
	const automatic =
		source.extras?.key === undefined ||
		source.autoKey === source.extras.key ||
		(source.height !== null &&
			isDerivedName(source.extras.key, `v${source.height}`));
	const copy = duplicate(
		source,
		"video",
		context,
		automatic && source.extras?.key !== undefined
			? source.height === null
				? `video${context.videos.length + 1}`
				: `v${source.height}`
			: undefined,
	);
	copy.autoKey = automatic ? copy.extras?.key : undefined;
	return {
		videos: [...context.videos, copy],
		audios: context.audios,
		drm: context.drm,
	};
}

export function addVodAudio(
	state: WizardState,
	sourceIndex?: number,
): Pick<WizardState, "videos" | "audios" | "drm"> {
	const context = prepareLadder(state);
	const source = context.audios[sourceIndex ?? -1] ?? {
		bitrate: 128_000,
		rate: 48_000,
	};
	return {
		videos: context.videos,
		audios: [...context.audios, duplicate(source, "audio", context)],
		drm: context.drm,
	};
}

function isDerivedName(key: string | undefined, base: string): boolean {
	if (key === base) return true;
	if (!key?.startsWith(`${base}-`)) return false;
	const suffix = key.slice(base.length + 1);
	return /^\d+$/.test(suffix) && Number(suffix) >= 2;
}

/** Keep only editor-owned destinations in sync when a stream changes mode. */
export function updateVodVideoModePaths(
	state: WizardState,
	next: WizardVideoRendition[],
): Pick<WizardState, "videos"> & Partial<Pick<WizardState, "drm">> {
	if (state.videos.length !== next.length) return { videos: next };
	const oldKeys = videoKeys(state.videos);
	const keys = videoKeys(next);
	const destinations = outputPaths({ ...state, videos: next });
	const allocated = new Set<string>();
	let drm = state.drm;
	const videos = next.map((video, index) => {
		const current = state.videos[index];
		if (!current) return video;
		const wasPerTitle = current.extras?.mode?.startsWith("PER_TITLE") ?? false;
		const perTitle = video.extras?.mode?.startsWith("PER_TITLE") ?? false;
		if (wasPerTitle === perTitle) return video;
		const key = keys[index] ?? "";
		const previousDefault = videoMuxingRelPath(current, oldKeys[index] ?? "");
		const templateLeaf = videoMuxingRelPath(
			{ ...video, extras: { ...video.extras, mode: "PER_TITLE_TEMPLATE" } },
			key,
		)
			.split("/")
			.slice(2)
			.join("/");
		// Copies made before mode editing retained the tokens without the "p".
		const leaves = [
			templateLeaf,
			(templateLeaf.match(/\{[^{}]+\}/g) ?? []).join("_"),
		];
		const ownedSuffix = (row?: ManagedPath) =>
			row?.path !== undefined && row.path === row.autoPath
				? leaves.find((leaf) => row.path?.endsWith(`/${leaf}`))
				: undefined;
		const muxingKeys = new Set(
			[current.muxing, ...(current.extraMuxings ?? [])].map(
				(leg) => leg?.key ?? oldKeys[index],
			),
		);
		const occupied = new Set(allocated);
		for (const destination of destinations) {
			const selected =
				destination.videoIndex === index ||
				(destination.drmMuxingKey !== undefined &&
					muxingKeys.has(destination.drmMuxingKey));
			const row = destination.row;
			const moving =
				selected &&
				row?.path !== undefined &&
				row.path === row.autoPath &&
				(perTitle
					? ownedSuffix(row) === undefined
					: ownedSuffix(row) !== undefined);
			// Release only owned paths that this transition will move.
			if (!moving) occupied.add(pathRoot(destination.path));
		}
		const roots = new Map<string, string>();
		const updatePath = <T extends ManagedPath>(row: T): T => {
			if (row.path === undefined || row.path !== row.autoPath) return row;
			const suffix = ownedSuffix(row);
			if (perTitle ? suffix !== undefined : suffix === undefined) return row;
			const base = perTitle
				? row.path
				: row.path.slice(0, -((suffix?.length ?? 0) + 1));
			const currentRoot = pathRoot(base);
			const proposed =
				perTitle && base === previousDefault ? `video/${key}` : currentRoot;
			const root = roots.get(currentRoot) ?? unique(proposed, occupied);
			roots.set(currentRoot, root);
			allocated.add(root);
			const path = [
				root,
				...base.split("/").slice(2),
				...(perTitle ? [templateLeaf] : []),
			].join("/");
			return { ...row, path, autoPath: path };
		};
		drm = drm?.map((row) =>
			muxingKeys.has(row.muxingKey) ? updatePath(row) : row,
		);
		return {
			...video,
			...(video.muxing ? { muxing: updatePath(video.muxing) } : {}),
			...(video.extraMuxings
				? { extraMuxings: video.extraMuxings.map(updatePath) }
				: {}),
		};
	});
	return { videos, ...(drm !== state.drm ? { drm } : {}) };
}

/** Rename an editor-owned height key and its references in one wizard patch. */
export function updateVodVideoHeight(
	state: WizardState,
	index: number,
	height: number | null,
): Partial<WizardState> {
	const current = state.videos[index];
	if (!current) return {};
	if (
		current.height === height ||
		(current.extras?.key !== undefined &&
			current.autoKey !== current.extras.key)
	)
		return {
			videos: state.videos.map((video, i) =>
				i === index ? { ...video, height } : video,
			),
		};
	const context = prepareLadder(state);
	const video = context.videos[index];
	const oldKey = video?.extras?.key;
	if (!video || oldKey === undefined) return {};
	const generatedLegs = [video.muxing, ...(video.extraMuxings ?? [])].map(
		(leg, i) =>
			leg?.key === undefined ||
			(i === 0
				? leg.key === oldKey
				: isDerivedName(leg.key, `${oldKey}-mux${i + 1}`)),
	);
	context.reserved.delete(oldKey);
	for (const [i, leg] of [
		video.muxing,
		...(video.extraMuxings ?? []),
	].entries())
		if (generatedLegs[i] && leg?.key !== undefined)
			context.reserved.delete(leg.key);
	const key = unique(
		height === null ? `video${index + 1}` : `v${height}`,
		context.reserved,
	);
	const muxingKeys = new Map<string, string>();
	// All destinations under a root occupy it, including custom and DRM paths.
	const nextPathRoot = unique(
		`video/${key}`,
		new Set([...context.paths].map(pathRoot)),
	);
	const renamePath = <T extends { path?: string; autoPath?: string }>(
		row: T,
	): T => {
		if (row.path === undefined || row.path !== row.autoPath) return row;
		const suffix = row.path.split("/").slice(2);
		const path = [nextPathRoot, ...suffix].join("/");
		return { ...row, path, autoPath: path };
	};
	const selectedMuxingKeys = new Set(
		[video.muxing, ...(video.extraMuxings ?? [])].map(
			(leg) => leg?.key ?? oldKey,
		),
	);
	const renameLeg = (leg: WizardMuxing | undefined, i: number) => {
		const next = leg === undefined ? leg : renamePath(leg);
		if (!generatedLegs[i]) return next;
		const nextKey =
			i === 0 ? key : unique(`${key}-mux${i + 1}`, context.reserved);
		muxingKeys.set(leg?.key ?? oldKey, nextKey);
		return { ...next, key: nextKey };
	};
	context.videos[index] = {
		...video,
		height,
		extras: { ...video.extras, key },
		autoKey: key,
		muxing: renameLeg(video.muxing, 0),
		...(video.extraMuxings
			? {
					extraMuxings: video.extraMuxings.map(
						(leg, i) => renameLeg(leg, i + 1) ?? leg,
					),
				}
			: {}),
	};
	const drm = context.drm?.map((row) => {
		const next = selectedMuxingKeys.has(row.muxingKey) ? renamePath(row) : row;
		const muxingKey = muxingKeys.get(row.muxingKey);
		if (muxingKey === undefined) return next;
		const base = `${row.muxingKey}-${row.kind.toLowerCase()}`;
		const automatic = row.key === undefined || isDerivedName(row.key, base);
		if (automatic && row.key !== undefined) context.reserved.delete(row.key);
		return {
			...next,
			muxingKey,
			...(automatic
				? {
						key: unique(
							`${muxingKey}-${row.kind.toLowerCase()}`,
							context.reserved,
						),
					}
				: {}),
		};
	});
	const remap = (value: string) => (value === oldKey ? key : value);
	return {
		videos: context.videos,
		audios: context.audios,
		...(drm ? { drm } : {}),
		...(state.thumbnails
			? {
					thumbnails: state.thumbnails.map((row) => ({
						...row,
						streamKey: remap(row.streamKey),
					})),
				}
			: {}),
		...(state.sprites
			? {
					sprites: state.sprites.map((row) => ({
						...row,
						streamKey: remap(row.streamKey),
					})),
				}
			: {}),
		...(state.qc?.gate
			? {
					qc: {
						...state.qc,
						gate: {
							...state.qc.gate,
							rules: state.qc.gate.rules.map((rule) => ({
								...rule,
								...(rule.renditions
									? { renditions: rule.renditions.map(remap) }
									: {}),
							})),
						},
					},
				}
			: {}),
	};
}
