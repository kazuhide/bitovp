import type { CompositionSourceFacts } from "./composition-frame";
import {
	type AnyEditDocument,
	type CompositionDocument,
	compositionDocumentSchema,
	DEFAULT_CAPTION_LAYOUT,
	DEFAULT_COMPOSITION_TEXT_STYLE,
	toCompositionDocument,
} from "./composition-schema";
import { suggestFixedCrop } from "./framing";
import type { NormalizedCropRect } from "./schema";

export const COMPOSITION_TEMPLATE_PRESETS = [
	{
		id: "portrait-clean",
		version: 1,
		name: "Portrait · clean",
		canvas: { width: 1080, height: 1920 },
	},
	{
		id: "landscape-clean",
		version: 1,
		name: "Landscape · clean",
		canvas: { width: 1920, height: 1080 },
	},
	{
		id: "square-clean",
		version: 1,
		name: "Square · clean",
		canvas: { width: 1080, height: 1080 },
	},
] as const;
export type CompositionTemplateId =
	(typeof COMPOSITION_TEMPLATE_PRESETS)[number]["id"];

/** Templates produce normal editable document fields, never opaque renderer code. */
export function applyCompositionTemplate(
	input: AnyEditDocument,
	presetId: string,
	sources: readonly CompositionSourceFacts[],
): CompositionDocument {
	const preset = COMPOSITION_TEMPLATE_PRESETS.find(
		(item) => item.id === presetId,
	);
	if (!preset) throw new RangeError("Unknown composition template");
	const document = toCompositionDocument(input);
	const aspectChanged =
		document.canvas.width * preset.canvas.height !==
		document.canvas.height * preset.canvas.width;
	for (const clip of document.clips) {
		const source = sources.find(
			(item) =>
				item.mediaVersionId ===
				(clip.mediaVersionId ?? document.mediaVersionId),
		);
		if (!source) throw new RangeError("Missing source geometry");
		if (!aspectChanged) continue;
		const layout = clip.layout ?? { x: 0, y: 0, w: 1, h: 1 };
		const oldTarget = {
			sourceWidth: source.width,
			sourceHeight: source.height,
			targetWidth: Math.max(1, Math.round(document.canvas.width * layout.w)),
			targetHeight: Math.max(1, Math.round(document.canvas.height * layout.h)),
		};
		const target = {
			...oldTarget,
			targetWidth: Math.max(1, Math.round(preset.canvas.width * layout.w)),
			targetHeight: Math.max(1, Math.round(preset.canvas.height * layout.h)),
		};
		const reframe = (rect: NormalizedCropRect) => {
			const centerX = rect.x + rect.w / 2;
			const centerY = rect.y + rect.h / 2;
			const max = suggestFixedCrop({ ...oldTarget, centerX, centerY });
			const zoom = Math.max(
				1,
				Math.min(3, Math.min(max.w / rect.w, max.h / rect.h)),
			);
			return suggestFixedCrop({ ...target, centerX, centerY, zoom });
		};
		clip.framing = clip.framing.map((part) => ({
			...part,
			origin: "MANUAL",
			manualOverride: true,
			...(part.mode === "CROP" ? { rect: reframe(part.rect) } : {}),
		}));
		if (clip.cropKeyframes)
			clip.cropKeyframes = clip.cropKeyframes.map((key) => ({
				...key,
				rect: reframe(key.rect),
			}));
		if (clip.fallbackCrop) {
			clip.fallbackCrop = reframe(clip.fallbackCrop);
			if (document.presentation)
				document.presentation.centerCropConfirmed = false;
		}
	}
	document.canvas = { ...preset.canvas };
	document.captionStyle = { ...DEFAULT_COMPOSITION_TEXT_STYLE };
	document.captionLayout = { ...DEFAULT_CAPTION_LAYOUT };
	document.template = {
		presetId: preset.id,
		version: preset.version,
		name: preset.name,
	};
	return compositionDocumentSchema.parse(document);
}

export function createCompositionVariants(
	input: AnyEditDocument,
	sources: readonly CompositionSourceFacts[],
	presetIds: readonly string[] = COMPOSITION_TEMPLATE_PRESETS.map((p) => p.id),
): { presetId: CompositionTemplateId; document: CompositionDocument }[] {
	if (
		presetIds.length < 1 ||
		presetIds.length > 3 ||
		new Set(presetIds).size !== presetIds.length
	)
		throw new RangeError("Expected 1..3 distinct composition presets");
	return presetIds.map((id) => {
		const document = applyCompositionTemplate(input, id, sources);
		const presetId = COMPOSITION_TEMPLATE_PRESETS.find(
			(preset) => preset.id === id,
		)?.id;
		if (!presetId) throw new RangeError("Unknown composition template");
		return { presetId, document };
	});
}
