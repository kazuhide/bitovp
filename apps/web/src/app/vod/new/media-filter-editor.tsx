"use client";

import { AUDIO_VOLUME_FORMATS, TEXT_FILTER_FONTS } from "@bitovp/core";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type { WizardFilter, WizardInputFile } from "./build-plan";

export const FILTER_KINDS = [
	"DEINTERLACE",
	"CROP",
	"ROTATE",
	"WATERMARK",
	"TEXT",
	"AUDIO_VOLUME",
	"EBU_R128_SINGLE_PASS",
	"DENOISE_HQDN3D",
	"UNSHARP",
] as const;
export function newFilter(
	key: string,
	kind: (typeof FILTER_KINDS)[number],
	inputKey = "",
): WizardFilter {
	switch (kind) {
		case "DEINTERLACE":
			return { key };
		case "CROP":
			return { key, kind, left: 0, top: 0 };
		case "ROTATE":
			return { key, kind, rotation: 90 };
		case "WATERMARK":
			return { key, kind, inputKey, imagePath: "", left: 0, top: 0 };
		case "TEXT":
			return {
				key,
				kind,
				text: "Text",
				x: "10",
				y: "10",
				font: "DEJAVUSANS",
				fontSize: 24,
			};
		case "AUDIO_VOLUME":
			return { key, kind, volume: 100, unit: "PERCENT" };
		case "DENOISE_HQDN3D":
		case "UNSHARP":
		case "EBU_R128_SINGLE_PASS":
			return { key, kind };
	}
}
type Control = "number" | "text" | readonly string[];
type Spec = [string, string, string, Control];
const edges: Spec[] = [
	["left", "Left", "左", "number"],
	["right", "Right", "右", "number"],
	["top", "Top", "上", "number"],
	["bottom", "Bottom", "下", "number"],
	["unit", "Unit", "単位", ["PIXELS", "PERCENTS"]],
];
const fields: Partial<Record<(typeof FILTER_KINDS)[number], Spec[]>> = {
	DENOISE_HQDN3D: [
		["lumaSpatial", "Spatial luma", "空間輝度", "number"],
		["chromaSpatial", "Spatial chroma", "空間色差", "number"],
		["lumaTmp", "Temporal luma", "時間輝度", "number"],
		["chromaTmp", "Temporal chroma", "時間色差", "number"],
	],
	UNSHARP: [
		[
			"lumaMatrixHorizontalSize",
			"Luma matrix width",
			"輝度マトリクス幅",
			"number",
		],
		[
			"lumaMatrixVerticalSize",
			"Luma matrix height",
			"輝度マトリクス高さ",
			"number",
		],
		["lumaEffectStrength", "Luma strength", "輝度強度", "number"],
		[
			"chromaMatrixHorizontalSize",
			"Chroma matrix width",
			"色差マトリクス幅",
			"number",
		],
		[
			"chromaMatrixVerticalSize",
			"Chroma matrix height",
			"色差マトリクス高さ",
			"number",
		],
		["chromaEffectStrength", "Chroma strength", "色差強度", "number"],
	],
	CROP: edges,
	ROTATE: [["rotation", "Rotation (degrees)", "回転角度", "number"]],
	WATERMARK: [
		["imagePath", "Image object path", "画像のオブジェクトパス", "text"],
		...edges,
	],
	AUDIO_VOLUME: [
		["volume", "Volume", "音量", "number"],
		["unit", "Unit", "単位", ["PERCENT", "DB"]],
		["format", "Sample format", "サンプル形式", AUDIO_VOLUME_FORMATS],
	],
	EBU_R128_SINGLE_PASS: [
		[
			"integratedLoudness",
			"Integrated loudness (LUFS)",
			"統合ラウドネス (LUFS)",
			"number",
		],
		["loudnessRange", "Loudness range (LU)", "ラウドネス範囲 (LU)", "number"],
		[
			"maximumTruePeakLevel",
			"True peak (dBTP)",
			"最大トゥルーピーク (dBTP)",
			"number",
		],
	],
	TEXT: [
		["text", "Text", "テキスト", "text"],
		["font", "Font", "フォント", TEXT_FILTER_FONTS],
		["x", "X position / expression", "X 座標／式", "text"],
		["y", "Y position / expression", "Y 座標／式", "text"],
		["fontSize", "Font size", "文字サイズ", "number"],
		["fontColor", "Font color", "文字色", "text"],
		["alpha", "Opacity (0–1)", "不透明度 (0–1)", "number"],
		["box", "Background box", "背景ボックス", ["true", "false"]],
		["boxColor", "Box color", "背景色", "text"],
		["boxBorderWidth", "Box border width", "背景の縁幅", "number"],
		["borderWidth", "Text border width", "文字の縁幅", "number"],
		["lineSpacing", "Line spacing", "行間", "number"],
		["fixBounds", "Keep within frame", "フレーム内に補正", ["true", "false"]],
		["shadowColor", "Shadow color", "影の色", "text"],
		["shadowX", "Shadow X", "影 X", "number"],
		["shadowY", "Shadow Y", "影 Y", "number"],
	],
};

