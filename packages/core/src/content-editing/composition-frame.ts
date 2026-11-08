import { z } from "zod";
import {
	type CompositionAudioAutomation,
	compositionAudioGainAt,
	compositionTransitionWeight,
} from "./composition-audio";
import { fitCompositionCaptionFontSize } from "./composition-caption-fit";
import { resolveCompositionCaptionDisplay } from "./composition-caption-translation";
import {
	type CompositionVideoGeometry,
	compositionOutputRect,
	type PixelRect,
} from "./composition-geometry";
import {
	compositionCaptionPresentationLayout,
	compositionHasUnconfirmedCenterCrop,
	resolvePresentedCompositionGeometry,
} from "./composition-presentation";
import {
	type CompositionAudioTrack,
	type CompositionCaption,
	type CompositionClip,
	type CompositionDocument,
	type CompositionOverlay,
	type CompositionTextStyle,
	compositionCanvasSchema,
	compositionClipOrder,
	DEFAULT_COMPOSITION_TEXT_STYLE,
	toCompositionDocument,
} from "./composition-schema";
import { cfrTimeMapSchema } from "./schema";
import { originalTimeToCfrFrame } from "./time";

export const COMPOSITION_COMPILER_VERSION = "content-composition-v2" as const;
export function compositionDurationFrames(input: unknown): number {
	const document = toCompositionDocument(input);
	return Math.max(
		...document.clips.map((c) => c.timelineStartFrame + c.durationFrames),
		...(document.audioTracks ?? []).map(
			(a) => a.timelineStartFrame + a.durationFrames,
		),
		...(document.captions ?? []).map((c) => c.toFrame),
		...(document.overlays ?? []).map((o) => o.toFrame),
	);
}
export function compositionRenderCanvas(
	input: { width: number; height: number },
	mode: "PREVIEW" | "EXPORT",
) {
	const canvas = compositionCanvasSchema.parse(input);
	if (mode === "EXPORT") return { ...canvas };
	if (mode !== "PREVIEW")
		throw new RangeError("Invalid composition render mode");
	const factor = 640 / Math.max(canvas.width, canvas.height);
	return {
		width: Math.round(canvas.width * factor),
		height: Math.round(canvas.height * factor),
	};
}
const sourceSchema = z.strictObject({
	mediaVersionId: z.uuid(),
	timeMap: cfrTimeMapSchema,
	width: z.number().int().min(2).max(8192),
	height: z.number().int().min(2).max(8192),
	hasAudio: z.boolean(),
});
export type CompositionSourceFacts = z.infer<typeof sourceSchema>;
export class CompositionError extends Error {
	constructor(
		public readonly code:
			| "TIME_MAP_MISMATCH"
			| "SOURCE_OUT_OF_BOUNDS"
			| "MISSING_MEDIA"
			| "UNCONFIRMED_FRAMING"
			| "NO_AUDIO_SOURCE"
			| "INVALID_FRAME",
	) {
		super(code);
		this.name = "CompositionError";
	}
}
export type CompiledCompositionClip = {
	clip: CompositionClip;
	mediaVersionId: string;
	sourceFromFrame: number;
	outputFromFrame: number;
	outputToFrame: number;
	trackId: string;
	trackOrder: number;
	transitionOut?: { fromFrame: number; durationFrames: number };
};
export type CompiledCompositionAudio = {
	id: string;
	kind: "CLIP" | "TRACK";
	mediaVersionId: string;
	sourceFromFrame: number;
	automation: CompositionAudioAutomation;
};
export type CompositionPlan = {
	schemaVersion: 2;
	compilerVersion: typeof COMPOSITION_COMPILER_VERSION;
	document: CompositionDocument;
	sources: CompositionSourceFacts[];
	durationFrames: number;
	clips: CompiledCompositionClip[];
	audio: CompiledCompositionAudio[];
};
export type CompositionVideoLayer = CompositionVideoGeometry & {
	clipId: string;
	mediaVersionId: string;
	trackId: string;
	trackOrder: number;
	localFrame: number;
	sourceFrame: number;
	sourceSeconds: number;
	sourceTimeUs: number;
	opacity: number;
	transitionWeight: number;
};
export type CompositionAudioState = {
	id: string;
	kind: "CLIP" | "TRACK";
	mediaVersionId: string;
	sourceSample: number;
	sourceSeconds: number;
	gain: number;
};
export type CompositionCaptionState = CompositionCaption & {
	rect: PixelRect;
	style: CompositionTextStyle;
	activeWords: NonNullable<CompositionCaption["words"]>;
};
export type CompositionOverlayState = CompositionOverlay & {
	pixelRect: PixelRect;
	resolvedStyle?: CompositionTextStyle;
};
export type CompositionFrame = {
	frame: number;
	timeUs: number;
	canvas: { width: number; height: number };
	layers: CompositionVideoLayer[];
	audio: CompositionAudioState[];
	captions: CompositionCaptionState[];
	overlays: CompositionOverlayState[];
};

