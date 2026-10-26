import {
	AudioVolumeFilter,
	AudioVolumeFormat,
	AudioVolumeUnit,
	CropFilter,
	DenoiseHqdn3dFilter,
	EbuR128SinglePassFilter,
	PositionUnit,
	RotateFilter,
	ScaleFilter,
	ScalingAlgorithm,
	TextFilter,
	TextFilterFont,
	UnsharpFilter,
	WatermarkFilter,
} from "@bitmovin/api-sdk";
import type { MediaFilter } from "@bitovp/core";
import type { OpsContext } from "./context";
import { optStr } from "./exec-shared";
import { optEnum } from "./shared";

/** SDK 1.285.0 boundary. Snapshot only the resource id: image URLs are capabilities. */
export async function createMediaFilter(
	ctx: OpsContext,
	kind: MediaFilter["kind"],
	p: Record<string, unknown>,
): Promise<string> {
	const { api, audited, id } = ctx;
	const endpoints = {
		CROP: "crop",
		SCALE: "scale",
		DENOISE_HQDN3D: "denoise-hqdn3d",
		UNSHARP: "unsharp",
		ROTATE: "rotate",
		WATERMARK: "watermark",
		TEXT: "text",
		AUDIO_VOLUME: "audio-volume",
		EBU_R128_SINGLE_PASS: "ebu-r128-single-pass",
	};
	const create = async () => {
		switch (kind) {
			case "DENOISE_HQDN3D":
				return api.encoding.filters.denoiseHqdn3d.create(
					new DenoiseHqdn3dFilter(p),
				);
			case "UNSHARP":
				return api.encoding.filters.unsharp.create(new UnsharpFilter(p));
			case "CROP":
				return api.encoding.filters.crop.create(
					new CropFilter({
						...p,
						unit: optEnum(PositionUnit, optStr(p.unit), "PositionUnit"),
					}),
				);
			case "SCALE":
				return api.encoding.filters.scale.create(
					new ScaleFilter({
						...p,
						scalingAlgorithm: optEnum(
							ScalingAlgorithm,
							optStr(p.scalingAlgorithm),
							"ScalingAlgorithm",
						),
					}),
				);
			case "ROTATE":
				return api.encoding.filters.rotate.create(new RotateFilter(p));
			case "WATERMARK":
				return api.encoding.filters.watermark.create(
					new WatermarkFilter({
						...p,
						unit: optEnum(PositionUnit, optStr(p.unit), "PositionUnit"),
					}),
				);
			case "TEXT":
				return api.encoding.filters.text.create(
					new TextFilter({
						...p,
						font: optEnum(TextFilterFont, optStr(p.font), "TextFilterFont"),
					}),
				);
			case "AUDIO_VOLUME":
				return api.encoding.filters.audioVolume.create(
					new AudioVolumeFilter({
						...p,
						unit: optEnum(AudioVolumeUnit, optStr(p.unit), "AudioVolumeUnit"),
						format: optEnum(
							AudioVolumeFormat,
							optStr(p.format),
							"AudioVolumeFormat",
						),
					}),
				);
			case "EBU_R128_SINGLE_PASS":
				return api.encoding.filters.ebuR128SinglePass.create(
					new EbuR128SinglePassFilter(p),
				);
		}
	};
	return audited(
		"POST",
		`/encoding/filters/${endpoints[kind]}`,
		kind === "WATERMARK" ? { ...p, image: "[REDACTED]" } : p,
		async () => {
			try {
				return await create();
			} catch (error) {
				// Provider errors may echo the capability URL; no raw message/cause crosses the boundary.
				if (kind === "WATERMARK")
					throw new Error("Watermark filter creation failed");
				throw error;
			}
		},
		(r) => ({ id: r.id }),
	).then(id);
}
