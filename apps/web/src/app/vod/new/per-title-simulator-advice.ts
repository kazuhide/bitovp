import type {
	PerTitleAdjustment,
	PerTitleGoal,
	PerTitleProposal,
} from "@bitovp/core";
import {
	type PerTitleAdviceField,
	type PerTitleAdviceOptions,
	perTitleAdviceFieldKey,
	perTitleAdviceFields,
	protectedPerTitleAdviceFields,
} from "./per-title-simulator-advice-fields";
import { assessPerTitleReach } from "./per-title-simulator-analysis-reach";
import { jointPerTitleExpansionLayouts } from "./per-title-simulator-joint";
import { assessPerTitleUpperLimit } from "./per-title-simulator-upper-limit";

export {
	type PerTitleAdviceField,
	type PerTitleAdviceOptions,
	perTitleAdviceFieldKey,
} from "./per-title-simulator-advice-fields";

import {
	getPerTitleAdjustment,
	getPerTitleGoalSetting,
	getPerTitleSetting,
	type PerTitleSettingScope,
	type PerTitleSettingValue,
	setPerTitleAdjustment,
	setPerTitleSetting,
	tunePerTitleSettings,
} from "./per-title-simulator-tuning";
export type PerTitleAdviceEdit = {
	scope: PerTitleSettingScope | "count";
	key: string;
	rowId?: string;
};
export type PerTitleAdviceChange = {
	scope: PerTitleSettingScope;
	key: string;
	rowId?: string;
	before: PerTitleSettingValue;
	after: PerTitleSettingValue;
	/** Existing automatic policies are fixed only for these explicitly reviewed changes. */
	beforeAdjustment?: PerTitleAdjustment;
	afterAdjustment?: PerTitleAdjustment;
};
export type PerTitleAdvice = {
	id: string;
	reason:
		| "evaluation"
		| "joint-range"
		| "upper-boundary"
		| "lower-boundary"
		| "global-range"
		| "row-range"
		| "spacing";
	changes: PerTitleAdviceChange[];
	goal: PerTitleGoal;
	proposal: PerTitleProposal;
	proof: "model-count" | "conditional-settings";
	facts: Record<string, number>;
	inputFingerprint: string;
	explanation?: { en: string; ja: string };
};

const LOW = "lowComplexityBoundaryForMaxBitrate";
const HIGH = "highComplexityBoundaryForMaxBitrate";
const RULE = "fixedResolutionAndBitrateConfiguration.";
const FORCED = [
	"forcedRenditionAboveHighestFixedRepresentation",
	"forcedRenditionAboveHighestFixedRepresentationFactor",
	"forcedRenditionAboveHighestFixedRepresentationCalculationMode",
].map((key) => RULE + key);
const rate = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isSafeInteger(value) &&
	value > 0 &&
	value <= 2_147_483_647;
const same = (a: unknown, b: unknown) => fingerprint(a) === fingerprint(b);
export function samePerTitleAdviceInput(a: PerTitleGoal, b: PerTitleGoal) {
	try {
		return same(a, b);
	} catch {
		return false;
	}
}
export function samePerTitleAdviceApi(
	a: PerTitleProposal["api"],
	b: PerTitleProposal["api"],
) {
	try {
		return same(a, b);
	} catch {
		return false;
	}
}
type Field = PerTitleAdviceField;
type Variant = {
	reason: PerTitleAdvice["reason"];
	goal: PerTitleGoal;
	allowed: Field[];
	facts: Record<string, number>;
	solver?: boolean;
};
const fieldKey = perTitleAdviceFieldKey;
const settings = perTitleAdviceFields;

