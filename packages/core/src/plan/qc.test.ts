import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compilePlan, qcOutputPath } from "./compiler";
import {
	DEFAULT_VMAF_MODEL,
	encodingPlanSchema,
	LIBVMAF_BUILTIN_MODELS,
	planQcSchema,
	vmafModelNeedsFile,
} from "./schema";
import { validatePlan } from "./validate";

/**
 * P4 VMAF-core: the optional `qc` plan option and its compiler QC mirror.
 * The 56 compiler goldens (compiler.test.ts) prove the absent-qc path is
 * byte-identical; these tests prove (a) the schema shape/defaults and
 * (b) that turning qc on adds exactly one progressive MP4 mirror per VIDEO
 * rendition under a `qc/` path and nothing for audio-only renditions.
 */

const dir = join(__dirname, "__fixtures__");

function loadRawPlan(name: string): unknown {
	return JSON.parse(readFileSync(join(dir, `${name}.plan.json`), "utf8"));
}

describe("VMAF model availability — refuse BEFORE the encode (review-234 I2)", () => {
	const planWithQc = () => {
		const raw = loadRawPlan("fixed-bitrate-hls-on-aws") as Record<
			string,
			unknown
		>;
		return encodingPlanSchema.parse({ ...raw, qc: { vmaf: true } });
	};

	it("refuses a model the scoring worker cannot load, naming the fix", () => {
		const issues = validatePlan(planWithQc(), {
			availableVmafModels: [...LIBVMAF_BUILTIN_MODELS],
		});
		const issue = issues.find((i) => i.code === "PLAN_VMAF_MODEL_UNAVAILABLE");
		expect(
			issue,
			"the default is file-only; a built-ins-only worker must refuse",
		).toBeTruthy();
		expect(issue?.level).toBe("error");
		expect(issue?.path).toBe("qc.model");
		// The message must name the model AND the two ways out, because this
		// is the last point before a paid encode.
		expect(issue?.message).toContain(DEFAULT_VMAF_MODEL);
		expect(issue?.message).toContain("VMAF_MODEL_DIR");
		expect(issue?.message).toContain("vmaf_v0.6.1");
	});

	it("passes when the worker DOES have the model", () => {
		const issues = validatePlan(planWithQc(), {
			availableVmafModels: [DEFAULT_VMAF_MODEL, ...LIBVMAF_BUILTIN_MODELS],
		});
		expect(issues.some((i) => i.code === "PLAN_VMAF_MODEL_UNAVAILABLE")).toBe(
			false,
		);
	});

	it("stays silent when the capability is unknown — an unknown must not manufacture a refusal", () => {
		expect(
			validatePlan(planWithQc()).some(
				(i) => i.code === "PLAN_VMAF_MODEL_UNAVAILABLE",
			),
		).toBe(false);
	});

	it("never fires on a plan without qc", () => {
		const plan = encodingPlanSchema.parse(
			loadRawPlan("fixed-bitrate-hls-on-aws"),
		);
		expect(
			validatePlan(plan, { availableVmafModels: [] }).some(
				(i) => i.code === "PLAN_VMAF_MODEL_UNAVAILABLE",
			),
		).toBe(false);
	});

	it("built-ins are classified as file-free; everything else needs a file", () => {
		for (const m of LIBVMAF_BUILTIN_MODELS) {
			expect(vmafModelNeedsFile(m), m).toBe(false);
		}
		expect(vmafModelNeedsFile(DEFAULT_VMAF_MODEL)).toBe(true);
		expect(vmafModelNeedsFile("vmaf_v1.0.16_hfr_5d0h")).toBe(true);
	});
});

