import type { PerTitleGoal, PerTitleProposal } from "@bitovp/core";
import {
	getPerTitleAdjustment,
	getPerTitleGoalSetting,
	getPerTitleSetting,
	type PerTitleSettingScope,
	type PerTitleSettingValue,
	perTitleGlobalFields,
	perTitleStreamFields,
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
};
export type PerTitleAdvice = {
	id: string;
	reason:
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
type Field = Pick<PerTitleAdviceChange, "scope" | "key" | "rowId">;
type Variant = {
	reason: PerTitleAdvice["reason"];
	goal: PerTitleGoal;
	allowed: Field[];
	facts: Record<string, number>;
	solver?: boolean;
};
const fieldKey = (field: Field) =>
	JSON.stringify([field.scope, field.rowId, field.key]);

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
function settings(goal: PerTitleGoal): Field[] {
	return [
		...perTitleGlobalFields(goal.codec).map((f) => ({
			scope: "global" as const,
			key: f.key,
		})),
		...[...(goal.rows ?? []), ...(goal.automaticTemplates ?? [])].flatMap(
			(row) =>
				perTitleStreamFields(goal.codec).map((f) => ({
					scope: "stream" as const,
					key: f.key,
					rowId: row.id,
				})),
		),
	];
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
function noConflict(proposal: PerTitleProposal) {
	return (
		proposal.status !== "conflict" &&
		!proposal.diagnostics.some((d) => d.severity === "conflict")
	);
}
function closedCount(goal: PerTitleGoal, proposal: PerTitleProposal) {
	const high = proposal.scenarios.find((s) => s.fraction === 1);
	return (
		!goal.automaticTemplates?.length &&
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
): PerTitleAdvice[] {
	try {
		if (
			!bounded(previous) ||
			!bounded(current) ||
			hasAutomaticPerTitleSettings(current) ||
			!editedOnly(previous, current, edit)
		)
			return [];
		const inputFingerprint = fingerprint(current);
		const baseline = tunePerTitleSettings(current, current);
		const variants: Variant[] = [];
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
			const coupled = curveRows.filter(
				(row) =>
					row.highComplexityBoundaryForMaxBitrate === previous.maxBitrate &&
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
					row.lowComplexityBoundaryForMaxBitrate === oldLow.lower &&
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
			let trial = current;
			for (const key of keys)
				trial = setPerTitleAdjustment(trial, baseline.proposal, "global", key, {
					mode: "auto",
					method: "constraints",
				});
			variants.push({
				reason: "spacing",
				goal: trial,
				allowed: keys.map((key) => field(key)),
				facts: {},
				solver: true,
			});
		}
		const result: PerTitleAdvice[] = [];
		const seen = new Set<string>();
		const allFields = settings(current);
		for (const variant of variants.slice(0, 4)) {
			const trial = tunePerTitleSettings(variant.goal, variant.goal);
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
			const checked = tunePerTitleSettings(adopted, adopted);
			if (
				!same(checked.proposal.api, trial.proposal.api) ||
				!noConflict(checked.proposal)
			)
				continue;
			const proof = closedCount(adopted, checked.proposal)
				? "model-count"
				: "conditional-settings";
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
					) && noConflict(checked.proposal)
				)
			)
				continue;
			const key = JSON.stringify(checked.proposal.api);
			if (seen.has(key)) continue;
			seen.add(key);
			result.push({
				id: variant.reason,
				reason: variant.reason,
				changes,
				goal: adopted,
				proposal: checked.proposal,
				proof,
				facts: variant.facts,
				inputFingerprint,
			});
		}
		return result
			.sort(
				(a, b) =>
					a.changes.length - b.changes.length || a.id.localeCompare(b.id),
			)
			.slice(0, 3);
	} catch {
		return [];
	}
}

/** A stale result is never applied; this does not authorize an encoding job. */
export function applyPerTitleAdvice(
	current: PerTitleGoal,
	advice: PerTitleAdvice,
): PerTitleGoal | null {
	try {
		if (
			!bounded(current) ||
			!bounded(advice.goal) ||
			fingerprint(current) !== advice.inputFingerprint
		)
			return null;
		const checked = tunePerTitleSettings(advice.goal, advice.goal);
		return noConflict(checked.proposal) &&
			same(checked.proposal.api, advice.proposal.api)
			? structuredClone(advice.goal)
			: null;
	} catch {
		return null;
	}
}
