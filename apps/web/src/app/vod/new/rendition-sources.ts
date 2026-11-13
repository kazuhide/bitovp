import type { Translator } from "@/lib/i18n/context";
import type { WizardState } from "./build-plan";
import type { SourceOption } from "./rendition-editors";
import { flattenStreams, streamReferenceLabel } from "./stream-model";

/**
 * The streams a video or audio rendition can read, labelled by type and input object
 * rather than by the internal key. A select stores the key; only the text is derived,
 * so the plan is unaffected.
 */
export function renditionSourceOptions(
	state: WizardState,
	t: Translator,
): { video: SourceOption[]; audio: SourceOption[] } {
	const sources = state.sources ?? {};
	const named: SourceOption[] = [
		// WEBVTT streams feed subtitles only.
		...flattenStreams(sources)
			.filter((stream) => stream.type !== "WEBVTT")
			.map((stream) => ({
				value: stream.key,
				label: streamReferenceLabel(state, stream),
			})),
		// Trimming and concatenation results reference other streams, not input files,
		// so `flattenStreams` leaves them out. A rendition reads one by key.
		...(sources.trimmingStreams ?? []).map((trim) => ({
			value: trim.key,
			label: t("wizardX.trimSourceKey", {
				source: trim.sourceKey,
				key: trim.key,
			}),
		})),
		...(sources.concatenationStreams ?? []).map((concatenation) => ({
			value: concatenation.key,
			label: t("wizardX.concatenationKey", { key: concatenation.key }),
		})),
	];
	return {
		video: [
			{ value: "", label: t("wizard.inputVideoTrackImplicit") },
			...named,
		],
		audio: [
			...(sources.audioMixStreams ?? []).map((mix) => ({
				value: mix.key,
				label: `${t("audioMix.title")} · ${mix.key}`,
			})),
			{ value: "", label: t("wizard.inputAudioTrackImplicit") },
			...named,
		],
	};
}
