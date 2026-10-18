import { audioKeys, type WizardState } from "./build-plan";

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
						(leg?.kind === "TS" || leg?.kind === "MP4") &&
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