describe("planQcSchema", () => {
	it("the default model is VMAF v1 — owner directive 2026-08-16", () => {
		// The VALUE, pinned once: every other assertion follows the constant,
		// so without this line changing the constant would silently pass them
		// all. v1's standard viewing condition (3.0 display-heights, 1080p);
		// present in the worker image and measured 120/120 frames.
		expect(DEFAULT_VMAF_MODEL).toBe("vmaf_v1.0.16_3d0h");
		expect(DEFAULT_VMAF_MODEL).toMatch(/^vmaf_v1\./);
	});

	it("parses and defaults model to the constant when present", () => {
		expect(planQcSchema.parse({ vmaf: true })).toEqual({
			vmaf: true,
			model: DEFAULT_VMAF_MODEL,
		});
		expect(planQcSchema.parse({ vmaf: false })).toEqual({
			vmaf: false,
			model: DEFAULT_VMAF_MODEL,
		});
	});

	it("keeps an explicit model and rejects unknown keys", () => {
		expect(planQcSchema.parse({ vmaf: true, model: "vmaf_4k_v0.6.1" })).toEqual(
			{ vmaf: true, model: "vmaf_4k_v0.6.1" },
		);
		expect(() => planQcSchema.parse({ vmaf: true, bogus: 1 })).toThrow();
	});

	it("accepts real VMAF v1 model names (filename-safe charset)", () => {
		for (const model of [
			"vmaf_v1.0.16_3d0h",
			"vmaf_v1.0.16_5d0h",
			"vmaf_v1.0.16_3d0h_2160",
			"vmaf_v1.0.16_hfr_1d5h_2160",
		]) {
			expect(planQcSchema.parse({ vmaf: true, model })).toEqual({
				vmaf: true,
				model,
			});
		}
	});

	it("rejects a model name that could traverse a path or inject filter params", () => {
		// The model becomes both `$VMAF_MODEL_DIR/<model>.json` and a libvmaf
		// filter token, so these must be refused at the validation boundary.
		for (const bad of [
			"../../etc/passwd", // path traversal
			"vmaf_v0.6.1:n_threads=999", // libvmaf param injection
			"a|name=psnr", // sub-model / feature injection
			"a/b", // path separator
			"with space",
			"semi;colon",
		]) {
			expect(() => planQcSchema.parse({ vmaf: true, model: bad })).toThrow();
		}
	});

	it("accepts an optional psnr flag and leaves it absent by default", () => {
		// absent ⇒ no materialized default (so VMAF-only plans round-trip clean)
		expect("psnr" in planQcSchema.parse({ vmaf: true })).toBe(false);
		expect(planQcSchema.parse({ vmaf: true, psnr: true })).toEqual({
			vmaf: true,
			model: DEFAULT_VMAF_MODEL,
			psnr: true,
		});
		// psnr-only request (vmaf off) is valid — the runner still computes VMAF.
		expect(planQcSchema.parse({ vmaf: false, psnr: true })).toEqual({
			vmaf: false,
			model: DEFAULT_VMAF_MODEL,
			psnr: true,
		});
	});

	it("stays absent on the plan root when omitted (no materialized default)", () => {
		const plan = encodingPlanSchema.parse(
			loadRawPlan("fixed-bitrate-hls-on-aws"),
		);
		expect("qc" in plan).toBe(false);
		expect(plan.qc).toBeUndefined();
	});

	it("materializes the qc default model when the plan carries qc", () => {
		const raw = loadRawPlan("fixed-bitrate-hls-on-aws") as Record<
			string,
			unknown
		>;
		const plan = encodingPlanSchema.parse({ ...raw, qc: { vmaf: true } });
		expect(plan.qc).toEqual({ vmaf: true, model: DEFAULT_VMAF_MODEL });
	});
});

describe("qcOutputPath", () => {
	it("appends a qc/ child, normalizing the trailing slash", () => {
		expect(qcOutputPath("output/x/video/360p")).toBe("output/x/video/360p/qc/");
		expect(qcOutputPath("output/x/video/360p/")).toBe(
			"output/x/video/360p/qc/",
		);
		expect(qcOutputPath("")).toBe("qc/");
	});
});

