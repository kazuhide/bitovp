"use client";

import { CODEC_OPTIONS, type DetailCodec } from "@bitovp/core";
import { useState } from "react";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { CODEC_DETAIL_FIELDS } from "./codec-detail-fields";
import { Collapsible, OptionsGrid } from "./wizard-fields";

const JAPANESE_HELP: Record<string, string> = {
	autoLevelSetup:
		"maxBitrateやbufsizeを指定すると、レベルから算出する上限より指定値が優先されます。",
	nalHrd:
		"仮想参照デコーダー（HRD）へバッファー情報を通知します。0より大きいbufsizeが必要です。",
	pixelFormat:
		"出力映像の画素形式、ビット深度、色差サンプリングです。エンコーダーとプロファイルが対応する組み合わせを選んでください。",
	allowedRADLBeforeIDR:
		"固定のキーフレーム間隔が必要です。bframes以下に設定してください。",
	gopLookahead:
		"キーフレームの区切りを探す先読みフレーム数です。rcLookahead以下に設定してください。",
	lookaheadSlices:
		"先読みを並列化する分割数（0〜16）です。値を増やすと処理が速くなる一方、判断の精度が下がる場合があります。",
	maxMerge: "マージ候補の最大数（1〜5）です。",
	rateDistortionLevelForModeDecision:
		"符号化モードの比較にかける処理量（0〜4）です。値を増やすと処理時間が長くなります。",
	automaticAltRefFramesEnabled: "2パスエンコードで使用できます。",
	clientBufferSize: "クライアント側バッファーの長さです。単位はミリ秒です。",
	clientInitialBufferSize: "初期バッファーの長さです。単位はミリ秒です。",
	maxIntraRate:
		"Iフレームの最大ビットレートを割合（％）で指定します。0は無制限です。",
	targetLevel:
		"255はレベル指定を無効にします。10はレベル1.0、11は1.1を表します。",
	tileRows: "タイルの行数を2の指数で指定します。0は1行、1は2行、2は4行です。",
};

function groupFor(key: string): number {
	if (
		/bitrate|buffer|crf|qp|quant|ratecontrol|biasPct|blur|Ratio|strictCbr/i.test(
			key,
		)
	)
		return 0;
	if (
		/gop|frame|slice|radl|lookahead|flush|parallel|thread|tile|nalHrd/i.test(
			key,
		)
	)
		return 1;
	if (/pixel|aspect|dynamicRange|interlace|videoFormat|Hlg|Hrd/i.test(key))
		return 3;
	return 2;
}

