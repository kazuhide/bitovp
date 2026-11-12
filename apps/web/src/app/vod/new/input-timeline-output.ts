import { audioKeys, type WizardState } from "./build-plan";

/** Explicit file-output preset; codec, rate and ordinary ladder decisions stay editable. */
export function vodInputTimelineFileOutput(
	state: WizardState,
	kind: "MP4" | "PROGRESSIVE_TS",
): Partial<WizardState> {
	const extension = kind === "MP4" ? "mp4" : "ts";
	const keys = audioKeys(state.audios);
	return {
		videos: state.videos.map((video, index) => ({
			...video,
			muxing: {
				kind,
				filename: `sequence-${index + 1}.${extension}`,
				muxedAudioKeys: keys,
			},
			extraMuxings: undefined,
		})),
		audios: state.audios.map((audio) => ({
			...audio,
			muxing: { ownContainer: false },
			extraMuxings: undefined,
		})),
		manifests: { ...state.manifests, hls: false, dash: false },
	};
}
