import { describe, expect, it } from "vitest";
import {
	BRAND_ICON_MAX_BYTES,
	brandingSettingsPatchSchema,
	brandingSettingsSchema,
	DEFAULT_BRANDING_SETTINGS,
	inspectBrandIcon,
	parseBrandingSettings,
} from "./branding";

const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVZkAAAAASUVORK5CYII=";
const data = (mime: string, bytes: Uint8Array) =>
	`data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
function webp(width: number, height: number, canvas?: [number, number]) {
	const image = Buffer.alloc(6);
	image[0] = 0x2f;
	image.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
	const chunk = (type: string, bytes: Buffer) => {
		const header = Buffer.alloc(8);
		header.write(type);
		header.writeUInt32LE(bytes.length, 4);
		return Buffer.concat([header, bytes]);
	};
	const extended = Buffer.alloc(10);
	if (canvas) {
		extended.writeUIntLE(canvas[0] - 1, 4, 3);
		extended.writeUIntLE(canvas[1] - 1, 7, 3);
	}
	const body = Buffer.concat([
		Buffer.from("WEBP"),
		...(canvas ? [chunk("VP8X", extended)] : []),
		chunk("VP8L", image),
	]);
	const header = Buffer.alloc(8);
	header.write("RIFF");
	header.writeUInt32LE(body.length, 4);
	return data("image/webp", Buffer.concat([header, body]));
}
describe("organization branding", () => {
	it("accepts bounded raster files and preserves the canonical data URL", () => {
		expect(inspectBrandIcon(PNG)).toEqual({
			mime: "image/png",
			bytes: 68,
			width: 1,
			height: 1,
		});
		expect(
			brandingSettingsSchema.parse({
				displayName: "  映像 🎬  ",
				iconDataUrl: PNG,
			}),
		).toEqual({ displayName: "映像 🎬", iconDataUrl: PNG });
		expect(inspectBrandIcon(webp(64, 32))).toMatchObject({
			width: 64,
			height: 32,
		});
		expect(inspectBrandIcon(webp(64, 32, [64, 32]))).toMatchObject({
			width: 64,
			height: 32,
		});
	});
	it("rejects overlarge or inconsistent WebP extended canvases", () => {
		expect(inspectBrandIcon(webp(64, 32, [4096, 32]))).toBeNull();
		expect(inspectBrandIcon(webp(64, 32, [64, 4096]))).toBeNull();
		expect(inspectBrandIcon(webp(64, 32, [128, 32]))).toBeNull();
	});
	it.each([
		"",
		" ",
		"a".repeat(65),
		"hello\nworld",
		"hello\u202eworld",
	])("rejects invalid name %j", (displayName) =>
		expect(brandingSettingsPatchSchema.safeParse({ displayName }).success).toBe(
			false,
		));
	it("counts Unicode characters and treats name content as plain text", () => {
		expect(
			brandingSettingsPatchSchema.parse({ displayName: "🎬".repeat(64) })
				.displayName,
		).toHaveLength(128);
		expect(
			brandingSettingsPatchSchema.safeParse({
				displayName: "<script>alert(1)</script>",
			}).success,
		).toBe(true);
	});
	it.each([
		"https://example.com/icon.png",
		"data:image/svg+xml;base64,PHN2Zz4=",
		PNG.replace("image/png", "image/jpeg"),
		PNG.slice(0, -4),
		`${PNG} `,
		"data:image/png;base64,AAAA",
	])("rejects unsupported, mismatched, truncated or noncanonical icon", (iconDataUrl) =>
		expect(brandingSettingsPatchSchema.safeParse({ iconDataUrl }).success).toBe(
			false,
		));
	it("rejects byte and dimension limits", () => {
		expect(
			inspectBrandIcon(
				data("image/png", new Uint8Array(BRAND_ICON_MAX_BYTES + 1)),
			),
		).toBeNull();
		const png = Buffer.from(PNG.split(",")[1] ?? "", "base64");
		png.writeUInt32BE(1025, 16);
		expect(inspectBrandIcon(data("image/png", png))).toBeNull();
	});
	it("missing/malformed rows fall back and patches do not inject defaults", () => {
		expect(parseBrandingSettings(undefined)).toEqual(DEFAULT_BRANDING_SETTINGS);
		expect(
			parseBrandingSettings({
				displayName: "Existing",
				iconDataUrl: "javascript:bad",
			}),
		).toEqual(DEFAULT_BRANDING_SETTINGS);
		expect(brandingSettingsPatchSchema.parse({})).toEqual({});
		expect(brandingSettingsPatchSchema.parse({ iconDataUrl: null })).toEqual({
			iconDataUrl: null,
		});
		expect(
			brandingSettingsPatchSchema.safeParse({ url: "https://example.com" })
				.success,
		).toBe(false);
	});
});