// A bounded exact-input token includes unset/non-finite values; it is not authentication.
function fingerprint(value: unknown): string {
	let nodes = 0;
	const seen = new WeakSet<object>();
	const encode = (item: unknown, depth: number): unknown => {
		if (++nodes > 8192 || depth > 16) throw new Error("Advice input limit.");
		if (item === undefined) return ["undefined"];
		if (typeof item === "number")
			return ["number", Object.is(item, -0) ? "-0" : String(item)];
		if (item === null || typeof item === "string" || typeof item === "boolean")
			return item;
		if (typeof item !== "object" || seen.has(item))
			throw new Error("Advice input invalid.");
		seen.add(item);
		const result = Array.isArray(item)
			? ["array", item.map((v) => encode(v, depth + 1))]
			: [
					"object",
					Object.keys(item)
						.sort()
						.map((key) => [
							key,
							encode((item as Record<string, unknown>)[key], depth + 1),
						]),
				];
		seen.delete(item);
		return result;
	};
	const result = JSON.stringify(encode(value, 0));
	if (result.length > 131072) throw new Error("Advice input limit.");
	return result;
}
export function hasAutomaticPerTitleSettings(goal: PerTitleGoal): boolean {
	const scopes = [
		goal.adjustments?.global,
		...Object.values(goal.adjustments?.streams ?? {}),
	];
	return scopes.some((scope) =>
		Object.values(scope ?? {}).some((adjustment) => adjustment.mode === "auto"),
	);
}
function bounded(goal: PerTitleGoal) {
	return (
		(goal.rows?.length ?? 0) + (goal.automaticTemplates?.length ?? 0) <= 64 &&
		(goal.scenarioFractions?.length ?? 0) <= 9
	);
}
function adviceFingerprint(
	goal: PerTitleGoal,
	fields: readonly Field[],
	contextKey?: string,
	referenceGoal?: PerTitleGoal,
) {
	if (
		contextKey !== undefined &&
		(typeof contextKey !== "string" || contextKey.length > 128)
	)
		throw new Error("Invalid advice context.");
	const input = `${fingerprint(goal)}\n${JSON.stringify(fields.map(fieldKey))}${referenceGoal === undefined ? "" : `\nreference:${fingerprint(referenceGoal)}`}`;
	return contextKey === undefined
		? input
		: `${input}\n${JSON.stringify(contextKey)}`;
}
function editedOnly(
	previous: PerTitleGoal,
	current: PerTitleGoal,
	edit: PerTitleAdviceEdit,
): boolean {
	const before = structuredClone(previous);
	const after = structuredClone(current);
	delete before.adjustments;
	delete after.adjustments;
	delete before.settingLocks;
	delete after.settingLocks;
	if (edit.scope === "count") {
		if (!["count", "countPolicy", "countPolicy.count"].includes(edit.key))
			return false;
		before.countPolicy = after.countPolicy;
	} else {
		if (!settings(current).some((f) => fieldKey(f) === fieldKey(edit as Field)))
			return false;
		const value = getPerTitleGoalSetting(
			current,
			edit.scope,
			edit.key,
			edit.rowId,
		);
		const patched = setPerTitleSetting(
			before,
			edit.scope,
			edit.key,
			value,
			edit.rowId,
		);
		delete patched.adjustments;
		if (fingerprint(patched) !== fingerprint(after)) return false;
		return (
			fingerprint(previous) !== fingerprint(current) &&
			!Object.is(
				getPerTitleGoalSetting(previous, edit.scope, edit.key, edit.rowId),
				value,
			)
		);
	}
	return (
		!same(previous.countPolicy, current.countPolicy) &&
		fingerprint(before) === fingerprint(after)
	);
}
function patch(
	goal: PerTitleGoal,
	fields: Field[],
	value: (field: Field) => PerTitleSettingValue,
): PerTitleGoal {
	return fields.reduce(
		(next, f) => setPerTitleSetting(next, f.scope, f.key, value(f), f.rowId),
		goal,
	);
}
function wireWithChanges(
	proposal: PerTitleProposal,
	changes: PerTitleAdviceChange[],
) {
	const api = structuredClone(proposal.api);
	for (const change of changes) {
		let target: Record<string, unknown>;
		let key = change.key;
		if (change.scope === "stream") {
			const stream = api.streams.find((row) => row.rowId === change.rowId);
			if (!stream) throw new Error("Missing advice stream.");
			stream.perTitleSettings ??= {};
			target = stream.perTitleSettings;
		} else if (key.startsWith(RULE)) {
			api.global.fixedResolutionAndBitrateConfiguration ??= {};
			target = api.global.fixedResolutionAndBitrateConfiguration;
			key = key.slice(RULE.length);
		} else target = api.global;
		if (change.after === undefined) delete target[key];
		else target[key] = change.after;
	}
	return api;
}
function noConflict(proposal: PerTitleProposal, goal: PerTitleGoal) {
	return (
		proposal.status !== "conflict" &&
		!proposal.diagnostics.some((d) => d.severity === "conflict") &&
		assessPerTitleUpperLimit(goal, proposal).finding === null
	);
}
function closedCount(goal: PerTitleGoal, proposal: PerTitleProposal) {
	const high = proposal.scenarios.find((s) => s.fraction === 1);
	// Ordinary templates are alternatives for the same placement model. Explicit
	// template metadata must not change the proof used by an implicit template.
	const automaticOnly =
		proposal.api.streams.length > 0 &&
		proposal.api.streams.every(
			(stream) => stream.mode === "PER_TITLE_TEMPLATE",
		);
	return (
		(!goal.automaticTemplates?.length || automaticOnly) &&
		goal.countPolicy.kind !== "unrestricted" &&
		proposal.applicable &&
		proposal.status === "candidate" &&
		proposal.derivation?.targetSatisfied === true &&
		high?.status === "modelled" &&
		!!high.modelCountRange &&
		high.modelCountRange.maximum <= goal.countPolicy.count &&
		(goal.countPolicy.kind !== "exact" ||
			high.modelRungs.length === goal.countPolicy.count)
	);
}

