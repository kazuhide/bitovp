"use client";
import type { ManifestCondition } from "@bitovp/core";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type { ManifestResources } from "./manifest-detail-fields";
import { ObjectFields } from "./manifest-field-editor";
import { Collapsible } from "./wizard-fields";

export function DefaultPeriodsEditor({
	value,
	onChange,
	idBase,
	resources,
}: {
	value: { encodingKeys: string[]; adaptationSets?: ManifestCondition[] }[];
	onChange: (
		next:
			| { encodingKeys: string[]; adaptationSets?: ManifestCondition[] }[]
			| undefined,
	) => void;
	idBase: string;
	resources: ManifestResources;
}) {
	const { t } = useT();
	return (
		<Collapsible summary={`periods (${value.length})`}>
			<div className="space-y-3">
				{value.map((period, index) => (
					<div
						key={index}
						className="space-y-3 rounded border border-zinc-800 p-3"
					>
						<Field label="encodingIds" htmlFor={`${idBase}-${index}-encodings`}>
							<SelectNative
								id={`${idBase}-${index}-encodings`}
								multiple
								value={period.encodingKeys}
								onChange={(event) =>
									onChange(
										value.map((p, i) =>
											i === index
												? {
														...p,
														encodingKeys: Array.from(
															event.target.selectedOptions,
															(option) => option.value,
														),
													}
												: p,
										),
									)
								}
							>
								{resources.encodings.map((encoding) => (
									<option key={encoding.value} value={encoding.value}>
										{encoding.label}
									</option>
								))}
							</SelectNative>
						</Field>
						<ConditionsEditor
							idBase={`${idBase}-${index}`}
							value={period.adaptationSets ?? []}
							onChange={(conditions) =>
								onChange(
									value.map((p, i) =>
										i === index ? { ...p, adaptationSets: conditions } : p,
									),
								)
							}
						/>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() =>
								onChange(
									value.length === 1
										? undefined
										: value.filter((_, i) => i !== index),
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
					onClick={() =>
						onChange([
							...value,
							{
								encodingKeys: resources.encodings[0]
									? [resources.encodings[0].value]
									: [],
							},
						])
					}
				>
					{t("manifestDetail.add")}
				</Button>
			</div>
		</Collapsible>
	);
}
function ConditionsEditor({
	value,
	onChange,
	idBase,
	depth = 0,
}: {
	value: ManifestCondition[];
	onChange: (next: ManifestCondition[]) => void;
	idBase: string;
	depth?: number;
}) {
	const { t } = useT();
	return (
		<div className="space-y-2">
			{value.map((condition, index) => (
				<div key={index} className="space-y-2 border-zinc-700 border-l pl-3">
					<Field label="type" htmlFor={`${idBase}-${index}-type`}>
						<SelectNative
							id={`${idBase}-${index}-type`}
							value={condition.type}
							onChange={(event) => {
								const type = event.target.value as ManifestCondition["type"];
								onChange(
									value.map((c, i) =>
										i === index
											? type === "CONDITION"
												? {
														type,
														attribute: "video.codec",
														operator: "==",
														value: "H264",
													}
												: {
														type,
														conditions:
															c.type === "CONDITION" ? [c] : c.conditions,
													}
											: c,
									),
								);
							}}
						>
							<option value="CONDITION">CONDITION</option>
							<option value="AND" disabled={depth >= 8}>
								AND
							</option>
							<option value="OR" disabled={depth >= 8}>
								OR
							</option>
						</SelectNative>
					</Field>
					{condition.type === "CONDITION" ? (
						<ObjectFields
							idBase={`${idBase}-${index}`}
							value={condition}
							fields={[
								{
									name: "attribute",
									values: [
										"audio.codec",
										"audio.language",
										"audio.bitrate",
										"subtitle.format",
										"subtitle.language",
										"video.height",
										"video.width",
										"video.codec",
										"video.bitrate",
										"drm.type",
										"muxing.type",
									],
								},
								{
									name: "operator",
									values: ["==", "!=", "<", "<=", ">", ">="],
								},
								{ name: "value" },
							]}
							resources={{
								muxings: [],
								encodings: [],
								drm: [],
								keyframes: [],
								sprites: [],
							}}
							onChange={(next) =>
								onChange(
									value.map((c, i) =>
										i === index ? (next as ManifestCondition) : c,
									),
								)
							}
						/>
					) : (
						<ConditionsEditor
							depth={depth + 1}
							idBase={`${idBase}-${index}-children`}
							value={condition.conditions}
							onChange={(conditions) =>
								onChange(
									value.map((c, i) =>
										i === index ? { ...condition, conditions } : c,
									),
								)
							}
						/>
					)}
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={() => onChange(value.filter((_, i) => i !== index))}
					>
						{t("manifestDetail.remove")}
					</Button>
				</div>
			))}
			<Button
				type="button"
				size="sm"
				variant="secondary"
				disabled={value.length >= 32}
				onClick={() =>
					onChange([
						...value,
						{
							type: "CONDITION",
							attribute: "video.codec",
							operator: "==",
							value: "H264",
						},
					])
				}
			>
				{t("manifestDetail.add")}
			</Button>
		</div>
	);
}
