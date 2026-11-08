import { z } from "zod";
import { automaticGenerationSchema } from "./automatic-binding";

export const MAX_EDIT_CLIPS = 20;
export const MAX_EDIT_DURATION_FRAMES = 180 * 30;
export const MAX_EDIT_FRAMING_SEGMENTS = 128;
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveInteger = safeInteger.min(1);
export const editingFpsSchema = z.strictObject({
	num: z.literal(30),
	den: z.literal(1),
});
export const editingCanvasSchema = z
	.strictObject({ width: positiveInteger, height: positiveInteger })
	.refine(
		({ width, height }) =>
			(width === 1920 && height === 1080) ||
			(width === 1080 && height === 1920),
		"Only landscape 1920x1080 and portrait 1080x1920 are supported",
	);
export const normalizedCropRectSchema = z
	.strictObject({
		x: z.number().finite().min(0).max(1),
		y: z.number().finite().min(0).max(1),
		w: z.number().finite().positive().max(1),
		h: z.number().finite().positive().max(1),
	})
	.refine(
		({ x, y, w, h }) => x + w <= 1 + 1e-12 && y + h <= 1 + 1e-12,
		"Crop must stay within the displayed source image",
	);
export type NormalizedCropRect = z.infer<typeof normalizedCropRectSchema>;

const frameRange = {
	fromFrame: safeInteger,
	toFrame: positiveInteger,
	origin: z.enum([
		"MANUAL",
		"AISA_PROPOSAL",
		"EDITOR_CONFIRMED",
		"AUTO_POLICY",
	]),
	manualOverride: z.boolean().optional(),
};
export const editFramingSchema = z.discriminatedUnion("mode", [
	z.strictObject({ ...frameRange, mode: z.literal("FIT") }),
	z.strictObject({
		...frameRange,
		mode: z.literal("CROP"),
		rect: normalizedCropRectSchema,
	}),
]);
export const editAudioSchema = z.strictObject({
	mode: z.enum(["SOURCE", "MUTE"]),
});
export const editClipSchema = z
	.strictObject({
		id: z.uuid(),
		sourceInUs: safeInteger,
		durationFrames: positiveInteger.max(MAX_EDIT_DURATION_FRAMES),
		timelineStartFrame: safeInteger.max(MAX_EDIT_DURATION_FRAMES - 1),
		framing: z.array(editFramingSchema).min(1).max(MAX_EDIT_FRAMING_SEGMENTS),
		audio: editAudioSchema,
		evidence: z
			.strictObject({
				sceneId: z.uuid(),
				shotIndex: safeInteger.max(4999).optional(),
			})
			.optional(),
	})
	.superRefine((clip, ctx) => {
		let nextFrame = 0;
		clip.framing.forEach((part, index) => {
			if (part.fromFrame !== nextFrame || part.toFrame <= part.fromFrame) {
				ctx.addIssue({
					code: "custom",
					path: ["framing", index],
					message: "Framing must cover each clip frame exactly once in order",
				});
			}
			nextFrame = part.toFrame;
		});
		if (nextFrame !== clip.durationFrames) {
			ctx.addIssue({
				code: "custom",
				path: ["framing"],
				message: "Framing must end at the clip duration",
			});
		}
	});

export const editingDocumentSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		mediaVersionId: z.uuid(),
		analysisRevisionId: z.uuid().nullable(),
		locale: z
			.string()
			.regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
			.max(35),
		sourceTimeDomain: z.literal("ORIGINAL_PRESENTATION_US"),
		timeMapId: z.uuid(),
		canvas: editingCanvasSchema,
		fps: editingFpsSchema,
		autoGeneration: automaticGenerationSchema.optional(),
		clips: z.array(editClipSchema).min(1).max(MAX_EDIT_CLIPS),
	})
	.superRefine((document, ctx) => {
		const automatic = document.autoGeneration;
		if (
			automatic &&
			(automatic.binding.mediaVersionId !== document.mediaVersionId ||
				automatic.binding.analysisRevisionId !== document.analysisRevisionId ||
				automatic.binding.timeMapId !== document.timeMapId ||
				automatic.binding.locale !== document.locale)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["autoGeneration"],
				message:
					"Automatic evidence must match the fixed source, analysis and time map",
			});
		}
		let nextFrame = 0;
		let framingSegments = 0;
		const ids = new Set<string>();
		document.clips.forEach((clip, index) => {
			if (
				clip.framing.some((part) => part.origin === "AUTO_POLICY") &&
				(!automatic || !clip.evidence)
			) {
				ctx.addIssue({
					code: "custom",
					path: ["clips", index, "framing"],
					message: "Automatic framing requires fixed policy evidence",
				});
			}
			if (ids.has(clip.id.toLowerCase())) {
				ctx.addIssue({
					code: "custom",
					path: ["clips", index, "id"],
					message: "Clip IDs must be unique",
				});
			}
			ids.add(clip.id.toLowerCase());
			if (clip.timelineStartFrame !== nextFrame) {
				ctx.addIssue({
					code: "custom",
					path: ["clips", index, "timelineStartFrame"],
					message: "Output clips must form one continuous timeline",
				});
			}
			if (clip.evidence && document.analysisRevisionId === null) {
				ctx.addIssue({
					code: "custom",
					path: ["clips", index, "evidence"],
					message: "Scene evidence needs a fixed analysis revision",
				});
			}
			nextFrame += clip.durationFrames;
			framingSegments += clip.framing.length;
		});
		if (nextFrame > MAX_EDIT_DURATION_FRAMES) {
			ctx.addIssue({
				code: "custom",
				path: ["clips"],
				message: "Output exceeds 180 seconds",
			});
		}
		if (framingSegments > MAX_EDIT_FRAMING_SEGMENTS) {
			ctx.addIssue({
				code: "custom",
				path: ["clips"],
				message: `Output exceeds ${MAX_EDIT_FRAMING_SEGMENTS} framing segments`,
			});
		}
	});
export type EditDocument = z.infer<typeof editingDocumentSchema>;
export type EditClip = z.infer<typeof editClipSchema>;
export type EditFraming = z.infer<typeof editFramingSchema>;

export const cfrTimeMapSchema = z
	.strictObject({
		id: z.uuid(),
		mediaVersionId: z.uuid(),
		kind: z.literal("CFR"),
		sourceStartUs: safeInteger,
		sourceEndUs: positiveInteger,
		editingStartFrame: safeInteger,
		editingEndFrame: positiveInteger,
		fps: editingFpsSchema,
	})
	.superRefine((map, ctx) => {
		const durationUs = BigInt(map.sourceEndUs) - BigInt(map.sourceStartUs);
		const frameCount =
			BigInt(map.editingEndFrame) - BigInt(map.editingStartFrame);
		if (
			durationUs <= 0n ||
			frameCount <= 0n ||
			(durationUs * 30n) / 1_000_000n !== frameCount
		) {
			ctx.addIssue({
				code: "custom",
				message: "CFR map duration and frame coverage must agree",
			});
		}
	});
export type CfrTimeMap = z.infer<typeof cfrTimeMapSchema>;
