import { describe, expect, it } from "vitest";
import {
	assertSupportedImagePatterns,
	UnsupportedImagePatternError,
} from "../../config/image-pattern-policy";

describe("Next image pattern policy", () => {
	it("accepts the current default image configuration and empty lists", () => {
		for (const config of [
			{},
			{ images: {} },
			{ images: { remotePatterns: [] } },
			{ images: { localPatterns: [], remotePatterns: [] } },
		]) {
			expect(() => assertSupportedImagePatterns(config)).not.toThrow();
		}
	});

	it("rejects custom remote patterns with an actionable typed error", () => {
		const check = () =>
			assertSupportedImagePatterns({
				images: { remotePatterns: [{ hostname: "images.example.com" }] },
			});

		expect(check).toThrow(UnsupportedImagePatternError);
		expect(check).toThrow(
			expect.objectContaining({
				code: "ERR_UNSUPPORTED_NEXT_IMAGE_PATTERNS",
				message: expect.stringContaining("images.remotePatterns"),
			}),
		);
		expect(check).toThrow(/unpatched vendored picomatch/);
	});

	it("rejects URL-form remote patterns before Next compiles them", () => {
		expect(() =>
			assertSupportedImagePatterns({
				images: { remotePatterns: [new URL("https://images.example.com/**")] },
			}),
		).toThrow(UnsupportedImagePatternError);
	});

	it("rejects custom local patterns, including ordinary path restrictions", () => {
		expect(() =>
			assertSupportedImagePatterns({
				images: { localPatterns: [{ pathname: "/assets/**" }] },
			}),
		).toThrow(/images.localPatterns/);
	});

	it("rejects repeated extglobs without compiling or testing the pattern", () => {
		expect(() =>
			assertSupportedImagePatterns({
				images: { localPatterns: [{ pathname: "/+(*a)" }] },
			}),
		).toThrow(UnsupportedImagePatternError);
	});

	it("does not let unoptimized mode bypass the configuration boundary", () => {
		expect(() =>
			assertSupportedImagePatterns({
				images: {
					unoptimized: true,
					remotePatterns: [{ hostname: "images.example.com" }],
				},
			}),
		).toThrow(UnsupportedImagePatternError);
	});
});
