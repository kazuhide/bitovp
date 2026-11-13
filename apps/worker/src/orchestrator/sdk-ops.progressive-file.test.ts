import {
	ProgressiveMovMuxing,
	ProgressiveTsMuxing,
	ProgressiveWebmMuxing,
} from "@bitmovin/api-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The gateway for the three whole-file muxings, against the SDK's own models.
 *
 * Offline evidence only: these arms prove which SDK endpoint is called and
 * what the request model holds. They do not prove Bitmovin accepts it — the
 * progressive MOV request in particular has never been sent by this app, and
 * no run of a progressive WebM holding two streams is on record.
 */
const api = vi.hoisted(() => ({
	tsCreate: vi.fn(),
	tsList: vi.fn(),
	tsCustomData: vi.fn(),
	movCreate: vi.fn(),
	movList: vi.fn(),
	movCustomData: vi.fn(),
	webmCreate: vi.fn(),
	webmList: vi.fn(),
	webmCustomData: vi.fn(),
	segmentedTsCreate: vi.fn(),
	segmentedWebmCreate: vi.fn(),
	mp4Create: vi.fn(),
}));

vi.mock("@bitmovin/api-sdk", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bitmovin/api-sdk")>();
	class FakeBitmovinApi {
		encoding = {
			encodings: {
				muxings: {
					progressiveTs: {
						create: api.tsCreate,
						list: api.tsList,
						customdata: { get: api.tsCustomData },
					},
					progressiveMov: {
						create: api.movCreate,
						list: api.movList,
						customdata: { get: api.movCustomData },
					},
					progressiveWebm: {
						create: api.webmCreate,
						list: api.webmList,
						customdata: { get: api.webmCustomData },
					},
					ts: { create: api.segmentedTsCreate },
					webm: { create: api.segmentedWebmCreate },
					mp4: { create: api.mp4Create },
				},
			},
		};
	}
	return { ...actual, default: FakeBitmovinApi };
});

import { createBitmovinSdkOps } from "./sdk-ops";

const tsParams = {
	streamId: "video-stream",
	additionalStreamIds: ["audio-stream"],
	filename: "video.ts",
	segmentLength: 4,
	startOffset: 10,
	destination: { outputId: "output-1", outputPath: "files/" },
	name: "Video Progressive TS Muxing 360p",
};
const movParams = {
	streamId: "video-stream",
	additionalStreamIds: ["audio-stream"],
	filename: "video.mov",
	destination: { outputId: "output-1", outputPath: "files/" },
	name: "Video Progressive MOV Muxing 360p",
};
const webmParams = {
	streamId: "video-stream",
	additionalStreamIds: ["audio-stream"],
	filename: "video.webm",
	destination: { outputId: "output-1", outputPath: "files/" },
	name: "Video Progressive WebM Muxing 360p",
};

function setup(window = false) {
	const audit = vi.fn(async () => {});
	const ops = createBitmovinSdkOps(
		{
			apiKey: "test-key",
			stamp: {
				jobId: "job-1",
				currentStep: () => "muxing:file",
				adoptWindow: () => window,
			},
		},
		audit,
	);
	return { ops, audit };
}

beforeEach(() => {
	vi.resetAllMocks();
	api.tsCreate.mockResolvedValue({ id: "ts-new" });
	api.tsList.mockResolvedValue({ items: [] });
	api.movCreate.mockResolvedValue({ id: "mov-new" });
	api.movList.mockResolvedValue({ items: [] });
	api.webmCreate.mockResolvedValue({ id: "webm-new" });
	api.webmList.mockResolvedValue({ items: [] });
});

describe("progressive TS gateway", () => {
	it("creates a ProgressiveTsMuxing on its own endpoint, video stream first", async () => {
		const { ops, audit } = setup();
		await expect(
			ops.createProgressiveTsMuxing("enc-1", tsParams),
		).resolves.toBe("ts-new");
		expect(api.tsCreate).toHaveBeenCalledTimes(1);
		expect(api.tsCreate.mock.calls[0]?.[0]).toBe("enc-1");
		const sent = api.tsCreate.mock.calls[0]?.[1];
		expect(sent).toBeInstanceOf(ProgressiveTsMuxing);
		expect(sent).toMatchObject({
			filename: "video.ts",
			segmentLength: 4,
			startOffset: 10,
			streams: [{ streamId: "video-stream" }, { streamId: "audio-stream" }],
			outputs: [{ outputId: "output-1", outputPath: "files/" }],
			name: "Video Progressive TS Muxing 360p",
		});
		// Segmented TS is a different resource with a different endpoint.
		expect(api.segmentedTsCreate).not.toHaveBeenCalled();
		expect(audit).toHaveBeenCalledWith(
			expect.objectContaining({
				path: "/encoding/encodings/enc-1/muxings/progressive-ts",
			}),
		);
	});

	it("puts neither number in the request body when neither was set", async () => {
		const { ops } = setup();
		const { segmentLength: _length, startOffset: _offset, ...unset } = tsParams;
		await ops.createProgressiveTsMuxing("enc-1", unset);
		const body = JSON.parse(
			JSON.stringify(api.tsCreate.mock.calls[0]?.[1]),
		) as Record<string, unknown>;
		expect(body).not.toHaveProperty("segmentLength");
		expect(body).not.toHaveProperty("startOffset");
		expect(body.filename).toBe("video.ts");
	});

	it("sends a video-only file as a single stream", async () => {
		const { ops } = setup();
		const { additionalStreamIds: _audio, ...videoOnly } = tsParams;
		await ops.createProgressiveTsMuxing("enc-1", videoOnly);
		expect(api.tsCreate.mock.calls[0]?.[1].streams).toEqual([
			expect.objectContaining({ streamId: "video-stream" }),
		]);
	});

	it("adopts the muxing a previous attempt created instead of creating a second file", async () => {
		const { ops } = setup(true);
		api.tsList.mockResolvedValue({ items: [{ id: "other" }, { id: "owned" }] });
		api.tsCustomData.mockImplementation(async (_enc, id) => ({
			customData: {
				bitovp: {
					job: id === "owned" ? "job-1" : "another-job",
					step: "muxing:file",
				},
			},
		}));
		await expect(
			ops.createProgressiveTsMuxing("enc-1", tsParams),
		).resolves.toBe("owned");
		expect(api.tsCreate).not.toHaveBeenCalled();
	});

	it("recovers a lost create response through the same lookup", async () => {
		const { ops } = setup();
		api.tsCreate.mockRejectedValue(new Error("response lost"));
		api.tsList.mockResolvedValue({ items: [{ id: "created-before-loss" }] });
		api.tsCustomData.mockResolvedValue({
			customData: { bitovp: { job: "job-1", step: "muxing:file" } },
		});
		await expect(
			ops.createProgressiveTsMuxing("enc-1", tsParams),
		).resolves.toBe("created-before-loss");
		expect(api.tsCreate).toHaveBeenCalledTimes(1);
	});
});

