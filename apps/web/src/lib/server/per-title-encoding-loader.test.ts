import { describe, expect, it, vi } from "vitest";
import { loadPerTitleEncodingSnapshot } from "./per-title-encoding-loader";

const uuid = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const encodingId = uuid(1);
const configurationId = uuid(2);
const template = (value: number, configId = configurationId) => ({
	id: uuid(value),
	mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	codecConfigId: configId,
	perTitleSettings: {
		fixedResolutionAndBitrateSettings: {
			minBitrate: 300000,
			maxBitrate: 600000,
		},
		codecMaxBitrateFactor: 1.5,
	},
});

function source() {
	const startRequest = {
		perTitle: { h264Configuration: { maxBitrate: 4000000 } },
	};
	const configuration = { width: 640, bitrate: null, profile: "HIGH" };
	const list = vi.fn(
		async (_id: string, _page: { limit: number; offset: number }) => ({
			items: [template(3)],
		}),
	);
	const getType = vi.fn(async (_id: string) => ({ type: "H264" }));
	const getConfiguration = vi.fn(async (_id: string) => configuration);
	const getStartRequest = vi.fn(async (_id: string) => startRequest);
	const mutate = vi.fn(() => {
		throw new Error("Provider mutations are forbidden");
	});
	return {
		startRequest,
		configuration,
		list,
		getType,
		getConfiguration,
		getStartRequest,
		mutate,
		api: {
			encoding: {
				encodings: { getStartRequest, streams: { list }, start: mutate },
				configurations: {
					type: { get: getType },
					video: {
						h264: { get: getConfiguration },
						h265: { get: getConfiguration },
						h265v2: { get: getConfiguration },
						vp9: { get: getConfiguration },
						av1: { get: getConfiguration },
					},
				},
			},
		},
	};
}

const options = () => ({ signal: new AbortController().signal });

