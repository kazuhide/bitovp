import { gzipSync } from "node:zlib";
import type { VmafFrame } from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();

let qcVmafEnabled = true;

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			// : the flag gate reads through the same context;
			// harness default ON, the off-case pin flips it.
			appSetting: {
				findUnique: async () => ({ value: { qcVmaf: qcVmafEnabled } }),
			},
			vmafJob: { findUnique },
		},
	}),
}));

import { GET } from "./route";

const JOB_ID = "00000000-0000-4000-8000-0000000000a2";

function frames(scores: number[]): VmafFrame[] {
	return scores.map((vmaf, frameNum) => ({ frameNum, vmaf }));
}
function gz(f: VmafFrame[]): Buffer {
	return gzipSync(Buffer.from(JSON.stringify(f), "utf8"));
}
function params() {
	return { params: Promise.resolve({ id: JOB_ID }) };
}
function jobWithTwoRenditions() {
	return {
		id: JOB_ID,
		model: "vmaf_v0.6.1",
		results: [
			{
				id: "00000000-0000-4000-8000-0000000000d1",
				renditionRef: { label: "360p", height: 360, bitrate: 800_000 },
				framesGzip: gz(frames([90, 80, 70])),
			},
			{
				id: "00000000-0000-4000-8000-0000000000d2",
				renditionRef: { label: "720p", height: 720, bitrate: 2_500_000 },
				framesGzip: gz(frames([95, 96])),
			},
		],
	};
}

beforeEach(() => {
	qcVmafEnabled = true;
	vi.clearAllMocks();
});

describe("GET /api/vmaf-jobs/[id]/export", () => {
	it("emits FULL CSV (rendition,frameNum,vmaf) over every rendition", async () => {
		findUnique.mockResolvedValueOnce(jobWithTwoRenditions());
		const res = await GET(
			new Request(`http://test/api/vmaf-jobs/${JOB_ID}/export?format=csv`),
			params(),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/text\/csv/);
		expect(res.headers.get("content-disposition")).toMatch(/attachment/);
		const text = await res.text();
		const lines = text.trim().split("\n");
		expect(lines[0]).toBe("rendition,frameNum,vmaf,psnr");
		// header + 3 (360p) + 2 (720p) rows = 6 lines, FULL data (not downsampled).
		expect(lines).toHaveLength(6);
		// VMAF-only frames leave the psnr column empty (trailing comma).
		expect(lines).toContain("360p,0,90,");
		expect(lines).toContain("720p,1,96,");
	});

	it("emits a JSON document with per-rendition full frame arrays", async () => {
		findUnique.mockResolvedValueOnce(jobWithTwoRenditions());
		const res = await GET(
			new Request(`http://test/api/vmaf-jobs/${JOB_ID}/export?format=json`),
			params(),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/application\/json/);
		const body = JSON.parse(await res.text());
		expect(body.vmafJobId).toBe(JOB_ID);
		expect(body.renditions).toHaveLength(2);
		expect(body.renditions[0].label).toBe("360p");
		expect(body.renditions[0].frames).toEqual([
			{ frameNum: 0, vmaf: 90 },
			{ frameNum: 1, vmaf: 80 },
			{ frameNum: 2, vmaf: 70 },
		]);
	});

	it("scopes to a single rendition via ?result=", async () => {
		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			model: "vmaf_v0.6.1",
			results: [
				{
					id: "00000000-0000-4000-8000-0000000000d2",
					renditionRef: { label: "720p" },
					framesGzip: gz(frames([95, 96])),
				},
			],
		});
		const res = await GET(
			new Request(
				`http://test/api/vmaf-jobs/${JOB_ID}/export?format=csv&result=00000000-0000-4000-8000-0000000000d2`,
			),
			params(),
		);
		expect(res.status).toBe(200);
		// findUnique called with a where filter scoping results to the id.
		const arg = findUnique.mock.calls[0]?.[0] as {
			select: { results: { where?: { id: string } } };
		};
		expect(arg.select.results.where).toEqual({
			id: "00000000-0000-4000-8000-0000000000d2",
		});
		const lines = (await res.text()).trim().split("\n");
		expect(lines).toHaveLength(3); // header + 2 frames
	});

	it("escapes a rendition label containing a comma in CSV", async () => {
		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			model: "vmaf_v0.6.1",
			results: [
				{
					id: "00000000-0000-4000-8000-0000000000d3",
					renditionRef: { label: "1080p, HDR" },
					framesGzip: gz(frames([99])),
				},
			],
		});
		const res = await GET(
			new Request(`http://test/api/vmaf-jobs/${JOB_ID}/export?format=csv`),
			params(),
		);
		const text = await res.text();
		expect(text).toContain('"1080p, HDR",0,99,');
	});

	it("quotes labels with embedded quotes/newlines and neutralizes formula-injection", async () => {
		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			model: "vmaf_v0.6.1",
			results: [
				{
					id: "00000000-0000-4000-8000-0000000000d4",
					renditionRef: { label: 'a"b\nc' },
					framesGzip: gz(frames([88])),
				},
				{
					id: "00000000-0000-4000-8000-0000000000d5",
					renditionRef: { label: "=HYPERLINK(1)" },
					framesGzip: gz(frames([77])),
				},
			],
		});
		const res = await GET(
			new Request(`http://test/api/vmaf-jobs/${JOB_ID}/export?format=csv`),
			params(),
		);
		const text = await res.text();
		// inner quote doubled + whole field quoted (contains a quote and newline).
		expect(text).toContain('"a""b\nc",0,88,');
		// leading "=" neutralized with a single-quote prefix (CSV-injection guard).
		expect(text).toContain("'=HYPERLINK(1),0,77,");
	});

	it("includes a psnr value in CSV/JSON when the frames carry it (P4-PR5)", async () => {
		const psnrFrames = [
			{ frameNum: 0, vmaf: 95, psnr: 42.5 },
			{ frameNum: 1, vmaf: 96, psnr: 44 },
		];
		findUnique.mockResolvedValue({
			id: JOB_ID,
			model: "vmaf_v0.6.1",
			results: [
				{
					id: "00000000-0000-4000-8000-0000000000d6",
					renditionRef: { label: "1080p" },
					framesGzip: gzipSync(Buffer.from(JSON.stringify(psnrFrames), "utf8")),
				},
			],
		});

		const csv = await GET(
			new Request(`http://test/api/vmaf-jobs/${JOB_ID}/export?format=csv`),
			params(),
		);
		const text = await csv.text();
		expect(text.split("\n")[0]).toBe("rendition,frameNum,vmaf,psnr");
		expect(text).toContain("1080p,0,95,42.5");
		expect(text).toContain("1080p,1,96,44");

		const json = await GET(
			new Request(`http://test/api/vmaf-jobs/${JOB_ID}/export?format=json`),
			params(),
		);
		const body = JSON.parse(await json.text());
		expect(body.renditions[0].frames).toEqual(psnrFrames);
	});

	it("404s a missing job", async () => {
		findUnique.mockResolvedValueOnce(null);
		const res = await GET(
			new Request(`http://test/api/vmaf-jobs/${JOB_ID}/export`),
			params(),
		);
		expect(res.status).toBe(404);
	});
});
