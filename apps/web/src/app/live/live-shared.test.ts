import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { messagesFor, translate } from "@/lib/i18n";
import type { Translator } from "@/lib/i18n/context";
import {
	actionFailureMessage,
	isActiveChannelStatus,
	LIVE_STATUS_TONE,
	liveStatusPresentation,
} from "./live-shared";

/** Real catalogues, not stubs — the frame's WORDING is part of the contract. */
const tFor = (locale: "en" | "ja"): Translator => {
	const messages = messagesFor(locale);
	return (key, values) => translate(messages, key, values);
};

describe("actionFailureMessage (route 409 → readable copy, ledger #101)", () => {
	const en = tFor("en");

	it("renders a coded lifecycle refusal in the selected locale instead of route prose", () => {
		const err = new ApiError(
			409,
			"Only RUNNING or ERROR channels can be stopped (status: STOPPED)",
			{ code: "LIVE_ACTION_NOT_STOPPABLE", status: "STOPPED" },
		);
		expect(actionFailureMessage(en, "stop", err)).toBe(
			"Channel stop rejected: The channel is STOPPED. Stop is available while it is RUNNING or ERROR. Refresh the page and check its current state.",
		);
		expect(actionFailureMessage(tFor("ja"), "stop", err)).toBe(
			"チャンネルの停止を実行できませんでした：チャンネルの状態は STOPPED です。停止できるのは RUNNING または ERROR のときです。画面を更新し、現在の状態を確認してください。",
		);
	});

	it("labels parameter actions readably", () => {
		const err = new ApiError(
			409,
			"Timeshift can only be reset on a RUNNING channel (status: STOPPED)",
			{ code: "LIVE_ACTION_TIMESHIFT_REQUIRES_RUNNING", status: "STOPPED" },
		);
		expect(actionFailureMessage(en, "reset-timeshift", err)).toMatch(
			/^Timeshift reset rejected: Timeshift can be reset/,
		);
		expect(
			actionFailureMessage(
				en,
				"scte35",
				new ApiError(
					409,
					"SCTE-35 cues need a RUNNING channel (status: ERROR)",
					{ code: "LIVE_ACTION_CUE_REQUIRES_RUNNING", status: "ERROR" },
				),
			),
		).toMatch(/^SCTE-35 cue insertion rejected:/);
	});

	it("withholds unstructured API diagnostics", () => {
		expect(
			actionFailureMessage(
				en,
				"start",
				new ApiError(503, "Server key configuration error"),
			),
		).toBe(
			"Channel start failed: The request could not be completed. Refresh the page and try again; if it still fails, contact an administrator.",
		);
	});

	it("never renders private registry references from unstructured route prose", () => {
		// Split only so the repository's separate source-pointer census does not
		// count this deliberately planted customer-error payload as provenance.
		const privatePointer = "led" + "ger #108";
		for (const message of [
			`Restart refused — provider state is terminal (${privatePointer})`,
			`Restart refused — provider state is terminal; ${privatePointer}`,
		]) {
			const visible = actionFailureMessage(
				en,
				"restart",
				new ApiError(409, message),
			);
			expect(visible).toContain("The request could not be completed");
			expect(visible).not.toMatch(/ledger|#108/i);
		}
	});

	it("degrades to a generic line for non-API errors (no internals leaked)", () => {
		expect(actionFailureMessage(en, "restart", new TypeError("boom"))).toBe(
			"Channel restart failed. Refresh the page and try again; contact an administrator if it continues.",
		);
	});

	it("localizes both the frame and coded reason in ja without mixed-language output", () => {
		const ja = tFor("ja");
		const err = new ApiError(
			409,
			"Only RUNNING or ERROR channels can be stopped (status: STOPPED)",
			{ code: "LIVE_ACTION_NOT_STOPPABLE", status: "STOPPED" },
		);
		expect(actionFailureMessage(ja, "stop", err)).toBe(
			"チャンネルの停止を実行できませんでした：チャンネルの状態は STOPPED です。停止できるのは RUNNING または ERROR のときです。画面を更新し、現在の状態を確認してください。",
		);
		expect(actionFailureMessage(ja, "stop", err)).not.toContain("Only");
		expect(actionFailureMessage(ja, "restart", new TypeError("boom"))).toBe(
			"チャンネルの再起動に失敗しました。画面を更新して再実行し、解消しない場合は管理者に連絡してください。",
		);
	});
});

describe("channel status helpers", () => {
	it("flags transitional + steady states as active for auto-refresh", () => {
		expect(isActiveChannelStatus("PROVISIONING")).toBe(true);
		expect(isActiveChannelStatus("RUNNING")).toBe(true);
		expect(isActiveChannelStatus("STOPPING")).toBe(true);
		expect(isActiveChannelStatus("CREATED")).toBe(false);
		expect(isActiveChannelStatus("STOPPED")).toBe(false);
		expect(isActiveChannelStatus("ERROR")).toBe(false);
	});

	it("tones RUNNING ok and ERROR error", () => {
		expect(LIVE_STATUS_TONE.RUNNING).toBe("ok");
		expect(LIVE_STATUS_TONE.ERROR).toBe("error");
		expect(LIVE_STATUS_TONE.STOPPED).toBe("neutral");
	});

	it("never presents a locally RUNNING channel as confirmed green while the provider is UNKNOWN or UNOBSERVED", () => {
		expect(liveStatusPresentation("RUNNING", "UNKNOWN")).toEqual({
			tone: "warn",
			providerUnconfirmed: true,
		});
		expect(liveStatusPresentation("RUNNING", "UNOBSERVED")).toEqual({
			tone: "warn",
			providerUnconfirmed: true,
		});
		expect(liveStatusPresentation("RUNNING", "RUNNING")).toEqual({
			tone: "ok",
			providerUnconfirmed: false,
		});
		expect(liveStatusPresentation("STOPPED", "UNOBSERVED")).toEqual({
			tone: "neutral",
			providerUnconfirmed: false,
		});
	});
});
