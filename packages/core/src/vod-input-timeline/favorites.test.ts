import { describe, expect, it } from "vitest";
import * as timeline from "./index";

const id = "00000000-0000-4000-8000-000000000001";
const favorite = {
	credentialId: id,
	bucket: "input",
	objectKey: "common/番組ロゴ.png",
	label: "番組ロゴ",
	kind: "IMAGE",
};

describe("VOD fixed source contracts", () => {
	it.each([
		"VIDEO",
		"AUDIO",
		"IMAGE",
	])("accepts a bounded %s reference", (kind) => {
		expect(
			timeline.vodInputFavoriteCreateSchema.parse({ ...favorite, kind }),
		).toEqual({ ...favorite, kind });
	});
	it.each([
		{ ...favorite, credentialId: "other-org" },
		{
			...favorite,
			objectKey: "https://storage.invalid/logo.png?signature=secret",
		},
		{ ...favorite, objectKey: "/Users/me/logo.png" },
		{ ...favorite, objectKey: "common/" },
		{ ...favorite, objectKey: "" },
		{ ...favorite, objectKey: "../logo.png" },
		{ ...favorite, label: " " },
		{ ...favorite, kind: "SECRET" },
		{ ...favorite, signedUrl: "https://private.invalid/?secret=redacted" },
		{ ...favorite, secret: "not-stored" },
	])("rejects invalid or secret-bearing input %#", (value) => {
		expect(timeline.vodInputFavoriteCreateSchema.safeParse(value).success).toBe(
			false,
		);
	});
	it("distinguishes an absent row from a malformed or over-capacity row", () => {
		expect(timeline.parseVodInputFavorites(undefined)).toEqual({
			schemaVersion: 1,
			items: [],
		});
		for (const value of [
			null,
			{},
			{ schemaVersion: 2, items: [] },
			{ schemaVersion: 1, items: "broken" },
		]) {
			expect(() => timeline.parseVodInputFavorites(value)).toThrow();
		}
		expect(() =>
			timeline.parseVodInputFavorites({
				schemaVersion: 1,
				items: Array.from(
					{ length: timeline.MAX_VOD_INPUT_FAVORITES + 1 },
					(_, n) => ({
						...favorite,
						id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
						objectKey: `image-${n}.png`,
					}),
				),
			}),
		).toThrow();
	});
	it("rejects duplicate ids and duplicate storage references in persisted data", () => {
		const item = { ...favorite, id };
		for (const second of [
			{ ...item, objectKey: "other.png" },
			{ ...item, id: "00000000-0000-4000-8000-000000000002" },
		]) {
			expect(() =>
				timeline.parseVodInputFavorites({
					schemaVersion: 1,
					items: [item, second],
				}),
			).toThrow();
		}
	});
});