/** Detailed API controls live inside Advanced; the ladder row stays compact. */
export function CodecDetailEditor<T extends object>({
	idBase,
	codec,
	value,
	onChange,
}: {
	idBase: string;
	codec: DetailCodec;
	value: T;
	onChange: (value: T) => void;
}) {
	const { locale } = useT();
	const [search, setSearch] = useState("");
	const record = value as Record<string, unknown>;
	const update = (key: string, next: unknown) =>
		onChange({ ...record, [key]: next } as T);
	const titles =
		locale === "ja"
			? [
					"レート制御",
					"フレーム構造と並列処理",
					"予測と解析",
					"色・画素とアスペクト比",
				]
			: [
					"Rate control",
					"Frame structure and parallelism",
					"Prediction and analysis",
					"Colour, pixels and aspect ratio",
				];
	const fields = CODEC_DETAIL_FIELDS[codec]
		.filter((field) => field.key.toLowerCase().includes(search.toLowerCase()))
		.map((field) => ({
			...field,
			help:
				locale === "ja" ? (JAPANESE_HELP[field.key] ?? field.help) : field.help,
		}));
	const captions = (record.cea608708SubtitleConfig ?? {}) as Record<
		string,
		unknown
	>;
	const ratio = (record.displayAspectRatio ?? {}) as Record<string, unknown>;
	return (
		<Collapsible
			summary={locale === "ja" ? "その他のAPI設定" : "Additional API settings"}
		>
			<Field
				label={
					locale === "ja" ? "APIパラメーターを検索" : "Search API parameters"
				}
				htmlFor={`${idBase}-search`}
			>
				<Input
					id={`${idBase}-search`}
					type="search"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
			</Field>
			{titles.map((title, group) => {
				const selected = fields.filter(
					(field) => groupFor(field.key) === group,
				);
				return selected.length > 0 ? (
					<Collapsible key={title} summary={title}>
						<OptionsGrid
							idBase={idBase}
							value={value}
							fields={selected}
							onChange={onChange}
						/>
					</Collapsible>
				) : null;
			})}
			{(codec === "AV1" || codec === "VP9") &&
			"displayAspectRatio".toLowerCase().includes(search.toLowerCase()) ? (
				<Collapsible summary="displayAspectRatio">
					<OptionsGrid
						idBase={`${idBase}-dar`}
						value={ratio}
						fields={[
							{
								key: "numerator",
								label: "displayAspectRatio.numerator",
								control: "num",
							},
							{
								key: "denominator",
								label: "displayAspectRatio.denominator",
								control: "num",
							},
						]}
						onChange={(next) =>
							update(
								"displayAspectRatio",
								Object.values(next).some((value) => value !== undefined)
									? next
									: undefined,
							)
						}
					/>
				</Collapsible>
			) : null}
			{(codec === "H264" || codec === "H265") &&
			"cea608708SubtitleConfig".toLowerCase().includes(search.toLowerCase()) ? (
				<Collapsible
					summary="cea608708SubtitleConfig"
					help={
						locale === "ja"
							? "入力の字幕を保持します。入力と出力のフレームレートが異なる場合は利用できません（フィールド単位のインターレース解除で2倍にする場合を除く）。"
							: "Preserves input captions. Input and output frame rates must match, except when per-field deinterlacing doubles the frame rate."
					}
				>
					<Field label="passthroughActivated" htmlFor={`${idBase}-captions`}>
						<SelectNative
							id={`${idBase}-captions`}
							value={
								captions.passthroughActivated === undefined
									? ""
									: String(captions.passthroughActivated)
							}
							onChange={(event) =>
								update(
									"cea608708SubtitleConfig",
									event.target.value === ""
										? undefined
										: {
												...captions,
												passthroughMode:
													captions.passthroughMode ?? "VIDEO_STREAM",
												passthroughActivated: event.target.value === "true",
											},
								)
							}
						>
							<option value="">{locale === "ja" ? "未指定" : "Unset"}</option>
							<option value="true">true</option>
							<option value="false">false</option>
						</SelectNative>
					</Field>
					{captions.passthroughActivated !== undefined ? (
						<Field label="passthroughMode" htmlFor={`${idBase}-caption-mode`}>
							<SelectNative
								id={`${idBase}-caption-mode`}
								value={
									typeof captions.passthroughMode === "string"
										? captions.passthroughMode
										: ""
								}
								onChange={(event) =>
									update("cea608708SubtitleConfig", {
										...captions,
										passthroughMode: event.target.value || undefined,
									})
								}
							>
								<option value="">{locale === "ja" ? "未指定" : "Unset"}</option>
								{typeof captions.passthroughMode === "string" &&
								!CODEC_OPTIONS.PassthroughMode.includes(
									captions.passthroughMode,
								) ? (
									<option value={captions.passthroughMode}>
										{captions.passthroughMode}
									</option>
								) : null}
								{CODEC_OPTIONS.PassthroughMode.map((mode) => (
									<option key={mode} value={mode}>
										{mode}
									</option>
								))}
							</SelectNative>
						</Field>
					) : null}
				</Collapsible>
			) : null}
			{codec === "H264" && "partitions".includes(search.toLowerCase()) ? (
				<Field
					label="partitions"
					htmlFor={`${idBase}-partitions`}
					help={
						locale === "ja"
							? "複数選択できます。NONEとALLは単独で指定してください。"
							: "Select multiple partitions, or choose NONE or ALL alone."
					}
				>
					<SelectNative
						multiple
						className="h-36"
						id={`${idBase}-partitions`}
						value={
							Array.isArray(record.partitions)
								? (record.partitions as string[])
								: []
						}
						onChange={(event) => {
							const selected = Array.from(
								event.target.selectedOptions,
								(option) => option.value,
							);
							update("partitions", selected.length > 0 ? selected : undefined);
						}}
					>
						{CODEC_OPTIONS.H264Partition.map((option) => (
							<option key={option} value={option}>
								{option}
							</option>
						))}
					</SelectNative>
				</Field>
			) : null}
		</Collapsible>
	);
}

export function AudioCutoffEditor({
	id,
	value,
	onChange,
}: {
	id: string;
	value: number | undefined;
	onChange: (value: number | undefined) => void;
}) {
	const { locale } = useT();
	return (
		<Collapsible
			summary={locale === "ja" ? "音声の詳細設定" : "Audio advanced settings"}
		>
			<Field
				label={
					locale === "ja" ? "カットオフ周波数 (Hz)" : "Cutoff frequency (Hz)"
				}
				htmlFor={id}
				help={
					locale === "ja"
						? "エンコーダーを通過する音声の最高周波数です。空欄はAPIの既定値を使います。"
						: "Highest audio frequency passed by the encoder. Leave blank to use the API default."
				}
			>
				<Input
					id={id}
					type="number"
					min={0}
					value={value ?? ""}
					onChange={(event) =>
						onChange(
							event.target.value === ""
								? undefined
								: Number(event.target.value),
						)
					}
				/>
			</Field>
		</Collapsible>
	);
}
