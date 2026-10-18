import type { AuditEntry } from "@bitovp/db";

// The recorder relaxes `actor` : ops do not name it, make-sdk does.
type RecordedEntry = Omit<AuditEntry, "actor"> & { actor?: string | null };

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The per-title capture's SDK adapter, against a stubbed BitmovinApi — same
 * pattern as `sdk-ops.live.test.ts` (only the default-export client is replaced;
 * no network). What is under test is the part core cannot own: C6 pagination and
 * its honesty flag, and the polymorphic codec-config read.
 */

const api = vi.hoisted(() => ({
	streamsList: vi.fn(
		async (_encodingId: string, _q?: { offset: number; limit: number }) =>
			({ items: [] }) as { items: unknown[] },
	),
	muxingsList: vi.fn(
		async (_encodingId: string, _q?: { offset: number; limit: number }) =>
			({ items: [] }) as { items: unknown[] },
	),
	drmList: vi.fn(async (_e: string, _m: string) => ({
		items: [] as unknown[],
	})),
	fmp4List: vi.fn(
		async (_e: string, _q?: unknown) => ({ items: [] }) as { items: unknown[] },
	),
	cencList: vi.fn(
		async (_e: string, _m: string, _q?: unknown) =>
			({ items: [] }) as { items: unknown[] },
	),
	typeGet: vi.fn(
		async (_id: string) => ({ type: "H264" }) as { type?: string },
	),
	h264Get: vi.fn(async (_id: string) => ({ bitrate: 4_200_000 })),
	aacGet: vi.fn(async (_id: string) => ({ bitrate: 128_000 })),
	webvttGet: vi.fn(async (_id: string) => ({
		appendOptionalZeroDuration: true,
	})),
}));

vi.mock("@bitmovin/api-sdk", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bitmovin/api-sdk")>();
	class FakeBitmovinApi {
		encoding = {
			encodings: {
				streams: { list: api.streamsList },
				muxings: {
					list: api.muxingsList,
					// WIRED. Its absence is why `drmList` recorded zero calls: the port
					// looks up `muxings["fmp4"]`, found `undefined`, and its guard returned
					// `[]` — indistinguishable from "this muxing has no DRM". The spy
					// existed and was reset in `beforeEach`; it was simply never reachable.
					fmp4: {
						list: api.fmp4List,
						drm: { list: api.drmList, cenc: { list: api.cencList } },
					},
				},
			},
			configurations: {
				type: { get: api.typeGet },
				video: { h264: { get: api.h264Get } },
				audio: { aac: { get: api.aacGet } },
				subtitles: { webvtt: { get: api.webvttGet } },
			},
		};
	}
	return { ...actual, default: FakeBitmovinApi };
});

import { SCAN_PAGE_CAP } from "@bitovp/core";
import { createBitmovinSdkOps } from "./sdk-ops";

function setup() {
	const audits: RecordedEntry[] = [];
	const ops = createBitmovinSdkOps(
		{ apiKey: "test-key", tenantOrgId: null, bitmovinAccountId: "acct-1" },
		async (entry) => {
			audits.push(entry);
		},
	);
	return { ops, audits };
}

/** n stream rows, distinctly identified. */
function streamRows(n: number, from = 0) {
	return Array.from({ length: n }, (_, i) => ({
		id: `s-${from + i}`,
		mode: "PER_TITLE_RESULT",
	}));
}

beforeEach(() => {
	vi.clearAllMocks();
	api.streamsList.mockImplementation(async () => ({ items: [] }));
	api.muxingsList.mockImplementation(async () => ({ items: [] }));
	api.typeGet.mockImplementation(async () => ({ type: "H264" }));
	api.drmList.mockImplementation(async () => ({ items: [] }));
	api.fmp4List.mockImplementation(async () => ({ items: [] }));
	api.cencList.mockImplementation(async () => ({ items: [] }));
});

