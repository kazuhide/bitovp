import { compileLiveChannel, liveChannelPlanSchema } from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../../../packages/core/src/live/__fixtures__/live-srt-listener.plan.json";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());
it.each([
	"CHUNKED_TEXT",
	"FMP4",
] as const)("executes %s Live OCR across the installed SDK using generated resource IDs", async (packaging) => {
	const track = {
		key: "ja",
		position: 2,
		inputPath: "/",
		language: "ja",
		label: "日本語",
		packaging,
		segmentLength: 6,
		destination: { outputKey: "origin", path: "out/subtitles/ja" },
	};
	const p = liveChannelPlanSchema.parse({ ...fixture, dvbSubtitles: [track] });
	const operations = compileLiveChannel(p).filter(
		(o) => o.step.startsWith("dvb:") || o.step.includes(":dvb:"),
	);
	const requests: { path: string; body: Record<string, unknown> }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			if (init.method !== "POST") throw Error("unexpected fixture method");
			requests.push({
				path: new URL(url).pathname,
				body: JSON.parse(String(init.body)),
			});
			return Response.json({
				status: "SUCCESS",
				data: { result: { id: `receipt-${requests.length}` } },
			});
		}),
	);
	const sdk = createBitmovinSdkOps({ apiKey: "offline-only" }, async () => {});
	const ids = new Map([
		["encoding", "enc"],
		["live-input:main", "transport"],
		["output:origin", "store"],
		["manifest:hls", "hls-id"],
		["manifest:dash", "dash-id"],
		["manifest:dash:period", "period-id"],
	]);
	for (const op of operations) {
		const result = await executeStep(op, {
			sdk,
			ids,
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 100, sleep: async () => {} },
		});
		if (!result.resourceId) throw Error("Missing created resource");
		ids.set(op.step, result.resourceId);
	}
	expect(requests[0]).toMatchObject({
		path: "/v1/encoding/encodings/enc/input-streams/subtitles/dvb-subtitle",
		body: {
			type: "DVB_SUBTITLE",
			inputId: "transport",
			position: 2,
			inputPath: "/",
			selectionMode: "POSITION_ABSOLUTE",
		},
	});
	expect(requests[1]?.path).toBe(
		"/v1/encoding/configurations/subtitles/webvtt",
	);
	expect(requests[2]).toMatchObject({
		path: "/v1/encoding/encodings/enc/streams",
		body: {
			codecConfigId: "receipt-2",
			inputStreams: [{ inputStreamId: "receipt-1" }],
		},
	});
	const name = packaging === "FMP4" ? "fmp4" : "chunked-text";
	expect(requests[3]).toMatchObject({
		path: `/v1/encoding/encodings/enc/muxings/${name}`,
		body: {
			streams: [{ streamId: "receipt-3" }],
			outputs: [{ outputId: "store", outputPath: "out/subtitles/ja" }],
		},
	});
	const sub = requests.find((r) => r.path.includes("/adaptationsets/subtitle"));
	expect(sub?.body).toMatchObject({ lang: "ja" });
	const rep = requests.find((r) => r.path.includes("/representations/"));
	expect(rep?.path).toContain(
		`/periods/period-id/adaptationsets/${ids.get("manifest:dash:dvb:ja:set")}/representations/${name}`,
	);
	expect(rep?.body).toMatchObject({ muxingId: "receipt-4", encodingId: "enc" });
	const media = requests.find((r) => r.path.includes("/media/subtitles"));
	if (packaging === "CHUNKED_TEXT")
		expect(media?.body).toMatchObject({
			muxingId: "receipt-4",
			streamId: "receipt-3",
			groupId: "subtitles",
			language: "ja",
			uri: "subtitles_ja.m3u8",
		});
	else expect(media).toBeUndefined();
});
