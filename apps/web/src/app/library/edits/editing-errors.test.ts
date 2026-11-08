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
});
