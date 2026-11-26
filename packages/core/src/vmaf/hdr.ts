import { z } from "zod";

/** Native PQ/ICtCp protocol, separate from every existing SDR generation. */
export const HDR_VMAF_SCORING_VERSION = 14;
export const HDR_LIBVMAF_REVISION = "a6ed0f18285cab504b779bbccb0bbaddc3bf44c2";
export const HDR_VMAF_MODELS = [
	{
		id: "hdr_vmaf_v1.1.8_3d0h_2160",
		sha256: "6e1bb29ade13e1cad05e1d13fed2ad76fc8e3d3621bd5e02ab23e5c98c0afffd",
	},
	{
		id: "hdr_vmaf_v1.1.8_1d5h_2160",
		sha256: "53d36d3173012efa6eb65ada92aa3967d3caceee68d088275b2a51a320948510",
	},
	{
		id: "hdr_vmaf_v1.1.8_hfr_3d0h_2160",
		sha256: "f32904ac748319a8dc584aeffa776df30e5002e95270414a57a9802a9c2b31d1",
	},
	{
		id: "hdr_vmaf_v1.1.8_hfr_1d5h_2160",
		sha256: "c8a979574c0d79bb22198323e6b4024b47bd305e5aa09575c4735fef43476bd8",
	},
] as const;
export function isHdrVmafModel(model: string): boolean {
	return HDR_VMAF_MODELS.some((entry) => entry.id === model);
}
export function hdrModelFrameRateMatches(
	model: string,
	rate: string | number,
): boolean {
	const parts =
		typeof rate === "string" ? rate.split("/").map(Number) : [rate, 1];
	const fps = Number(parts[0]) / Number(parts[1]);
	return (
		isHdrVmafModel(model) &&
		Number.isFinite(fps) &&
		(model.includes("_hfr_") ? fps >= 50 && fps <= 60 : fps >= 23 && fps <= 30)
	);
}

const integer = z.number().int().positive().safe();
const inputSchema = z.strictObject({
	width: integer.max(4096),
	height: integer.max(2160),
	pixelFormat: z.enum([
		"rgb48le",
		"gbrp12le",
		"gbrp16le",
		"yuv420p10le",
		"yuv444p16le",
	]),
	bitDepth: z.union([z.literal(10), z.literal(12), z.literal(16)]),
	range: z.enum(["limited", "full"]),
	primaries: z.enum(["bt2020", "smpte432"]),
	transfer: z.enum(["smpte2084", "arib-std-b67"]),
	matrix: z.enum(["bt2020nc", "gbr"]),
	frameRate: z.string().regex(/^[1-9]\d{0,7}\/[1-9]\d{0,7}$/),
	attributeSource: z.enum(["STREAM_METADATA", "P3_D65_PQ_RGB_FULL"]),
	dolbyVision: z
		.strictObject({ profile: z.literal(10), compatibilityId: z.literal(1) })
		.optional(),
});
export type HdrInput = z.infer<typeof inputSchema>;
export type HdrReferenceColor = "P3_D65_PQ_RGB_FULL";
const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

/** The explicit RGB declaration supplies missing IMF color attributes.
 * It never overrides contrary tags or supplies a presentation clock. */
