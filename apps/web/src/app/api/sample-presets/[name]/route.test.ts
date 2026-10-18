import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/sample-presets/[name]", () => {
	it("returns the plan JSON for a known preset", async () => {
		const res = await GET(new Request("http://test"), {
			params: Promise.resolve({ name: "fixed-bitrate-hls-on-aws" }),
		});
		expect(res.status).toBe(200);
		// Presets are immutable per build — cacheable on the 200 path only.
		expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.planVersion).toBe(1);
		expect(body.name).toBe("h264-aac-fmp4-fixed-bitrate-hls-aws");
	});

	it("404s for unknown presets", async () => {
		const res = await GET(new Request("http://test"), {
			params: Promise.resolve({ name: "not-a-preset" }),
		});
		expect(res.status).toBe(404);
	});

	it("404s for prototype-chain names instead of leaking objects", async () => {
		for (const name of ["__proto__", "constructor", "toString"]) {
			const res = await GET(new Request("http://test"), {
				params: Promise.resolve({ name }),
			});
			expect(res.status).toBe(404);
		}
	});
});
