import { z } from "zod";

export const BRANDING_SETTINGS_KEY = "workspace.branding";
export const BRAND_ICON_MAX_BYTES = 256 * 1024;
export const BRAND_ICON_MAX_DIMENSION = 1024;
/** Includes base64 expansion, two fields and JSON escaping for a 64-character name. */
export const BRANDING_REQUEST_MAX_BYTES = 352_000;

function dimensions(bytes: Uint8Array, mime: string): [number, number] | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ascii = (at: number, n: number) =>
		String.fromCharCode(...bytes.subarray(at, at + n));
	if (mime === "image/png") {
		if (bytes.length < 57 || ascii(0, 8) !== "\x89PNG\r\n\x1a\n") return null;
		let at = 8;
		let size: [number, number] | null = null;
		let image = false;
		while (at + 12 <= bytes.length) {
			const length = view.getUint32(at);
			const kind = ascii(at + 4, 4);
			if (at + 12 + length > bytes.length) return null;
			if (at === 8) {
				if (kind !== "IHDR" || length !== 13) return null;
				size = [view.getUint32(at + 8), view.getUint32(at + 12)];
			} else if (kind === "IHDR" || kind === "acTL") return null;
			if (kind === "IDAT" && length > 0) image = true;
			at += 12 + length;
			if (kind === "IEND")
				return length === 0 && at === bytes.length && image ? size : null;
		}
		return null;
	}
	if (mime === "image/jpeg") {
		if (
			bytes.length < 12 ||
			bytes[0] !== 255 ||
			bytes[1] !== 216 ||
			bytes.at(-2) !== 255 ||
			bytes.at(-1) !== 217
		)
			return null;
		let at = 2;
		let size: [number, number] | null = null;
		while (at + 4 <= bytes.length) {
			if (bytes[at++] !== 255) return null;
			while (bytes[at] === 255) at++;
			const marker = bytes[at++];
			if (marker === undefined) return null;
			const length = view.getUint16(at);
			if (length < 2 || at + length > bytes.length) return null;
			if ([0xc0, 0xc1, 0xc2].includes(marker)) {
				if (length < 8 || size) return null;
				size = [view.getUint16(at + 5), view.getUint16(at + 3)];
			}
			// Entropy-coded bytes are not marker segments. The browser decodes the upload
			// before preview; the server only accepts an inert, bounded raster container.
			if (marker === 0xda)
				return size && at + length < bytes.length - 2 ? size : null;
			at += length;
		}
		return null;
	}
	if (mime === "image/webp") {
		if (
			bytes.length < 26 ||
			ascii(0, 4) !== "RIFF" ||
			ascii(8, 4) !== "WEBP" ||
			view.getUint32(4, true) + 8 !== bytes.length
		)
			return null;
		let at = 12;
		let size: [number, number] | null = null;
		let canvas: [number, number] | null = null;
		while (at + 8 <= bytes.length) {
			const kind = ascii(at, 4);
			const length = view.getUint32(at + 4, true);
			const start = at + 8;
			if (start + length > bytes.length || kind === "ANIM" || kind === "ANMF")
				return null;
			if (kind === "VP8X") {
				if (
					canvas ||
					at !== 12 ||
					length !== 10 ||
					((bytes[start] ?? 0) & 2) !== 0
				)
					return null;
				canvas = [
					1 + (view.getUint32(start + 4, true) & 0xffffff),
					1 + (view.getUint32(start + 6, true) >>> 8),
				];
				if (canvas.some((n) => n > BRAND_ICON_MAX_DIMENSION)) return null;
			}
			if (kind === "VP8 " || kind === "VP8L") {
				if (size) return null;
				if (kind === "VP8 ") {
					if (length < 10 || ascii(start + 3, 3) !== "\x9d\x01\x2a")
						return null;
					size = [
						view.getUint16(start + 6, true) & 0x3fff,
						view.getUint16(start + 8, true) & 0x3fff,
					];
				} else {
					if (length < 5 || bytes[start] !== 0x2f) return null;
					const packed = view.getUint32(start + 1, true);
					size = [(packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1];
				}
			}
			at = start + length + (length % 2);
		}
		return at === bytes.length &&
			(!canvas || (canvas[0] === size?.[0] && canvas[1] === size?.[1]))
			? size
			: null;
	}
	return null;
}

/** No remote URL, SVG, animation, unbounded decode or user-declared MIME trust. */
export function inspectBrandIcon(
	value: string,
): { mime: string; bytes: number; width: number; height: number } | null {
	if (value.length > Math.ceil(BRAND_ICON_MAX_BYTES / 3) * 4 + 32) return null;
	const match =
		/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
			value,
		);
	if (!match?.[1] || !match[2] || match[2].length % 4 !== 0) return null;
	try {
		const raw = atob(match[2]);
		if (raw.length > BRAND_ICON_MAX_BYTES || btoa(raw) !== match[2])
			return null;
		const size = dimensions(
			Uint8Array.from(raw, (c) => c.charCodeAt(0)),
			match[1],
		);
		if (!size || size.some((n) => n < 1 || n > BRAND_ICON_MAX_DIMENSION))
			return null;
		return {
			mime: match[1],
			bytes: raw.length,
			width: size[0],
			height: size[1],
		};
	} catch {
		return null;
	}
}

const displayName = z
	.string()
	.trim()
	.refine(
		(s) =>
			Array.from(s).length >= 1 &&
			Array.from(s).length <= 64 &&
			!/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(s),
		"Use 1–64 characters without control characters",
	);
const iconDataUrl = z
	.string()
	.refine(
		(s) => inspectBrandIcon(s) !== null,
		"Use a static PNG, JPEG or WebP up to 256 KiB and 1024 × 1024 pixels",
	)
	.nullable();
export const brandingSettingsSchema = z
	.object({ displayName, iconDataUrl })
	.strict();
export const brandingSettingsPatchSchema = z
	.object({
		displayName: displayName.optional(),
		iconDataUrl: iconDataUrl.optional(),
	})
	.strict();
export type BrandingSettings = z.infer<typeof brandingSettingsSchema>;
export const DEFAULT_BRANDING_SETTINGS: BrandingSettings = {
	displayName: "Bitmovin OVP",
	iconDataUrl: null,
};
export function parseBrandingSettings(value: unknown): BrandingSettings {
	const parsed = brandingSettingsSchema.safeParse(value);
	return parsed.success ? parsed.data : { ...DEFAULT_BRANDING_SETTINGS };
}
