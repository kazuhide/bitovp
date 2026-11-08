import { z } from "zod";

const versionSchema = z.strictObject({
	etag: z.string().min(1).optional(),
	versionId: z.string().min(1).optional(),
	generation: z.string().min(1).optional(),
});
export const editingObjectSchema = z.strictObject({
	credentialId: z.uuid(),
	bucket: z.string().min(1).max(1024),
	key: z.string().min(1).max(4096),
	expect: versionSchema.optional(),
	size: z
		.number()
		.int()
		.positive()
		.max(20 * 1024 ** 3)
		.optional(),
});
export const editingOutputSchema = z.strictObject({
	credentialId: z.uuid(),
	bucket: z.string().min(1).max(1024),
	prefix: z
		.string()
		.max(2048)
		.refine(
			(s) =>
				!s.split("/").includes("..") &&
				!Array.from(s).some((character) => character.charCodeAt(0) < 32),
		),
});
/** Server/worker only. These locators never appear in the editor's public document. */
export const editingMediaStorageSchema = z
	.strictObject({
		source: editingObjectSchema,
		output: editingOutputSchema,
		prepared: editingObjectSchema.optional(),
		sourceFormat: z.literal("HLS").optional(),
		hlsRootPrefix: z.string().max(2048).optional(),
	})
	.superRefine((value, ctx) => {
		if (value.sourceFormat === undefined && value.hlsRootPrefix === undefined)
			return;
		const root = value.hlsRootPrefix;
		const safe = (s: string) =>
			!s.startsWith("/") &&
			!s.includes("\\") &&
			!Array.from(s).some(
				(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
			) &&
			!s.split("/").some((part) => part === ".." || part === ".");
		if (
			value.sourceFormat !== "HLS" ||
			root === undefined ||
			!safe(root) ||
			!safe(value.source.key) ||
			!value.source.key.endsWith(".m3u8") ||
			(root !== "" &&
				!value.source.key.startsWith(`${root.replace(/\/+$/, "")}/`))
		)
			ctx.addIssue({
				code: "custom",
				message: "HLS sources require a matching retained output root",
			});
	});
export type EditingObject = z.infer<typeof editingObjectSchema>;
export type EditingMediaStorage = z.infer<typeof editingMediaStorageSchema>;
export const editingRenderProfileSchema = z.strictObject({
	kind: z.enum(["PREVIEW", "EXPORT"]),
});
