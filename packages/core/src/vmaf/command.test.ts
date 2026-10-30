import { describe, expect, it } from "vitest";
import { buildVmafCommand } from "./command";

/**
 * The libvmaf argv builder is pure — these assert its exact shape (no
 * ffmpeg execution). Geometry conform + model selector + JSON log path are
 * the load-bearing details PR3's worker depends on.
 */

const BASE = {
	referencePath: "/spool/reference.mp4",
	distortedPath: "/spool/qc/v360.mp4",
	model: "vmaf_v0.6.1",
	logPath: "/spool/qc/v360.vmaf.json",
	scaleToReference: { width: 1920, height: 1080 },
	fpsConform: 24,
};

/** filter_complex is always the 8th token (after -filter_complex). */
function filterComplexOf(argv: string[]): string {
	const i = argv.indexOf("-filter_complex");
	expect(i).toBeGreaterThanOrEqual(0);
	return argv[i + 1] as string;
}

describe("NVDEC input handling", () => {
	it("preserves the complete CPU command when no input uses CUDA", () => {
		expect(buildVmafCommand({ ...BASE, decode: {} })).toEqual(
			buildVmafCommand(BASE),
		);
	});

	it("qualifies each input independently and downloads all planes before CPU processing", () => {
		const cpu = buildVmafCommand({ ...BASE, psnr: true, alignFrames: 2 });
		const gpu = buildVmafCommand({
			...BASE,
			psnr: true,
			alignFrames: 2,
			decode: { reference: { device: 1, downloadFormat: "p010le" } },
		});
		const first = gpu.indexOf("-i");
		const second = gpu.indexOf("-i", first + 1);
		expect(gpu.slice(0, first)).not.toContain("-hwaccel");
		expect(gpu.slice(first + 2, second)).toEqual([
			"-hwaccel",
			"cuda",
			"-hwaccel_device",
			"1",
			"-hwaccel_output_format",
			"cuda",
		]);
		expect(filterComplexOf(gpu)).toBe(
			filterComplexOf(cpu).replace(
				"[1:v]",
				"[1:v]hwdownload,format=p010le,format=yuv420p10le,",
			),
		);
		expect(filterComplexOf(gpu)).toContain("[dist][ref]libvmaf=");
		expect(filterComplexOf(gpu)).not.toContain("libvmaf_cuda");
	});

	it("keeps v1, scaling, frame timing and PSNR unchanged after the download", () => {
		const options = {
			...BASE,
			model: "vmaf_v1.0.16_3d0h",
			modelPath: "/models/vmaf_v1.0.16_3d0h.json",
			psnr: true,
			alignFrames: -3,
			decoderThreads: 2,
			filterComplexThreads: 1,
		};
		const cpu = buildVmafCommand(options);
		const gpu = buildVmafCommand({
			...options,
			decode: {
				distorted: { device: 0, downloadFormat: "nv12" },
				reference: { device: 0, downloadFormat: "p010le" },
			},
		});
		expect(filterComplexOf(gpu)).toBe(
			filterComplexOf(cpu)
				.replace("[0:v]", "[0:v]hwdownload,format=nv12,format=yuv420p,")
				.replace("[1:v]", "[1:v]hwdownload,format=p010le,format=yuv420p10le,"),
		);
		expect(gpu.filter((arg) => arg === "-hwaccel")).toHaveLength(2);
		expect(gpu.filter((arg) => arg === "-threads")).toHaveLength(2);
	});

	it.each([
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("rejects an invalid device ordinal: %s", (device) => {
		expect(() =>
			buildVmafCommand({
				...BASE,
				decode: { distorted: { device, downloadFormat: "nv12" } },
			}),
		).toThrow("INVALID_CUDA_DECODE_OPTIONS");
	});

	it("keeps hardware decoding outside the validated cloud-only measurement method", () => {
		expect(() =>
			buildVmafCommand({
				...BASE,
				measurementMethod: "FRAME_INDEX_BT709_10BIT",
				decode: { reference: { device: 0, downloadFormat: "nv12" } },
			}),
		).toThrow("GPU_DECODE_NOT_QUALIFIED_FOR_FRAME_INDEX_METHOD");
	});
});

describe("experimental VMAFx CUDA scoring", () => {
	const options = {
		...BASE,
		model: "vmaf_v1.0.16_3d0h",
		modelPath: "/models/vmaf_v1.0.16_3d0h.json",
		distortedOriginal: { width: 1280, height: 720, bitdepth: 8 },
		psnr: true,
		threads: 2,
		subsample: 1,
	};
	it("keeps CPU preprocessing and selects the requested model with full CUDA provenance", () => {
		const cpu = filterComplexOf(buildVmafCommand(options));
		const gpu = buildVmafCommand({
			...options,
			scoring: { backend: "vmafx-cuda", device: 0 },
		});
		const graph = filterComplexOf(gpu);
		expect(
			graph
				.slice(0, graph.indexOf("[dist][ref]"))
				.replaceAll("format=yuv420p10le,", ""),
		).toBe(cpu.slice(0, cpu.indexOf("[dist][ref]")));
		expect(graph.match(/format=yuv420p10le/g)).toHaveLength(2);
		expect(graph).toContain("[dist][ref]vmafx=");
		expect(graph).toContain(
			"backend=cuda:device=0:import=auto:gpumask=0:provenance=log+report:score_fmt=%.17g",
		);
		expect(graph).toContain(
			"model='path=/models/vmaf_v1.0.16_3d0h.json\\:name=vmaf\\:cambi.enc_width=1280\\:cambi.enc_height=720\\:cambi.enc_bitdepth=8'",
		);
		expect(graph).toContain("feature=psnr:");
		expect(graph).toContain("n_threads=2:n_subsample=1");
		expect(graph).toContain("eof_action=repeat:shortest=0:repeatlast=1");
		expect(gpu).not.toContain("-hwaccel");
	});
	it("requires an explicit model file and rejects unsupported features before executing", () => {
		expect(() =>
			buildVmafCommand({
				...BASE,
				scoring: { backend: "vmafx-cuda", device: 0 },
			}),
		).toThrow("VMAFX_REQUIRES_V1_MODEL_FILE");
		expect(() =>
			buildVmafCommand({
				...options,
				features: ["float_ssim"],
				scoring: { backend: "vmafx-cuda", device: 0 },
			}),
		).toThrow("VMAFX_UNQUALIFIED_FEATURE");
		expect(() =>
			buildVmafCommand({
				...options,
				subsample: 2,
				scoring: { backend: "vmafx-cuda", device: 0 },
			}),
		).toThrow("VMAFX_REQUIRES_ALL_FRAMES");
		expect(() =>
			buildVmafCommand({
				...options,
				distortedOriginal: undefined,
				scoring: { backend: "vmafx-cuda", device: 0 },
			}),
		).toThrow("VMAFX_REQUIRES_ORIGINAL_DISTORTED_GEOMETRY");
	});
	it("keeps the cloud-only generation outside experimental CUDA scoring", () => {
		expect(() =>
			buildVmafCommand({
				...options,
				measurementMethod: "FRAME_INDEX_BT709_10BIT",
				scoring: { backend: "vmafx-cuda", device: 0 },
			}),
		).toThrow("GPU_SCORING_NOT_QUALIFIED_FOR_FRAME_INDEX_METHOD");
	});
	it.each([
		"3d0h",
		"3d0h_2160",
		"5d0h",
		"1d5h_2160",
		"hfr_3d0h",
		"hfr_3d0h_2160",
		"hfr_5d0h",
		"hfr_1d5h_2160",
	])("preserves the exact selected v1 model: %s", (suffix) => {
		const model = `vmaf_v1.0.16_${suffix}`;
		const graph = filterComplexOf(
			buildVmafCommand({
				...options,
				model,
				modelPath: `/models/${model}.json`,
				scoring: { backend: "vmafx-cuda", device: 0 },
			}),
		);
		expect(graph).toContain(
			`model='path=/models/${model}.json\\:name=vmaf\\:cambi.enc_width=1280`,
		);
	});
});

describe("buildVmafCommand", () => {
	it("orders inputs distorted-first, reference-second", () => {
		const argv = buildVmafCommand(BASE);
		const i0 = argv.indexOf("-i");
		expect(argv[i0 + 1]).toBe("/spool/qc/v360.mp4"); // [0:v] distorted
		const i1 = argv.indexOf("-i", i0 + 1);
		expect(argv[i1 + 1]).toBe("/spool/reference.mp4"); // [1:v] reference
	});

	it("scale+fps-conforms the distorted input then runs libvmaf", () => {
		const fc = filterComplexOf(buildVmafCommand(BASE));
		expect(fc).toBe(
			// Both pads carry `setpts`: libvmaf pairs by PTS, and a mezzanine with a
			// non-zero first timestamp otherwise has its frame N scored against the
			// encode's frame N±1 — worth 61 VMAF points on a real encode.
			"[0:v]scale=1920:1080:flags=bicubic,fps=24,settb=AVTB,setpts=N/FRAME_RATE/TB[dist];" +
				"[1:v]settb=AVTB,setpts=N/FRAME_RATE/TB[ref];" +
				"[dist][ref]libvmaf=model=version=vmaf_v0.6.1:log_path=/spool/qc/v360.vmaf.json:log_fmt=json[out]",
		);
	});

	it("selects a built-in model with model=version= and JSON log", () => {
		const fc = filterComplexOf(buildVmafCommand(BASE));
		expect(fc).toContain("libvmaf=model=version=vmaf_v0.6.1");
		expect(fc).toContain("log_path=/spool/qc/v360.vmaf.json");
		expect(fc).toContain("log_fmt=json");
	});

	it("uses model=path= when a custom model file is given", () => {
		const fc = filterComplexOf(
			buildVmafCommand({ ...BASE, modelPath: "/models/vmaf_v0.6.1.json" }),
		);
		expect(fc).toContain("libvmaf=model=path=/models/vmaf_v0.6.1.json");
		expect(fc).not.toContain("model=version=");
	});

	it("appends n_threads when threads is set", () => {
		const fc = filterComplexOf(buildVmafCommand({ ...BASE, threads: 4 }));
		expect(fc).toContain(":n_threads=4");
		// omitted ⇒ no n_threads token
		expect(filterComplexOf(buildVmafCommand(BASE))).not.toContain("n_threads");
	});

	it("bounds each decoder and the filter graph without changing scoring terms", () => {
		const argv = buildVmafCommand({
			...BASE,
			decoderThreads: 2,
			filterComplexThreads: 1,
		});
		const first = argv.indexOf("-i");
		const second = argv.indexOf("-i", first + 1);
		expect(argv.slice(first - 2, first)).toEqual(["-threads", "2"]);
		expect(argv.slice(second - 2, second)).toEqual(["-threads", "2"]);
		expect(argv[argv.indexOf("-filter_complex_threads") + 1]).toBe("1");
		expect(filterComplexOf(argv)).toBe(filterComplexOf(buildVmafCommand(BASE)));
		expect(buildVmafCommand(BASE)).not.toContain("-threads");
		expect(buildVmafCommand(BASE)).not.toContain("-filter_complex_threads");
	});

	it.each([
		0,
		-1,
		1.5,
		Number.NaN,
	])("rejects unbounded or invalid ordinary decoder limits: %s", (decoderThreads) => {
		expect(() => buildVmafCommand({ ...BASE, decoderThreads })).toThrow(
			"positive integers",
		);
	});

	describe("frame subsample (n_subsample)", () => {
		it("appends n_subsample when subsample > 1", () => {
			const fc = filterComplexOf(buildVmafCommand({ ...BASE, subsample: 4 }));
			expect(fc).toContain(":n_subsample=4");
		});

		it("omits n_subsample when unset (full precision, unchanged argv)", () => {
			expect(filterComplexOf(buildVmafCommand(BASE))).not.toContain(
				"n_subsample",
			);
		});

		it("omits n_subsample when subsample is 1 (1 = score every frame)", () => {
			expect(
				filterComplexOf(buildVmafCommand({ ...BASE, subsample: 1 })),
			).not.toContain("n_subsample");
		});

		it("positions n_subsample AFTER n_threads", () => {
			const fc = filterComplexOf(
				buildVmafCommand({ ...BASE, threads: 5, subsample: 4 }),
			);
			expect(fc).toContain(":n_threads=5:n_subsample=4");
			expect(fc.indexOf("n_subsample")).toBeGreaterThan(
				fc.indexOf("n_threads"),
			);
		});

		it("comes after the log tokens when threads is unset (full token order)", () => {
			const fc = filterComplexOf(buildVmafCommand({ ...BASE, subsample: 4 }));
			expect(fc).toContain(
				"libvmaf=model=version=vmaf_v0.6.1:log_path=/spool/qc/v360.vmaf.json:log_fmt=json:n_subsample=4[out]",
			);
		});
	});

	it("falls back to a no-op null node when no conform is requested", () => {
		const fc = filterComplexOf(
			buildVmafCommand({
				referencePath: "ref.mp4",
				distortedPath: "dist.mp4",
				model: "vmaf_v0.6.1",
				logPath: "out.json",
			}),
		);
		expect(fc).toBe(
			// No conform requested, but the re-time still applies — so the chain is
			// `setpts` rather than the old no-op `null`.
			"[0:v]settb=AVTB,setpts=N/FRAME_RATE/TB[dist];" +
				"[1:v]settb=AVTB,setpts=N/FRAME_RATE/TB[ref];" +
				"[dist][ref]libvmaf=model=version=vmaf_v0.6.1:log_path=out.json:log_fmt=json[out]",
		);
	});

	it("emits scale-only / fps-only conform chains", () => {
		expect(
			filterComplexOf(
				buildVmafCommand({
					referencePath: "r",
					distortedPath: "d",
					model: "m",
					logPath: "l",
					scaleToReference: { width: 1280, height: 720 },
				}),
			),
		).toContain(
			"[0:v]scale=1280:720:flags=bicubic,settb=AVTB,setpts=N/FRAME_RATE/TB[dist]",
		);
		expect(
			filterComplexOf(
				buildVmafCommand({
					referencePath: "r",
					distortedPath: "d",
					model: "m",
					logPath: "l",
					fpsConform: 30,
				}),
			),
		).toContain("[0:v]fps=30,settb=AVTB,setpts=N/FRAME_RATE/TB[dist]");
	});

	it("maps the libvmaf output and discards muxing (-f null -)", () => {
		const argv = buildVmafCommand(BASE);
		expect(argv.slice(-5)).toEqual(["-map", "[out]", "-f", "null", "-"]);
	});

	describe("PSNR feature (P4-PR5)", () => {
		it("appends feature=name=psnr when psnr:true", () => {
			const fc = filterComplexOf(buildVmafCommand({ ...BASE, psnr: true }));
			expect(fc).toContain(":feature=name=psnr:");
			// feature sits between the model selector and the log path.
			expect(fc).toContain(
				"libvmaf=model=version=vmaf_v0.6.1:feature=name=psnr:log_path=",
			);
		});

		it("omits the feature token when psnr is unset (VMAF-only, unchanged argv)", () => {
			expect(filterComplexOf(buildVmafCommand(BASE))).not.toContain("feature=");
		});

		it("supports an explicit features list and pipe-joins multiple", () => {
			const fc = filterComplexOf(
				buildVmafCommand({ ...BASE, features: ["psnr", "float_ssim"] }),
			);
			expect(fc).toContain(":feature=name=psnr|name=float_ssim:");
		});

		it("de-duplicates psnr across the shorthand and the list", () => {
			const fc = filterComplexOf(
				buildVmafCommand({ ...BASE, features: ["psnr"], psnr: true }),
			);
			// exactly one name=psnr (no name=psnr|name=psnr)
			expect(fc).toContain(":feature=name=psnr:");
			expect(fc).not.toContain("name=psnr|name=psnr");
		});

		it("combines PSNR with model=path= and n_threads", () => {
			const fc = filterComplexOf(
				buildVmafCommand({
					...BASE,
					modelPath: "/models/vmaf_v0.6.1.json",
					psnr: true,
					threads: 2,
				}),
			);
			expect(fc).toContain(
				"libvmaf=model=path=/models/vmaf_v0.6.1.json:feature=name=psnr:log_path=",
			);
			expect(fc).toContain(":n_threads=2");
		});
	});
});

describe("buildVmafCommand — alignFrames", () => {
	/**
	 * Measured need: the VOD scorer compared frame N with frame N, and a real
	 * encode's mean went from 31.6 to 61.4 when the reference was shifted one
	 * frame . This is how that shift is
	 * expressed.
	 */
	const base = {
		referencePath: "ref.mov",
		distortedPath: "dis.mp4",
		model: "vmaf_v0.6.1",
		logPath: "out.json",
	};
	const graph = (argv: string[]) =>
		argv[argv.indexOf("-filter_complex") + 1] ?? "";

	it("drops leading REFERENCE frames for a positive offset", () => {
		const g = graph(buildVmafCommand({ ...base, alignFrames: 1 }));
		expect(g).toContain(
			"[1:v]select='gte(n\\,1)',settb=AVTB,setpts=N/FRAME_RATE/TB[ref]",
		);
		expect(g).toContain("[dist][ref]libvmaf=");
	});

	it("drops leading DISTORTED frames for a negative offset", () => {
		const g = graph(buildVmafCommand({ ...base, alignFrames: -2 }));
		// The drop joins the distorted side's conform chain and carries its own
		// re-time, so `setpts` is not doubled there.
		expect(g).toContain(
			"select='gte(n\\,2)',settb=AVTB,setpts=N/FRAME_RATE/TB[dist]",
		);
		expect(g.match(/setpts=/g)).toHaveLength(2);
		expect(g.match(/settb=/g)).toHaveLength(2);
		expect(g).toContain("[dist][ref]libvmaf=");
	});

	it("emits no frame drop at offset 0 or when absent", () => {
		/**
		 * The graph is NOT the pre-alignment one any more: both pads are always
		 * re-timed, because the measured defect was a PTS offset and comparing
		 * mistimed frames is never the intent. What offset 0 must not do is DROP
		 * frames.
		 */
		const without = graph(buildVmafCommand(base));
		expect(graph(buildVmafCommand({ ...base, alignFrames: 0 }))).toBe(without);
		expect(without).not.toContain("select=");
		expect(without).toContain("[1:v]settb=AVTB,setpts=N/FRAME_RATE/TB[ref]");
	});

	it("keeps the comma escaped — the graph is one argv token", () => {
		// An unescaped comma would terminate `select` and start a new filter, so
		// ffmpeg would either error or silently filter something else.
		const g = graph(buildVmafCommand({ ...base, alignFrames: 3 }));
		expect(g).toContain("gte(n\\,3)");
		expect(g).not.toMatch(/gte\(n,3\)/);
	});

	it("composes with the conform chain on the distorted side", () => {
		const g = graph(
			buildVmafCommand({
				...base,
				alignFrames: -1,
				scaleToReference: { width: 1920, height: 1080 },
				fpsConform: 24,
			}),
		);
		// Scale and fps FIRST, then the drop: dropping before the fps conform
		// would count frames at the wrong rate.
		expect(g).toContain(
			"[0:v]scale=1920:1080:flags=bicubic,fps=24,select='gte(n\\,1)',settb=AVTB,setpts=N/FRAME_RATE/TB[dist]",
		);
	});
});

describe("explicit frame-index BT709 10-bit method", () => {
	const options = {
		referencePath: "/reference.mov",
		distortedPath: "/distorted.mp4",
		logPath: "/result.json",
		model: "vmaf_v1.0.16_3d0h",
		modelPath: "/model.json",
		measurementMethod: "FRAME_INDEX_BT709_10BIT" as const,
		referenceFrameRate: "24000/1001",
		scaleToReference: { width: 1920, height: 1080 },
		distortedOriginal: { width: 640, height: 360, bitdepth: 8 },
		psnr: true,
	};
	it("normalizes both legs identically and preserves original CAMBI geometry", () => {
		const args = buildVmafCommand(options),
			graph = args[args.indexOf("-filter_complex") + 1];
		expect(graph?.match(/format=yuv420p10le/g)).toHaveLength(2);
		expect(
			graph?.match(/settb=AVTB,setpts=N\/\(24000\/1001\)\/TB/g),
		).toHaveLength(2);
		expect(graph).toContain(
			"\\:cambi.enc_width=640\\:cambi.enc_height=360\\:cambi.enc_bitdepth=8",
		);
		expect(graph).toContain("eof_action=endall:shortest=1:repeatlast=0");
		expect(graph).not.toContain("fps=");
		expect(
			buildVmafCommand({ ...options, model: "vmaf_v0.6.1" }).join(" "),
		).not.toContain("cambi.enc_");
	});
	it("rejects resampling, offset changes and malformed metadata", () => {
		for (const change of [
			{ fpsConform: 24 },
			{ alignFrames: 1 },
			{ subsample: 2 },
			{ referenceFrameRate: "24:evil" },
			{ distortedOriginal: undefined },
		]) {
			expect(() => buildVmafCommand({ ...options, ...change })).toThrow(
				"INVALID_FRAME_INDEX_MEASUREMENT_OPTIONS",
			);
		}
	});
	it("validates the display canvas while retaining native CAMBI geometry", () => {
		const referenceGeometry = {
			width: 1440,
			height: 1080,
			sampleAspectRatio: "4:3",
		};
		expect(buildVmafCommand({ ...options, referenceGeometry })).toEqual(
			buildVmafCommand(options),
		);
		for (const change of [
			{ sampleAspectRatio: "N/A" },
			{ sampleAspectRatio: "0:1" },
			{ sampleAspectRatio: "-1:1" },
			{ sampleAspectRatio: "1:1" },
			{ width: 1439 },
		]) {
			expect(() =>
				buildVmafCommand({
					...options,
					referenceGeometry: { ...referenceGeometry, ...change },
				}),
			).toThrow();
		}
	});
});