describe("listEncodingStreams", () => {
	it("paginates to exhaustion with limit 100 (C6)", async () => {
		const { ops } = setup();
		api.streamsList.mockImplementation(async (_id, q) =>
			q?.offset === 0
				? { items: streamRows(100) }
				: { items: streamRows(3, 100) },
		);
		const page = await ops.listEncodingStreams("bm-enc");
		expect(api.streamsList).toHaveBeenCalledTimes(2);
		expect(api.streamsList).toHaveBeenNthCalledWith(1, "bm-enc", {
			offset: 0,
			limit: 100,
		});
		expect(api.streamsList).toHaveBeenNthCalledWith(2, "bm-enc", {
			offset: 100,
			limit: 100,
		});
		expect(page.items).toHaveLength(103);
		expect(page.complete).toBe(true);
	});

	it("stops at the shared page cap and reports an incomplete scan", async () => {
		// A list that never shortens must not spin forever — and must not claim to
		// be the whole ladder either.
		const { ops } = setup();
		api.streamsList.mockImplementation(async () => ({
			items: streamRows(100),
		}));
		const page = await ops.listEncodingStreams("bm-enc");
		expect(api.streamsList).toHaveBeenCalledTimes(SCAN_PAGE_CAP);
		expect(page.complete).toBe(false);
		expect(page.items).toHaveLength(SCAN_PAGE_CAP * 100);
	});

	it("carries mode, config id and applied settings", async () => {
		const { ops } = setup();
		api.streamsList.mockImplementation(async () => ({
			items: [
				{
					id: "s-1",
					mode: "PER_TITLE_RESULT",
					name: "Stream H264 1080p",
					codecConfigId: "cfg-1",
					appliedSettings: { width: 1920, height: 1080 },
				},
			],
		}));
		const page = await ops.listEncodingStreams("bm-enc");
		expect(page.items[0]).toEqual({
			streamId: "s-1",
			mode: "PER_TITLE_RESULT",
			codecConfigId: "cfg-1",
			// The columns that say what the ladder actually cost. Confirmed present
			// on real results (17 encodings, ).
			appliedSettings: { width: 1920, height: 1080 },
		});
	});

	it("treats a row with no id or mode as an incomplete scan, not a skip", async () => {
		const { ops } = setup();
		api.streamsList.mockImplementation(async () => ({
			items: [{ id: "s-1", mode: "PER_TITLE_RESULT" }, { id: "s-2" }],
		}));
		const page = await ops.listEncodingStreams("bm-enc");
		expect(page.items).toHaveLength(1);
		// Silently dropping it would understate the ladder with no way to tell.
		expect(page.complete).toBe(false);
	});
});

