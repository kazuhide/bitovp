import { muxingKindCarriesAudio } from "@bitovp/core";
import { audioKeys, type WizardMuxing, type WizardState } from "./build-plan";

type Audio = WizardState["audios"][number];

const sameRow = (one: Audio | undefined, other: Audio) =>
	one === other || JSON.stringify(one) === JSON.stringify(other);

/**
 * A video container names the audio it carries by key, and a derived key follows the
 * bitrate. Without this, editing an audio bitrate left the old key in the container:
 * the track dropped out of the file and came back as a container of its own.
 *
 * The name a row's containers use follows the row's key for as long as that key is
 * the row's alone. While it is not, they keep the name they have, and the row
 * remembers it (`carriedAs`) until its key is its own again. Two bitrates pass through
 * one key while one is being typed (64 kbps on the way to 640), and two rows can be
 * left equal for a while; renaming the containers to the key both rows have would
 * leave nothing to tell, once the keys part, which row a container meant. A plan in
 * that state is refused for the key it names twice, so a file is never started
 * without the track it is waiting for.
 *
 * Which row is which is known for an edit of one row. A reorder, an added and a
 * removed row change which track a key means, and are left alone — apart from a row
 * that is waiting for its key, which gets it as soon as it is free, whatever freed
 * it. A key that two rows were already known by says nothing, and is not followed.
 */
export function followRenamedAudioKeys(
	previous: Pick<WizardState, "audios">,
	next: Pick<WizardState, "videos" | "audios">,
): Pick<WizardState, "videos" | "audios"> {
	if (previous.audios === next.audios) return next;
	const after = audioKeys(next.audios);
	const before = audioKeys(previous.audios);
	const edited =
		previous.audios.length === next.audios.length
			? next.audios.filter(
					(audio, index) => !sameRow(previous.audios[index], audio),
				).length
			: Number.POSITIVE_INFINITY;
	// The name each row's containers use as the edit arrives.
	const names = next.audios.map((audio, index) =>
		edited <= 1
			? (previous.audios[index]?.carriedAs ?? before[index])
			: (audio.carriedAs ?? after[index]),
	);
	const alone = (keys: readonly (string | undefined)[], key: string) =>
		keys.indexOf(key) === keys.lastIndexOf(key);
	// A row waits while another row has its key, or is still known by it.
	const waiting = after.map((key) => !alone(after, key));
	for (let settled = false; !settled; ) {
		settled = true;
		for (const [index, key] of after.entries()) {
			if (
				!waiting[index] &&
				names.some((name, at) => at !== index && waiting[at] && name === key)
			) {
				waiting[index] = true;
				settled = false;
			}
		}
	}
	const renamed = new Map<string, string>();
	const audios = next.audios.map((audio, index) => {
		const name = names[index];
		const key = after[index];
		const held = waiting[index] && name !== key ? name : undefined;
		if (!waiting[index] && name !== undefined && key !== undefined)
			if (name !== key && alone(names, name)) renamed.set(name, key);
		if (audio.carriedAs === held) return audio;
		const { carriedAs: _released, ...row } = audio;
		return held === undefined ? row : { ...row, carriedAs: held };
	});
	const changed = audios.some((audio, index) => audio !== next.audios[index]);
	if (renamed.size === 0)
		return changed ? { videos: next.videos, audios } : next;
	const follow = (leg: WizardMuxing): WizardMuxing =>
		leg.muxedAudioKeys?.some((key) => renamed.has(key))
			? {
					...leg,
					muxedAudioKeys: leg.muxedAudioKeys.map(
						(key) => renamed.get(key) ?? key,
					),
				}
			: leg;
	return {
		audios: changed ? audios : next.audios,
		videos: next.videos.map((video) => ({
			...video,
			...(video.muxing ? { muxing: follow(video.muxing) } : {}),
			...(video.extraMuxings
				? { extraMuxings: video.extraMuxings.map((leg) => follow(leg)) }
				: {}),
		})),
	};
}

/** Keep automatic packaging defaults safe across edits in every wizard step. */
export function reconcileAutomaticAudioPackaging(
	state: WizardState,
): WizardState["audios"] {
	const keys = audioKeys(state.audios);
	return state.audios.map((audio, index) => {
		const key = keys[index];
		// What the video containers call this track: its key, or the name it had
		// before another row took the same key. Asked by the key, a track that
		// waits is carried by nothing, and would be given a container of its own.
		const name = audio.carriedAs ?? key;
		const { ownContainer, autoOwnContainer, ...options } = audio.muxing ?? {};
		const explicitOutput =
			Object.values(options).some((value) => value !== undefined) ||
			Boolean(audio.extraMuxings?.length || audio.extras?.hlsMedia) ||
			state.drm?.some((row) => row.muxingKey === (audio.muxing?.key ?? key));
		const covered =
			name !== undefined &&
			state.videos.length > 0 &&
			state.videos.every((video) =>
				[video.muxing, ...(video.extraMuxings ?? [])].every(
					(leg) =>
						// Absent kind = the fMP4 default, which carries nothing.
						leg?.kind !== undefined &&
						muxingKindCarriesAudio(leg.kind) &&
						leg.muxedAudioKeys?.includes(name),
				),
			);
		if (autoOwnContainer && (explicitOutput || !covered)) {
			return {
				...audio,
				muxing: {
					...options,
					ownContainer: undefined,
					autoOwnContainer: undefined,
				},
			};
		}
		if (!explicitOutput && covered && ownContainer === undefined) {
			return {
				...audio,
				muxing: {
					...audio.muxing,
					ownContainer: false,
					autoOwnContainer: true,
				},
			};
		}
		return audio;
	});
}
