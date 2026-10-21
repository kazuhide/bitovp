import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { messagesFor, translate } from "@/lib/i18n";
import type { Translator } from "@/lib/i18n/context";
import type { CustomerErrorCode } from "./customer-error";
import {
	apiCustomerErrorCode,
	customerErrorDetails,
	localizedCustomerError,
} from "./customer-error";

const tFor = (locale: "en" | "ja"): Translator => {
	const messages = messagesFor(locale);
	return (key, values) => translate(messages, key, values);
};

describe("structured customer errors", () => {
	it.each([
		"ja",
		"en",
	] as const)("distinguishes awaiting media from unobservable readiness in %s", (locale) => {
		const pending = localizedCustomerError(
			tFor(locale),
			new ApiError(409, "raw", { code: "LIVE_VMAF_FIRST_SEGMENT_PENDING" }),
			"captureVmaf.failed",
		);
		const unknown = localizedCustomerError(
			tFor(locale),
			new ApiError(409, "secret", { code: "LIVE_VMAF_READINESS_UNOBSERVABLE" }),
			"captureVmaf.failed",
		);
		expect(pending).toMatch(
			locale === "ja"
				? /対象すべて.*少し待って/
				: /every capture target.*wait briefly/i,
		);
		expect(unknown).toMatch(
			locale === "ja" ? /出力設定.*読み取り/ : /output settings.*read access/i,
		);
		expect(unknown).not.toContain("secret");
	});
	it("does not allow safe details to replace the stable code", () => {
		expect(
			customerErrorDetails("AUTH_BUSY", {
				code: "AUTH_INVALID_CREDENTIALS",
			}),
		).toMatchObject({ code: "AUTH_BUSY" });
	});

	it("round-trips a stable code and safe interpolation details", () => {
		const details = customerErrorDetails("LIVE_RUNTIME_REQUIRES_RUNNING", {
			status: "STOPPED",
		});
		const error = new ApiError(409, "raw route prose in English", details);

		expect(apiCustomerErrorCode(error)).toBe("LIVE_RUNTIME_REQUIRES_RUNNING");
		expect(
			localizedCustomerError(tFor("ja"), error, "common.requestFailed"),
		).toBe(
			"この操作はチャンネルが RUNNING の間だけ利用できます。現在の状態は STOPPED です。チャンネルを開始し、入力の接続を確認してから再実行してください。",
		);
		expect(
			localizedCustomerError(tFor("en"), error, "common.requestFailed"),
		).toBe(
			"This operation is available while the channel is RUNNING. Its current state is STOPPED. Start the channel, confirm the input is connected, and try again.",
		);
	});

	it("never falls back to an ApiError's raw prose when the code is absent or unknown", () => {
		for (const error of [
			new ApiError(502, "Bitmovin provider-specific raw English"),
			new ApiError(502, "another raw English failure", {
				code: "A_FUTURE_CODE",
			}),
		]) {
			const visible = localizedCustomerError(
				tFor("ja"),
				error,
				"common.requestFailed",
			);
			expect(visible).toBe(
				"リクエストに失敗しました。もう一度お試しください。",
			);
			expect(visible).not.toMatch(/Bitmovin|provider|raw English/i);
		}
	});

	it("keeps safe output identity while withholding the provider diagnostic", () => {
		const error = new ApiError(
			409,
			"live VMAF capture cannot use output due to provider internals",
			customerErrorDetails("LIVE_VMAF_OUTPUT_UNREADABLE", {
				output: "archive-output",
				rendition: "video-1080p",
			}),
		);
		const visible = localizedCustomerError(
			tFor("ja"),
			error,
			"captureVmaf.failed",
		);
		expect(visible).toContain("archive-output");
		expect(visible).toContain("video-1080p");
		expect(visible).not.toMatch(/provider internals/i);
	});

	it.each<{
		code: CustomerErrorCode;
		details?: Record<string, string | number>;
		en: RegExp;
		ja: RegExp;
	}>([
		{
			code: "RESET_CLEANUP_UNCONFIRMED",
			en: /cleanup.*could not be confirmed.*administrator or support/i,
			ja: /配信リソースの後処理を確認できない.*管理者またはサポート窓口/,
		},
		{
			code: "RESET_PROVIDER_RESOURCES_UNCONFIRMED",
			en: /cloud encoding resources.*Bitmovin.*stop/i,
			ja: /クラウドのエンコーディングリソース.*Bitmovin.*停止/,
		},
		{
			code: "RESET_LOCAL_WORK_ACTIVE",
			en: /VMAF measurement or pseudo-live feed.*finish or stop/i,
			ja: /VMAF 測定または疑似ライブ配信.*完了を待つか停止/,
		},
		{
			code: "RESET_ACTIVE_WORK",
			en: /encoding or live processing.*stop/i,
			ja: /エンコーディングまたはライブ処理.*停止/,
		},
		{
			code: "RESET_STATE_CHANGED",
			en: /status changed.*review.*try again/i,
			ja: /状態が変わり.*確認.*再実行/,
		},
		{
			code: "SCHEDULE_NOT_CANCELLABLE",
			details: { status: "FIRED" },
			en: /already FIRED.*Refresh the schedule/,
			ja: /すでに FIRED.*スケジュールを更新/,
		},
		{
			code: "CONTENT_INSERT_NOT_ACTIVE",
			en: /No inserted content.*no stop is needed/,
			ja: /再生中の差し込みコンテンツはない.*停止操作は不要/,
		},
		{
			code: "FEEDER_SOURCE_UNREADABLE",
			en: /storage credential.*object path.*read permission/,
			ja: /ストレージ認証情報.*オブジェクトパス.*読み取り権限/,
		},
		{
			code: "ALERT_CHANNEL_NOT_FOUND",
			en: /Return to the channel list/,
			ja: /チャンネル一覧に戻り/,
		},
		{
			code: "STORAGE_ENDPOINT_NOT_ALLOWED",
			en: /storage endpoint.*not allowed.*administrator/i,
			ja: /ストレージ接続先.*許可されていません.*管理者/,
		},
		{
			code: "STORAGE_BROWSE_UNSUPPORTED",
			en: /cannot browse.*enter.*manually/i,
			ja: /^この認証情報では、ストレージの参照機能を使えません。バケット名とファイルのパスを手入力するか、参照できる認証情報を選択してください。$/,
		},
	])("keeps $code remediation locale-owned in JA and EN", ({
		code,
		details,
		en,
		ja,
	}) => {
		const error = new ApiError(
			409,
			"raw provider diagnostic that must never be rendered",
			customerErrorDetails(code, details),
		);
		for (const [locale, expected] of [
			["en", en],
			["ja", ja],
		] as const) {
			const visible = localizedCustomerError(
				tFor(locale),
				error,
				"common.requestFailed",
			);
			expect(visible).toMatch(expected);
			expect(visible).not.toContain("raw provider diagnostic");
		}
	});
});
