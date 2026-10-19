import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { vmafExportStream } from "./vmaf-export";

describe("streamed VMAF export bytes", () => {
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
