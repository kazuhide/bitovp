import {
	NATIVE_OFFICIAL_REVISION,
	type NativeExpected,
} from "./native-contract";

export function fixtureValue<T>(array: readonly T[], index: number): T {
	const value = array[index];
	if (value === undefined)
		throw new Error("Required test fixture entry is missing");
	return value;
}

export const SHA =
	"e4cf8c147e1368b35497d772920bc92f98c1ad7853c1033d8a836947f427140e";
const names = [
	"cambi_cmxv_17",
	"speed_chroma_uv_mxv_45",
	"integer_adm3_csf_2",
	"integer_motion3_mxv_18",
	"psnr_y",
	"psnr_cb",
	"psnr_cr",
];
export const nativeExpected: NativeExpected = {
	model: "vmaf_v1.0.16_3d0h",
	modelSha256: SHA,
	backend: "vulkan",
	device: 0,
	sourceSha256: "a".repeat(64),
	width: 640,
	height: 360,
	bitDepth: 10,
	distortedOriginal: { width: 640, height: 360, bitdepth: 8 },
	referenceSha256: "b".repeat(64),
	distortedSha256: "c".repeat(64),
	frameCount: 2,
	psnr: true,
};

export function nativeReceipt() {
	return {
		schema: 1,
		implementation: "bitovp-owned",
		officialRevision: NATIVE_OFFICIAL_REVISION,
		sourceSha256: nativeExpected.sourceSha256,
		backend: "vulkan",
		frames: 2,
		width: 640,
		height: 360,
		bitDepth: 10,
		requestedDeviceIndex: 0,
		referenceSha256: nativeExpected.referenceSha256,
		distortedSha256: nativeExpected.distortedSha256,
		distortedOriginal: { ...nativeExpected.distortedOriginal },
		device: {
			index: 0,
			name: "fixture AMD",
			uuid: "0123456789abcdef",
			vendorId: 0x1002,
			deviceId: 0x150e,
			integrated: true,
			memoryBudgetBytes: 2 ** 30,
		},
		cpuParity: {
			checked: true,
			featureCount: 14,
			scoreCount: 2,
			maxFeatureError: 0,
			maxScoreError: 0,
		},
		models: [
			{
				id: nativeExpected.model,
				sha256: SHA,
				pooled: {
					min: 90,
					max: 92,
					mean: 91,
					harmonicMean: 2 / (1 / 91 + 1 / 93) - 1,
				},
				frames: [90, 92],
			},
		],
		extractors: ["cambi", "speed_chroma", "adm", "motion", "psnr"].map(
			(name, i) => ({
				name,
				options: {} as Record<string, string>,
				features: i === 4 ? names.slice(4) : [names[i]],
			}),
		),
		features: [0, 1].flatMap((index) =>
			names.map((name) => ({
				index,
				name,
				value: name.startsWith("psnr") ? 40 : 0.5,
			})),
		),
	};
}