export function MediaFilterEditor({
	idBase,
	filter,
	inputFiles,
	onChange,
}: {
	idBase: string;
	filter: WizardFilter;
	inputFiles: WizardInputFile[];
	onChange: (next: WizardFilter) => void;
}) {
	const { locale } = useT();
	const ja = locale === "ja";
	const inputs = inputFiles.filter(
		(f, i, all) =>
			["S3", "GENERIC_S3", "GCS"].includes(f.kind) &&
			all.findIndex((x) => x.inputKey === f.inputKey) === i,
	);
	const patch = (key: string, value: unknown) =>
		onChange({ ...filter, [key]: value } as WizardFilter);
	return (
		<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
			<Field
				label={ja ? "フィルターの種類" : "Filter type"}
				htmlFor={`${idBase}-kind`}
			>
				<SelectNative
					id={`${idBase}-kind`}
					value={filter.kind ?? "DEINTERLACE"}
					onChange={(e) =>
						onChange(
							newFilter(
								filter.key,
								e.target.value as (typeof FILTER_KINDS)[number],
								inputs[0]?.inputKey,
							),
						)
					}
				>
					{FILTER_KINDS.map((k) => (
						<option key={k} value={k}>
							{k}
						</option>
					))}
				</SelectNative>
			</Field>
			{filter.kind === "WATERMARK" ? (
				<Field
					label={ja ? "画像の入力ストレージ" : "Image input storage"}
					htmlFor={`${idBase}-input`}
					help={
						ja
							? "S3・S3 互換・GCS HMAC の入力に対応"
							: "S3, S3-compatible and GCS HMAC inputs"
					}
				>
					<SelectNative
						id={`${idBase}-input`}
						value={filter.inputKey}
						onChange={(e) => patch("inputKey", e.target.value)}
					>
						<option value="">{ja ? "入力を選択" : "Select input"}</option>
						{inputs.map((f) => (
							<option key={f.inputKey} value={f.inputKey}>
								{f.name ?? f.inputKey} · {f.bucket}
							</option>
						))}
						{filter.inputKey &&
						!inputs.some((f) => f.inputKey === filter.inputKey) ? (
							<option value={filter.inputKey}>
								{filter.inputKey} ({ja ? "未設定" : "missing"})
							</option>
						) : null}
					</SelectNative>
				</Field>
			) : null}
			{(fields[filter.kind ?? "DEINTERLACE"] ?? []).map(
				([key, en, jp, control]) => {
					const value = (filter as unknown as Record<string, unknown>)[key];
					const id = `${idBase}-${key}`;
					return (
						<Field
							key={key}
							htmlFor={id}
							label={ja ? jp : en}
							tooltip={
								filter.kind === "UNSHARP"
									? ja
										? "サイズ: 3〜23の奇数。強度: -1.5〜1.5（正は鮮鋭化、負はぼかし）。空欄はAPIの既定値。"
										: "Matrix: odd 3–23. Strength: -1.5–1.5 (positive sharpens, negative blurs). Blank uses the API default."
									: filter.kind === "DENOISE_HQDN3D"
										? ja
											? "0以上。空欄はAPIの既定値。"
											: "Non-negative. Blank uses the API default."
										: undefined
							}
						>
							{typeof control === "string" ? (
								<Input
									id={id}
									type={control}
									step={control === "number" ? "any" : undefined}
									value={value === undefined ? "" : String(value)}
									onChange={(e) =>
										patch(
											key,
											e.target.value === ""
												? undefined
												: control === "number"
													? Number(e.target.value)
													: e.target.value,
										)
									}
								/>
							) : (
								<SelectNative
									id={id}
									value={value === undefined ? "" : String(value)}
									onChange={(e) =>
										patch(
											key,
											e.target.value === ""
												? undefined
												: key === "box" || key === "fixBounds"
													? e.target.value === "true"
													: e.target.value,
										)
									}
								>
									<option value="">{ja ? "未設定" : "Not set"}</option>
									{control.map((v) => (
										<option key={v} value={v}>
											{v}
										</option>
									))}
								</SelectNative>
							)}
						</Field>
					);
				},
			)}
		</div>
	);
}
