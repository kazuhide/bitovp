import { z } from "zod";

export const NATIVE_EDITING_COMPONENTS = [
	"MEDIA_TOOLS",
	"ASR_RUNTIME",
	"ASR_MODEL",
	"VAD_MODEL",
	"CAPTION_ALIGNMENT",
	"CAPTION_FONT",
	"SCRATCH",
	"VOD_PREVIEW_STORAGE",
] as const;
export type NativeEditingComponent = (typeof NATIVE_EDITING_COMPONENTS)[number];
export const nativeEditingPreflightSchema = z
	.strictObject({
		version: z.literal("bitovp-native-editing-preflight-v1"),
		checkedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		code: z.enum(["READY", "UNAVAILABLE"]),
		checks: z
			.array(
				z.strictObject({
					component: z.enum(NATIVE_EDITING_COMPONENTS),
					code: z.enum([
						"READY",
						"MISSING",
						"ACCESS_DENIED",
						"MISMATCH",
						"FAILED",
					]),
				}),
			)
			.min(1)
			.max(NATIVE_EDITING_COMPONENTS.length),
	})
	.refine(
		(value) =>
			new Set(value.checks.map((row) => row.component)).size ===
				value.checks.length &&
			(value.code === "READY") ===
				value.checks.every((row) => row.code === "READY"),
	);
export type NativeEditingPreflight = z.infer<
	typeof nativeEditingPreflightSchema
>;
