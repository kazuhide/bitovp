"use client";
import {
	allowedStreamOperators,
	availableStreamAttributes,
	conditionTreeLimits,
	type StreamCondition,
	type StreamConditionLeaf,
	type StreamConditionMedia,
} from "@bitovp/core";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { Collapsible } from "./wizard-fields";

const signs = {
	EQUAL: "=",
	NOT_EQUAL: "≠",
	LESS_THAN: "<",
	LESS_THAN_OR_EQUAL: "≤",
	GREATER_THAN: ">",
	GREATER_THAN_OR_EQUAL: "≥",
};
const leaf = (): StreamConditionLeaf => ({
	attribute: "INPUTSTREAM",
	operator: "EQUAL",
	value: "true",
});
function size(value: StreamCondition): number {
	return "conditions" in value
		? 1 + value.conditions.reduce((sum, c) => sum + size(c), 0)
		: 1;
}
function height(value: StreamCondition): number {
	return "conditions" in value
		? 1 + Math.max(...value.conditions.map(height))
		: 0;
}
type Props = {
	idBase: string;
	media: StreamConditionMedia;
	live?: boolean;
	value?: StreamCondition;
	onChange: (value: StreamCondition | undefined) => void;
};

export function StreamConditionEditor(props: Props) {
	const { t } = useT();
	return (
		<Collapsible
			summary={
				props.value
					? t("streamConditions.enabled")
					: t("streamConditions.title")
			}
			deferContent
		>
			{props.value ? (
				<ConditionNode
					{...props}
					value={props.value}
					depth={0}
					count={size(props.value)}
				/>
			) : (
				<Button
					type="button"
					variant="secondary"
					size="sm"
					onClick={() => props.onChange(leaf())}
				>
					{t("streamConditions.add")}
				</Button>
			)}
		</Collapsible>
	);
}
function ConditionNode({
	idBase,
	media,
	live = false,
	value,
	onChange,
	depth,
	count,
}: Props & { value: StreamCondition; depth: number; count: number }) {
	const { t } = useT();
	const attributes = availableStreamAttributes(media, live);
	const wrap = (type: "AND" | "OR") =>
		onChange({ type, conditions: [value, leaf()] });
	const canWrap =
		depth + height(value) < conditionTreeLimits.depth &&
		count + 2 <= conditionTreeLimits.nodes;
	const btn = {
		type: "button" as const,
		variant: "secondary" as const,
		size: "sm" as const,
	};
	return (
		<fieldset className="min-w-0 space-y-2 border-zinc-700 border-l pl-3">
			<legend className="text-xs text-zinc-400">
				{t("streamConditions.rule")}
			</legend>
			{"conditions" in value ? (
				<>
					<Field
						htmlFor={`${idBase}-group`}
						label={t("streamConditions.group")}
					>
						<SelectNative
							id={`${idBase}-group`}
							value={value.type}
							onChange={(e) =>
								onChange({
									...value,
									type: e.target.value === "AND" ? "AND" : "OR",
								})
							}
						>
							<option value="AND">{t("streamConditions.all")}</option>
							<option value="OR">{t("streamConditions.any")}</option>
						</SelectNative>
					</Field>
					{value.conditions.map((c, index) => (
						<ConditionNode
							key={index}
							idBase={`${idBase}-${index}`}
							media={media}
							live={live}
							value={c}
							depth={depth + 1}
							count={count}
							onChange={(next) => {
								const children = value.conditions.flatMap((old, n) =>
									n !== index ? [old] : next ? [next] : [],
								);
								onChange(
									children.length
										? { ...value, conditions: children }
										: undefined,
								);
							}}
						/>
					))}
					<Button
						{...btn}
						disabled={
							value.conditions.length >= conditionTreeLimits.children ||
							depth >= conditionTreeLimits.depth ||
							count >= conditionTreeLimits.nodes
						}
						onClick={() =>
							onChange({ ...value, conditions: [...value.conditions, leaf()] })
						}
					>
						{t("streamConditions.add")}
					</Button>
				</>
			) : (
				<div className="grid gap-2 sm:grid-cols-3">
					<Field
						htmlFor={`${idBase}-attr`}
						label={t("streamConditions.attribute")}
					>
						<SelectNative
							id={`${idBase}-attr`}
							value={value.attribute}
							onChange={(e) => {
								const attr = attributes.find((a) => a.key === e.target.value);
								if (!attr) return;
								const ops = allowedStreamOperators(attr.format);
								const format = attributes.find(
									(a) => a.key === value.attribute,
								)?.format;
								const initial =
									attr.format === "boolean"
										? "true"
										: attr.key === "LANGUAGE"
											? "und"
											: attr.key === "CHANNELLAYOUT"
												? "stereo"
												: "0";
								onChange({
									attribute: attr.key,
									operator: ops.includes(value.operator)
										? value.operator
										: "EQUAL",
									value: format === attr.format ? value.value : initial,
								});
							}}
						>
							{!attributes.some((a) => a.key === value.attribute) && (
								<option value={value.attribute}>{value.attribute}</option>
							)}
							{attributes.map((a) => (
								<option key={a.key} value={a.key}>
									{t(`streamConditions.attributes.${a.key}` as const)}
								</option>
							))}
						</SelectNative>
					</Field>
					<Field
						htmlFor={`${idBase}-op`}
						label={t("streamConditions.comparison")}
					>
						<SelectNative
							id={`${idBase}-op`}
							value={value.operator}
							onChange={(e) =>
								onChange({
									...value,
									operator: e.target.value as StreamConditionLeaf["operator"],
								})
							}
						>
							{[
								...new Set([
									...allowedStreamOperators(
										attributes.find((a) => a.key === value.attribute)?.format,
									),
									value.operator,
								]),
							].map((op) => (
								<option key={op} value={op}>
									{signs[op]}
								</option>
							))}
						</SelectNative>
					</Field>
					<Field
						htmlFor={`${idBase}-value`}
						label={t("streamConditions.value")}
					>
						{attributes.find((a) => a.key === value.attribute)?.format ===
							"boolean" && ["true", "false"].includes(value.value) ? (
							<SelectNative
								id={`${idBase}-value`}
								value={value.value}
								onChange={(e) => onChange({ ...value, value: e.target.value })}
							>
								<option value="true">{t("streamConditions.yes")}</option>
								<option value="false">{t("streamConditions.no")}</option>
							</SelectNative>
						) : (
							<Input
								id={`${idBase}-value`}
								value={value.value}
								onChange={(e) => onChange({ ...value, value: e.target.value })}
							/>
						)}
					</Field>
				</div>
			)}
			<div className="flex flex-wrap gap-2">
				<Button {...btn} disabled={!canWrap} onClick={() => wrap("AND")}>
					{t("streamConditions.and")}
				</Button>
				<Button {...btn} disabled={!canWrap} onClick={() => wrap("OR")}>
					{t("streamConditions.or")}
				</Button>
				<Button {...btn} onClick={() => onChange(undefined)}>
					{t("streamConditions.remove")}
				</Button>
			</div>
		</fieldset>
	);
}