/** Closed interval ladders also need the full explicit analysis-input domain. */
export function hasPerTitleEvaluationCountEvidence(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
): boolean {
	const hasFixedBitrateStreams = proposal.api.streams.some(
		(stream) =>
			stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	);
	return (
		closedCount(goal, proposal) &&
		(!hasFixedBitrateStreams ||
			assessPerTitleReach(goal, proposal).count.status === "model-checked")
	);
}
function sharedLow(
	goal: PerTitleGoal,
):
	| { lower: number; highestFixedMinimum: number; minimumStep: number }
	| undefined {
	if (
		goal.strategy !== "fixed-ranges" ||
		(goal.autoRepresentations !== false &&
			!(
				goal.autoRepresentations === undefined &&
				getPerTitleAdjustment(goal, goal, "global", "autoRepresentations")
					.mode === "fixed"
			)) ||
		!goal.rows?.length
	)
		return undefined;
	const rows = goal.rows;
	const all = [...rows, ...(goal.automaticTemplates ?? [])];
	const basis = all.every((row) => row.width === undefined && rate(row.height))
		? "height"
		: all.every((row) => rate(row.width))
			? "width"
			: null;
	if (!basis) return undefined;
	const max = Math.max(...rows.map((row) => row[basis] as number));
	const top = rows.filter((row) => row[basis] === max);
	if (
		top.length !== 1 ||
		!goal.automaticTemplates?.some((row) => (row[basis] as number) > max) ||
		!rate(top[0]?.minBitrate) ||
		!Number.isFinite(goal.minBitrateStepSize)
	)
		return undefined;
	const low = Math.trunc(
		top[0].minBitrate * (goal.minBitrateStepSize as number),
	);
	return rate(low)
		? {
				lower: low,
				highestFixedMinimum: top[0].minBitrate,
				minimumStep: goal.minBitrateStepSize as number,
			}
		: undefined;
}

