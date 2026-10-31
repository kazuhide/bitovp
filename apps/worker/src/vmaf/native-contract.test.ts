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