function pinnedSourceStart(
	source: CompositionSourceFacts,
	sourceInUs: number,
	durationFrames: number,
) {
	const map = source.timeMap;
	if (sourceInUs < map.sourceStartUs || sourceInUs >= map.sourceEndUs)
		throw new CompositionError("SOURCE_OUT_OF_BOUNDS");
	const from =
		BigInt(map.editingStartFrame) +
		originalTimeToCfrFrame(sourceInUs, map.sourceStartUs, "FLOOR");
	const end = from + BigInt(durationFrames);
	if (
		end > BigInt(map.editingEndFrame) ||
		end * 1600n > BigInt(Number.MAX_SAFE_INTEGER)
	)
		throw new CompositionError("SOURCE_OUT_OF_BOUNDS");
	return Number(from);
}
function findSource(
	plan: Pick<CompositionPlan, "sources">,
	mediaVersionId: string,
) {
	const source = plan.sources.find((s) => s.mediaVersionId === mediaVersionId);
	if (!source) throw new CompositionError("MISSING_MEDIA");
	return source;
}

/** Compile serializable, pinned frame facts once. This function grants no source authority. */
export function compileComposition(
	input: unknown,
	inputSources: readonly CompositionSourceFacts[],
	options: { allowUnconfirmed?: boolean } = {},
): CompositionPlan {
	const document = toCompositionDocument(input);
	const supplied = z.array(sourceSchema).min(1).max(8).parse(inputSources);
	const declarations = [
		{ mediaVersionId: document.mediaVersionId, timeMapId: document.timeMapId },
		...(document.sources ?? []),
	];
	if (
		new Set(supplied.map((s) => s.mediaVersionId)).size !== supplied.length ||
		supplied.length !== declarations.length
	)
		throw new CompositionError("TIME_MAP_MISMATCH");
	const sources = declarations.map((declaration) => {
		const source = supplied.find(
			(s) => s.mediaVersionId === declaration.mediaVersionId,
		);
		if (!source) throw new CompositionError("MISSING_MEDIA");
		if (
			source.timeMap.id !== declaration.timeMapId ||
			source.timeMap.mediaVersionId !== source.mediaVersionId
		)
			throw new CompositionError("TIME_MAP_MISMATCH");
		return source;
	});
	const tracks = document.videoTracks ?? [
		{ id: "main", name: "Main", order: 0 },
	];
	if (
		!options.allowUnconfirmed &&
		compositionHasUnconfirmedCenterCrop(document)
	)
		throw new CompositionError("UNCONFIRMED_FRAMING");
	const clips = document.clips
		.map((clip): CompiledCompositionClip => {
			const mediaVersionId = clip.mediaVersionId ?? document.mediaVersionId;
			const source = findSource({ sources }, mediaVersionId);
			if (
				!options.allowUnconfirmed &&
				clip.framing.some((p) => p.origin === "AISA_PROPOSAL")
			)
				throw new CompositionError("UNCONFIRMED_FRAMING");
			const sourceFromFrame = pinnedSourceStart(
				source,
				clip.sourceInUs,
				clip.durationFrames,
			);
			// Convex keyframe interpolation is bounded by its endpoints. Validate every
			// active CROP endpoint/key, including explicit FIT gaps and one-pixel edges.
			for (const framing of clip.framing) {
				const sampleFrames = [
					framing.fromFrame,
					framing.toFrame - 1,
					...(clip.cropKeyframes ?? [])
						.filter(
							(k) => k.frame >= framing.fromFrame && k.frame < framing.toFrame,
						)
						.map((k) => k.frame),
				];
				for (const frame of sampleFrames)
					resolvePresentedCompositionGeometry({
						document,
						clip,
						sourceWidth: source.width,
						sourceHeight: source.height,
						...document.canvas,
						frame,
					});
			}
			const trackId = clip.trackId ?? "main";
			const track = tracks.find((t) => t.id === trackId);
			if (!track) throw new CompositionError("MISSING_MEDIA");
			return {
				clip,
				mediaVersionId,
				sourceFromFrame,
				outputFromFrame: clip.timelineStartFrame,
				outputToFrame: clip.timelineStartFrame + clip.durationFrames,
				trackId,
				trackOrder: track.order,
			};
		})
		.sort(
			(a, b) =>
				a.trackOrder - b.trackOrder || compositionClipOrder(a.clip, b.clip),
		);
	for (const track of tracks) {
		const ordered = clips.filter((c) => c.trackId === track.id);
		ordered.forEach((clip, index) => {
			const next = ordered[index + 1];
			if (next?.clip.transitionIn)
				clip.transitionOut = {
					fromFrame: next.outputFromFrame,
					durationFrames: next.clip.transitionIn.durationFrames,
				};
		});
	}
	const audio: CompiledCompositionAudio[] = [];
	for (const item of clips) {
		const source = findSource({ sources }, item.mediaVersionId);
		if (item.clip.audio.mode === "MUTE" || !source.hasAudio) continue;
		audio.push({
			id: `clip:${item.clip.id}`,
			kind: "CLIP",
			mediaVersionId: item.mediaVersionId,
			sourceFromFrame: item.sourceFromFrame,
			automation: {
				timelineStartFrame: item.outputFromFrame,
				durationFrames: item.clip.durationFrames,
				gainDb: item.clip.audio.gainDb ?? 0,
				fadeInFrames: item.clip.audio.fadeInFrames ?? 0,
				fadeOutFrames: item.clip.audio.fadeOutFrames ?? 0,
				fadeWindow: item.clip.audio.fadeWindow,
				transitionInFrames: item.clip.transitionIn?.durationFrames,
				transitionOut: item.transitionOut,
			},
		});
	}
	for (const track of document.audioTracks ?? []) {
		const source = findSource({ sources }, track.mediaVersionId);
		if (!source.hasAudio) throw new CompositionError("NO_AUDIO_SOURCE");
		audio.push({
			id: `track:${track.id}`,
			kind: "TRACK",
			mediaVersionId: track.mediaVersionId,
			sourceFromFrame: pinnedSourceStart(
				source,
				track.sourceInUs,
				track.durationFrames,
			),
			automation: audioTrackAutomation(track, document.captions ?? []),
		});
	}
	const durationFrames = compositionDurationFrames(document);
	return {
		schemaVersion: 2,
		compilerVersion: COMPOSITION_COMPILER_VERSION,
		document,
		sources,
		durationFrames,
		clips,
		audio,
	};
}
function audioTrackAutomation(
	track: CompositionAudioTrack,
	captions: readonly CompositionCaption[],
): CompositionAudioAutomation {
	return {
		timelineStartFrame: track.timelineStartFrame,
		durationFrames: track.durationFrames,
		gainDb: track.gainDb,
		fadeInFrames: track.fadeInFrames,
		fadeOutFrames: track.fadeOutFrames,
		fadeWindow: track.fadeWindow,
		ducking:
			track.ducking?.source === "CAPTIONS"
				? {
						...track.ducking,
						intervals: captions.map(({ fromFrame, toFrame }) => ({
							fromFrame,
							toFrame,
						})),
					}
				: track.ducking,
	};
}
export function compositionClipWeight(
	item: CompiledCompositionClip,
	frame: number,
) {
	let weight = item.clip.transitionIn
		? compositionTransitionWeight(
				frame - item.outputFromFrame,
				item.clip.transitionIn.durationFrames,
			)
		: 1;
	if (item.transitionOut)
		weight *=
			1 -
			compositionTransitionWeight(
				frame - item.transitionOut.fromFrame,
				item.transitionOut.durationFrames,
			);
	return weight;
}
export function evaluateCompositionAudio(
	plan: CompositionPlan,
	frame: number,
): CompositionAudioState[] {
	if (!Number.isFinite(frame) || frame < 0 || frame > plan.durationFrames)
		throw new CompositionError("INVALID_FRAME");
	return plan.audio
		.filter(
			(a) =>
				frame >= a.automation.timelineStartFrame &&
				frame < a.automation.timelineStartFrame + a.automation.durationFrames,
		)
		.map((item) => {
			const sourceFrame =
				item.sourceFromFrame + frame - item.automation.timelineStartFrame;
			return {
				id: item.id,
				kind: item.kind,
				mediaVersionId: item.mediaVersionId,
				sourceSample: Math.floor(sourceFrame * 1600),
				sourceSeconds: sourceFrame / 30,
				gain: compositionAudioGainAt(item.automation, frame),
			};
		});
}