describe("compilePlan with qc (VMAF mirror muxings)", () => {
	it("compiles identically to the absent-qc plan when qc is omitted", () => {
		// Two representative fixtures: 1 standard AV ladder, 1 audio-only.
		for (const name of [
			"fixed-bitrate-hls-on-aws",
			"audio-only-aac-fmp4-hls-dash",
		]) {
			const raw = loadRawPlan(name);
			const withoutQc = compilePlan(encodingPlanSchema.parse(raw));
			// qc:{vmaf:false} must behave exactly like absent qc (no mirror op).
			const qcFalse = compilePlan(
				encodingPlanSchema.parse({
					...(raw as Record<string, unknown>),
					qc: { vmaf: false },
				}),
			);
			expect(qcFalse).toEqual(withoutQc);
			expect(withoutQc.some((op) => op.step.startsWith("qc-muxing:"))).toBe(
				false,
			);
		}
	});

	it("emits exactly one progressive MP4 mirror per VIDEO rendition at qc/", () => {
		const raw = loadRawPlan("fixed-bitrate-hls-on-aws") as Record<
			string,
			unknown
		>;
		const plan = encodingPlanSchema.parse({ ...raw, qc: { vmaf: true } });
		const ops = compilePlan(plan);
		const qcOps = ops.filter((op) => op.step.startsWith("qc-muxing:"));

		// fixed-bitrate-hls-on-aws has 2 video (v360, v540) + 2 audio renditions.
		expect(qcOps.map((op) => op.step)).toEqual([
			"qc-muxing:v360",
			"qc-muxing:v540",
		]);
		for (const op of qcOps) {
			expect(op.kind).toBe("CREATE_MUXING_MP4");
			// Progressive single-file: NO fragmentation fields.
			expect(op.payload).not.toHaveProperty("fragmentDuration");
			expect(op.payload).not.toHaveProperty("fragmentedMP4MuxingManifestType");
		}

		const v360 = qcOps.find((op) => op.step === "qc-muxing:v360");
		expect(v360?.payload).toMatchObject({
			filename: "v360.mp4",
			outputPath: "output/h264-aac-fmp4-fixed-bitrate-hls-aws/video/360p/qc/",
			acl: "PUBLIC_READ",
		});
		expect(v360?.refs).toEqual({
			encodingId: "encoding",
			streamId: "stream:v360",
			outputId: "output:origin",
		});

		const v540 = qcOps.find((op) => op.step === "qc-muxing:v540");
		expect(v540?.payload).toMatchObject({
			filename: "v540.mp4",
			outputPath: "output/h264-aac-fmp4-fixed-bitrate-hls-aws/video/540p/qc/",
		});

		// No manifest entry references the QC mirror muxings.
		const referenced = new Set(
			ops.flatMap((op) => Object.values(op.refs).flat()),
		);
		expect(referenced.has("qc-muxing:v360")).toBe(false);
		expect(referenced.has("qc-muxing:v540")).toBe(false);

		// QC ops sit after their stream (backward refs only) — reuse the global
		// invariant locally for the new steps.
		const seen = new Set<string>();
		for (const op of ops) {
			for (const target of Object.values(op.refs).flat()) {
				expect(seen.has(target)).toBe(true);
			}
			seen.add(op.step);
		}
	});

	it("emits no QC mirror for an audio-only plan", () => {
		const raw = loadRawPlan("audio-only-aac-fmp4-hls-dash") as Record<
			string,
			unknown
		>;
		const ops = compilePlan(
			encodingPlanSchema.parse({ ...raw, qc: { vmaf: true } }),
		);
		expect(ops.some((op) => op.step.startsWith("qc-muxing:"))).toBe(false);
	});

	it("emits the mirror when only psnr is requested (vmaf:false) — PSNR rides the same pass", () => {
		// PSNR needs the distorted file too, so the mirror gate is vmaf||psnr.
		const raw = loadRawPlan("fixed-bitrate-hls-on-aws") as Record<
			string,
			unknown
		>;
		const ops = compilePlan(
			encodingPlanSchema.parse({ ...raw, qc: { vmaf: false, psnr: true } }),
		);
		const qcOps = ops.filter((op) => op.step.startsWith("qc-muxing:"));
		expect(qcOps.map((op) => op.step)).toEqual([
			"qc-muxing:v360",
			"qc-muxing:v540",
		]);
	});

	it("emits the same mirror ops for {vmaf:true}, {psnr:true}, and {vmaf:true,psnr:true}", () => {
		// The mirror is identical regardless of WHICH metric(s) are requested —
		// psnr only changes the runner's libvmaf flags, never the compiled ops.
		const raw = loadRawPlan("fixed-bitrate-hls-on-aws") as Record<
			string,
			unknown
		>;
		const mirrorsFor = (qc: Record<string, unknown>) =>
			compilePlan(encodingPlanSchema.parse({ ...raw, qc })).filter((op) =>
				op.step.startsWith("qc-muxing:"),
			);
		const vmafOnly = mirrorsFor({ vmaf: true });
		expect(mirrorsFor({ vmaf: false, psnr: true })).toEqual(vmafOnly);
		expect(mirrorsFor({ vmaf: true, psnr: true })).toEqual(vmafOnly);
	});
});

