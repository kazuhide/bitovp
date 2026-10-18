import { beforeEach, describe, expect, it, vi } from "vitest";

const playbackCorsForManifest = vi.fn();
vi.mock("@/lib/server/playback-cors", async () => {
	const actual = await vi.importActual<
		typeof import("@/lib/server/playback-cors")
	>("@/lib/server/playback-cors");
	return {
		pageOrigin: actual.pageOrigin,
		playbackCorsForManifest: (...args: unknown[]) =>
			playbackCorsForManifest(...args),
	};
});
vi.mock("@/lib/server/context", () => ({ getServerContext: () => ({}) }));

import { GET } from "./route";

/**  residual (b) — the live twin of the VOD ratelimit pin. */

const CHANNEL = "00000000-0000-4000-8000-0000000000bb";

function req(forwardedFor: string) {
	return new Request(
		`http://test/api/live-channels/${CHANNEL}/playback-cors?manifestKey=hls`,
		{ headers: { "x-forwarded-for": forwardedFor } },
	);
}
const ctx = { params: Promise.resolve({ id: CHANNEL }) };

beforeEach(() => {
	vi.clearAllMocks();
	// Hermetic against the dev shell (review-181 N4): an exported
	// TRUSTED_PROXY_HOPS would give the 31 requests 31 distinct keys and turn
	// this file's 429 into a confusing green-then-red. (A second it here
	// would start with the bucket already exhausted — module-level limiter.)
	vi.unstubAllEnvs();
	vi.stubEnv("TRUSTED_PROXY_HOPS", "");
	playbackCorsForManifest.mockResolvedValue({
		supported: true,
		origin: "http://test",
		bucket: "b",
		verdict: { code: "OK" },
	});
});

describe("GET live playback-cors — rate limiting (ledger #61 b)", () => {
	it("refuses the 31st request and never reaches storage for it", async () => {
		const statuses: number[] = [];
		for (let i = 0; i < 31; i += 1) {
			statuses.push((await GET(req(`198.51.100.${i}`), ctx)).status);
		}
		expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
		expect(statuses[30]).toBe(429);
		expect(playbackCorsForManifest).toHaveBeenCalledTimes(30);
	});
});
