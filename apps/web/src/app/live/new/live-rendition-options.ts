import type { LiveChannelPlanInput } from "@bitovp/core";
import { audioKeys, videoKeys } from "@/app/vod/new/build-plan";
import type { MessageKey } from "@/lib/i18n";
import type {
	LiveAudioRendition,
	LiveMuxingOptions,
	LiveVideoRendition,
	LiveWizardState,
} from "./build-live-plan";
import { liveMirrorEntries } from "./live-output-model";

/** Origin and MSL delivery use their own media naming/path contracts. */
export function liveStorageOptionsAvailable(state: LiveWizardState): boolean {
	return [
		state.output,
		...liveMirrorEntries(state).map((entry) => entry.output),
	].every(
		(output) =>
			output.kind !== "AKAMAI_MSL" && output.kind !== "LIVE_MEDIA_INGEST",
	);
}

function validSegmentName(value: string, template: boolean): boolean {
	const token = /\{(?:segment_)?rand_chars(?::[1-9]\d*)?\}/g;
	const literal = template ? value.replace(token, "random") : value;
	return (
		(value.includes("%number%") ||
			(template && /\{segment_rand_chars(?::[1-9]\d*)?\}/.test(value))) &&
		/^[A-Za-z0-9_.-]+$/.test(literal.replaceAll("%number%", "0")) &&
		!literal.includes("..")
	);
}

type Muxing = LiveChannelPlanInput["muxings"][number];

class LiveOptionsError extends Error {
	constructor(
		readonly messageKey: MessageKey,
		message: string,
	) {
		super(message);
	}
}

/** Validate optional form values without throwing during ordinary plan rendering. */
function assertLiveMuxingOptions(
	muxing: Muxing,
	options: LiveMuxingOptions | undefined,
	state: LiveWizardState,
): void {
	if (!options || !Object.values(options).some((value) => value !== undefined))
		return;
	if (!liveStorageOptionsAvailable(state))
		throw new LiveOptionsError(
			"liveRendition.storageRequired",
			"Custom media filenames and paths require storage outputs. Clear these settings before choosing MSL or Live Media Ingest.",
		);
	if (muxing.kind === "MP4")
		throw new LiveOptionsError(
			"liveRendition.ownContainerRequired",
			"Use the archive settings for progressive MP4.",
		);
	if (
		options.segmentNaming !== undefined &&
		options.segmentNamingTemplate !== undefined
	)
		throw new LiveOptionsError(
			"liveRendition.conflictingNaming",
			"Choose either segment naming or a segment naming template, not both.",
		);
	for (const field of ["segmentNaming", "segmentNamingTemplate"] as const) {
		const value = options[field];
		if (
			value !== undefined &&
			!validSegmentName(value, field === "segmentNamingTemplate")
		)
			throw new LiveOptionsError(
				"liveRendition.invalidSegmentName",
				"Use a flat segment filename with %number% (or a per-segment random template), without directory or URL characters.",
			);
	}
	if (options.initSegmentName !== undefined) {
		if (muxing.kind !== "FMP4")
			throw new LiveOptionsError(
				"liveRendition.initRequiresFmp4",
				"Custom init filenames here require an fMP4 container.",
			);
		if (
			!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(options.initSegmentName) ||
			options.initSegmentName.includes("..")
		)
			throw new LiveOptionsError(
				"liveRendition.invalidInitName",
				"Use a flat init filename without directory or URL characters.",
			);
	}
	if (
		options.path !== undefined &&
		(!options.path ||
			/[\\%?#]/.test(options.path) ||
			Array.from(options.path).some(
				(character) => character.charCodeAt(0) <= 32,
			) ||
			options.path.split("/").some((part) => part === "." || part === ".."))
	)
		throw new LiveOptionsError(
			"liveRendition.invalidOutputPath",
			"Use an output subdirectory without parent traversal, encoded paths, whitespace or URL characters.",
		);
}

/** Keep mapping total so incomplete form values remain editable. */
export function applyLiveMuxingOptions(
	muxing: Muxing,
	options: LiveMuxingOptions | undefined,
): Muxing {
	if (!options) return muxing;
	return {
		...muxing,
		...(options.segmentNaming !== undefined
			? { segmentNaming: options.segmentNaming }
			: {}),
		...(options.segmentNamingTemplate !== undefined
			? { segmentNamingTemplate: options.segmentNamingTemplate }
			: {}),
		...(muxing.kind === "FMP4" && options.initSegmentName !== undefined
			? { initSegmentName: options.initSegmentName }
			: {}),
		...(options.path !== undefined && muxing.destination
			? {
					destination: { ...muxing.destination, path: options.path },
				}
			: {}),
	};
}

/** Separate media folders also prevent dynamic segment patterns overlapping. */
export function assertLiveMuxingFolders(
	muxings: Muxing[],
	rows: (LiveAudioRendition | LiveVideoRendition)[],
): void {
	const normalize = (path: string) => path.split("/").filter(Boolean).join("/");
	const customPaths = new Set(
		rows.flatMap((row) =>
			row.muxing?.path !== undefined ? [normalize(row.muxing.path)] : [],
		),
	);
	const seen = new Set<string>();
	for (const muxing of muxings) {
		if (muxing.kind === "MP4" || !muxing.destination) continue;
		const path = normalize(muxing.destination.path);
		if (customPaths.has(path) && seen.has(path))
			throw new LiveOptionsError(
				"liveRendition.sharedFolder",
				"Give each Live media container a separate output folder; this custom path overlaps another rendition.",
			);
		seen.add(path);
	}
}

/** Options that do not fit the selected output/container block preview and submission. */
export function liveRenditionOptionsProblem(
	state: LiveWizardState,
	plan: LiveChannelPlanInput,
): { message: string; messageKey?: MessageKey } | undefined {
	try {
		for (const { rows, keys } of [
			{ rows: state.videos, keys: videoKeys(state.videos) },
			{ rows: state.audios, keys: audioKeys(state.audios) },
		])
			rows.forEach((row, index) => {
				if (
					!row.muxing ||
					!Object.values(row.muxing).some((value) => value !== undefined)
				)
					return;
				const muxing = plan.muxings.find(
					(entry) => entry.kind !== "MP4" && entry.streamKey === keys[index],
				);
				if (!muxing)
					throw new LiveOptionsError(
						"liveRendition.ownContainerRequired",
						"Custom audio media settings require its own container. Enable the standalone container or clear these settings.",
					);
				assertLiveMuxingOptions(muxing, row.muxing, state);
			});
		assertLiveMuxingFolders(plan.muxings, [...state.videos, ...state.audios]);
	} catch (error) {
		return error instanceof LiveOptionsError
			? { message: error.message, messageKey: error.messageKey }
			: { message: error instanceof Error ? error.message : String(error) };
	}
	return undefined;
}
