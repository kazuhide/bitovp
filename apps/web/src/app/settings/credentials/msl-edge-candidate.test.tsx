import { describe, expect, it } from "vitest";
import { mslEdgeBaseUrlCandidate } from "./msl-edge-candidate";

/**
 * The MSL4 candidate rule (2026-09-02): `https://<host>` + Akamai's documented
 * event path for the format, minus the trailing slash the credential schema
 * refuses. The host is the operator's; nothing is guessed or defaulted. The
 * rendered block is exercised through `credential-form.test.tsx`.
 */
describe("mslEdgeBaseUrlCandidate", () => {
	const identity = { streamId: "2126636", eventName: "bitmovinhlsjp20260821" };

	it("assembles the measured MSL4 Production root from host + HLS + identity", () => {
		expect(
			mslEdgeBaseUrlCandidate({
				host: "bitmovinmsl4hlsjp.akamaized.net",
				format: "HLS",
				...identity,
			}),
		).toBe(
			"https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/bitmovinhlsjp20260821",
		);
	});

	it("keys the event-root prefix off the stream format", () => {
		for (const [format, prefix] of [
			["HLS", "hls"],
			["DASH", "dash"],
			["CMAF", "cmaf"],
		] as const) {
			expect(
				mslEdgeBaseUrlCandidate({
					host: "x.akamaized.net",
					format,
					...identity,
				}),
			).toBe(
				`https://x.akamaized.net/${prefix}/live/2126636/bitmovinhlsjp20260821`,
			);
		}
	});

	it("lower-cases and trims the host, and percent-encodes the event name", () => {
		expect(
			mslEdgeBaseUrlCandidate({
				host: "  X.Akamaized.NET ",
				format: "HLS",
				streamId: 7,
				eventName: "my event",
			}),
		).toBe("https://x.akamaized.net/hls/live/7/my%20event");
	});

	it.each([
		["an empty host", { host: "", format: "HLS", ...identity }],
		[
			"a URL in the host box",
			{ host: "https://x.akamaized.net", format: "HLS", ...identity },
		],
		[
			"a host with a path",
			{ host: "x.akamaized.net/hls", format: "HLS", ...identity },
		],
		[
			"a host with a port",
			{ host: "x.akamaized.net:443", format: "HLS", ...identity },
		],
		[
			"a missing stream id",
			{ host: "x.akamaized.net", format: "HLS", streamId: "", eventName: "ev" },
		],
		[
			"a non-numeric stream id",
			{
				host: "x.akamaized.net",
				format: "HLS",
				streamId: "abc",
				eventName: "ev",
			},
		],
		[
			"a zero stream id",
			{ host: "x.akamaized.net", format: "HLS", streamId: 0, eventName: "ev" },
		],
		[
			"a fractional stream id",
			{
				host: "x.akamaized.net",
				format: "HLS",
				streamId: "1.5",
				eventName: "ev",
			},
		],
		[
			"a missing event name",
			{ host: "x.akamaized.net", format: "HLS", streamId: 1, eventName: "" },
		],
		[
			"an undefined event name",
			{
				host: "x.akamaized.net",
				format: "HLS",
				streamId: 1,
				eventName: undefined,
			},
		],
	] as const)("is null for %s — no partial candidate is ever offered", (_name, args) => {
		expect(mslEdgeBaseUrlCandidate(args)).toBeNull();
	});
});