export function hdrInputFromProbe(
	text: string,
	role: "reference" | "distorted",
	declared?: HdrReferenceColor,
): HdrInput {
	if (text.length > 1_048_576) throw new Error("HDR_PROBE_LIMIT");
	const probe = record(JSON.parse(text));
	const streams: unknown = probe?.streams;
	const videos = Array.isArray(streams)
		? streams.map(record).filter((v) => v?.codec_type === "video")
		: [];
	const video = videos[0];
	if (videos.length !== 1 || !video)
		throw new Error("HDR_VIDEO_SELECTION_UNSUPPORTED");
	if (
		video.sample_aspect_ratio !== "1:1" ||
		(video.field_order !== "progressive" &&
			!(video.codec_name === "av1" && video.field_order === undefined)) ||
		["crop_top", "crop_bottom", "crop_left", "crop_right"].some(
			(key) => video[key] !== undefined && video[key] !== 0,
		)
	)
		throw new Error("HDR_PRESENTATION_UNSUPPORTED");
	const side = Array.isArray(video.side_data_list)
		? video.side_data_list.map(record)
		: [];
	if (
		side.some((s) =>
			[
				"Display Matrix",
				"Frame Cropping",
				"Stereo 3D",
				"Spherical Mapping",
			].includes(String(s?.side_data_type)),
		)
	)
		throw new Error("HDR_PRESENTATION_UNSUPPORTED");
	const dovi = side.filter(
		(s) => s?.side_data_type === "DOVI configuration record",
	);
	if (
		dovi.length &&
		(dovi.length !== 1 ||
			dovi[0]?.dv_profile !== 10 ||
			dovi[0]?.dv_bl_signal_compatibility_id !== 1 ||
			dovi[0]?.el_present_flag !== 0 ||
			dovi[0]?.bl_present_flag !== 1 ||
			dovi[0]?.rpu_present_flag !== 1 ||
			video.color_transfer !== "smpte2084" ||
			video.codec_name !== "av1")
	)
		throw new Error("HDR_DOLBY_BASE_LAYER_UNSUPPORTED");
	const rgb = ["rgb48le", "gbrp12le", "gbrp16le"].includes(
		String(video.pix_fmt),
	);
	let range =
		video.color_range === "tv" || video.color_range === "mpeg"
			? "limited"
			: video.color_range === "pc" || video.color_range === "jpeg"
				? "full"
				: undefined;
	let matrix = video.color_space;
	let primaries = video.color_primaries;
	let transfer = video.color_transfer;
	if (declared) {
		if (
			role !== "reference" ||
			!rgb ||
			(primaries !== undefined && primaries !== "smpte432") ||
			(transfer !== undefined && transfer !== "smpte2084") ||
			(video.color_range !== undefined && range !== "full") ||
			(matrix !== undefined && matrix !== "gbr" && matrix !== "rgb")
		)
			throw new Error("HDR_REFERENCE_DECLARATION_MISMATCH");
		range = "full";
		matrix = "gbr";
		primaries = "smpte432";
		transfer = "smpte2084";
	}
	if (!range || !matrix || !primaries || !transfer)
		throw new Error("HDR_COLOR_ATTRIBUTES_REQUIRED");
	if (!["smpte2084", "arib-std-b67"].includes(String(transfer)))
		throw new Error("HDR_TRANSFER_UNSUPPORTED");
	if (transfer === "arib-std-b67" && (rgb || primaries !== "bt2020"))
		throw new Error("HDR_HLG_COLOR_SPACE_UNSUPPORTED");
	if (
		role === "distorted" &&
		(video.pix_fmt !== "yuv420p10le" ||
			range !== "limited" ||
			primaries !== "bt2020" ||
			matrix !== "bt2020nc")
	)
		throw new Error("HDR_ENCODED_FORMAT_UNSUPPORTED");
	if (
		rgb
			? range !== "full" || matrix !== "gbr"
			: range !== "limited" || matrix !== "bt2020nc" || primaries !== "bt2020"
	)
		throw new Error("HDR_COLOR_SPACE_UNSUPPORTED");
	let frameRate = String(video.avg_frame_rate);
	// Some declared RGB MXF streams expose only a nominal edit rate. This is
	// a candidate clock: the HDR runner must validate every PTS/duration and
	// every declared edit unit before starting the scorer. Never rewrite avg.
	if (
		declared === "P3_D65_PQ_RGB_FULL" &&
		role === "reference" &&
		rgb &&
		record(probe?.format)?.format_name === "mxf" &&
		frameRate === "0/0" &&
		typeof video.r_frame_rate === "string" &&
		/^[1-9]\d{0,7}\/[1-9]\d{0,7}$/.test(video.r_frame_rate) &&
		typeof video.time_base === "string" &&
		/^[1-9]\d{0,7}\/[1-9]\d{0,7}$/.test(video.time_base) &&
		typeof video.duration_ts === "number" &&
		Number.isSafeInteger(video.duration_ts) &&
		video.duration_ts > 0 &&
		video.duration_ts <= 500_000
	) {
		const [rateNum = 0n, rateDen = 0n] = video.r_frame_rate
			.split("/")
			.map(BigInt);
		const [tickNum = 0n, tickDen = 0n] = video.time_base.split("/").map(BigInt);
		if (rateNum * tickNum === rateDen * tickDen) frameRate = video.r_frame_rate;
	}
	const parts = frameRate.split("/").map(Number);
	const rate = (parts[0] ?? 0) / (parts[1] ?? 0);
	if (
		!Number.isFinite(rate) ||
		rate < 23 ||
		(rate > 30 && rate < 50) ||
		rate > 60 ||
		video.r_frame_rate !== frameRate
	)
		throw new Error("HDR_FRAME_RATE_UNSUPPORTED");
	const depth =
		Number(video.bits_per_raw_sample) ||
		(video.pix_fmt === "yuv420p10le"
			? 10
			: video.pix_fmt === "gbrp12le"
				? 12
				: 16);
	const input = inputSchema.parse({
		width: video.width,
		height: video.height,
		pixelFormat: video.pix_fmt,
		bitDepth: depth,
		range,
		matrix,
		primaries,
		transfer,
		frameRate,
		attributeSource: declared ?? "STREAM_METADATA",
		...(dovi.length
			? { dolbyVision: { profile: 10, compatibilityId: 1 } }
			: {}),
	});
	if (
		input.width % 2 ||
		input.height % 2 ||
		input.width < 216 ||
		input.height < 216
	)
		throw new Error("HDR_GEOMETRY_UNSUPPORTED");
	return input;
}

