import { muxingKindCarriesAudio } from "@bitovp/core";
import { audioKeys, type WizardMuxing, type WizardState } from "./build-plan";

/**
 * A video container names the audio it carries by key, and a derived key follows the
 * bitrate. Without this, editing an audio bitrate left the old key in the container:
 * the track dropped out of the file and came back as a container of its own.
 *
 * Only a rename is followed — the same row, its old key gone from the list. A reorder
 * or a removal changes which track a key means, and is left alone. So is a key two
 * rows share, before or after the edit: it does not say which row a container meant.
 * Two bitrates pass through such a key while one is being typed (64 kbps on the way
 * to 640), and following it would hand the container the other row's track.
 */
export function followRenamedAudioKeys(
	previous: Pick<WizardState, "audios">,
	next: Pick<WizardState, "videos" | "audios">,
): WizardState["videos"] {
	if (
		previous.audios === next.audios ||
		previous.audios.length !== next.audios.length
	)
		return next.videos;
	const before = audioKeys(previous.audios);
	const after = audioKeys(next.audios);
	const one = (keys: readonly string[], key: string) =>
		keys.indexOf(key) === keys.lastIndexOf(key);
	const renamed = new Map<string, string>();
	for (const [index, key] of before.entries()) {
		const to = after[index];
		if (
			to !== undefined &&
			to !== key &&
			!after.includes(key) &&
			one(before, key) &&
			one(after, to)
		)
			renamed.set(key, to);
	}
	if (renamed.size === 0) return next.videos;
	const follow = (leg: WizardMuxing): WizardMuxing =>
		leg.muxedAudioKeys?.some((key) => renamed.has(key))
			? {
					...leg,
					muxedAudioKeys: leg.muxedAudioKeys.map(
						(key) => renamed.get(key) ?? key,
					),
				}
			: leg;
	return next.videos.map((video) => ({
		...video,
		...(video.muxing ? { muxing: follow(video.muxing) } : {}),
		...(video.extraMuxings
			? { extraMuxings: video.extraMuxings.map((leg) => follow(leg)) }
			: {}),
	}));
}

/** Keep automatic packaging defaults safe across edits in every wizard step. */
export function reconcileAutomaticAudioPackaging(
	state: WizardState,
): WizardState["audios"] {
	const keys = audioKeys(state.audios);
	return state.audios.map((audio, index) => {
		const key = keys[index];
		const { ownContainer, autoOwnContainer, ...options } = audio.muxing ?? {};
		const explicitOutput =
			Object.values(options).some((value) => value !== undefined) ||
			Boolean(audio.extraMuxings?.length || audio.extras?.hlsMedia) ||
			state.drm?.some((row) => row.muxingKey === (audio.muxing?.key ?? key));
		const covered =
			key !== undefined &&
			state.videos.length > 0 &&
			state.videos.every((video) =>
				[video.muxing, ...(video.extraMuxings ?? [])].every(
					(leg) =>
						// Absent kind = the fMP4 default, which carries nothing.
						leg?.kind !== undefined &&
						muxingKindCarriesAudio(leg.kind) &&
						leg.muxedAudioKeys?.includes(key),
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