/** Dependency advice only: no quality estimates, remote calls, or automatic adoption. */
export function perTitleAdvice(
	previous: PerTitleGoal,
	current: PerTitleGoal,
	edit: PerTitleAdviceEdit,
	options: PerTitleAdviceOptions = {},
): PerTitleAdvice[] {
	try {
		if (
			!bounded(previous) ||
			!bounded(current) ||
			hasAutomaticPerTitleSettings(current)
		)
			return [];
		const protectedFields = protectedPerTitleAdviceFields(current, options);
		const protectedKeys = new Set(protectedFields.map(fieldKey));
		const applied = protectedPerTitleAdviceFields(current, {
			protectedFields: options.appliedFields,
		});
		const appliedKeys = new Set(applied.map(fieldKey));
		// Retain the original driver; only explicit adoptions may accompany it.
		const manual = patch(current, applied, (f) =>
			getPerTitleGoalSetting(previous, f.scope, f.key, f.rowId),
		);
		if (
			!editedOnly(previous, manual, edit) ||
			(edit.scope !== "count" &&
				applied.some((f) => fieldKey(f) === fieldKey(edit as Field)))
		)
			return [];
		const inputFingerprint = adviceFingerprint(
			current,
			protectedFields,
			options.contextKey,
			options.referenceGoal,
		);
		const reference = options.referenceGoal ?? current;
		const baseline = tunePerTitleSettings(current, reference);
		const variants: Variant[] = [];
		let jointVariants: Iterable<Variant> = [];
		const rows =
			current.strategy === "fixed-ranges" ? (current.rows ?? []) : [];
		const curveRows = rows.filter(
			(row) => row.bitrateSelectionMode === "COMPLEXITY_RANGE",
		);
		const field = (key: string, rowId?: string): Field => ({
			scope: rowId === undefined ? "global" : "stream",
			key,
			...(rowId === undefined ? {} : { rowId }),
		});
		const push = (
			reason: Variant["reason"],
			fields: Field[],
			value: (f: Field) => PerTitleSettingValue,
			facts: Record<string, number>,
		) => {
			fields = fields.filter((f) => !protectedKeys.has(fieldKey(f)));
			if (fields.length)
				variants.push({
					reason,
					allowed: fields,
					goal: patch(current, fields, value),
					facts,
				});
		};
		if (
			edit.scope === "global" &&
			edit.key === "maxBitrate" &&
			rate(current.maxBitrate)
		) {
			if (current.maxBitrate > previous.maxBitrate) {
				jointVariants = (function* (): Generator<Variant> {
					for (const layout of jointPerTitleExpansionLayouts(
						previous,
						current,
						protectedKeys,
					)) {
						for (const candidate of layout)
							yield {
								reason: "joint-range",
								goal: candidate.goal,
								allowed: [
									field("minBitrateStepSize"),
									field("maxBitrateStepSize"),
									field(FORCED[1] as string),
									...rows.flatMap((row) =>
										["minBitrate", "maxBitrate", LOW, HIGH].map((key) =>
											field(key, row.id),
										),
									),
								],
								facts: candidate.facts,
							};
					}
				})();
			} else {
				const coupled = curveRows.filter(
					(row) =>
						(row.highComplexityBoundaryForMaxBitrate === previous.maxBitrate ||
							appliedKeys.has(fieldKey(field(HIGH, row.id)))) &&
						previous.rows?.find((old) => old.id === row.id)
							?.highComplexityBoundaryForMaxBitrate === previous.maxBitrate,
				);
				push(
					"upper-boundary",
					coupled.map((row) => field(HIGH, row.id)),
					() => current.maxBitrate,
					{ previousMaximum: previous.maxBitrate, maximum: current.maxBitrate },
				);
			}
		}
		const oldLow = sharedLow(previous),
			newLow = sharedLow(current);
		if (
			oldLow !== undefined &&
			newLow !== undefined &&
			oldLow.lower !== newLow.lower &&
			((edit.scope === "global" && edit.key === "minBitrateStepSize") ||
				(edit.scope === "stream" && edit.key === "minBitrate"))
		) {
			const coupled = curveRows.filter(
				(row) =>
					(row.lowComplexityBoundaryForMaxBitrate === oldLow.lower ||
						appliedKeys.has(fieldKey(field(LOW, row.id)))) &&
					previous.rows?.find((old) => old.id === row.id)
						?.lowComplexityBoundaryForMaxBitrate === oldLow.lower,
			);
			push(
				"lower-boundary",
				coupled.map((row) => field(LOW, row.id)),
				() => newLow.lower,
				{
					previousLower: oldLow.lower,
					...newLow,
				},
			);
		}
		if (
			edit.scope === "stream" &&
			(edit.key === "minBitrate" || edit.key === "maxBitrate")
		) {
			const row = rows.find((row) => row.id === edit.rowId);
			const value = row?.[edit.key];
			if (
				rate(value) &&
				((edit.key === "minBitrate" && value < current.minBitrate) ||
					(edit.key === "maxBitrate" && value > current.maxBitrate))
			)
				push("global-range", [field(edit.key)], () => value, { value });
		}
		if (
			edit.scope === "global" &&
			(edit.key === "minBitrate" || edit.key === "maxBitrate") &&
			rate(current[edit.key])
		) {
			const key = edit.key;
			const value = current[key];
			const peer = key === "minBitrate" ? "maxBitrate" : "minBitrate";
			const outside = rows.filter(
				(row) =>
					rate(row[key]) &&
					(key === "minBitrate"
						? (row[key] as number) < value
						: (row[key] as number) > value),
			);
			if (
				outside.every(
					(row) =>
						rate(row[peer]) &&
						(key === "minBitrate"
							? (row[peer] as number) >= value
							: (row[peer] as number) <= value),
				)
			)
				push(
					"row-range",
					outside.map((row) => field(key, row.id)),
					() => value,
					{ value },
				);
		}
		const rangeEdit =
			(edit.scope === "global" || edit.scope === "stream") &&
			(edit.key === "minBitrate" || edit.key === "maxBitrate");
		const stepEdit =
			edit.scope === "global" && edit.key.endsWith("BitrateStepSize");
		if (edit.scope === "count" || stepEdit || rangeEdit) {
			const keys = !stepEdit
				? ["minBitrateStepSize", "maxBitrateStepSize"]
				: [
						edit.key === "minBitrateStepSize"
							? "maxBitrateStepSize"
							: "minBitrateStepSize",
					];
			if (
				!stepEdit &&
				current.strategy === "fixed-ranges" &&
				!current.automaticTemplates?.length &&
				current.countPolicy.kind === "exact" &&
				current.countPolicy.count > rows.length &&
				current.fixedResolutionAndBitrateConfiguration === undefined
			)
				keys.push(...FORCED);
			const adjustableKeys = keys.filter(
				(key) => !protectedKeys.has(fieldKey(field(key))),
			);
			let trial = current;
			for (const key of adjustableKeys)
				trial = setPerTitleAdjustment(trial, baseline.proposal, "global", key, {
					mode: "auto",
					method: "constraints",
				});
			variants.push({
				reason: "spacing",
				goal: trial,
				allowed: adjustableKeys.map((key) => field(key)),
				facts: {},
				solver: true,
			});
		}
		const result: PerTitleAdvice[] = [];
		const seen = new Set<string>();
		const allFields = settings(current);
		function* candidates() {
			yield* jointVariants;
			yield* variants;
		}
		let attempts = 0;
		// Five endpoint layouts, each with four policies, two H layouts and four precisions.
		for (const variant of candidates()) {
			if (attempts++ >= 164) break;
			const trial = tunePerTitleSettings(variant.goal, reference);
			const allowed = new Set(variant.allowed.map(fieldKey));
			const changes: PerTitleAdviceChange[] = allFields.flatMap((f) => {
				const before = getPerTitleSetting(
						baseline.proposal,
						f.scope,
						f.key,
						f.rowId,
					),
					after = getPerTitleSetting(trial.proposal, f.scope, f.key, f.rowId);
				return Object.is(before, after) ? [] : [{ ...f, before, after }];
			});
			if (
				!changes.length ||
				changes.some(
					(c) =>
						!allowed.has(fieldKey(c)) ||
						protectedKeys.has(fieldKey(c)) ||
						(edit.scope !== "count" && fieldKey(c) === fieldKey(edit as Field)),
				)
			)
				continue;
			if (
				!same(wireWithChanges(baseline.proposal, changes), trial.proposal.api)
			)
				continue;
			const adopted = changes.reduce(
				(goal, change) =>
					setPerTitleSetting(
						goal,
						change.scope,
						change.key,
						change.after,
						change.rowId,
					),
				current,
			);
			if (
				protectedFields.some(
					(f) =>
						!Object.is(
							getPerTitleGoalSetting(current, f.scope, f.key, f.rowId),
							getPerTitleGoalSetting(adopted, f.scope, f.key, f.rowId),
						),
				)
			)
				continue;
			const checked = tunePerTitleSettings(adopted, reference);
			if (
				!same(checked.proposal.api, trial.proposal.api) ||
				!noConflict(checked.proposal, checked.goal)
			)
				continue;
			const proof = closedCount(checked.goal, checked.proposal)
				? "model-count"
				: "conditional-settings";
			if (
				variant.reason === "joint-range" &&
				current.countPolicy.kind !== "unrestricted" &&
				!current.automaticTemplates?.length &&
				proof !== "model-count"
			)
				continue;
			if (variant.solver && edit.scope === "count" && proof !== "model-count")
				continue;
			if (
				variant.solver &&
				rangeEdit &&
				current.countPolicy.kind !== "unrestricted" &&
				(current.automaticTemplates?.length ?? 0) > 0 &&
				proof !== "model-count"
			)
				continue;
			if (
				variant.solver &&
				proof !== "model-count" &&
				!(
					baseline.proposal.diagnostics.some(
						(d) => d.severity === "conflict",
					) && noConflict(checked.proposal, checked.goal)
				)
			)
				continue;
			const key = JSON.stringify(checked.proposal.api);
			if (seen.has(key)) continue;
			seen.add(key);
			result.push({
				id: `${variant.reason}-${result.length}`,
				reason: variant.reason,
				changes,
				goal: adopted,
				proposal: checked.proposal,
				proof,
				facts: variant.facts,
				inputFingerprint,
			});
			// Joint variants are ranked and must pass the count gate before reaching here.
			if (variant.reason === "joint-range") break;
		}
		const ranked = result.sort(
			(a, b) =>
				Number(b.proof === "model-count") - Number(a.proof === "model-count") ||
				Number(b.reason === "joint-range") -
					Number(a.reason === "joint-range") ||
				(a.facts.connectionRisk ?? 0) - (b.facts.connectionRisk ?? 0) ||
				(a.facts.capacity ?? 0) - (b.facts.capacity ?? 0) ||
				(a.facts.boundaryGap ?? 0) - (b.facts.boundaryGap ?? 0) ||
				a.changes.length - b.changes.length ||
				a.id.localeCompare(b.id),
		);
		return ranked.slice(0, ranked[0]?.reason === "joint-range" ? 1 : 3);
	} catch {
		return [];
	}
}

