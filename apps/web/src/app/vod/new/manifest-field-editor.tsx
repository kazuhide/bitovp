"use client";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type { Bag, ManifestResources, Spec } from "./manifest-detail-fields";
import { CodesInput, Collapsible } from "./wizard-fields";

function visible(field: Spec, value: Bag): boolean {
	if (value.positionMode)
		return (
			!["time", "segment", "keyframeKey"].includes(field.name) ||
			field.name ===
				(value.positionMode === "TIME"
					? "time"
					: value.positionMode === "SEGMENT"
						? "segment"
						: "keyframeKey")
		);
	if (
		["VTT", "SPRITE", "PROGRESSIVE_WEBM", "VIDEO", "CLOSED_CAPTIONS"].includes(
			String(value.type),
		)
	) {
		const type = value.type;
		if (field.name === "vttUrl") return type === "VTT";
		if (field.name === "spriteKey") return type === "SPRITE";
		if (["muxingKey", "drmKey", "dependencyMuxingKey"].includes(field.name))
			return type !== "VTT" && type !== "SPRITE";
		if (field.name === "forced") return type !== "VIDEO";
		if (
			field.name === "startSegmentNumber" ||
			field.name === "endSegmentNumber"
		)
			return type !== "VTT";
		if (field.name === "instreamId") return type === "CLOSED_CAPTIONS";
		if (field.name === "uri") return type === "VTT" || type === "VIDEO";
	}
	return true;
}
export function ObjectFields({
	idBase,
	fields,
	value,
	onChange,
	resources,
}: {
	idBase: string;
	fields: Spec[];
	value: Bag;
	onChange: (value: Bag) => void;
	resources: ManifestResources;
}) {
	const { t } = useT();
	const patch = (name: string, next: unknown) => {
		let result = { ...value, [name]: next };
		if (next === undefined) delete result[name];
		if (name === "positionMode") {
			for (const key of ["time", "segment", "keyframeKey"]) delete result[key];
			result = {
				...result,
				...(next === "TIME"
					? { time: 0 }
					: next === "SEGMENT"
						? { segment: 0 }
						: { keyframeKey: "" }),
			};
		}
		if (name === "type") {
			for (const key of [
				"muxingKey",
				"spriteKey",
				"drmKey",
				"dependencyMuxingKey",
				"vttUrl",
				"uri",
				"instreamId",
				"lang",
				"startSegmentNumber",
				"endSegmentNumber",
				"forced",
			])
				delete result[key];
			Object.assign(
				result,
				next === "VTT"
					? {
							vttUrl: "",
							...(fields.some((f) => f.name === "uri")
								? { uri: "subtitles.m3u8" }
								: { lang: "en" }),
						}
					: next === "SPRITE"
						? { spriteKey: "" }
						: {
								muxingKey: "",
								...(next === "VIDEO"
									? { uri: "video.m3u8" }
									: next === "CLOSED_CAPTIONS"
										? { instreamId: "CC1" }
										: {}),
							},
			);
		}
		onChange(result);
	};
	return (
		<div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
			{fields
				.filter((field) => visible(field, value))
				.map((field) => {
					const id = `${idBase}-${field.name}`;
					const current = value[field.name];
					if (field.type === "object")
						return (
							<div key={field.name} className="min-w-0 sm:col-span-2">
								<Collapsible summary={field.name}>
									<ObjectFields
										idBase={id}
										fields={field.fields ?? []}
										value={isBag(current) ? current : {}}
										onChange={(next) =>
											patch(
												field.name,
												Object.keys(next).length ? next : undefined,
											)
										}
										resources={resources}
									/>
								</Collapsible>
							</div>
						);
					if (field.type === "texts") {
						const texts = Array.isArray(current)
							? current.filter(
									(value): value is string => typeof value === "string",
								)
							: [];
						return (
							<div key={field.name} className="min-w-0 sm:col-span-2">
								<Collapsible summary={`${field.name} (${texts.length})`}>
									{texts.map((text, index) => (
										<div key={index} className="space-y-2">
											<Field
												label={`${field.name} ${index + 1}`}
												htmlFor={`${id}-${index}`}
											>
												<textarea
													id={`${id}-${index}`}
													className="min-h-20 w-full rounded border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs"
													value={text}
													onChange={(event) =>
														patch(
															field.name,
															texts.map((item, i) =>
																i === index ? event.target.value : item,
															),
														)
													}
												/>
											</Field>
											<Button
												type="button"
												variant="ghost"
												size="sm"
												onClick={() =>
													patch(
														field.name,
														texts.length === 1
															? undefined
															: texts.filter((_, i) => i !== index),
													)
												}
											>
												{t("manifestDetail.remove")}
											</Button>
										</div>
									))}
									<Button
										type="button"
										variant="secondary"
										size="sm"
										disabled={texts.length >= 64}
										onClick={() => patch(field.name, [...texts, ""])}
									>
										{t("manifestDetail.add")}
									</Button>
								</Collapsible>
							</div>
						);
					}
					if (field.type === "rows") {
						const rows = Array.isArray(current) ? current.filter(isBag) : [];
						return (
							<div key={field.name} className="min-w-0 sm:col-span-2">
								<Collapsible summary={`${field.name} (${rows.length})`}>
									<div className="space-y-3">
										{rows.map((row, index) => (
											<div
												key={index}
												className="space-y-2 rounded border border-zinc-800 p-3"
											>
												<ObjectFields
													idBase={`${id}-${index}`}
													fields={field.fields ?? []}
													value={row}
													resources={resources}
													onChange={(next) =>
														patch(
															field.name,
															rows.map((item, i) =>
																i === index ? next : item,
															),
														)
													}
												/>
												<Button
													type="button"
													variant="ghost"
													size="sm"
													onClick={() =>
														patch(
															field.name,
															rows.length === 1
																? undefined
																: rows.filter((_, i) => i !== index),
														)
													}
												>
													{t("manifestDetail.remove")}
												</Button>
											</div>
										))}
										<Button
											type="button"
											variant="secondary"
											size="sm"
											disabled={rows.length >= 64}
											onClick={() =>
												patch(field.name, [...rows, { ...field.initial }])
											}
										>
											{t("manifestDetail.add")}
										</Button>
									</div>
								</Collapsible>
							</div>
						);
					}
					const options = field.resource
						? resources[field.resource]
						: field.values?.map((value) => ({ value, label: value }));
					return (
						<Field
							key={field.name}
							label={field.name}
							htmlFor={id}
							hint={
								field.name === "vttUrl"
									? t("manifestDetail.publicVttUrl")
									: undefined
							}
						>
							{field.type === "lines" ? (
								<CodesInput
									id={id}
									value={
										Array.isArray(current)
											? current.filter(
													(value): value is string => typeof value === "string",
												)
											: undefined
									}
									placeholder={field.values?.join(", ") ?? ""}
									onChange={(values) => patch(field.name, values)}
								/>
							) : field.type === "boolean" || options ? (
								<SelectNative
									id={id}
									value={current === undefined ? "" : String(current)}
									onChange={(event) =>
										patch(
											field.name,
											event.target.value === ""
												? undefined
												: field.type === "boolean"
													? event.target.value === "true"
													: event.target.value,
										)
									}
								>
									<option value="">{t("manifestDetail.unset")}</option>
									{field.type === "boolean" ? (
										<>
											<option value="true">true</option>
											<option value="false">false</option>
										</>
									) : (
										options?.map((option) => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))
									)}
								</SelectNative>
							) : (
								<Input
									id={id}
									type={field.type === "number" ? "number" : "text"}
									step={field.type === "number" ? "any" : undefined}
									value={
										typeof current === "string" || typeof current === "number"
											? current
											: ""
									}
									onChange={(event) =>
										patch(
											field.name,
											event.target.value === ""
												? undefined
												: field.type === "number"
													? Number(event.target.value)
													: event.target.value,
										)
									}
								/>
							)}
						</Field>
					);
				})}
		</div>
	);
}
function isBag(value: unknown): value is Bag {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
