"use client";

import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";

export type AisaInputType = "RTMP" | "HLS" | "REFERENCE";

export function AisaLiveFields({
	inputType,
	onInputType,
	prefix,
}: {
	inputType: AisaInputType;
	onInputType: (value: AisaInputType) => void;
	prefix: string;
}) {
	const { t } = useT();
	return (
		<>
			<Field label={t("aisaLive.name")} htmlFor="aisa-name">
				<Input
					id="aisa-name"
					name="name"
					required
					maxLength={200}
					autoComplete="off"
				/>
			</Field>
			<Field label={t("aisaLive.input")} htmlFor="aisa-input-type">
				<SelectNative
					id="aisa-input-type"
					value={inputType}
					onChange={(event) => onInputType(event.target.value as AisaInputType)}
				>
					<option value="RTMP">{t("aisaLive.rtmp")}</option>
					<option value="HLS">{t("aisaLive.hls")}</option>
					<option value="REFERENCE">{t("aisaLive.reference")}</option>
				</SelectNative>
			</Field>
			{inputType === "HLS" ? (
				<Field
					label={t("aisaLive.hlsUrl")}
					htmlFor="aisa-hls-url"
					hint={t("aisaLive.hlsHint")}
				>
					<Input
						id="aisa-hls-url"
						name="url"
						type="url"
						required
						autoComplete="off"
					/>
				</Field>
			) : (
				<>
					{inputType === "REFERENCE" ? (
						<Field label={t("aisaLive.inputId")} htmlFor="aisa-input-id">
							<Input
								id="aisa-input-id"
								name="inputId"
								required
								autoComplete="off"
							/>
						</Field>
					) : null}
					<Field
						label={t("aisaLive.streamKey")}
						htmlFor="aisa-stream-key"
						hint={t("aisaLive.streamKeyHint")}
					>
						<Input
							id="aisa-stream-key"
							name="streamKey"
							type="password"
							autoComplete="new-password"
							required={inputType === "RTMP"}
							pattern="[a-zA-Z]{3,20}"
							minLength={3}
							maxLength={20}
						/>
					</Field>
				</>
			)}
			<Field
				label={t("aisaLive.outputId")}
				htmlFor="aisa-output-id"
				hint={t("aisaLive.outputHint")}
			>
				<Input
					id="aisa-output-id"
					name="outputId"
					required
					autoComplete="off"
				/>
			</Field>
			<div className="grid gap-4 sm:grid-cols-2">
				<Field
					label={t("aisaLive.recordingPath")}
					htmlFor="aisa-recording-path"
				>
					<Input
						id="aisa-recording-path"
						name="recordingPath"
						defaultValue={`${prefix}/recording`}
						required
						maxLength={1024}
					/>
				</Field>
				<Field label={t("aisaLive.analysisPath")} htmlFor="aisa-analysis-path">
					<Input
						id="aisa-analysis-path"
						name="analysisPath"
						defaultValue={`${prefix}/analysis`}
						required
						maxLength={1024}
					/>
				</Field>
			</div>
			<details className="rounded-md border border-zinc-800 p-4">
				<summary className="cursor-pointer text-sm text-zinc-300">
					{t("aisaLive.advanced")}
				</summary>
				<div className="mt-4 grid gap-4 sm:grid-cols-2">
					<Field
						label={t("aisaLive.region")}
						htmlFor="aisa-region"
						hint={t("aisaLive.defaultHint")}
					>
						<Input
							id="aisa-region"
							name="cloudRegion"
							placeholder="GOOGLE_EUROPE_WEST_1"
							maxLength={128}
						/>
					</Field>
					<Field
						label={t("aisaLive.encoderVersion")}
						htmlFor="aisa-encoder-version"
						hint={t("aisaLive.defaultHint")}
					>
						<Input
							id="aisa-encoder-version"
							name="encoderVersion"
							placeholder="2.291.0"
							maxLength={128}
						/>
					</Field>
				</div>
			</details>
		</>
	);
}