/** Certify a current-input candidate without inventing a prior manual edit. */
export function createPerTitleEvaluationAdvice(
	current: PerTitleGoal,
	candidate: PerTitleGoal,
	options: PerTitleAdviceOptions = {},
	facts: Record<string, number> = {},
): PerTitleAdvice | null {
	try {
		if (
			!bounded(current) ||
			!bounded(candidate) ||
			(options.referenceGoal !== undefined &&
				(!bounded(options.referenceGoal) ||
					options.referenceGoal.codec !== current.codec))
		)
			return null;
		const protectedFields = protectedPerTitleAdviceFields(current, options);
		const held = new Set(protectedFields.map(fieldKey));
		const reference = options.referenceGoal ?? current;
		const baseline = tunePerTitleSettings(current, reference).proposal;
		const trial = tunePerTitleSettings(candidate, reference).proposal;
		const changes = settings(current).flatMap(
			(field): PerTitleAdviceChange[] => {
				const before = getPerTitleSetting(
					baseline,
					field.scope,
					field.key,
					field.rowId,
				);
				const after = getPerTitleSetting(
					trial,
					field.scope,
					field.key,
					field.rowId,
				);
				if (Object.is(before, after)) return [];
				const adjustment = getPerTitleAdjustment(
					current,
					reference,
					field.scope,
					field.key,
					field.rowId,
				);
				return [
					{
						...field,
						before,
						after,
						...(adjustment.mode === "auto"
							? {
									beforeAdjustment: adjustment,
									afterAdjustment: { mode: "fixed" as const },
								}
							: {}),
					},
				];
			},
		);
		if (
			!changes.length ||
			changes.some((field) => held.has(fieldKey(field))) ||
			!same(wireWithChanges(baseline, changes), trial.api)
		)
			return null;
		const adopted = changes.reduce(
			(goal, field) =>
				setPerTitleSetting(
					goal,
					field.scope,
					field.key,
					field.after,
					field.rowId,
				),
			current,
		);
		const resolved = tunePerTitleSettings(adopted, reference);
		const checked = resolved.proposal;
		if (
			!noConflict(checked, resolved.goal) ||
			!same(checked.api, trial.api) ||
			protectedFields.some(
				(field) =>
					!Object.is(
						getPerTitleGoalSetting(
							current,
							field.scope,
							field.key,
							field.rowId,
						),
						getPerTitleGoalSetting(
							adopted,
							field.scope,
							field.key,
							field.rowId,
						),
					),
			)
		)
			return null;
		const proof = hasPerTitleEvaluationCountEvidence(resolved.goal, checked)
			? "model-count"
			: "conditional-settings";
		if (
			current.countPolicy.kind !== "unrestricted" &&
			!current.automaticTemplates?.length &&
			proof !== "model-count"
		)
			return null;
		return {
			id: "evaluation",
			reason: "evaluation",
			changes,
			goal: adopted,
			proposal: checked,
			proof,
			facts,
			inputFingerprint: adviceFingerprint(
				current,
				protectedFields,
				options.contextKey,
				options.referenceGoal,
			),
		};
	} catch {
		return null;
	}
}