describe("listAllMuxings", () => {
	it("returns the polymorphic type discriminant and segment counts", async () => {
		const { ops } = setup();
		api.muxingsList.mockImplementation(async () => ({
			items: [
				{
					id: "m-1",
					type: "FMP4",
					streams: [{ streamId: "s-1" }, { streamId: "s-2" }],
					avgBitrate: 4_000_000,
					maxBitrate: 4_500_000,
					segmentsMuxed: 240,
					outputs: [{ outputId: "out-1", outputPath: "video/1080p/" }],
				},
			],
		}));
		const page = await ops.listAllMuxings("bm-enc");
		expect(page.items[0]).toEqual({
			muxingId: "m-1",
			muxingType: "FMP4",
			streamIds: ["s-1", "s-2"],
			avgBitrate: 4_000_000,
			maxBitrate: 4_500_000,
			segmentsMuxed: 240,
			// EVERY output, not the first — `Muxing.outputs` is an array.
			outputs: [{ outputId: "out-1", outputPath: "video/1080p/" }],
			drm: [],
		});
	});

	it("keeps the QC-mirror filename and name off the SDK muxing row (§5.4 key)", async () => {
		// The worker's primary capture path runs through core's `readMuxingRow`. The
		// mirror `filename` is the RESULT↔template correlation key (audit 602ec286
		// HIGH-2 / §5.4); this pins it survives the SDK-facing listAllMuxings.
		const { ops } = setup();
		api.muxingsList.mockImplementation(async () => ({
			items: [
				{
					id: "m-qc",
					type: "MP4",
					filename: "v180.mp4",
					name: "QC VMAF Mirror v180",
					streams: [{ streamId: "s-1" }],
					outputs: [{ outputId: "out-1", outputPath: "video/180p_x/qc/" }],
				},
			],
		}));
		const page = await ops.listAllMuxings("bm-enc");
		expect(page.items[0]).toMatchObject({
			muxingId: "m-qc",
			muxingType: "MP4",
			filename: "v180.mp4",
			name: "QC VMAF Mirror v180",
		});
	});

	it("follows the DRM hop and keeps every encrypted output path", async () => {
		// `stream → muxing → drm → output → outputPath`. A DRM'd muxing usually has NO
		// output of its own, so skipping this hop loses the only path to the encrypted
		// rung — the shape that hid 8 of 16 writes in `storageSummaries`.
		//
		// This test previously recorded ZERO calls and I could not explain it, so I
		// deleted it rather than loosen it. The assertion was right the whole time; the
		// FAKE was missing `muxings.fmp4`, so the port's guard returned `[]` before
		// anything touched the spy. Two things hid that: the guard cannot tell "no DRM
		// route" from "no DRM", and vitest's default reporter SWALLOWS `console.log`, so
		// the probe I reached for printed nothing.
		const { ops } = setup();
		api.muxingsList.mockImplementation(async () => ({
			// No output of its own — the DRM carries it.
			items: [
				{
					id: "m-1",
					type: "FMP4",
					streams: [{ streamId: "s-1" }],
					outputs: [],
				},
			],
		}));
		api.drmList.mockImplementation(async () => ({
			items: [
				{
					id: "drm-cenc",
					type: "CENC",
					// PLURAL: one DRM can write more than one output.
					outputs: [
						{ outputId: "out-1", outputPath: "dash/1080p_enc/" },
						{ outputId: "out-2", outputPath: "hls/1080p_enc/" },
					],
				},
				{
					id: "drm-fp",
					type: "FAIRPLAY",
					outputs: [{ outputPath: "fp/1080p/" }],
				},
			],
		}));
		const page = await ops.listAllMuxings("bm-enc");
		expect(api.drmList).toHaveBeenCalledWith("bm-enc", "m-1");
		expect(page.items[0]?.outputs).toEqual([]);
		expect(page.items[0]?.drm).toEqual([
			{
				drmId: "drm-cenc",
				drmType: "CENC",
				outputs: [
					{ outputId: "out-1", outputPath: "dash/1080p_enc/" },
					{ outputId: "out-2", outputPath: "hls/1080p_enc/" },
				],
			},
			{
				drmId: "drm-fp",
				drmType: "FAIRPLAY",
				outputs: [{ outputPath: "fp/1080p/" }],
			},
		]);
	});

	it("labels a muxing whose type is missing rather than guessing one", async () => {
		const { ops } = setup();
		api.muxingsList.mockImplementation(async () => ({
			items: [{ id: "m-1", streams: [{ streamId: "s-1" }] }],
		}));
		const page = await ops.listAllMuxings("bm-enc");
		expect(page.items[0]?.muxingType).toBe("UNKNOWN");
		// An unmapped kind has no DRM route, so no call is attempted for it.
		expect(page.items[0]?.drm).toEqual([]);
	});
});

