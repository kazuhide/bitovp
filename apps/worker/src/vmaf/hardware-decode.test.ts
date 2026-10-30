import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessRunner } from "../feeder/supervisor";
import {
	hardwareDecodeFailureReason,
	selectHardwareDecode,
} from "./hardware-decode";

const probe = (video: Record<string, unknown> = {}) =>
	JSON.stringify({
		streams: [
			{
				codec_type: "video",
				codec_name: "h264",
				pix_fmt: "yuv420p",
				...video,
			},
		],
	});

const setup = () => {
	const run = vi.fn<ProcessRunner["run"]>().mockResolvedValue({
		code: 0,
		stdout: "frame=3\nprogress=end\n",
		stderr: "",
	});
	return {
		run,
		options: {
			policy: { backend: "auto" as const, device: 2 },
			probe: probe(),
			path: "/tmp/input with spaces.mp4",
			runner: { run, spawn: vi.fn() } satisfies ProcessRunner,
			ffmpegPath: "/opt/ffmpeg/bin/ffmpeg",
		},
	};
};

const identityDisplayMatrix = [
	"",
	"00000000:        65536           0           0",
	"00000001:            0       65536           0",
	"00000002:            0           0  1073741824",
	"",
].join("\n");

const containerCrop = {
	side_data_type: "Frame Cropping",
	crop_top: 9,
	crop_bottom: 9,
	crop_left: 16,
	crop_right: 16,
};

afterEach(() => vi.useRealTimers());