describe("Per-Title encoding read loader", () => {
	it("retains declared dimensions and original settings without starting an encoding", async () => {
		const input = source();
		const snapshot = await loadPerTitleEncodingSnapshot(
			input.api,
			encodingId,
			options(),
		);
		expect(snapshot).toEqual({
			startRequest: input.startRequest,
			streams: [
				{
					stream: template(3),
					codecType: "H264",
					configuration: input.configuration,
				},
			],
		});
		expect(snapshot.streams[0]?.configuration).not.toHaveProperty("height");
		expect(input.mutate).not.toHaveBeenCalled();
	});

	it("does not inspect result or standard streams and excludes audio templates", async () => {
		const input = source();
		input.list.mockResolvedValue({
			items: [
				{ ...template(3), mode: "PER_TITLE_RESULT" },
				{ ...template(4), mode: "STANDARD" },
				template(5, uuid(6)),
			],
		});
		input.getType.mockResolvedValue({ type: "AAC" });
		const snapshot = await loadPerTitleEncodingSnapshot(
			input.api,
			encodingId,
			options(),
		);
		expect(snapshot.streams).toEqual([]);
		expect(input.getType).toHaveBeenCalledExactlyOnceWith(uuid(6));
		expect(input.getConfiguration).not.toHaveBeenCalled();
	});

	it.each([
		"H264",
		"H265",
		"H265V2",
		"VP9",
		"AV1",
	])("reads the typed %s configuration", async (codecType) => {
		const input = source();
		input.getType.mockResolvedValue({ type: codecType });
		const snapshot = await loadPerTitleEncodingSnapshot(
			input.api,
			encodingId,
			options(),
		);
		expect(snapshot.streams[0]?.codecType).toBe(codecType);
		expect(snapshot.streams[0]?.configuration).toBe(input.configuration);
	});

	it("keeps unsupported template modes and codec types available for explicit projection issues", async () => {
		const input = source();
		input.list.mockResolvedValue({
			items: [{ ...template(3), mode: "PER_TITLE_TEMPLATE_FUTURE" }],
		});
		input.getType.mockResolvedValue({ type: "FUTURE_VIDEO" });
		const snapshot = await loadPerTitleEncodingSnapshot(
			input.api,
			encodingId,
			options(),
		);
		expect(snapshot.streams).toEqual([
			{
				stream: expect.objectContaining({ mode: "PER_TITLE_TEMPLATE_FUTURE" }),
				codecType: "FUTURE_VIDEO",
				configuration: null,
			},
		]);
		expect(input.getConfiguration).not.toHaveBeenCalled();
	});

	it("deduplicates codec reads shared by different template streams", async () => {
		const input = source();
		input.list.mockResolvedValue({ items: [template(3), template(4)] });
		const snapshot = await loadPerTitleEncodingSnapshot(
			input.api,
			encodingId,
			options(),
		);
		expect(snapshot.streams).toHaveLength(2);
		expect(input.getType).toHaveBeenCalledOnce();
		expect(input.getConfiguration).toHaveBeenCalledOnce();
	});

	it("walks every page and does not count repeated stream identities twice", async () => {
		const input = source();
		const first = Array.from({ length: 99 }, (_, index) => ({
			...template(100 + index),
			mode: "STANDARD",
		}));
		input.list.mockImplementation(async (_id, page) => ({
			items:
				page.offset === 0
					? [...first, template(3)]
					: [template(3), template(4)],
		}));
		const snapshot = await loadPerTitleEncodingSnapshot(
			input.api,
			encodingId,
			options(),
		);
		expect(
			snapshot.streams.map(({ stream }) => (stream as { id: string }).id),
		).toEqual([uuid(3), uuid(4)]);
		expect(input.list.mock.calls.map(([, page]) => page)).toEqual([
			{ limit: 100, offset: 0 },
			{ limit: 100, offset: 100 },
		]);
		expect(input.getConfiguration).toHaveBeenCalledOnce();
	});

	it("refuses a list exceeding its explicit resource limit without a partial success", async () => {
		const input = source();
		input.list.mockResolvedValue({ items: [], totalCount: 1001 } as never);
		await expect(
			loadPerTitleEncodingSnapshot(input.api, encodingId, options()),
		).rejects.toMatchObject({ code: "IMPORT_LIMIT_EXCEEDED" });
		expect(input.getConfiguration).not.toHaveBeenCalled();
	});

	it.each([
		false,
		true,
	])("checks actual page contents at the stream limit without relying on totalCount (extra: %s)", async (extra) => {
		const input = source();
		input.list.mockImplementation(async (_id, page) => ({
			items:
				page.offset === 1000
					? extra
						? [{ ...template(2000), mode: "STANDARD" }]
						: []
					: Array.from({ length: 100 }, (_, index) => ({
							...template(100 + page.offset + index),
							mode: "STANDARD",
						})),
		}));
		const pending = loadPerTitleEncodingSnapshot(
			input.api,
			encodingId,
			options(),
		);
		if (extra)
			await expect(pending).rejects.toMatchObject({
				code: "IMPORT_LIMIT_EXCEEDED",
			});
		else expect((await pending).streams).toEqual([]);
		expect(input.list).toHaveBeenCalledTimes(11);
		expect(input.getConfiguration).not.toHaveBeenCalled();
	});

	it("refuses a non-progressing full page rather than looping or truncating", async () => {
		const input = source();
		input.list.mockResolvedValue({
			items: Array.from({ length: 100 }, (_, index) => ({
				...template(100 + index),
				mode: "STANDARD",
			})),
		});
		await expect(
			loadPerTitleEncodingSnapshot(input.api, encodingId, options()),
		).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
		expect(input.list).toHaveBeenCalledTimes(2);
	});

	it("does not mistake repeated pages for the reported total number of distinct streams", async () => {
		const input = source();
		input.list.mockResolvedValue({
			items: Array.from({ length: 100 }, (_, index) => ({
				...template(100 + index),
				mode: "STANDARD",
			})),
			totalCount: 200,
		} as never);
		await expect(
			loadPerTitleEncodingSnapshot(input.api, encodingId, options()),
		).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
	});

	it("does not accept a short final page missing records from the reported total", async () => {
		const input = source();
		input.list.mockResolvedValue({
			items: [template(3)],
			totalCount: 2,
		} as never);
		await expect(
			loadPerTitleEncodingSnapshot(input.api, encodingId, options()),
		).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
	});

	it("rejects conflicting copies of the same template identity", async () => {
		const input = source();
		input.list.mockResolvedValue({
			items: [template(3), { ...template(3), codecConfigId: uuid(7) }],
		});
		await expect(
			loadPerTitleEncodingSnapshot(input.api, encodingId, options()),
		).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
	});

	it.each([
		{ items: null },
		{ items: [null] },
		{ items: [{ ...template(3), codecConfigId: "../configuration" }] },
		{ items: [{ ...template(3), id: "" }] },
	])("does not silently omit malformed template records (%j)", async (page) => {
		const input = source();
		input.list.mockResolvedValue(page as never);
		await expect(
			loadPerTitleEncodingSnapshot(input.api, encodingId, options()),
		).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
	});

	it("does not issue provider reads for an already canceled request", async () => {
		const input = source();
		const controller = new AbortController();
		controller.abort();
		await expect(
			loadPerTitleEncodingSnapshot(input.api, encodingId, {
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(input.getStartRequest).not.toHaveBeenCalled();
		expect(input.list).not.toHaveBeenCalled();
	});

	it("cancels a pending provider read without waiting for an unresponsive promise", async () => {
		const input = source();
		const controller = new AbortController();
		input.getStartRequest.mockImplementation(() => new Promise(() => {}));
		const pending = loadPerTitleEncodingSnapshot(input.api, encodingId, {
			signal: controller.signal,
		});
		await Promise.resolve();
		expect(input.getStartRequest).toHaveBeenCalledOnce();
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(input.list).not.toHaveBeenCalled();
	});
});