/** Video-only samples share geometry/clock with preview without laying out subtitles. */
export function evaluateCompositionVideoLayers(
	plan: CompositionPlan,
	frame: number,
	outputCanvas = plan.document.canvas,
): CompositionVideoLayer[] {
	if (
		plan.compilerVersion !== COMPOSITION_COMPILER_VERSION ||
		!Number.isSafeInteger(frame) ||
		frame < 0 ||
		frame >= plan.durationFrames
	)
		throw new CompositionError("INVALID_FRAME");
	if (
		![outputCanvas.width, outputCanvas.height].every(
			(n) => Number.isSafeInteger(n) && n > 0 && n <= 3840,
		) ||
		outputCanvas.width * plan.document.canvas.height !==
			outputCanvas.height * plan.document.canvas.width
	)
		throw new RangeError("Output canvas must retain the composition aspect");
	const layers = plan.clips
		.filter((c) => frame >= c.outputFromFrame && frame < c.outputToFrame)
		.map((item): CompositionVideoLayer => {
			const source = findSource(plan, item.mediaVersionId);
			const localFrame = frame - item.outputFromFrame;
			const framing = item.clip.framing.find(
				(p) => localFrame >= p.fromFrame && localFrame < p.toFrame,
			);
			if (!framing) throw new RangeError("Missing composition framing");
			const sourceFrame = item.sourceFromFrame + localFrame;
			const sourceTimeUs = Number(
				BigInt(source.timeMap.sourceStartUs) +
					(BigInt(sourceFrame - source.timeMap.editingStartFrame) * 1_000_000n +
						29n) /
						30n,
			);
			const transitionWeight = compositionClipWeight(item, frame);
			return {
				clipId: item.clip.id,
				mediaVersionId: item.mediaVersionId,
				trackId: item.trackId,
				trackOrder: item.trackOrder,
				localFrame,
				sourceFrame,
				sourceSeconds: sourceFrame / 30,
				sourceTimeUs,
				transitionWeight,
				opacity: (item.clip.opacity ?? 1) * transitionWeight,
				...resolvePresentedCompositionGeometry({
					document: plan.document,
					clip: item.clip,
					sourceWidth: source.width,
					sourceHeight: source.height,
					...outputCanvas,
					frame: localFrame,
				}),
			};
		});
	return layers;
}