describe("hardware decode qualification", () => {
	it("keeps CPU policy a no-op without parsing or launching", async () => {
		const { run, options } = setup();
		expect(
			await selectHardwareDecode({
				...options,
				policy: { backend: "cpu", device: 0 },
				probe: "not JSON",
			}),
		).toEqual({});
		expect(run).not.toHaveBeenCalled();
	});

	it.each([
		["h264", "yuv420p", "8", "nv12"],
		["hevc", "yuv420p10le", "10", "p010le"],
		["vp9", "yuv420p", "0", "nv12"],
		["av1", "p010le", undefined, "p010le"],
		["hevc", "nv12", 8, "nv12"],
		["h264", "yuvj420p", undefined, "nv12"],
	])("qualifies %s/%s by decoding actual CUDA frames", async (codec_name, pix_fmt, bits_per_raw_sample, downloadFormat) => {
		const { run, options } = setup();
		expect(
			await selectHardwareDecode({
				...options,
				probe: probe({ codec_name, pix_fmt, bits_per_raw_sample }),
			}),
		).toEqual({ cuda: { device: 2, downloadFormat } });
		expect(run).toHaveBeenCalledOnce();
		const call = run.mock.calls[0];
		if (!call) throw new Error("Expected a CUDA qualification process");
		const [binary, argv, settings] = call;
		expect(binary).toBe(options.ffmpegPath);
		expect(argv).toEqual([
			"-hide_banner",
			"-nostdin",
			"-progress",
			"pipe:1",
			"-nostats",
			"-hwaccel",
			"cuda",
			"-hwaccel_device",
			"2",
			"-hwaccel_output_format",
			"cuda",
			"-i",
			options.path,
			"-map",
			"0:v:0",
			"-frames:v",
			"3",
			"-vf",
			`hwdownload,format=${downloadFormat}`,
			"-an",
			"-sn",
			"-f",
			"null",
			"-",
		]);
		expect(settings).toMatchObject({
			abortKillAfterMs: 250,
			signal: expect.any(AbortSignal),
		});
	});

	it.each([
		{
			label: "container clean aperture",
			video: { side_data_list: [containerCrop] },
			reason: "CUDA_CONTAINER_CROP_REQUIRES_CPU",
		},
		{
			label: "90-degree display rotation",
			video: {
				side_data_list: [
					{
						side_data_type: "Display Matrix",
						rotation: 90,
						displaymatrix:
							"\n00000000:            0       65536           0\n00000001:       -65536           0           0\n00000002:            0           0  1073741824\n",
					},
				],
			},
			reason: "CUDA_DISPLAY_MATRIX_REQUIRES_CPU",
		},
		{
			label: "180-degree display rotation",
			video: {
				side_data_list: [
					{
						side_data_type: "Display Matrix",
						rotation: 180,
						displaymatrix:
							"\n00000000:       -65536           0           0\n00000001:            0      -65536           0\n00000002:            0           0  1073741824\n",
					},
				],
			},
			reason: "CUDA_DISPLAY_MATRIX_REQUIRES_CPU",
		},
		{
			label: "zero-rotation mirror matrix",
			video: {
				side_data_list: [
					{
						side_data_type: "Display Matrix",
						rotation: 0,
						displaymatrix: identityDisplayMatrix.replace(
							"       65536           0\n00000002",
							"      -65536           0\n00000002",
						),
					},
				],
			},
			reason: "CUDA_DISPLAY_MATRIX_REQUIRES_CPU",
		},
		{
			label: "missing display matrix despite zero rotation",
			video: {
				side_data_list: [{ side_data_type: "Display Matrix", rotation: 0 }],
			},
			reason: "CUDA_DISPLAY_MATRIX_REQUIRES_CPU",
		},
		{
			label: "malformed display matrix",
			video: {
				side_data_list: [
					{
						side_data_type: "Display Matrix",
						rotation: 0,
						displaymatrix: "not a matrix",
					},
				],
			},
			reason: "CUDA_DISPLAY_MATRIX_REQUIRES_CPU",
		},
		{
			label: "truncated display matrix",
			video: {
				side_data_list: [
					{
						side_data_type: "Display Matrix",
						rotation: 0,
						displaymatrix: identityDisplayMatrix.split("00000002:")[0],
					},
				],
			},
			reason: "CUDA_DISPLAY_MATRIX_REQUIRES_CPU",
		},
		{
			label: "almost-unit display matrix",
			video: {
				side_data_list: [
					{
						side_data_type: "Display Matrix",
						rotation: 0,
						displaymatrix: identityDisplayMatrix.replace("65536", "65535"),
					},
				],
			},
			reason: "CUDA_DISPLAY_MATRIX_REQUIRES_CPU",
		},
		{
			label: "unit matrix with conflicting rotation",
			video: {
				side_data_list: [
					{
						side_data_type: "Display Matrix",
						rotation: 90,
						displaymatrix: identityDisplayMatrix,
					},
				],
			},
			reason: "CUDA_DISPLAY_MATRIX_REQUIRES_CPU",
		},
		{
			label: "legacy rotation tag",
			video: { tags: { rotate: "90" } },
			reason: "CUDA_DISPLAY_MATRIX_REQUIRES_CPU",
		},
	])("keeps $label on CPU before launching a CUDA process", async ({
		video,
		reason,
	}) => {
		const { run, options } = setup();
		expect(
			await selectHardwareDecode({ ...options, probe: probe(video) }),
		).toEqual({ reason });
		expect(run).not.toHaveBeenCalled();
		await expect(
			selectHardwareDecode({
				...options,
				policy: { backend: "cuda", device: 2 },
				probe: probe(video),
			}),
		).rejects.toThrow(reason);
		expect(run).not.toHaveBeenCalled();
	});

	it.each([
		{
			label: "all-zero container crop",
			video: {
				side_data_list: [
					{
						side_data_type: "Frame Cropping",
						crop_top: 0,
						crop_bottom: 0,
						crop_left: 0,
						crop_right: 0,
					},
				],
			},
		},
		{
			label: "exact unit display matrix with zero rotation",
			video: {
				side_data_list: [
					{
						side_data_type: "Display Matrix",
						rotation: 0,
						displaymatrix: identityDisplayMatrix,
					},
				],
			},
		},
		{
			label: "unrelated HDR side data",
			video: {
				side_data_list: [
					{
						side_data_type: "Mastering display metadata",
						red_x: "34000/50000",
					},
					{
						side_data_type: "Content light level metadata",
						max_content: 1000,
						max_average: 400,
					},
				],
			},
		},
	])("still qualifies CUDA for $label", async ({ video }) => {
		const { run, options } = setup();
		expect(
			await selectHardwareDecode({ ...options, probe: probe(video) }),
		).toEqual({ cuda: { device: 2, downloadFormat: "nv12" } });
		expect(run).toHaveBeenCalledOnce();
	});

	it("ignores presentation metadata on audio and later video streams", async () => {
		const { run, options } = setup();
		const value = JSON.stringify({
			streams: [
				{
					codec_type: "audio",
					codec_name: "aac",
					side_data_list: [containerCrop],
				},
				{ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p" },
				{
					codec_type: "video",
					codec_name: "h264",
					pix_fmt: "yuv420p",
					side_data_list: [containerCrop],
				},
			],
		});
		expect(await selectHardwareDecode({ ...options, probe: value })).toEqual({
			cuda: { device: 2, downloadFormat: "nv12" },
		});
		expect(run).toHaveBeenCalledOnce();
	});

	it("keeps the first cropped video on CPU despite a later plain video", async () => {
		const { run, options } = setup();
		const value = JSON.stringify({
			streams: [
				{
					codec_type: "video",
					codec_name: "h264",
					pix_fmt: "yuv420p",
					side_data_list: [containerCrop],
				},
				{ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p" },
			],
		});
		expect(await selectHardwareDecode({ ...options, probe: value })).toEqual({
			reason: "CUDA_CONTAINER_CROP_REQUIRES_CPU",
		});
		expect(run).not.toHaveBeenCalled();
	});

	it("keeps CPU policy a no-op even with presentation transforms", async () => {
		const { run, options } = setup();
		expect(
			await selectHardwareDecode({
				...options,
				policy: { backend: "cpu", device: 0 },
				probe: probe({
					side_data_list: [containerCrop],
					tags: { rotate: "90" },
				}),
			}),
		).toEqual({});
		expect(run).not.toHaveBeenCalled();
	});

	it.each([
		[{ codec_name: "mpeg2video" }, "CUDA_UNSUPPORTED_CODEC"],
		[
			{ codec_name: "h264", pix_fmt: "yuv420p10le" },
			"CUDA_UNSUPPORTED_H264_DEPTH",
		],
		[{ pix_fmt: "yuv422p" }, "CUDA_UNSUPPORTED_PIXEL_FORMAT"],
		[{ pix_fmt: "yuv420p12le" }, "CUDA_UNSUPPORTED_PIXEL_FORMAT"],
		[{ pix_fmt: undefined }, "CUDA_UNSUPPORTED_PIXEL_FORMAT"],
		[{ bits_per_raw_sample: "10" }, "CUDA_CONFLICTING_BIT_DEPTH"],
		[{ bits_per_raw_sample: "N/A" }, "CUDA_UNKNOWN_BIT_DEPTH"],
	])("keeps unsupported metadata on CPU: %j", async (video, reason) => {
		const { run, options } = setup();
		expect(
			await selectHardwareDecode({ ...options, probe: probe(video) }),
		).toEqual({ reason });
		expect(run).not.toHaveBeenCalled();
		await expect(
			selectHardwareDecode({
				...options,
				policy: { backend: "cuda", device: 2 },
				probe: probe(video),
			}),
		).rejects.toThrow(String(reason));
	});

	it.each([
		"not JSON",
		"null",
		"{}",
		'{"streams":[]}',
		'{"streams":[null]}',
	])("handles incomplete probe metadata without starting a process: %s", async (value) => {
		const { run, options } = setup();
		expect(await selectHardwareDecode({ ...options, probe: value })).toEqual({
			reason: "CUDA_INVALID_PROBE",
		});
		expect(run).not.toHaveBeenCalled();
	});

	it("selects only the first video stream, even when a later video is supported", async () => {
		const { run, options } = setup();
		const value = JSON.stringify({
			streams: [
				{ codec_type: "audio", codec_name: "aac" },
				{ codec_type: "video", codec_name: "mjpeg", pix_fmt: "yuv420p" },
				{ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p" },
			],
		});
		expect(await selectHardwareDecode({ ...options, probe: value })).toEqual({
			reason: "CUDA_UNSUPPORTED_CODEC",
		});
		expect(run).not.toHaveBeenCalled();
	});

	it("accepts a short input that decoded one real frame", async () => {
		const { run, options } = setup();
		run.mockResolvedValue({
			code: 0,
			stdout: "frame=1\nprogress=end\n",
			stderr: "",
		});
		expect(await selectHardwareDecode(options)).toHaveProperty("cuda");
	});

	it.each([
		"",
		"frame=0\nprogress=end\n",
		"frame=invalid\n",
	])("rejects a successful process that did not prove any decoded frames", async (stdout) => {
		const { run, options } = setup();
		run.mockResolvedValue({ code: 0, stdout, stderr: "" });
		await expect(selectHardwareDecode(options)).rejects.toThrow(
			"CUDA_DECODE_PROBE_EMPTY",
		);
	});

	it("falls back only in automatic mode for a recognized unavailable device", async () => {
		const { run, options } = setup();
		run.mockResolvedValue({
			code: 1,
			stdout: "",
			stderr: "Cannot load libcuda.so.1 at /private/user-input.mp4",
		});
		expect(await selectHardwareDecode(options)).toEqual({
			reason: "CUDA_DRIVER_UNAVAILABLE",
		});
		await expect(
			selectHardwareDecode({
				...options,
				policy: { backend: "cuda", device: 2 },
			}),
		).rejects.toThrow("CUDA_DRIVER_UNAVAILABLE");
	});

	it.each([
		"Hardware is lacking required capabilities",
		"Video width 7680 not within range from 48 to 4096",
		"Video height 4320 not within range from 16 to 4096",
		"Video macroblock count 129600 exceeds maximum of 65536",
	])("uses CPU when NVDEC reports unsupported hardware capabilities: %s", async (stderr) => {
		const { run, options } = setup();
		run.mockResolvedValue({ code: 1, stdout: "", stderr });
		expect(await selectHardwareDecode(options)).toEqual({
			reason: "CUDA_NVDEC_CAPABILITY_UNSUPPORTED",
		});
		await expect(
			selectHardwareDecode({
				...options,
				policy: { backend: "cuda", device: 0 },
			}),
		).rejects.toThrow("CUDA_NVDEC_CAPABILITY_UNSUPPORTED");
	});

	it.each([
		"Invalid data found when processing input",
		"corrupt decoded frame",
		"Unknown encoder: libvmaf",
		"Unrecognized option mystery",
		"Cannot load libcuda.so.1\nInvalid data found when processing input",
	])("does not hide input or unknown failures: %s", async (stderr) => {
		const { run, options } = setup();
		run.mockResolvedValue({ code: 1, stdout: "", stderr });
		await expect(selectHardwareDecode(options)).rejects.toThrow(
			"CUDA_DECODE_PROBE_FAILED",
		);
	});

	it("sanitizes unexpected process-launch failures instead of falling back", async () => {
		const { run, options } = setup();
		run.mockRejectedValue(
			new Error("/private/user-input.mp4 could not be opened"),
		);
		await expect(selectHardwareDecode(options)).rejects.toThrow(
			"CUDA_DECODE_PROBE_FAILED",
		);
	});

	it("propagates a pre-existing parent cancellation without starting a process", async () => {
		const { run, options } = setup();
		const controller = new AbortController();
		const reason = new Error("Canceled by the user");
		controller.abort(reason);
		await expect(
			selectHardwareDecode({ ...options, signal: controller.signal }),
		).rejects.toBe(reason);
		expect(run).not.toHaveBeenCalled();
	});

	it("does not turn parent cancellation into fallback after the process closes", async () => {
		const { run, options } = setup();
		const controller = new AbortController();
		const reason = new Error("Canceled by the user");
		run.mockImplementation(async () => {
			controller.abort(reason);
			return { code: 1, stdout: "", stderr: "CUDA_ERROR_NO_DEVICE" };
		});
		await expect(
			selectHardwareDecode({ ...options, signal: controller.signal }),
		).rejects.toBe(reason);
	});

	it("bounds qualification time and waits for process closure without falling back", async () => {
		vi.useFakeTimers();
		const { run, options } = setup();
		let finish: (() => void) | undefined;
		run.mockImplementation(
			(_binary, _args, settings) =>
				new Promise((resolve) => {
					finish = () =>
						resolve({ code: null, stdout: "", stderr: "CUDA_ERROR_NO_DEVICE" });
					expect(settings?.signal?.aborted).toBe(false);
				}),
		);
		const settled = vi.fn();
		const pending = selectHardwareDecode(options);
		void pending.then(settled, settled);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(run.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
		expect(settled).not.toHaveBeenCalled();
		finish?.();
		await expect(pending).rejects.toThrow("CUDA_DECODE_PROBE_TIMEOUT");
	});

	it.each([
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("rejects invalid device %s", async (device) => {
		const { run, options } = setup();
		await expect(
			selectHardwareDecode({ ...options, policy: { backend: "auto", device } }),
		).rejects.toThrow("CUDA_INVALID_DEVICE");
		expect(run).not.toHaveBeenCalled();
	});
});

describe("CUDA failure classification", () => {
	it("does not retry a missing model even when a CUDA failure is also reported", () => {
		expect(
			hardwareDecodeFailureReason(
				"Cannot load libcuda.so.1\ncould not load libvmaf model with version vmaf_v1.0.16_3d0h",
			),
		).toBeUndefined();
	});
	it.each([
		["Cannot load libcuda.so.1", "CUDA_DRIVER_UNAVAILABLE"],
		["Could not dynamically load CUDA", "CUDA_DRIVER_UNAVAILABLE"],
		["CUDA_ERROR_INSUFFICIENT_DRIVER", "CUDA_DRIVER_UNAVAILABLE"],
		["CUDA_ERROR_SYSTEM_DRIVER_MISMATCH", "CUDA_DRIVER_UNAVAILABLE"],
		["CUDA_ERROR_NO_DEVICE", "CUDA_DEVICE_UNAVAILABLE"],
		["No CUDA capable device is detected", "CUDA_DEVICE_UNAVAILABLE"],
		[
			"No device available for decoder: device type cuda needed for codec h264",
			"CUDA_DEVICE_UNAVAILABLE",
		],
		["Cannot load libnvcuvid.so.1", "CUDA_NVDEC_UNAVAILABLE"],
		["Failed loading nvcuvid.", "CUDA_NVDEC_UNAVAILABLE"],
		["Unknown hwaccel: cuda", "CUDA_BUILD_UNAVAILABLE"],
	])("classifies recognized availability failures: %s", (stderr, expected) => {
		expect(hardwareDecodeFailureReason(stderr)).toBe(expected);
	});

	it.each([
		"Device creation failed",
		"Invalid argument",
		"",
		"Error while decoding stream #0:0",
	])("leaves ambiguous errors fatal: %s", (stderr) =>
		expect(hardwareDecodeFailureReason(stderr)).toBeUndefined());
});
