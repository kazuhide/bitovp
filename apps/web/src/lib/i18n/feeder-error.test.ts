import {
	feederError,
	feederErrorEnglish,
	MEDIA_ATTRIBUTE_NAMES,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { isInternalFeederError } from "@/lib/feeder-error-audience";
import { type Locale, type MessageKey, messagesFor, translate } from ".";
import { customerFeederErrorMessage, feederErrorMessage } from "./feeder-error";
import { mediaAttributeLabel, mediaDifferenceText } from "./media-difference";

/** A translator identical to the one `LocaleProvider` builds. */
function translator(locale: Locale) {
	const messages = messagesFor(locale);
	return (key: MessageKey, values?: Record<string, string | number>) =>
		translate(messages, key, values);
}

const en = translator("en");
const ja = translator("ja");

const DIFF = "frame rate 30000/1001 → 24/1\nH.264 profile Main → High";

describe("structured media differences", () => {
	it("covers every emitted media attribute, keeps EN notification parity and translates presence only", () => {
		for (const attribute of MEDIA_ATTRIBUTE_NAMES) {
			expect(mediaAttributeLabel(ja, attribute)).not.toBe(attribute);
			expect(mediaAttributeLabel(en, attribute)).toBe(attribute);
			const stored = feederError("slateMismatch", {}, [
				{ attribute, reference: "48", candidate: "44.1", blocking: true },
			]);
			expect(feederErrorMessage(en, stored)).toBe(feederErrorEnglish(stored));
		}
		expect(
			mediaDifferenceText(ja, {
				attribute: "video stream",
				reference: "present",
				candidate: "absent",
			}),
		).toBe("映像ストリーム あり → なし");
		expect(mediaAttributeLabel(ja, "__proto__")).toBe("不明な属性");
	});
	it.each([
		"sourceMismatch",
		"slateMismatch",
	] as const)("localizes %s attributes and planned normalization without changing values", (code) => {
		const stored = feederError(code, { originKind: "runSource" }, [
			{
				attribute: "frame rate",
				reference: "30000/1001",
				candidate: "24/1",
				blocking: true,
			},
			{
				attribute: "resolution",
				reference: "1920×1080",
				candidate: "1280×720",
				blocking: false,
			},
		]);
		const out = feederErrorMessage(ja, stored);
		expect(out).toContain("フレームレート 30000/1001 → 24/1");
		expect(out).toContain("解像度 1920×1080 → 1280×720");
		expect(out).not.toMatch(/frame rate|resolution|re-encoded|blocking/);
		expect(feederErrorMessage(en, stored)).toBe(feederErrorEnglish(stored));
		if (code === "sourceMismatch") {
			expect(out).toContain("（一致するよう再エンコード予定）");
			expect(feederErrorEnglish(stored)).toContain(
				"(will be re-encoded to match)",
			);
		} else {
			expect(out).not.toContain("再エンコード");
			expect(feederErrorEnglish(stored)).not.toContain("re-encoded");
		}
	});
	it.each([
		"ja",
		"en",
	] as const)("uses localized generic copy when optional detail and params are unusable in %s", (locale) => {
		const t = translator(locale);
		const stored = JSON.stringify({
			code: "slateMismatch",
			params: {},
			differences: [
				{
					attribute: "INTERNAL_BAD",
					reference: "x",
					candidate: "y",
					blocking: false,
				},
			],
		});
		expect(feederErrorMessage(t, stored)).toBe(t("feeder.internalFailure"));
		expect(customerFeederErrorMessage(t, stored)).toBe(
			t("feeder.internalFailure"),
		);
		expect(feederErrorEnglish(stored)).toBe(en("feeder.internalFailure"));
	});
	it.each([
		"ja",
		"en",
	] as const)("uses legacy params for a future unknown attribute in %s", (locale) => {
		const t = translator(locale);
		const params = {
			originKind: "runSource",
			differences: "color primaries bt709 → bt2020",
		};
		const stored = JSON.stringify({
			code: "sourceMismatch",
			params,
			differences: [
				{
					attribute: "color primaries",
					reference: "bt709",
					candidate: "bt2020",
					blocking: true,
				},
			],
		});
		const expected = feederErrorMessage(
			t,
			feederError("sourceMismatch", params),
		);
		expect(feederErrorMessage(t, stored)).toBe(expected);
		expect(customerFeederErrorMessage(t, stored)).toBe(expected);
		expect(expected).toContain(params.differences);
		expect(expected).not.toContain('"code"');
	});
});

describe("feederErrorMessage", () => {
	it.each([
		"toString",
		"constructor",
		"__proto__",
		"hasOwnProperty",
		7,
		null,
		false,
	])("keeps JA/EN/customer and English notification generic for bad origin %j", (originKind) => {
		const stored = JSON.stringify({
			code: "sourceMismatch",
			params: { originKind, differences: "x" },
		});
		for (const t of [ja, en]) {
			expect(feederErrorMessage(t, stored)).toBe(t("feeder.internalFailure"));
			expect(customerFeederErrorMessage(t, stored)).toBe(
				t("feeder.internalFailure"),
			);
		}
		expect(feederErrorEnglish(stored)).toBe(en("feeder.internalFailure"));
	});
	it("renders a sourceMismatch in EN with origin + diff interpolated", () => {
		const stored = feederError("sourceMismatch", {
			originKind: "runSource",
			differences: DIFF,
		});
		expect(feederErrorMessage(en, stored)).toBe(
			"Source does not match what this channel is ingesting (the source this run started on) — the encoder would warn on the attribute change and drop the input, leaving the playlist advancing on a frozen picture:\n" +
				DIFF,
		);
	});

	it("renders a sourceMismatch in JA — the localized sentence, origin phrase and diff", () => {
		const stored = feederError("sourceMismatch", {
			originKind: "heartbeat",
			differences: "frame rate 29.97 → 24/1",
		});
		expect(feederErrorMessage(ja, stored)).toBe(
			"素材がこのチャンネルの入力と一致しません（比較対象: エンコーダの最新ハートビート）。エンコーダが入力の変化を検出して切断するため、プレイリストが更新されても映像が止まる場合があります:\nframe rate 29.97 → 24/1",
		);
	});

	it("renders ingestUnsatisfied in EN and JA with the problem detail", () => {
		const stored = feederError("ingestUnsatisfied", {
			detail: 'ingest "audio" needs audio, but the source carries video, data',
		});
		expect(feederErrorMessage(en, stored)).toBe(
			'Source cannot satisfy the channel\'s ingest: ingest "audio" needs audio, but the source carries video, data. The encoder would accept the connection and publish nothing.',
		);
		const jaMsg = feederErrorMessage(ja, stored);
		expect(jaMsg).toContain(
			"エンコーダが接続を受け付けても、配信の出力は生成されません。",
		);
		expect(jaMsg).toContain('ingest "audio" needs audio');
	});

	it("renders slatePosition in EN and JA naming what sits at position 0", () => {
		const stored = feederError("slatePosition", { found: "audio" });
		expect(feederErrorMessage(en, stored)).toContain(
			"video stream at stream position 0, and this file carries audio there",
		);
		const jaMsg = feederErrorMessage(ja, stored);
		expect(jaMsg).toContain(
			"Bitmovin では先頭（位置 0）に映像ストリームが必要ですが、このファイルでは audio です。",
		);
		expect(jaMsg).toContain("audio");
	});

	it("renders slateMismatch in JA with the diff appended", () => {
		const stored = feederError("slateMismatch", {
			differences: "resolution 1920×1080 → 1280×720",
		});
		const jaMsg = feederErrorMessage(ja, stored);
		expect(jaMsg).toContain("挿入時（オンエア時）に失敗します");
		expect(jaMsg).toContain("resolution 1920×1080 → 1280×720");
	});

	// Legacy rows predate the structured/localizable contract and may contain
	// process or provider diagnostics. They therefore use locale-owned copy;
	// the stored value remains available only through ADMIN Diagnostics.
	it("replaces a legacy plain-string error with locale-owned copy", () => {
		const legacy =
			"ffprobe failed (code 1): moov atom not found\nsecond line kept";
		expect(feederErrorMessage(en, legacy)).toBe(
			"The file input could not continue. Ask an administrator to review Diagnostics.",
		);
		expect(feederErrorMessage(ja, legacy)).toBe(
			"ファイル入力を継続できませんでした。管理者に診断情報の確認を依頼してください。",
		);
		expect(feederErrorMessage(en, legacy)).not.toContain("ffprobe");
	});

	// A malformed structured error must never throw the panel down. `translate`
	// throws on an unfilled `{placeholder}`; the helper catches it and falls
	// back to localized generic copy, never a developer code.
	it("does not throw when a structured error is missing its params", () => {
		const noParams = feederError("sourceMismatch", {});
		expect(() => feederErrorMessage(ja, noParams)).not.toThrow();
		expect(feederErrorMessage(ja, noParams)).toBe(ja("feeder.internalFailure"));

		const badOrigin = feederError("sourceMismatch", { differences: DIFF });
		expect(feederErrorMessage(en, badOrigin)).toBe(
			en("feeder.internalFailure"),
		);
	});
});

describe("customerFeederErrorMessage", () => {
	it("replaces legacy process diagnostics while preserving the stored record for Diagnostics", () => {
		const internal =
			"worker lost ffmpeg PID 4242 while -stream_loop remained active";
		expect(customerFeederErrorMessage(en, internal)).toBe(
			"The file input could not continue. Ask an administrator to review Diagnostics.",
		);
		expect(customerFeederErrorMessage(ja, internal)).toBe(
			"ファイル入力を継続できませんでした。管理者に診断情報の確認を依頼してください。",
		);
	});

	it("keeps localized structured errors but never trusts legacy prose", () => {
		const structured = feederError("sourceMismatch", {
			originKind: "runSource",
			differences: DIFF,
		});
		expect(customerFeederErrorMessage(en, structured)).toBe(
			feederErrorMessage(en, structured),
		);
		const legacy = "The source file is unavailable in the selected bucket.";
		expect(customerFeederErrorMessage(en, legacy)).toBe(
			"The file input could not continue. Ask an administrator to review Diagnostics.",
		);
		expect(customerFeederErrorMessage(en, legacy)).not.toContain(
			"selected bucket",
		);
	});

	it("never classifies a structured refusal as raw process diagnostics", () => {
		const structured = feederError("ingestUnsatisfied", {
			detail: "the source metadata contains an ffmpeg-labelled tag",
		});
		expect(isInternalFeederError(structured)).toBe(false);
	});
});

/**
 *  review DRIFT PIN: core's `feederErrorEnglish` (the worker's
 * notification path) and the web `en.ts` catalogue (the panel's `en` render)
 * hold the SAME English in two files. This asserts they produce byte-identical
 * output for every code, so an edit to one that forgets the other fails here
 * instead of shipping two English truths that quietly disagree.
 */
describe("feederErrorEnglish matches the en.ts catalogue (no drift)", () => {
	const cases: { name: string; stored: string }[] = [
		{
			name: "ingestUnsatisfied",
			stored: feederError("ingestUnsatisfied", {
				detail: 'ingest "audio" needs audio, but the source carries video',
			}),
		},
		{
			name: "sourceMismatch · runSource",
			stored: feederError("sourceMismatch", {
				originKind: "runSource",
				differences: DIFF,
			}),
		},
		{
			name: "sourceMismatch · heartbeat",
			stored: feederError("sourceMismatch", {
				originKind: "heartbeat",
				differences: "frame rate 29.97 → 24/1",
			}),
		},
		{
			name: "slatePosition",
			stored: feederError("slatePosition", { found: "audio" }),
		},
		{
			name: "slateMismatch",
			stored: feederError("slateMismatch", {
				differences: "resolution 1920×1080 → 1280×720",
			}),
		},
		{ name: "slateImage", stored: feederError("slateImage") },
	];

	it.each(cases)("$name — core English equals the en-locale render", ({
		stored,
	}) => {
		expect(feederErrorEnglish(stored)).toBe(feederErrorMessage(en, stored));
	});
});