describe("compilePlan with qc.only (VMAF-only encode)", () => {
	// fixed-bitrate-hls-on-aws carries 2 video + 2 audio renditions, fMP4
	// delivery muxings and an HLS manifest. Bolting qc.only onto it proves the
	// compiler strips EVERYTHING delivery-side down to the video qc mirrors.
	// (The compiler does not run validate, so the manifest the fixture carries
	// is simply dropped here — validate.test.ts covers the rejection.)
	const onlyOps = () => {
		const raw = loadRawPlan("fixed-bitrate-hls-on-aws") as Record<
			string,
			unknown
		>;
		return compilePlan(
			encodingPlanSchema.parse({ ...raw, qc: { vmaf: true, only: true } }),
		);
	};

	it("compiles to ONLY the per-video qc mirrors — no delivery muxings", () => {
		const ops = onlyOps();
		// The qc mirror is the ONLY muxing op, one per VIDEO rendition.
		const muxingOps = ops.filter((op) => op.kind.startsWith("CREATE_MUXING_"));
		expect(muxingOps.map((op) => op.step)).toEqual([
			"qc-muxing:v360",
			"qc-muxing:v540",
		]);
		for (const op of muxingOps) {
			expect(op.kind).toBe("CREATE_MUXING_MP4");
		}
		// No delivery fMP4 muxings survived.
		expect(ops.some((op) => op.kind === "CREATE_MUXING_FMP4")).toBe(false);
	});

	it("emits no manifest, audio, thumbnail, sprite, drm, or keyframe ops", () => {
		const ops = onlyOps();
		const kinds = ops.map((op) => op.kind);
		expect(kinds.some((k) => k.includes("MANIFEST"))).toBe(false);
		expect(kinds.some((k) => k.startsWith("CREATE_HLS"))).toBe(false);
		expect(kinds.some((k) => k.startsWith("CREATE_DASH"))).toBe(false);
		// Audio renditions are skipped entirely: no AAC codec config / stream.
		expect(kinds).not.toContain("CREATE_CODEC_AAC");
		expect(ops.some((op) => op.step.startsWith("codec:a"))).toBe(false);
		expect(ops.some((op) => op.step.startsWith("stream:a"))).toBe(false);
		// Only the two video codec configs + streams remain.
		expect(ops.filter((op) => op.kind === "CREATE_CODEC_H264")).toHaveLength(2);
		expect(ops.filter((op) => op.kind === "CREATE_STREAM")).toHaveLength(2);
	});

	it("the START op carries no manifest refs (post or jit)", () => {
		const ops = onlyOps();
		const start = ops.find((op) => op.kind === "START_ENCODING");
		expect(start?.refs.vodHlsManifestIds).toBeUndefined();
		expect(start?.refs.vodDashManifestIds).toBeUndefined();
		expect(start?.refs.vodSmoothManifestIds).toBeUndefined();
	});

	it("the dedicated fixture compiles to the documented op shape", () => {
		// vmaf-only-h264 is the golden-pinned minimal qc.only plan.
		const ops = compilePlan(
			encodingPlanSchema.parse(loadRawPlan("vmaf-only-h264")),
		);
		expect(ops.map((op) => op.kind)).toEqual([
			"CREATE_INPUT_S3",
			"CREATE_OUTPUT_S3",
			"CREATE_ENCODING",
			"CREATE_INGEST_INPUT_STREAM",
			"CREATE_CODEC_H264",
			"CREATE_STREAM",
			"CREATE_MUXING_MP4",
			"START_ENCODING",
			"AWAIT_ENCODING",
		]);
		const qc = ops.find((op) => op.step === "qc-muxing:v540");
		expect(qc?.payload.outputPath).toBe("output/vmaf-only-h264/video/540p/qc/");
	});

	it("retains the per-title {uuid} placeholder on the qc mirror (per-title VMAF case)", () => {
		// The user's real case: a PER-TITLE encode measured for VMAF only. The qc
		// mirror keeps its {height}_{bitrate}_{uuid} placeholder (resolved per rung
		// at run time by the worker), and nothing delivery-side survives.
		const raw = loadRawPlan("pertitle-h264-fmp4-ts-dash-hls-on-aws") as Record<
			string,
			unknown
		>;
		const ops = compilePlan(
			encodingPlanSchema.parse({ ...raw, qc: { vmaf: true, only: true } }),
		);
		const qcMux = ops.filter((op) => op.step.startsWith("qc-muxing:"));
		expect(qcMux.length).toBeGreaterThan(0);
		for (const op of qcMux) {
			expect(op.kind).toBe("CREATE_MUXING_MP4");
			expect(String(op.payload.outputPath)).toContain("{");
		}
		expect(ops.some((op) => op.kind === "CREATE_MUXING_FMP4")).toBe(false);
		expect(ops.some((op) => op.kind === "CREATE_MUXING_TS")).toBe(false);
		expect(ops.some((op) => op.kind.includes("MANIFEST"))).toBe(false);
	});
});