describe("progressive MOV gateway", () => {
	it("creates a ProgressiveMovMuxing on its own endpoint, video stream first", async () => {
		const { ops, audit } = setup();
		await expect(
			ops.createProgressiveMovMuxing("enc-1", movParams),
		).resolves.toBe("mov-new");
		expect(api.movCreate).toHaveBeenCalledTimes(1);
		const sent = api.movCreate.mock.calls[0]?.[1];
		expect(sent).toBeInstanceOf(ProgressiveMovMuxing);
		expect(sent).toMatchObject({
			filename: "video.mov",
			streams: [{ streamId: "video-stream" }, { streamId: "audio-stream" }],
			outputs: [{ outputId: "output-1", outputPath: "files/" }],
			name: "Video Progressive MOV Muxing 360p",
		});
		expect(api.mp4Create).not.toHaveBeenCalled();
		expect(api.tsCreate).not.toHaveBeenCalled();
		expect(audit).toHaveBeenCalledWith(
			expect.objectContaining({
				path: "/encoding/encodings/enc-1/muxings/progressive-mov",
			}),
		);
	});

	it("adopts the muxing a previous attempt created", async () => {
		const { ops } = setup(true);
		api.movList.mockResolvedValue({ items: [{ id: "owned" }] });
		api.movCustomData.mockResolvedValue({
			customData: { bitovp: { job: "job-1", step: "muxing:file" } },
		});
		await expect(
			ops.createProgressiveMovMuxing("enc-1", movParams),
		).resolves.toBe("owned");
		expect(api.movCreate).not.toHaveBeenCalled();
	});
});

describe("progressive WebM gateway", () => {
	/** The request body as it goes out: what the SDK's serialiser keeps. */
	const body = (call: number) =>
		JSON.parse(JSON.stringify(api.webmCreate.mock.calls[call]?.[1])) as Record<
			string,
			unknown
		>;

	it("creates a ProgressiveWebmMuxing holding both streams, video first", async () => {
		const { ops, audit } = setup();
		await expect(
			ops.createProgressiveWebmMuxing("enc-1", webmParams),
		).resolves.toBe("webm-new");
		expect(api.webmCreate).toHaveBeenCalledTimes(1);
		expect(api.webmCreate.mock.calls[0]?.[0]).toBe("enc-1");
		const sent = api.webmCreate.mock.calls[0]?.[1];
		expect(sent).toBeInstanceOf(ProgressiveWebmMuxing);
		expect(sent.streams).toHaveLength(2);
		expect(sent).toMatchObject({
			filename: "video.webm",
			streams: [{ streamId: "video-stream" }, { streamId: "audio-stream" }],
			outputs: [{ outputId: "output-1", outputPath: "files/" }],
			name: "Video Progressive WebM Muxing 360p",
		});
		// Segmented WebM is a different resource with a different endpoint.
		expect(api.segmentedWebmCreate).not.toHaveBeenCalled();
		expect(api.movCreate).not.toHaveBeenCalled();
		expect(audit).toHaveBeenCalledWith(
			expect.objectContaining({
				path: "/encoding/encodings/enc-1/muxings/progressive-webm",
			}),
		);
	});

	it("sends exactly one stream when no additional id is given — the request it always made", async () => {
		// The QC mirror of a VP9 rendition and a WEBM muxing marked progressive
		// call this with one stream. Absent and `undefined` (what the executor
		// passes for a ref the op does not carry) are the same request.
		const { ops } = setup();
		const { additionalStreamIds: _audio, ...oneStream } = webmParams;
		await ops.createProgressiveWebmMuxing("enc-1", oneStream);
		await ops.createProgressiveWebmMuxing("enc-1", {
			...oneStream,
			additionalStreamIds: undefined,
		});
		expect(api.webmCreate).toHaveBeenCalledTimes(2);
		// The whole body, so a field that crept in beside the stream would show.
		const single = {
			type: "PROGRESSIVE_WEBM",
			name: "Video Progressive WebM Muxing 360p",
			filename: "video.webm",
			streams: [{ streamId: "video-stream" }],
			outputs: [{ outputId: "output-1", outputPath: "files/", acl: [] }],
			ignoredBy: [],
		};
		expect(body(0)).toEqual(single);
		expect(body(1)).toEqual(single);
		// The two-stream request differs from it by the second stream alone.
		await ops.createProgressiveWebmMuxing("enc-1", webmParams);
		expect(body(2)).toEqual({
			...single,
			streams: [{ streamId: "video-stream" }, { streamId: "audio-stream" }],
		});
	});
});
