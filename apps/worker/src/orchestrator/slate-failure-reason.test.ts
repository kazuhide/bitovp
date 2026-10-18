import { describe, expect, it } from "vitest";
import {
	providerReasonClause,
	REASON_CLOCK_SKEW_MS,
	REASON_MESSAGE_CAP,
	selectProviderFailureReason,
} from "./slate-failure-reason";

const FIRED_AT = Date.parse("2026-09-02T13:40:00.000Z");
const at = (offsetSeconds: number) =>
	new Date(FIRED_AT + offsetSeconds * 1000).toISOString();

describe("selectProviderFailureReason (WP-A3)", () => {
	it("keeps ERROR and WARNING dated since the fire, oldest first, and quotes the first", () => {
		const reason = selectProviderFailureReason(
			[
				{ type: "WARNING", text: "later warning", date: at(22) },
				{ type: "ERROR", text: "the reason", date: at(21) },
				{ type: "INFO", text: "chatter", date: at(5) },
				{ type: "DEBUG", text: "noise", date: at(6) },
			],
			FIRED_AT,
		);
		expect(reason.first?.text).toBe("the reason");
		expect(reason.messages.map((m) => m.text)).toEqual([
			"the reason",
			"later warning",
		]);
	});

	it("drops messages older than the fire minus the clock tolerance, keeps those inside it", () => {
		const reason = selectProviderFailureReason(
			[
				{ type: "ERROR", text: "an hour ago", date: at(-3600) },
				{
					type: "ERROR",
					text: "just inside",
					date: at(-REASON_CLOCK_SKEW_MS / 1000),
				},
				{
					type: "ERROR",
					text: "just outside",
					date: at(-REASON_CLOCK_SKEW_MS / 1000 - 1),
				},
			],
			FIRED_AT,
		);
		expect(reason.messages.map((m) => m.text)).toEqual(["just inside"]);
	});

	it("keeps an undated or unparseable message — it cannot be excluded honestly — and orders it LAST", () => {
		const reason = selectProviderFailureReason(
			[
				{ type: "ERROR", text: "undated", date: null },
				{ type: "ERROR", text: "garbage date", date: "not-a-date" },
				{ type: "ERROR", text: "dated", date: at(21) },
			],
			FIRED_AT,
		);
		expect(reason.messages.map((m) => m.text)).toEqual([
			"dated",
			"undated",
			"garbage date",
		]);
		// The dated one is what the note quotes.
		expect(reason.first?.text).toBe("dated");
	});

	it("is case-insensitive on the severity and caps the list", () => {
		const many = Array.from({ length: REASON_MESSAGE_CAP + 5 }, (_, i) => ({
			type: i % 2 === 0 ? "error" : "Warning",
			text: `m${i}`,
			date: at(i),
		}));
		const reason = selectProviderFailureReason(many, FIRED_AT);
		expect(reason.messages).toHaveLength(REASON_MESSAGE_CAP);
		expect(reason.first?.text).toBe("m0");
	});

	it("reports no message as null", () => {
		expect(selectProviderFailureReason([], FIRED_AT)).toEqual({
			first: null,
			messages: [],
		});
	});
});

describe("providerReasonClause", () => {
	it("quotes the provider, names the absence, or names the read failure", () => {
		expect(
			providerReasonClause({
				kind: "messages",
				reason: {
					first: { type: "ERROR", text: "frame rate mismatch", date: null },
					messages: [],
				},
			}),
		).toBe("provider: frame rate mismatch");
		expect(
			providerReasonClause({
				kind: "messages",
				reason: { first: null, messages: [] },
			}),
		).toBe("provider reported no message");
		expect(
			providerReasonClause({ kind: "unreadable", error: "timed out" }),
		).toBe("provider messages could not be read: timed out");
	});
});