/** A stale result is never applied; this does not authorize an encoding job. */
export function applyPerTitleAdvice(
	current: PerTitleGoal,
	advice: PerTitleAdvice,
	options: PerTitleAdviceOptions = {},
): PerTitleGoal | null {
	try {
		const protectedFields = protectedPerTitleAdviceFields(current, options);
		if (
			!bounded(current) ||
			!bounded(advice.goal) ||
			adviceFingerprint(
				current,
				protectedFields,
				options.contextKey,
				options.referenceGoal,
			) !== advice.inputFingerprint ||
			protectedFields.some(
				(f) =>
					!Object.is(
						getPerTitleGoalSetting(current, f.scope, f.key, f.rowId),
						getPerTitleGoalSetting(advice.goal, f.scope, f.key, f.rowId),
					),
			)
		)
			return null;
		const reference = options.referenceGoal ?? current;
		const baseline = tunePerTitleSettings(current, reference).proposal;
		const checked = tunePerTitleSettings(advice.goal, reference);
		if (
			protectedFields.some(
				(field) =>
					!Object.is(
						getPerTitleSetting(baseline, field.scope, field.key, field.rowId),
						getPerTitleSetting(
							checked.proposal,
							field.scope,
							field.key,
							field.rowId,
						),
					) ||
					!same(
						getPerTitleAdjustment(
							current,
							reference,
							field.scope,
							field.key,
							field.rowId,
						),
						getPerTitleAdjustment(
							advice.goal,
							reference,
							field.scope,
							field.key,
							field.rowId,
						),
					),
			)
		)
			return null;
		const changed = new Set(advice.changes.map(fieldKey));
		if (
			advice.changes.some((field) => {
				const before = getPerTitleAdjustment(
					current,
					reference,
					field.scope,
					field.key,
					field.rowId,
				);
				const after = getPerTitleAdjustment(
					advice.goal,
					reference,
					field.scope,
					field.key,
					field.rowId,
				);
				return (
					(before.mode === "auto" ||
						field.beforeAdjustment !== undefined ||
						field.afterAdjustment !== undefined) &&
					(!same(field.beforeAdjustment, before) ||
						!same(field.afterAdjustment, after))
				);
			})
		)
			return null;
		if (
			settings(current).some(
				(field) =>
					!changed.has(fieldKey(field)) &&
					!same(
						getPerTitleAdjustment(
							current,
							reference,
							field.scope,
							field.key,
							field.rowId,
						),
						getPerTitleAdjustment(
							advice.goal,
							reference,
							field.scope,
							field.key,
							field.rowId,
						),
					),
			)
		)
			return null;
		return noConflict(checked.proposal, checked.goal) &&
			same(checked.proposal.api, advice.proposal.api)
			? structuredClone(advice.goal)
			: null;
	} catch {
		return null;
	}
}

