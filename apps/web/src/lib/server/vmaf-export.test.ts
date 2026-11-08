import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { vmafExportStream } from "./vmaf-export";

describe("streamed VMAF export bytes", () => {
	it("exports model-free CAMBI as a separate metric without a VMAF value", async () => {
		const banding = [
			{
				frameNum: 0,
				timestampSeconds: 0.1,
				durationSeconds: 0.04,
				cambi: 7,
				computedCambi: 7.01,
				cpuReferenceCambi: 7.00000001,
			},
		];
		const job = {
			id: "banding",
			model: "CAMBI",
			params: { kind: "BANDING" },
			results: [{ id: "a", renditionRef: { label: "360p" } }],
		};
		const read = async () =>
			gzipSync(JSON.stringify({ kind: "QC_FRAMES", version: 1, banding }));
		const json = await new Response(
			vmafExportStream(job, "json", read, new AbortController().signal),
		).json();
		expect(json).toMatchObject({
			kind: "BANDING",
			detector: "CAMBI",
			model: null,
			renditions: [{ bandingFrames: banding }],
		});
		expect(json.renditions[0]).not.toHaveProperty("frames");
		const csv = await new Response(
			vmafExportStream(job, "csv", read, new AbortController().signal),
		).text();
		expect(csv).toBe(
			"rendition,frameNum,vmaf,psnr,timestampSeconds,durationSeconds,cambi,computedCambi,cpu_reference_cambi,metric\n360p,0,,,0.1,0.04,7,7.01,7.00000001,CAMBI",
		);
	});

	it("preserves full VMAF and CAMBI series in combined exports", async () => {
		const vmaf = [{ frameNum: 0, vmaf: 95 }];
		const banding = [
			{ frameNum: 0, timestampSeconds: 0, durationSeconds: 0.04, cambi: 7 },
		];
		const job = {
			id: "combined",
			model: "vmaf_v0.6.1",
			params: { banding: true },
			results: [{ id: "a", renditionRef: {} }],
		};
		const read = async () =>
			gzipSync(
				JSON.stringify({ kind: "QC_FRAMES", version: 1, vmaf, banding }),
			);
		const json = await new Response(
			vmafExportStream(job, "json", read, new AbortController().signal),
		).json();
		expect(json.renditions[0]).toMatchObject({
			frames: vmaf,
			bandingFrames: banding,
		});
	});
	it("includes only validated local execution provenance in JSON", async () => {
		const localExecution = {
			version: 1,
			requestedDecode: "auto",
			device: 0,
			decode: {
				reference: { backend: "cuda" },
				distorted: { backend: "cuda" },
			},
			scoring: {
				backend: "cpu",
				implementation: "libvmaf",
				model: "vmaf_v1.0.16_3d0h",
			},
			attempts: 1,
		};
		const text = await new Response(
			vmafExportStream(
				{
					id: "job",
					model: "model",
					results: [
						{
							id: "valid",
							renditionRef: {},
							provenance: {
								localExecution,
								reference: { path: "/private/source.mp4" },
							},
						},
						{
							id: "invalid",
							renditionRef: {},
							provenance: {
								localExecution: {
									...localExecution,
									stderr: "private diagnostic",
								},
							},
						},
					],
				},
				"json",
				async () => null,
				new AbortController().signal,
			),
		).text();
		const data = JSON.parse(text);
		expect(data.renditions[0].localExecution).toEqual(localExecution);
		expect(data.renditions[1]).not.toHaveProperty("localExecution");
		expect(text).not.toMatch(/private|stderr|provenance/);
	});

	it.each([
		{ frames: [] },
		{ frames: [{ frameNum: -0, vmaf: 91.12345678901235, psnr: 42.5 }] },
	])("preserves full two-space JSON, including empty/null series and Unicode", async ({
		frames,
	}) => {
		const job = {
			id: "job",
			model: "model",
			results: [
				{ id: "a", renditionRef: { label: '雪😀,"label"\nline' } },
				{ id: "b", renditionRef: {} },
			],
		};
		const read = vi.fn(async (id: string) =>
			id === "a" ? gzipSync(JSON.stringify(frames)) : null,
		);
		const text = await new Response(
			vmafExportStream(job, "json", read, new AbortController().signal),
		).text();
		expect(text).toBe(
			JSON.stringify(
				{
					vmafJobId: "job",
					model: "model",
					renditions: [
						{
							id: "a",
							label: '雪😀,"label"\nline',
							renditionRef: job.results[0]?.renditionRef,
							frames,
						},
						{
							id: "b",
							label: "Rendition 2",
							renditionRef: {},
							frames: [],
						},
					],
				},
				null,
				2,
			),
		);
	});

	it.each([
		"json",
		"csv",
	] as const)("keeps empty %s exports byte-identical without fetching a blob", async (format) => {
		const read = vi.fn();
		const text = await new Response(
			vmafExportStream(
				{ id: "job", model: "model", results: [] },
				format,
				read,
				new AbortController().signal,
			),
		).text();
		expect(text).toBe(
			format === "csv"
				? "rendition,frameNum,vmaf,psnr"
				: JSON.stringify(
						{ vmafJobId: "job", model: "model", renditions: [] },
						null,
						2,
					),
		);
		expect(read).not.toHaveBeenCalled();
	});

	it("retains CSV formula defenses, quoting, full number precision and absent PSNR cells", async () => {
		const frames = [
			{ frameNum: 0, vmaf: -0, psnr: 42.1234567890123 },
			{ frameNum: 1, vmaf: 91.12345678901235 },
		];
		const text = await new Response(
			vmafExportStream(
				{
					id: "job",
					model: "model",
					results: [{ id: "a", renditionRef: { label: '=雪,"x"\nline' } }],
				},
				"csv",
				async () => gzipSync(JSON.stringify(frames)),
				new AbortController().signal,
			),
		).text();
		expect(text).toBe(
			'rendition,frameNum,vmaf,psnr\n"\'=雪,""x""\nline",0,0,42.1234567890123\n"\'=雪,""x""\nline",1,91.12345678901235,',
		);
	});

	it("does not consume later results if the request aborts during a blob query", async () => {
		let resolve: (blob: Uint8Array) => void = () => {};
		const waiting = new Promise<Uint8Array>((accept) => {
			resolve = accept;
		});
		const read = vi.fn(() => waiting);
		const controller = new AbortController();
		const reader = vmafExportStream(
			{
				id: "job",
				model: "model",
				results: [
					{ id: "a", renditionRef: {} },
					{ id: "b", renditionRef: {} },
				],
			},
			"json",
			read,
			controller.signal,
		).getReader();
		const pending = reader.read();
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
		controller.abort();
		resolve(gzipSync("[]"));
		await expect(pending).rejects.toThrow();
		expect(read).toHaveBeenCalledTimes(1);
	});
});
