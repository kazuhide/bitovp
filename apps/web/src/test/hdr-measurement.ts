import {
	HDR_LIBVMAF_REVISION,
	HDR_VMAF_MODELS,
	type HdrMeasurement,
} from "@bitovp/core";

export function hdrMeasurementFixture(hlg = false): HdrMeasurement {
	const input: HdrMeasurement["reference"] = {
		width: 3840,
		height: 2160,
		pixelFormat: "yuv420p10le",
		bitDepth: 10,
		range: "limited",
		primaries: "bt2020",
		transfer: "smpte2084",
		matrix: "bt2020nc",
		frameRate: "24/1",
		attributeSource: "STREAM_METADATA",
	};
	return {
		version: 1,
		method: "HDR_VMAF_PQ_ICTCP_16",
		scope: "HDR_BASE_LAYER",
		dolbyRpuApplied: false,
		model: HDR_VMAF_MODELS[0].id,
		modelSha256: HDR_VMAF_MODELS[0].sha256,
		libvmafRevision: HDR_LIBVMAF_REVISION,
		normalization: "ZIMG_BT2020_PQ_YUV444_16",
		comparison: "LIMITED_BT2020_PQ_ICTCP420_16_DISPLAY2160",
		reference: input,
		distorted: { ...input, transfer: hlg ? "arib-std-b67" : "smpte2084" },
		frameCount: 2,
		...(hlg
			? {
					hlgReferenceDisplay: {
						peakNits: 1000,
						blackNits: 0,
						systemGamma: 1.2,
						approximateGamma: false,
					},
				}
			: {}),
	};
}
