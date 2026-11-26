import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	NATIVE_MODEL_SHA256,
	NATIVE_OFFICIAL_REVISION,
	nativeSourceFromVersion,
	prepareNativeModel,
	verifyNativeReceipt,
} from "./native-contract";

import {
	nativeExpected as expected,
	fixtureValue,
	nativeReceipt,
	SHA,
} from "./native-fixture.test-helper";

describe("owned native receipt contract", () => {
	it("keeps full precision, requires runtime CPU parity, and adapts existing result parsing", () => {
		const result = verifyNativeReceipt(nativeReceipt(), expected);
		expect(result.scoring).toMatchObject({
			implementation: "bitovp-owned",
			backend: "vulkan",
			modelSha256: SHA,
			officialRevision: NATIVE_OFFICIAL_REVISION,
			cpuParity: { checked: true },
		});
		expect(result.log.frames).toEqual([
			{ frameNum: 0, metrics: { vmaf: 90, psnr_y: 40 } },
			{ frameNum: 1, metrics: { vmaf: 92, psnr_y: 40 } },
		]);
	});
	it.each([
		(r: ReturnType<typeof nativeReceipt>) => {
			r.sourceSha256 = "d".repeat(64);
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			r.officialRevision = "d".repeat(40);
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			r.backend = "cpu";
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			r.device.index = 1;
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			r.device.vendorId = 0x10de;
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			r.requestedDeviceIndex = 1;
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			r.distortedOriginal.bitdepth = 10;
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			r.referenceSha256 = "f".repeat(64);
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			fixtureValue(r.models, 0).sha256 = "f".repeat(64);
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			r.frames = 3;
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			fixtureValue(r.models, 0).frames.pop();
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			fixtureValue(r.models, 0).pooled.mean = 99;
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			r.features.pop();
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			fixtureValue(r.features, 0).value = Number.NaN;
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			fixtureValue(r.features, 0).index = 2;
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			fixtureValue(r.features, 0).name = "unknown";
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			r.features[0] = fixtureValue(r.features, 1);
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			fixtureValue(r.extractors, 0).name = "cambi_cuda";
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			r.cpuParity.checked = false;
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			r.cpuParity.featureCount = 13;
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			r.cpuParity.scoreCount = 1;
		},
		(r: ReturnType<typeof nativeReceipt>) => {
			r.cpuParity.maxScoreError = 0.01;
		},
	])("rejects inconsistent receipt %s", (change) => {
		const raw = nativeReceipt();
		change(raw);
		expect(() => verifyNativeReceipt(raw, expected)).toThrow(/NATIVE_RECEIPT/);
	});
	it("takes a receipt only for the comparison that the worker asked for", () => {
		// The pictures have the bit depth that the worker named: the reference's.
		const eight = { ...nativeReceipt(), bitDepth: 8 };
		expect(
			verifyNativeReceipt(eight, { ...expected, bitDepth: 8 }).scoring.bitDepth,
		).toBe(8);
		expect(
			verifyNativeReceipt(nativeReceipt(), expected).scoring.bitDepth,
		).toBe(10);
		expect(() => verifyNativeReceipt(eight, expected)).toThrow(
			"NATIVE_RECEIPT_COMPARISON_MISMATCH",
		);
		expect(() =>
			verifyNativeReceipt(nativeReceipt(), { ...expected, bitDepth: 8 }),
		).toThrow("NATIVE_RECEIPT_COMPARISON_MISMATCH");
		expect(() =>
			verifyNativeReceipt({ ...nativeReceipt(), bitDepth: 12 }, expected),
		).toThrow("NATIVE_RECEIPT_SCHEMA_MISMATCH");

		// libvmaf's defaults, as the scorer writes them for a run that declares
		// nothing to CAMBI.
		const cambi = (options: Record<string, string>) => {
			const raw = nativeReceipt();
			fixtureValue(raw.extractors, 0).options = options;
			return raw;
		};
		const undeclared = {
			enc_width: "0",
			enc_height: "0",
			enc_bitdepth: "0",
			window_size: "65",
		};
		expect(
			verifyNativeReceipt(cambi(undeclared), expected).scoring.bitDepth,
		).toBe(10);
		// A scorer built from an earlier source declares the encode in every run.
		const declarations: Record<string, string>[] = [
			{ enc_width: "320", enc_height: "180", enc_bitdepth: "8" },
			{ ...undeclared, enc_width: "640" },
			{ ...undeclared, enc_height: "360" },
			{ ...undeclared, enc_bitdepth: "8" },
			{ enc_bitdepth: "10" },
		];
		for (const declared of declarations)
			expect(
				() => verifyNativeReceipt(cambi(declared), expected),
				JSON.stringify(declared),
			).toThrow("NATIVE_RECEIPT_COMPARISON_MISMATCH");
	});
	it("pins both the official revision and a recorded owned source hash", () => {
		expect(
			nativeSourceFromVersion(
				`bitovp-vmaf 0.1 owned CUDA/Vulkan; official=${NATIVE_OFFICIAL_REVISION}; source=${expected.sourceSha256}\n`,
			),
		).toBe(expected.sourceSha256);
		for (const text of [
			"ffmpeg 8",
			"bitovp-vmaf source=unrecorded",
			`bitovp-vmaf 0.1 owned CUDA/Vulkan; official=${"d".repeat(40)}; source=${expected.sourceSha256}`,
		])
			expect(() => nativeSourceFromVersion(text)).toThrow(/NATIVE_BINARY/);
	});
	it("hashes the actual requested model file and retains the existing model pin", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bitovp-native-model-"));
		try {
			const path = join(directory, "model.json");
			await writeFile(path, "wrong bytes");
			await expect(
				prepareNativeModel({ model: expected.model, modelPath: path }),
			).rejects.toThrow("NATIVE_MODEL_SHA256_MISMATCH");
			const manifest = await readFile(
				new URL("../../../../docker/vmaf-models.sha256", import.meta.url),
				"utf8",
			);
			const entries = new Map(
				manifest
					.split("\n")
					.filter((line) => /^[a-f0-9]{64}\s/.test(line))
					.map((line) => {
						const [hash, file] = line.trim().split(/\s+/);
						return [file, hash];
					}),
			);
			expect(Object.keys(NATIVE_MODEL_SHA256)).toHaveLength(8);
			for (const [model, hash] of Object.entries(NATIVE_MODEL_SHA256))
				expect(entries.get(`${model}.json`)).toBe(hash);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