/** One output-frame clock for canvas, cropping, caption emphasis, and MP4 commands. */
export function evaluateCompositionFrame(
	plan: CompositionPlan,
	frame: number,
	outputCanvas = plan.document.canvas,
): CompositionFrame {
	const layers = evaluateCompositionVideoLayers(plan, frame, outputCanvas);
	const style = {
		...DEFAULT_COMPOSITION_TEXT_STYLE,
		...plan.document.captionStyle,
	};
	const captionRect = compositionOutputRect(
		compositionCaptionPresentationLayout(plan.document),
		outputCanvas.width,
		outputCanvas.height,
		plan.document.canvas,
	);
	const captions = (plan.document.captions ?? [])
		.filter((c) => frame >= c.fromFrame && frame < c.toFrame)
		.map((caption) => {
			const display = resolveCompositionCaptionDisplay(
				caption,
				plan.document.captionDisplayLanguage,
			);
			return {
				...caption,
				...display,
				rect: { ...captionRect },
				style: {
					...style,
					fontSize: fitCompositionCaptionFontSize({
						text: display.text,
						rect: captionRect,
						canvasHeight: outputCanvas.height,
						fontSize: style.fontSize,
					}),
				},
				activeWords: display.words.filter(
					(w) => frame >= w.fromFrame && frame < w.toFrame,
				),
			};
		});
	const overlays = (plan.document.overlays ?? [])
		.filter((o) => frame >= o.fromFrame && frame < o.toFrame)
		.sort((a, b) => a.zIndex - b.zIndex || (a.id < b.id ? -1 : 1))
		.map((overlay) => ({
			...overlay,
			pixelRect: compositionOutputRect(
				overlay.rect,
				outputCanvas.width,
				outputCanvas.height,
				plan.document.canvas,
			),
			...(overlay.kind === "TEXT"
				? {
						resolvedStyle: {
							...DEFAULT_COMPOSITION_TEXT_STYLE,
							...overlay.style,
						},
					}
				: {}),
		}));
	return {
		frame,
		timeUs: Math.floor((frame * 1_000_000) / 30),
		canvas: { ...outputCanvas },
		layers,
		audio: evaluateCompositionAudio(plan, frame),
		captions,
		overlays,
	};
}