describe("getCodecConfigDetail", () => {
	it("reads the type, then the typed endpoint for that type", async () => {
		const { ops } = setup();
		const detail = await ops.getCodecConfigDetail("cfg-1");
		expect(api.typeGet).toHaveBeenCalledWith("cfg-1");
		expect(api.h264Get).toHaveBeenCalledWith("cfg-1");
		expect(detail).toEqual({
			codecType: "H264",
			params: { bitrate: 4_200_000 },
		});
	});

	it("routes each mapped group — audio and subtitles, not just video", async () => {
		const { ops } = setup();
		api.typeGet.mockImplementation(async () => ({ type: "AAC" }));
		expect(await ops.getCodecConfigDetail("cfg-a")).toEqual({
			codecType: "AAC",
			params: { bitrate: 128_000 },
		});
		api.typeGet.mockImplementation(async () => ({ type: "WEBVTT" }));
		expect(await ops.getCodecConfigDetail("cfg-w")).toEqual({
			codecType: "WEBVTT",
			params: { appendOptionalZeroDuration: true },
		});
	});

	it("returns the type with empty params for a codec it cannot fetch", async () => {
		// DTS is a real Bitmovin codec type with no entry in the shared table (the
		// plan schema cannot emit it). Recording WHAT it is beats throwing away the
		// whole ladder's snapshot for one exotic rung.
		const { ops } = setup();
		api.typeGet.mockImplementation(async () => ({ type: "DTS" }));
		expect(await ops.getCodecConfigDetail("cfg-x")).toEqual({
			codecType: "DTS",
			params: {},
		});
	});

	it("returns null when the type itself is unreadable", async () => {
		const { ops } = setup();
		api.typeGet.mockImplementation(async () => ({}));
		expect(await ops.getCodecConfigDetail("cfg-x")).toBeNull();
	});
});

describe("first-of-many guards on the per-kind facade (review of PR #147)", () => {
	/**
	 * `Muxing.outputs` and `Drm.outputs` are ARRAYS, and the per-kind facade used to
	 * read `[0]` — the same shape that hid 8 of 16 writes in `storageSummaries` and
	 * one leg of the results panel. Here the consequence is worse than a display: the
	 * per-title expansion derives MANIFEST entries from these paths, so a dropped leg
	 * is segments silently missing from the generated manifest. The compiler emits
	 * exactly one destination per muxing/DRM today; these tests pin that the day that
	 * invariant breaks, the facade fails loudly instead of picking a survivor.
	 */
	it("refuses a muxing whose outputs name two distinct paths", async () => {
		const { ops } = setup();
		api.fmp4List.mockImplementation(async () => ({
			items: [
				{
					id: "m-1",
					streams: [{ streamId: "s-1" }],
					outputs: [
						{ outputPath: "video/1080p/" },
						{ outputPath: "video/1080p-copy/" },
					],
				},
			],
		}));
		await expect(ops.listMuxings("bm-enc", "FMP4")).rejects.toThrow(
			/2 distinct output paths/,
		);
	});

	it("tolerates an output carrying no path beside one that does", async () => {
		// {a, undefined} is ONE base path plus a pathless output — the guard must
		// not read it as two distinct paths (review of PR #152: the Set held
		// undefined and the error said "2 distinct output paths", misdescribing it).
		const { ops } = setup();
		api.fmp4List.mockImplementation(async () => ({
			items: [
				{
					id: "m-1",
					streams: [{ streamId: "s-1" }],
					outputs: [{ outputPath: "video/1080p/" }, {}],
				},
			],
		}));
		const rows = await ops.listMuxings("bm-enc", "FMP4");
		expect(rows[0]?.outputPath).toBe("video/1080p/");
	});

	it("tolerates duplicate outputs that agree on the path", async () => {
		// Two outputs to ONE path are redundant, not ambiguous — [0] is every leg.
		const { ops } = setup();
		api.fmp4List.mockImplementation(async () => ({
			items: [
				{
					id: "m-1",
					streams: [{ streamId: "s-1" }],
					outputs: [
						{ outputPath: "video/1080p/" },
						{ outputPath: "video/1080p/" },
					],
				},
			],
		}));
		const rows = await ops.listMuxings("bm-enc", "FMP4");
		expect(rows[0]?.outputPath).toBe("video/1080p/");
	});

	it("refuses a DRM whose outputs name two distinct paths", async () => {
		const { ops } = setup();
		api.cencList.mockImplementation(async () => ({
			items: [
				{
					id: "drm-1",
					outputs: [{ outputPath: "dash/enc/" }, { outputPath: "hls/enc/" }],
				},
			],
		}));
		await expect(
			ops.listMuxingDrm("bm-enc", "m-1", "FMP4", "CENC"),
		).rejects.toThrow(/2 distinct output paths/);
	});
});
