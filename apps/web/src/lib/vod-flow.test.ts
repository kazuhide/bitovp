import { describe, expect, it } from "vitest";
import { parseVodFlow, resolveVodFlow, vodFlowHref } from "./vod-flow";

describe("the flow a new VOD job opens in", () => {
	it.each([
		["streaming", "streaming"],
		["file", "file"],
		["FILE", undefined],
		["", undefined],
		[null, undefined],
		[undefined, undefined],
	] as const)("reads %j as %j", (value, flow) => {
		expect(parseVodFlow(value)).toBe(flow);
	});

	it.each([
		// The URL decides, whatever was remembered.
		["file", "streaming", "file"],
		["streaming", "file", "streaming"],
		// Without a usable URL value, the flow last chosen in this browser.
		[undefined, "file", "file"],
		[null, "file", "file"],
		["mezzanine", "file", "file"],
		// With neither, the flow the wizard had before there were two.
		[undefined, undefined, "streaming"],
		[undefined, "mezzanine", "streaming"],
	] as const)("resolves ?flow=%j with %j remembered to %j", (param, remembered, flow) => {
		expect(resolveVodFlow(param, remembered)).toBe(flow);
	});

	it("gives each flow a URL that resolves back to it", () => {
		for (const flow of ["streaming", "file"] as const) {
			const url = new URL(vodFlowHref(flow), "https://app.invalid");
			expect(url.pathname).toBe("/vod/new");
			expect(resolveVodFlow(url.searchParams.get("flow"), undefined)).toBe(
				flow,
			);
		}
	});
});