/** Patch a simulator draft only. A subset may conflict and carries no bundle proof. */
export function applySelectedPerTitleAdvice(
	current: PerTitleGoal,
	advice: PerTitleAdvice,
	selected: readonly PerTitleAdviceField[],
	options: PerTitleAdviceOptions = {},
): PerTitleGoal | null {
	try {
		const validated = applyPerTitleAdvice(current, advice, options);
		if (!validated) return null;
		const fields = protectedPerTitleAdviceFields(current, {
			protectedFields: selected,
		});
		if (!fields.length) return null;
		const held = new Set(
			protectedPerTitleAdviceFields(current, options).map(fieldKey),
		);
		const reference = options.referenceGoal ?? current;
		const baseline = tunePerTitleSettings(current, reference).proposal;
		const changes: PerTitleAdviceChange[] = [];
		for (const field of fields) {
			if (held.has(fieldKey(field))) return null;
			const offered = advice.changes.filter(
				(change) => fieldKey(change) === fieldKey(field),
			);
			const before = getPerTitleSetting(
				baseline,
				field.scope,
				field.key,
				field.rowId,
			);
			const after = getPerTitleGoalSetting(
				validated,
				field.scope,
				field.key,
				field.rowId,
			);
			if (
				offered.length !== 1 ||
				!Object.is(offered[0]?.before, before) ||
				!Object.is(offered[0]?.after, after) ||
				(getPerTitleAdjustment(
					current,
					reference,
					field.scope,
					field.key,
					field.rowId,
				).mode === "auto" &&
					(!same(
						offered[0]?.beforeAdjustment,
						getPerTitleAdjustment(
							current,
							reference,
							field.scope,
							field.key,
							field.rowId,
						),
					) ||
						!same(offered[0]?.afterAdjustment, { mode: "fixed" }))) ||
				Object.is(before, after)
			)
				return null;
			changes.push({ ...field, before, after });
		}
		const patched = patch(current, fields, (field) =>
			getPerTitleGoalSetting(validated, field.scope, field.key, field.rowId),
		);
		const checked = tunePerTitleSettings(patched, reference);
		return same(wireWithChanges(baseline, changes), checked.proposal.api)
			? structuredClone(patched)
			: null;
	} catch {
		return null;
	}
}
