import type { PerTitleGoal } from "@bitovp/core";
import {
	type PerTitleSettingScope,
	perTitleGlobalFields,
	perTitleStreamFields,
} from "./per-title-simulator-tuning";

export type PerTitleAdviceField = {
	scope: PerTitleSettingScope;
	key: string;
	rowId?: string;
};
export type PerTitleAdviceOptions = {
	protectedFields?: readonly PerTitleAdviceField[];
	/** Previously selected changes accompanying the original edit, including released fields. */
	appliedFields?: readonly PerTitleAdviceField[];
};
export const perTitleAdviceFieldKey = (field: PerTitleAdviceField) =>
	JSON.stringify([field.scope, field.rowId, field.key]);

export function perTitleAdviceFields(
	goal: PerTitleGoal,
): PerTitleAdviceField[] {
	return [
		...perTitleGlobalFields(goal.codec).map(({ key }) => ({
			scope: "global" as const,
			key,
		})),
		...[...(goal.rows ?? []), ...(goal.automaticTemplates ?? [])].flatMap(
			(row) =>
				perTitleStreamFields(goal.codec).map(({ key }) => ({
					scope: "stream" as const,
					key,
					rowId: row.id,
				})),
		),
	];
}

/** Pins refer to current input fields, not saved values or API parameters. */
export function protectedPerTitleAdviceFields(
	goal: PerTitleGoal,
	options: PerTitleAdviceOptions,
): PerTitleAdviceField[] {
	const fields =
		options.protectedFields === undefined ? [] : options.protectedFields;
	if (!Array.isArray(fields) || fields.length > 1024)
		throw new Error("Invalid advice protections.");
	const supported = new Map(
		perTitleAdviceFields(goal).map((f) => [perTitleAdviceFieldKey(f), f]),
	);
	const unique = new Map<string, PerTitleAdviceField>();
	for (const field of fields) {
		if (
			!field ||
			typeof field !== "object" ||
			typeof field.key !== "string" ||
			(field.rowId !== undefined && typeof field.rowId !== "string") ||
			Object.keys(field).some((key) => !["scope", "key", "rowId"].includes(key))
		)
			throw new Error("Invalid advice protection.");
		const key = perTitleAdviceFieldKey(field);
		const canonical = supported.get(key);
		if (!canonical) throw new Error("Unknown advice protection.");
		unique.set(key, canonical);
	}
	return [...unique.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, field]) => field);
}
