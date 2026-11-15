import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../../..");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");

describe("isolated HDR QC runtime source contract", () => {
	it("keeps the SDR libvmaf pin and exports distinct HDR programs", () => {
		expect(dockerfile).toContain(
			'ARG LIBVMAF_COMMIT="f712fa7564fe49b12991d83920b83573af2ae063"',
		);
		expect(dockerfile).toContain("FROM ffmpeg-build AS ffmpeg-hdr-build");
		expect(dockerfile).toContain("FROM scratch AS ffmpeg-hdr");
		expect(dockerfile).toContain("/bin/ffmpeg-hdr /bin/ffprobe-hdr");
		expect(dockerfile).toContain(
			"VMAF_HDR_FFMPEG_PATH=/opt/bitovp-hdr/bin/ffmpeg-hdr",
		);
		expect(dockerfile).toContain(
			"VMAF_HDR_FFPROBE_PATH=/opt/bitovp-hdr/bin/ffprobe-hdr",
		);
		expect(dockerfile).toContain("VMAF_HDR_MODEL_DIR=/opt/bitovp-hdr/model");
		expect(dockerfile).toContain(
			"COPY --from=ffmpeg-hdr /model/ /opt/bitovp-hdr/model/",
		);
	});

	it("pins zimg, the HDR library, models and colorimetry bridge", () => {
		expect(dockerfile).toContain(
			'ARG HDR_LIBVMAF_COMMIT="a6ed0f18285cab504b779bbccb0bbaddc3bf44c2"',
		);
		expect(dockerfile).toContain("-Denable_zimg=true");
		expect(dockerfile).toContain("--enable-libzimg");
		expect(dockerfile).toContain("--fuzz=0 < /tmp/ffmpeg-hdr-wrap.patch");
		expect(dockerfile).toContain(
			"--fuzz=0 < /tmp/ffmpeg-hdr-colorimetry.patch",
		);
		expect(dockerfile).toContain("sh /tmp/hdr-build-proof.sh");
		const manifest = readFileSync(
			join(root, "docker/hdr-vmaf-models.sha256"),
			"utf8",
		)
			.split("\n")
			.filter((line) => line && !line.startsWith("#"));
		expect(manifest).toEqual([
			"6e1bb29ade13e1cad05e1d13fed2ad76fc8e3d3621bd5e02ab23e5c98c0afffd  hdr_vmaf_v1.1.8_3d0h_2160.json",
			"53d36d3173012efa6eb65ada92aa3967d3caceee68d088275b2a51a320948510  hdr_vmaf_v1.1.8_1d5h_2160.json",
			"f32904ac748319a8dc584aeffa776df30e5002e95270414a57a9802a9c2b31d1  hdr_vmaf_v1.1.8_hfr_3d0h_2160.json",
			"c8a979574c0d79bb22198323e6b4024b47bd305e5aa09575c4735fef43476bd8  hdr_vmaf_v1.1.8_hfr_1d5h_2160.json",
		]);
	});
});

describe("HDR build proof rejects incomplete or fabricated score evidence", () => {
	const valid = {
		version: "a6ed0f1",
		frames: [
			{ frameNum: 0, metrics: { vmaf: 110 } },
			{ frameNum: 1, metrics: { vmaf: 108 } },
		],
		pooled_metrics: { vmaf: { mean: 109, min: 108, max: 110 } },
	};
	function check(document: unknown) {
		const directory = mkdtempSync(join(tmpdir(), "bitovp-hdr-proof-"));
		try {
			const file = join(directory, "log.json");
			writeFileSync(file, JSON.stringify(document));
			return spawnSync(
				"python3",
				[
					"-c",
					"import importlib.util,sys; s=importlib.util.spec_from_file_location('proof',sys.argv[1]); p=importlib.util.module_from_spec(s); s.loader.exec_module(p); print(p.read_metric(sys.argv[2], 'vmaf', 2))",
					join(root, "docker/hdr-build-proof.py"),
					file,
				],
				{ encoding: "utf8" },
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}

	it("accepts two finite contiguous frames whose mean matches the pool", () => {
		const result = check(valid);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("109");
	});

	it.each([
		["missing frames", { ...valid, frames: valid.frames.slice(0, 1) }],
		[
			"repeated frame indices",
			{ ...valid, frames: [valid.frames[0], valid.frames[0]] },
		],
		[
			"non-finite frame scores",
			{
				...valid,
				frames: [{ frameNum: 0, metrics: { vmaf: null } }, valid.frames[1]],
			},
		],
		[
			"incorrect pooled mean",
			{ ...valid, pooled_metrics: { vmaf: { mean: 1, min: 108, max: 110 } } },
		],
	])("refuses %s", (_name, document) => {
		expect(check(document).status).not.toBe(0);
	});
});

it("anchors the fixed HLG reference display at 1000 nits and 75% diffuse white", () => {
	const result = spawnSync(
		"python3",
		[
			"-c",
			"import importlib.util,sys; s=importlib.util.spec_from_file_location('proof',sys.argv[1]); p=importlib.util.module_from_spec(s); s.loader.exec_module(p); print(p.hlg_display_luminance(1.0)); print(p.hlg_display_luminance(0.75))",
			join(root, "docker/hdr-build-proof.py"),
		],
		{ encoding: "utf8" },
	);
	expect(result.status, result.stderr).toBe(0);
	const [peak, white] = result.stdout.trim().split("\n").map(Number);
	expect(peak).toBeCloseTo(1000, 2);
	expect(white).toBeGreaterThan(202);
	expect(white).toBeLessThan(204);
});
