import { z } from "zod";
import {
	boundedConditionTree,
	conditionTreeLimits,
} from "./bounded-condition-tree";

const leafSchema = z.strictObject({
	attribute: z.string().min(1),
	operator: z.enum([
		"EQUAL",
		"NOT_EQUAL",
		"LESS_THAN",
		"LESS_THAN_OR_EQUAL",
		"GREATER_THAN",
		"GREATER_THAN_OR_EQUAL",
	]),
	value: z.string(),
});

export type StreamConditionLeaf = z.infer<typeof leafSchema>;
export type StreamCondition =
	| StreamConditionLeaf
	| { type: "AND" | "OR"; conditions: StreamCondition[] };

const node: z.ZodType<StreamCondition> = z.lazy(() =>
	z.union([
		leafSchema,
		z.strictObject({
			type: z.enum(["AND", "OR"]),
			conditions: z.array(node).min(1).max(conditionTreeLimits.children),
		}),
	]),
);
export const streamConditionSchema = boundedConditionTree(
	node,
	"Stream conditions",
);

export const audioStreamGuard: StreamConditionLeaf = {
	attribute: "AUDIOSTREAMCOUNT",
	operator: "GREATER_THAN",
	value: "0",
};
export function isAudioStreamGuard(
	value: StreamCondition | undefined,
): boolean {
	return (
		value !== undefined &&
		"attribute" in value &&
		value.attribute === audioStreamGuard.attribute &&
		value.operator === audioStreamGuard.operator &&
		value.value === audioStreamGuard.value
	);
}

export type StreamConditionMedia = "video" | "audio" | "subtitle";
type ValueFormat = "integer" | "decimal" | "fps" | "pid" | "boolean" | "text";
type Attribute = {
	key: string;
	media?: readonly StreamConditionMedia[];
	vodOnly?: boolean;
	format: ValueFormat;
};
export const streamAttributes = [
	{ key: "INPUTSTREAM", format: "boolean" },
	{ key: "STREAMCOUNT", format: "integer" },
	{ key: "VIDEOSTREAMCOUNT", format: "integer" },
	{ key: "AUDIOSTREAMCOUNT", format: "integer" },
	{ key: "DURATION", format: "decimal", vodOnly: true },
	{ key: "WIDTH", media: ["video"], format: "integer" },
	{ key: "HEIGHT", media: ["video"], format: "integer" },
	{
		key: "BITRATE",
		media: ["video", "audio"],
		vodOnly: true,
		format: "integer",
	},
	{ key: "FPS", media: ["video"], format: "fps" },
	{ key: "ASPECTRATIO", media: ["video"], format: "decimal" },
	{ key: "ROTATION", media: ["video"], format: "decimal" },
	{ key: "SAMPLERATE", media: ["audio"], format: "integer" },
	{ key: "LANGUAGE", media: ["audio", "subtitle"], format: "text" },
	{ key: "CHANNELFORMAT", media: ["audio"], format: "integer" },
	{ key: "CHANNELLAYOUT", media: ["audio"], format: "text" },
	{ key: "HEARINGIMPAIRED", media: ["subtitle"], format: "boolean" },
	{ key: "STREAMID", format: "pid" },
] as const satisfies readonly Attribute[];
export type StreamAttributeKey = (typeof streamAttributes)[number]["key"];
export function availableStreamAttributes(
	media: StreamConditionMedia,
	live: boolean,
) {
	return (
		streamAttributes as readonly (Attribute & { key: StreamAttributeKey })[]
	).filter(
		(a) => (!live || !a.vodOnly) && (!a.media || a.media.includes(media)),
	);
}
export const streamConditionOperators = leafSchema.shape.operator.options;
export function allowedStreamOperators(
	format: ValueFormat | undefined,
): readonly StreamConditionLeaf["operator"][] {
	return format === "boolean" ? ["EQUAL"] : streamConditionOperators;
}

export function validStreamValue(value: string, format: ValueFormat) {
	const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
	switch (format) {
		case "boolean":
			return value === "true" || value === "false";
		case "text":
			return value.trim().length > 0;
		case "integer":
			return /^[+-]?\d+$/.test(value) && Number.isSafeInteger(Number(value));
		case "pid":
			return (
				/^(?:0[xX][\da-fA-F]+|\d+)$/.test(value) &&
				Number.isSafeInteger(Number(value))
			);
		case "decimal":
			return number.test(value) && Number.isFinite(Number(value));
		case "fps": {
			if (number.test(value)) return Number.isFinite(Number(value));
			const parts = /^(\d+)\/(\d+)$/.exec(value);
			return (
				!!parts &&
				Number(parts[2]) > 0 &&
				Number.isFinite(Number(parts[1]) / Number(parts[2])) &&
				Number.isFinite(Number(parts[2]))
			);
		}
	}
}
export function guardedAudioCondition(
	condition: StreamCondition | undefined,
): StreamCondition {
	if (!condition) return audioStreamGuard;
	if (
		isAudioStreamGuard(condition) ||
		("conditions" in condition &&
			condition.type === "AND" &&
			condition.conditions.some(isAudioStreamGuard))
	)
		return condition;
	return { type: "AND", conditions: [audioStreamGuard, condition] };
}
