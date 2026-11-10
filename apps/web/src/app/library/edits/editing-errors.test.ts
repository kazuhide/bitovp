import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { translate } from "@/lib/i18n";
import type { Translator } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/messages/en";
import { ja } from "@/lib/i18n/messages/ja";
import { editingErrorMessage } from "./editing-errors";

describe("editing error messages", () => {
	const english: Translator = (key, values) => translate(en, key, values);
	const japanese: Translator = (key, values) => translate(ja, key, values);
	it("maps known codes and conflict without exposing backend identifiers", () => {
		expect(
			editingErrorMessage(new ApiError(409, "EDIT_CONFLICT"), english),
		).toBe(en.editing.conflict);
		expect(editingErrorMessage("SOURCE_OUT_OF_BOUNDS", japanese)).toBe(
			ja.editing.rangeInvalid,
		);
		expect(editingErrorMessage("UNCONFIRMED_FRAMING", english)).toBe(
			en.editing.errors.unconfirmed,
		);
	});
	it("shows a safe fallback for unknown failures instead of raw private error text", () => {
		expect(
			editingErrorMessage(new Error("secret bucket/private.mp4"), english),
		).toBe(en.editing.failed);
		expect(editingErrorMessage({ detail: "secret" }, japanese)).toBe(
			ja.editing.failed,
		);
	});
	it.each([
		"CLIP_EDITING_UNAVAILABLE",
		"LOCAL_STORY_ENGINE_UNAVAILABLE",
		"LOCAL_SEMANTIC_UNAVAILABLE",
	])("explains unavailable editing for %s", (code) => {
		expect(editingErrorMessage(new ApiError(503, code), english)).toMatch(
			/editing service.*unavailable/i,
		);
		expect(editingErrorMessage(new ApiError(503, code), japanese)).toMatch(
			/編集サービス/,
		);
	});
	it("explains unsupported HLS with a usable next step", () => {
		expect(editingErrorMessage("HLS_UNSUPPORTED", english)).toMatch(/HLS.*MP4/);
		expect(editingErrorMessage("HLS_UNSUPPORTED", japanese)).toMatch(
			/HLS.*MP4/,
		);
	});
	it("explains HLS preparation limits without exposing storage details", () => {
		expect(editingErrorMessage("HLS_LIMIT", english)).toMatch(
			/limits.*MP4.*shorter/,
		);
		expect(editingErrorMessage("HLS_LIMIT", japanese)).toMatch(
			/上限.*MP4.*短い/,
		);
	});
	it.each([
		401, 403,
	])("explains authentication/permission failure%s without raw text", (status) => {
		const message = editingErrorMessage(
			new ApiError(status, "private backend location"),
			english,
		);
		expect(message).toMatch(status === 401 ? /sign in/i : /permission/i);
		expect(message).not.toContain("private");
	});
	it("uses the safe machine-readable API code when the outer message is generic", () => {
		expect(
			editingErrorMessage(
				new ApiError(422, "private storage response", {
					code: "HLS_UNSUPPORTED",
				}),
				english,
			),
		).toMatch(/HLS.*MP4/);
	});
});
