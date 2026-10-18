import {
	CmafMuxing,
	DashCmafRepresentation,
	DashRepresentationType,
	DashRepresentationTypeMode,
} from "@bitmovin/api-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	cmafCreate: vi.fn(),
	cmafList: vi.fn(),
	cmafCustomData: vi.fn(),
	fmp4Create: vi.fn(),
	fmp4List: vi.fn(),
	dashCmafCreate: vi.fn(),
	dashFmp4Create: vi.fn(),
}));

vi.mock("@bitmovin/api-sdk", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bitmovin/api-sdk")>();
	class FakeBitmovinApi {
		encoding = {
			encodings: {
				muxings: {
					cmaf: {
						create: api.cmafCreate,
						list: api.cmafList,
						customdata: { get: api.cmafCustomData },
					},
					fmp4: { create: api.fmp4Create, list: api.fmp4List },
				},
			},
			manifests: {
				dash: {
					periods: {
						adaptationsets: {
							representations: {
								cmaf: { create: api.dashCmafCreate },
								fmp4: { create: api.dashFmp4Create },
							},
						},
					},
				},
			},
		};
	}
	return { ...actual, default: FakeBitmovinApi };
});

import { createBitmovinSdkOps } from "./sdk-ops";

const params = {
	streamId: "stream-1",
	segmentLength: 4,
	segmentNamingTemplate: "seg_{rand_chars:8}_%number%.m4s",
	initSegmentNameTemplate: "init_{rand_chars:8}.mp4",
	framesPerCmafChunk: 6,
	destination: { outputId: "output-1", outputPath: "video/360p/" },
	name: "cmaf-video",
};

function setup(window = false) {
	const audit = vi.fn(async () => {});
	const ops = createBitmovinSdkOps(
		{
			apiKey: "test-key",
			stamp: {
				jobId: "job-1",
				currentStep: () => "muxing:cmaf-video",
				adoptWindow: () => window,
			},
		},
		audit,
	);
	return { ops, audit };
}

beforeEach(() => {
	vi.resetAllMocks();
	api.cmafCreate.mockResolvedValue({ id: "cmaf-new" });
	api.cmafList.mockResolvedValue({ items: [] });
	api.dashCmafCreate.mockResolvedValue({ id: "repr-new" });
});

describe("CMAF SDK facade", () => {
	it("uses the dedicated muxing endpoint and SDK fields, omitting conflicting literals", async () => {
		const { ops, audit } = setup();
		await expect(ops.createCmafMuxing("enc-1", params)).resolves.toBe(
			"cmaf-new",
		);
		const sent = api.cmafCreate.mock.calls[0]?.[1];
		expect(sent).toBeInstanceOf(CmafMuxing);
		expect(sent).toMatchObject({
			segmentLength: 4,
			segmentNamingTemplate: params.segmentNamingTemplate,
			initSegmentNameTemplate: params.initSegmentNameTemplate,
			framesPerCmafChunk: 6,
			streams: [{ streamId: "stream-1" }],
			outputs: [{ outputId: "output-1", outputPath: "video/360p/" }],
		});
		expect(sent.segmentNaming).toBeUndefined();
		expect(sent.initSegmentName).toBeUndefined();
		expect(api.fmp4Create).not.toHaveBeenCalled();
		expect(audit).toHaveBeenCalledWith(
			expect.objectContaining({
				path: "/encoding/encodings/enc-1/muxings/cmaf",
			}),
		);
	});
	it("retains ordinary literal init and segment names", async () => {
		const { ops } = setup();
		await ops.createCmafMuxing("enc-1", {
			streamId: "stream-1",
			segmentLength: 4,
			segmentNaming: "segment_%number%.m4s",
			initSegmentName: "init.mp4",
		});
		expect(api.cmafCreate.mock.calls[0]?.[1]).toMatchObject({
			segmentNaming: "segment_%number%.m4s",
			initSegmentName: "init.mp4",
		});
		expect(
			api.cmafCreate.mock.calls[0]?.[1].initSegmentNameTemplate,
		).toBeUndefined();
	});

	it("adopts only the matching job/step custom data without creating another muxing", async () => {
		const { ops } = setup(true);
		api.cmafList.mockResolvedValue({
			items: [{ id: "other" }, { id: "owned" }],
		});
		api.cmafCustomData.mockImplementation(async (_enc, id) => ({
			customData: {
				bitovp: {
					job: id === "owned" ? "job-1" : "another-job",
					step: "muxing:cmaf-video",
				},
			},
		}));
		await expect(ops.createCmafMuxing("enc-1", params)).resolves.toBe("owned");
		expect(api.cmafCreate).not.toHaveBeenCalled();
		expect(api.fmp4List).not.toHaveBeenCalled();
	});

	it("recovers a lost create response through the same CMAF custom-data lookup", async () => {
		const { ops } = setup();
		api.cmafCreate.mockRejectedValue(new Error("response lost"));
		api.cmafList.mockResolvedValue({ items: [{ id: "created-before-loss" }] });
		api.cmafCustomData.mockResolvedValue({
			customData: { bitovp: { job: "job-1", step: "muxing:cmaf-video" } },
		});
		await expect(ops.createCmafMuxing("enc-1", params)).resolves.toBe(
			"created-before-loss",
		);
		expect(api.cmafCreate).toHaveBeenCalledTimes(1);
	});

	it("paginates the CMAF listing rather than substituting fMP4", async () => {
		const { ops } = setup();
		const rows = Array.from({ length: 100 }, (_, i) => ({
			id: `cmaf-${i}`,
			streams: [{ streamId: `stream-${i}` }],
			outputs: [{ outputPath: `video/${i}/` }],
		}));
		api.cmafList.mockResolvedValueOnce({ items: rows }).mockResolvedValueOnce({
			items: [{ id: "last", streams: [{ streamId: "last-stream" }] }],
		});
		await expect(ops.listMuxings("enc-1", "CMAF")).resolves.toHaveLength(101);
		expect(api.cmafList).toHaveBeenNthCalledWith(2, "enc-1", {
			offset: 100,
			limit: 100,
		});
		expect(api.fmp4List).not.toHaveBeenCalled();
	});

	it("creates a dedicated DASH CMAF representation preserving per-title mode", async () => {
		const { ops } = setup();
		await ops.createDashCmafRepresentation("manifest", "period", "adaptation", {
			type: "TEMPLATE",
			mode: "TEMPLATE_REPRESENTATION",
			segmentPath: "video/",
			encodingId: "enc-1",
			muxingId: "mux-1",
		});
		const sent = api.dashCmafCreate.mock.calls[0]?.[3];
		expect(sent).toBeInstanceOf(DashCmafRepresentation);
		expect(sent).toMatchObject({
			type: DashRepresentationType.TEMPLATE,
			mode: DashRepresentationTypeMode.TEMPLATE_REPRESENTATION,
			encodingId: "enc-1",
			muxingId: "mux-1",
			segmentPath: "video/",
		});
		expect(api.dashFmp4Create).not.toHaveBeenCalled();
	});

	it("rejects all CMAF DRM operations without touching an unavailable endpoint", async () => {
		const { ops } = setup();
		for (const kind of ["CENC", "FAIRPLAY", "SPEKE"] as const) {
			await expect(
				ops.listMuxingDrm("enc-1", "mux-1", "CMAF", kind),
			).rejects.toThrow(/CMAF/);
		}
		expect(api.cmafCreate).not.toHaveBeenCalled();
	});
});