export const hdrMeasurementSchema = z
	.strictObject({
		version: z.literal(1),
		method: z.literal("HDR_VMAF_PQ_ICTCP_16"),
		scope: z.literal("HDR_BASE_LAYER"),
		dolbyRpuApplied: z.literal(false),
		model: z.enum([
			HDR_VMAF_MODELS[0].id,
			HDR_VMAF_MODELS[1].id,
			HDR_VMAF_MODELS[2].id,
			HDR_VMAF_MODELS[3].id,
		]),
		modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
		libvmafRevision: z.literal(HDR_LIBVMAF_REVISION),
		normalization: z.literal("ZIMG_BT2020_PQ_YUV444_16"),
		comparison: z.literal("LIMITED_BT2020_PQ_ICTCP420_16_DISPLAY2160"),
		reference: inputSchema,
		distorted: inputSchema,
		frameCount: integer,
		hlgReferenceDisplay: z
			.strictObject({
				peakNits: z.literal(1000),
				blackNits: z.literal(0),
				systemGamma: z.literal(1.2),
				approximateGamma: z.literal(false),
			})
			.optional(),
	})
	.refine(
		(value) =>
			HDR_VMAF_MODELS.some(
				(m) => m.id === value.model && m.sha256 === value.modelSha256,
			) &&
			value.reference.frameRate === value.distorted.frameRate &&
			hdrModelFrameRateMatches(value.model, value.reference.frameRate) &&
			Boolean(value.hlgReferenceDisplay) ===
				[value.reference.transfer, value.distorted.transfer].includes(
					"arib-std-b67",
				),
	);
export type HdrMeasurement = z.infer<typeof hdrMeasurementSchema>;
export function hdrMeasurementOf(
	provenance: unknown,
): HdrMeasurement | undefined {
	return hdrMeasurementSchema.safeParse(record(provenance)?.hdrMeasurement)
		.data;
}

type HdrCommandOptions = {
	referencePath: string;
	distortedPath: string;
	logPath: string;
	model: string;
	modelPath: string;
	reference: HdrInput;
	distorted: HdrInput;
	threads?: number;
	decoderThreads?: number;
};

/** zimg's exact display-referred HLG path uses a 1000-nit reference display
 * and luma-weighted OOTF gamma 1.2. agamma=false must not be dropped. */
export function hdrColorConversion(
	input: HdrInput,
	width = input.width,
	height = input.height,
): string {
	return [
		...(input.matrix === "gbr" ? ["format=gbrp16le"] : []),
		`zscale=w=${width}:h=${height}:filter=bicubic:matrixin=${input.matrix === "gbr" ? "gbr" : "2020_ncl"}:primariesin=${input.primaries === "bt2020" ? "2020" : "smpte432"}:transferin=${input.transfer}:rangein=${input.range}:matrix=2020_ncl:primaries=2020:transfer=smpte2084:range=limited:dither=none:npl=1000:agamma=false`,
		"format=yuv444p16le",
		"setparams=range=limited:color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc",
	].join(",");
}
export function buildHdrVmafCommand(options: HdrCommandOptions): string[] {
	const { reference: ref, distorted: dist } = options;
	if (!isHdrVmafModel(options.model) || ref.frameRate !== dist.frameRate)
		throw new Error("HDR_MEASUREMENT_CONTRACT_INVALID");
	if (!hdrModelFrameRateMatches(options.model, ref.frameRate))
		throw new Error("HDR_MODEL_FRAME_RATE_MISMATCH");
	for (const value of [options.modelPath, options.logPath])
		if (!/^\/[A-Za-z0-9/_.-]+$/.test(value))
			throw new Error("HDR_FILTER_PATH_INVALID");
	for (const value of [options.threads ?? 1, options.decoderThreads ?? 1])
		if (!Number.isSafeInteger(value) || value < 1 || value > 64)
			throw new Error("HDR_THREADS_INVALID");
	const leg = (input: HdrInput) =>
		[
			hdrColorConversion(input, ref.width, ref.height),
			"setsar=1",
			"settb=AVTB",
			`setpts=N/(${ref.frameRate})/TB`,
		].join(",");
	const graph = `[0:v:0]${leg(dist)}[dist];[1:v:0]${leg(ref)}[ref];[dist][ref]libvmaf=model='path=${options.modelPath}\\:cambi.enc_width=${dist.width}\\:cambi.enc_height=${dist.height}\\:cambi.enc_bitdepth=${dist.bitDepth}':log_fmt=json:log_path=${options.logPath}:n_threads=${options.threads ?? 1}:n_subsample=1:eof_action=endall:shortest=1:repeatlast=0[out]`;
	return [
		"-hide_banner",
		"-nostdin",
		"-v",
		"error",
		"-xerror",
		"-err_detect",
		"explode",
		"-noautorotate",
		"-threads",
		String(options.decoderThreads ?? 1),
		"-i",
		options.distortedPath,
		"-noautorotate",
		"-threads",
		String(options.decoderThreads ?? 1),
		"-i",
		options.referencePath,
		"-filter_complex_threads",
		"1",
		"-filter_complex",
		graph,
		"-map",
		"[out]",
		"-an",
		"-sn",
		"-fps_mode",
		"passthrough",
		"-f",
		"null",
		"-",
	];
}
