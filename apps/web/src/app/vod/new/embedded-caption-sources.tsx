"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type { WizardCaptionStream } from "./build-plan";
import type { InputFileOption } from "./stream-model";

export function EmbeddedCaptionSources({
	streams,
	files,
	encodings,
	nextKey,
	onChange,
}: {
	streams: WizardCaptionStream[];
	files: InputFileOption[];
	encodings: string[];
	nextKey: string;
	onChange: (next: WizardCaptionStream[]) => void;
}) {
	const ja = useT().locale === "ja";
	const update = (next: WizardCaptionStream) =>
		onChange(streams.map((s) => (s.key === next.key ? next : s)));
	return (
		<>
			{streams.map((stream) => {
				const shared = {
					key: stream.key,
					inputFile: stream.inputFile,
					encodingKey: stream.encodingKey,
				};
				const id = `caption-${stream.key}`;
				return (
					<fieldset
						key={stream.key}
						className="space-y-2 rounded-md border p-3"
					>
						<legend>
							{ja ? "埋め込み字幕" : "Embedded captions"} · {stream.key}
						</legend>
						<div className="grid gap-3 sm:grid-cols-2">
							<Field
								label={ja ? "入力素材" : "Source media"}
								htmlFor={id + "-file"}
							>
								<SelectNative
									id={id + "-file"}
									value={stream.inputFile}
									onChange={(e) =>
										update({ ...stream, inputFile: e.target.value })
									}
								>
									<option value="">{ja ? "素材を選択" : "Select media"}</option>
									{stream.inputFile &&
										!files.some((f) => f.key === stream.inputFile) && (
											<option value={stream.inputFile}>
												{stream.inputFile} ({ja ? "見つかりません" : "missing"})
											</option>
										)}
									{files.map((f) => (
										<option key={f.key} value={f.key}>
											{f.label}
										</option>
									))}
								</SelectNative>
							</Field>
							<Field
								label={ja ? "字幕形式" : "Caption format"}
								htmlFor={id + "-type"}
							>
								<SelectNative
									id={id + "-type"}
									value={stream.kind}
									onChange={(e) => {
										const value = e.target.value;
										if (value === "DVB")
											update({ ...shared, kind: value, selectionMode: "AUTO" });
										if (value === "CEA608")
											update({ ...shared, kind: value, channel: "CC1" });
										if (value === "CEA708") update({ ...shared, kind: value });
									}}
								>
									<option value="CEA608">CEA-608</option>
									<option value="CEA708">CEA-708</option>
									<option value="DVB">DVB</option>
								</SelectNative>
							</Field>
							{stream.kind === "CEA608" && (
								<Field
									label={ja ? "チャンネル" : "Caption channel"}
									htmlFor={id + "-channel"}
								>
									<SelectNative
										id={id + "-channel"}
										value={stream.channel}
										onChange={(e) =>
											update({
												...stream,
												channel: e.target.value === "CC3" ? "CC3" : "CC1",
											})
										}
									>
										<option>CC1</option>
										<option>CC3</option>
									</SelectNative>
								</Field>
							)}
							{stream.kind === "CEA708" && (
								<Field
									label={ja ? "サービス番号" : "Caption service"}
									htmlFor={id + "-service"}
								>
									<Input
										id={id + "-service"}
										type="number"
										min={1}
										max={63}
										step={1}
										placeholder="1"
										value={stream.channel ?? ""}
										onChange={(e) =>
											update({
												...stream,
												channel:
													e.target.value === ""
														? undefined
														: e.target.valueAsNumber,
											})
										}
									/>
								</Field>
							)}
							{stream.kind === "DVB" && (
								<>
									<Field
										label={ja ? "トラックの選択方法" : "Track selection"}
										htmlFor={id + "-mode"}
									>
										<SelectNative
											id={id + "-mode"}
											value={stream.selectionMode}
											onChange={(e) => {
												const mode = e.target.value;
												if (mode === "AUTO")
													update({
														...shared,
														kind: "DVB",
														selectionMode: mode,
													});
												if (
													mode === "POSITION_ABSOLUTE" ||
													mode === "SUBTITLE_RELATIVE"
												)
													update({ ...stream, selectionMode: mode });
											}}
										>
											<option value="AUTO">{ja ? "自動" : "Automatic"}</option>
											<option value="POSITION_ABSOLUTE">
												{ja
													? "全トラック内の位置"
													: "Position among all tracks"}
											</option>
											<option value="SUBTITLE_RELATIVE">
												{ja
													? "字幕トラック内の位置"
													: "Position among subtitle tracks"}
											</option>
										</SelectNative>
									</Field>
									{stream.selectionMode !== "AUTO" && (
										<Field
											label={
												ja
													? "トラック位置（0始まり）"
													: "Track position (zero-based)"
											}
											htmlFor={id + "-position"}
										>
											<Input
												id={id + "-position"}
												type="number"
												min={0}
												max={2147483647}
												step={1}
												placeholder="0"
												value={stream.position ?? ""}
												onChange={(e) =>
													update({
														...stream,
														position:
															e.target.value === ""
																? undefined
																: e.target.valueAsNumber,
													})
												}
											/>
										</Field>
									)}
								</>
							)}
							{encodings.length > 0 && (
								<Field
									label={ja ? "エンコード" : "Encoding"}
									htmlFor={id + "-encoding"}
								>
									<SelectNative
										id={id + "-encoding"}
										value={stream.encodingKey ?? ""}
										onChange={(e) =>
											update({
												...stream,
												encodingKey: e.target.value || undefined,
											})
										}
									>
										<option value="">{ja ? "選択" : "Select"}</option>
										{stream.encodingKey &&
											!encodings.includes(stream.encodingKey) && (
												<option value={stream.encodingKey}>
													{stream.encodingKey} (
													{ja ? "見つかりません" : "missing"})
												</option>
											)}
										{encodings.map((key) => (
											<option key={key}>{key}</option>
										))}
									</SelectNative>
								</Field>
							)}
						</div>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() =>
								onChange(streams.filter((row) => row.key !== stream.key))
							}
						>
							{ja ? "字幕ソースを削除" : "Remove caption source"}
						</Button>
					</fieldset>
				);
			})}
			<Button
				type="button"
				size="sm"
				variant="secondary"
				onClick={() =>
					onChange([
						...streams,
						{
							key: nextKey,
							kind: "CEA608",
							channel: "CC1",
							inputFile: files[0]?.key ?? "",
						},
					])
				}
			>
				{ja ? "埋め込み字幕を追加" : "Add embedded captions"}
			</Button>
		</>
	);
}
