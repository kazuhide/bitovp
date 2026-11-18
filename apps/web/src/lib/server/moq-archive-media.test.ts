import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	hasWebmHeader,
	normalizeMoqArchive,
	validateMoqArchiveProbe,
} from "./moq-archive-media";

const execFile = vi.hoisted(() =>
	vi.fn<
		(
			executable: string,
			args: string[],
			options: object,
			done: (error: Error | null, result: { stdout: string }) => void,
		) => void
	>(),
);
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, default: { ...actual, execFile }, execFile };
});

const probe = () => ({
	format: { format_name: "matroska,webm" },
	streams: [{ index: 0, codec_type: "video", codec_name: "vp8" }],
	packets: [
		{ stream_index: 0, pts_time: "0.000", duration_time: "0.033" },
		{ stream_index: 0, pts_time: "9.967", duration_time: "0.033" },
	],
});
describe("bounded WebM archive media validation", () => {
	it("requires an EBML header with the actual WebM DocType", () => {
		expect(
			hasWebmHeader(
				Buffer.from([
					0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62,
					0x6d,
				]),
			),
		).toBe(true);
		expect(hasWebmHeader(Buffer.from("not webm"))).toBe(false);
		expect(
			hasWebmHeader(
				Buffer.from([
					0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x66, 0x61, 0x6b,
					0x65,
				]),
			),
		).toBe(false);
	});
	it("derives actual duration from packet timestamps even when MediaRecorder omits format duration", () => {
		expect(validateMoqArchiveProbe(probe())).toBe(10_000);
	});
	it.each([
		{ streams: [{ index: 0, codec_type: "audio", codec_name: "opus" }] },
		{ packets: [] },
		{
			packets: [
				{ stream_index: 0, pts_time: "0" },
				{ stream_index: 0, pts_time: "91" },
			],
		},
		{ format: { format_name: "matroska,webm", duration: "91" } },
		{ packets: [{ stream_index: 0, pts_time: "NaN" }] },
		{
			packets: Array.from({ length: 40_001 }, () => ({
				stream_index: 0,
				pts_time: "0",
			})),
		},
	])("refuses absent video, invalid timestamps or a recording longer than ninety seconds", (override) => {
		expect(() =>
			validateMoqArchiveProbe({ ...probe(), ...override }),
		).toThrow();
	});
});

describe("MoQ archive normalization at the recording limit", () => {
	const source = "/capture.webm";
	const target = "/saved.webm";

	const media = (
		lastPacketAt: string,
		duration: string,
		priorPacketAt?: string,
	) => ({
		...probe(),
		format: { ...probe().format, duration },
		packets: [
			{ stream_index: 0, pts_time: "0.000", duration_time: "0.033" },
			...(priorPacketAt
				? [{ stream_index: 0, pts_time: priorPacketAt, duration_time: "0.033" }]
				: []),
			{
				stream_index: 0,
				pts_time: lastPacketAt,
				duration_time: "0.033",
			},
		],
	});

	function stubMediaTools(
		input: ReturnType<typeof media>,
		output: ReturnType<typeof media>,
	) {
		execFile.mockImplementation((_file, args, _options, done) => {
			const readingSource = args[args.indexOf("-i") + 1] === source;
			const stdout = args.includes("-show_packets")
				? JSON.stringify(readingSource ? input : output)
				: "";
			done(null, { stdout });
		});
	}

	beforeEach(() => {
		execFile.mockReset();
	});

	it("saves a seekable clip after a late automatic stop and reports the saved duration", async () => {
		stubMediaTools(media("90.467", "90.500"), media("89.866", "89.899"));

		await expect(normalizeMoqArchive(source, target)).resolves.toBe(89_899);
		const [, remux, confirmed] = execFile.mock.calls;
		const args = remux?.[1] ?? [];
		const limitSeconds = Number(args[args.indexOf("-t") + 1]);
		expect(limitSeconds).toBeGreaterThan(89.8);
		expect(limitSeconds).toBeLessThan(90);
		expect(args).toContain("0:a:0?");
		expect(confirmed?.[1]).toContain(target);
	});

	it("rejects a capture well beyond the recording limit before remux", async () => {
		stubMediaTools(media("95.967", "96.000"), media("89.866", "89.899"));

		await expect(normalizeMoqArchive(source, target)).rejects.toThrow(
			"Invalid WebM archive",
		);
		expect(execFile).toHaveBeenCalledOnce();
	});

	it("rejects an output that still exceeds the saved duration limit", async () => {
		stubMediaTools(media("90.467", "90.500"), media("90.000", "90.033"));

		await expect(normalizeMoqArchive(source, target)).rejects.toThrow(
			"Invalid WebM archive",
		);
		expect(execFile).toHaveBeenCalledTimes(3);
	});

	it("still rejects unexpected truncation after applying the duration cap", async () => {
		stubMediaTools(
			media("90.467", "90.500", "89.700"),
			media("74.967", "75.000"),
		);

		await expect(normalizeMoqArchive(source, target)).rejects.toThrow(
			"WebM archive was truncated",
		);
	});

	it("keeps available video when a frame gap spans the cutoff", async () => {
		stubMediaTools(
			media("90.457", "90.490", "88.956"),
			media("88.956", "88.989"),
		);

		await expect(normalizeMoqArchive(source, target)).resolves.toBe(88_989);
	});

	it("copy-remuxes a short archive without shortening it", async () => {
		stubMediaTools(media("9.967", "10.000"), media("9.967", "10.000"));

		await expect(normalizeMoqArchive(source, target)).resolves.toBe(10_000);
		expect(execFile.mock.calls[1]?.[1]).not.toContain("-t");
	});
});
