import {
	PER_TITLE_MIN_BITRATE,
	PER_TITLE_SIMULATOR_MAX_BITRATE,
	type PerTitleAdjustment,
	type PerTitleAdjustmentMethod,
	type PerTitleCodec,
	type PerTitleGoal,
	type PerTitleProposal,
	recommendPerTitleSettings,
	resolvePerTitleFixedMode,
} from "@bitovp/core";
import { autoTunePerTitleGoal } from "./per-title-simulator-auto";

export type PerTitleSettingScope = "global" | "stream";
export type PerTitleSettingValue = number | string | boolean | undefined;
export type PerTitleSettingField = {
	key: string;
	label: string;
	kind: "bitrate" | "number" | "selection" | "toggle";
	group:
		| "range"
		| "spacing"
		| "analysis"
		| "automatic"
		| "additional"
		| "stream";
	methods: readonly PerTitleAdjustmentMethod[];
	minimum?: number;
	maximum?: number;
	integer?: boolean;
	options?: readonly string[];
};

const RULE = "fixedResolutionAndBitrateConfiguration.";
const COUNT = `${RULE}forcedRenditionAboveHighestFixedRepresentation`;
const FACTOR = `${COUNT}Factor`;
const CALCULATION = `${COUNT}CalculationMode`;
const THRESHOLD = "autoRepresentations.adoptConfigurationThreshold";
const RANGE_METHODS = ["constraints", "proportional", "logarithmic"] as const;
const CONSTRAINT_METHODS = ["constraints", "default"] as const;
const RATE_MAXIMUM = PER_TITLE_SIMULATOR_MAX_BITRATE;
const isContainer = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const rate = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isSafeInteger(value) &&
	value > 0 &&
	value <= RATE_MAXIMUM;

function field(
	key: string,
	kind: PerTitleSettingField["kind"],
	group: PerTitleSettingField["group"],
	methods: readonly PerTitleAdjustmentMethod[] = ["default"],
	options: Partial<PerTitleSettingField> = {},
): PerTitleSettingField {
	return {
		key,
		label: key.slice(key.lastIndexOf(".") + 1),
		kind,
		group,
		methods,
		...options,
	};
}

export function perTitleGlobalFields(
	codec: PerTitleCodec,
): readonly PerTitleSettingField[] {
	return [
		field("minBitrate", "bitrate", "range", ["proportional", "default"], {
			minimum: PER_TITLE_MIN_BITRATE,
			maximum: RATE_MAXIMUM,
			integer: true,
		}),
		field("maxBitrate", "bitrate", "range", ["proportional", "default"], {
			minimum: PER_TITLE_MIN_BITRATE,
			maximum: RATE_MAXIMUM,
			integer: true,
		}),
		field("minBitrateStepSize", "number", "spacing", CONSTRAINT_METHODS, {
			minimum: 1,
		}),
		field("maxBitrateStepSize", "number", "spacing", CONSTRAINT_METHODS, {
			minimum: 1,
		}),
		field(
			codec === "H265V2" ? "targetQualityQp" : "targetQualityCrf",
			"number",
			"analysis",
		),
		field("complexityFactor", "number", "analysis", ["default"], {
			minimum: 0,
		}),
		field("resolutionScaleFactor", "number", "analysis", ["default"], {
			minimum: -15,
			maximum: 15,
		}),
		...(["H264", "H265", "H265V2"].includes(codec)
			? [
					field("codecMinBitrateFactor", "number", "analysis", ["default"], {
						minimum: 0,
					}),
					field("codecMaxBitrateFactor", "number", "analysis", ["default"], {
						minimum: 0,
					}),
					...(codec !== "H265V2"
						? [
								field("codecBufsizeFactor", "number", "analysis", ["default"], {
									minimum: 0,
								}),
							]
						: []),
				]
			: []),
		field("autoRepresentations", "toggle", "automatic", CONSTRAINT_METHODS),
		field(THRESHOLD, "number", "automatic", ["default"], {
			minimum: 0,
			maximum: 1,
		}),
		field(COUNT, "number", "additional", CONSTRAINT_METHODS, {
			minimum: 0,
			maximum: 256,
			integer: true,
		}),
		field(FACTOR, "number", "additional", CONSTRAINT_METHODS, { minimum: 0 }),
		field(CALCULATION, "selection", "additional", CONSTRAINT_METHODS, {
			options: ["LAST_CALCULATED_BITRATE", "MINIMUM", "MAXIMUM", "AVERAGE"],
		}),
	];
}

export function perTitleStreamFields(
	codec: PerTitleCodec,
): readonly PerTitleSettingField[] {
	return [
		field("minBitrate", "bitrate", "stream", RANGE_METHODS, {
			minimum: 1,
			maximum: RATE_MAXIMUM,
			integer: true,
		}),
		field("maxBitrate", "bitrate", "stream", RANGE_METHODS, {
			minimum: 1,
			maximum: RATE_MAXIMUM,
			integer: true,
		}),
		field("bitrateSelectionMode", "selection", "stream", CONSTRAINT_METHODS, {
			options: ["OPTIMIZED", "COMPLEXITY_RANGE"],
		}),
		field(
			"lowComplexityBoundaryForMaxBitrate",
			"bitrate",
			"stream",
			RANGE_METHODS,
			{ minimum: 1, maximum: RATE_MAXIMUM, integer: true },
		),
		field(
			"highComplexityBoundaryForMaxBitrate",
			"bitrate",
			"stream",
			RANGE_METHODS,
			{ minimum: 1, maximum: RATE_MAXIMUM, integer: true },
		),
		...(["H264", "H265"].includes(codec)
			? [
					field("codecMaxBitrateFactor", "number", "stream", ["default"], {
						minimum: 0,
					}),
					field("codecBufsizeFactor", "number", "stream", ["default"], {
						minimum: 0,
					}),
				]
			: []),
	];
}

const fieldsFor = (codec: PerTitleCodec, scope: PerTitleSettingScope) =>
	scope === "global"
		? perTitleGlobalFields(codec)
		: perTitleStreamFields(codec);

export function getPerTitleGoalSetting(
	goal: PerTitleGoal,
	scope: PerTitleSettingScope,
	key: string,
	rowId?: string,
): PerTitleSettingValue {
	if (scope === "stream") {
		const row = [...(goal.rows ?? []), ...(goal.automaticTemplates ?? [])].find(
			(r) => r.id === rowId,
		);
		return row
			? (row as unknown as Record<string, PerTitleSettingValue>)[key]
			: undefined;
	}
	if (key === "autoRepresentations")
		return goal.autoRepresentations === undefined
			? undefined
			: goal.autoRepresentations !== false;
	if (key === THRESHOLD)
		return goal.autoRepresentations
			? goal.autoRepresentations.adoptConfigurationThreshold
			: goal.adjustments?.inactiveAutoRepresentationThreshold;
	if (key.startsWith(RULE))
		return (
			goal.fixedResolutionAndBitrateConfiguration as
				| Record<string, PerTitleSettingValue>
				| undefined
		)?.[key.slice(RULE.length)];
	return (goal as unknown as Record<string, PerTitleSettingValue>)[key];
}

export function getPerTitleSetting(
	proposal: PerTitleProposal,
	scope: PerTitleSettingScope,
	key: string,
	rowId?: string,
): PerTitleSettingValue {
	if (scope === "stream")
		return (
			proposal.api.streams.find((s) => s.rowId === rowId)?.perTitleSettings as
				| Record<string, PerTitleSettingValue>
				| undefined
		)?.[key];
	const global = proposal.api.global;
	if (key === "autoRepresentations")
		return global.autoRepresentations !== undefined;
	if (key === THRESHOLD)
		return global.autoRepresentations?.adoptConfigurationThreshold;
	if (key.startsWith(RULE))
		return (
			global.fixedResolutionAndBitrateConfiguration as
				| Record<string, PerTitleSettingValue>
				| undefined
		)?.[key.slice(RULE.length)];
	return (global as unknown as Record<string, PerTitleSettingValue>)[key];
}

export function getPerTitleAdjustment(
	draft: PerTitleGoal,
	_anchor: PerTitleGoal,
	scope: PerTitleSettingScope,
	key: string,
	rowId?: string,
): PerTitleAdjustment {
	const scoped =
		scope === "global"
			? draft.adjustments?.global
			: Object.hasOwn(draft.adjustments?.streams ?? {}, rowId ?? "")
				? draft.adjustments?.streams?.[rowId ?? ""]
				: undefined;
	const explicit =
		scoped && Object.hasOwn(scoped, key) ? scoped[key] : undefined;
	return explicit ?? { mode: "fixed" };
}

/** Preserve source values; only required, unset fixed steps receive model defaults. */
export function initializePerTitleSettings(goal: PerTitleGoal): PerTitleGoal {
	const next = structuredClone(goal);
	for (const [key, value] of [
		["minBitrateStepSize", 1.5],
		["maxBitrateStepSize", 1.9],
	] as const) {
		if (
			next[key] === undefined &&
			getPerTitleAdjustment(next, next, "global", key).mode === "fixed"
		)
			next[key] = value;
	}
	return next;
}

function putValue(
	goal: PerTitleGoal,
	scope: PerTitleSettingScope,
	key: string,
	value: PerTitleSettingValue,
	rowId?: string,
): PerTitleGoal {
	if (scope === "stream") {
		const patch = <T extends { id: string }>(row: T): T => {
			if (row.id !== rowId) return row;
			const next = { ...row };
			const values = next as Record<string, unknown>;
			if (value === undefined) delete values[key];
			else values[key] = value;
			return next;
		};
		return {
			...goal,
			...(goal.rows === undefined ? {} : { rows: goal.rows.map(patch) }),
			...(goal.automaticTemplates === undefined
				? {}
				: { automaticTemplates: goal.automaticTemplates.map(patch) }),
		};
	}
	if (key === "autoRepresentations") {
		const threshold = goal.autoRepresentations
			? goal.autoRepresentations.adoptConfigurationThreshold
			: goal.adjustments?.inactiveAutoRepresentationThreshold;
		return {
			...goal,
			...(threshold !== undefined
				? {
						adjustments: {
							...goal.adjustments,
							inactiveAutoRepresentationThreshold: threshold,
						},
					}
				: {}),
			autoRepresentations:
				value === undefined
					? undefined
					: value === false
						? false
						: {
								...(threshold !== undefined
									? { adoptConfigurationThreshold: threshold }
									: {}),
								...(goal.autoRepresentations || {}),
							},
		};
	}
	if (key === THRESHOLD) {
		const adjustments = { ...goal.adjustments };
		if (value === undefined)
			delete adjustments.inactiveAutoRepresentationThreshold;
		else adjustments.inactiveAutoRepresentationThreshold = value as number;
		if (goal.autoRepresentations === false) return { ...goal, adjustments };
		if (value === undefined && !goal.autoRepresentations)
			return { ...goal, adjustments };
		const automatic = { ...(goal.autoRepresentations || {}) };
		if (value === undefined) delete automatic.adoptConfigurationThreshold;
		else automatic.adoptConfigurationThreshold = value as number;
		return { ...goal, autoRepresentations: automatic, adjustments };
	}
	if (key.startsWith(RULE)) {
		const rule = { ...goal.fixedResolutionAndBitrateConfiguration } as Record<
			string,
			PerTitleSettingValue
		>;
		if (value === undefined) delete rule[key.slice(RULE.length)];
		else rule[key.slice(RULE.length)] = value;
		return {
			...goal,
			fixedResolutionAndBitrateConfiguration: Object.keys(rule).length
				? rule
				: undefined,
		} as PerTitleGoal;
	}
	const next = { ...goal };
	if (value === undefined)
		delete (next as unknown as Record<string, unknown>)[key];
	else (next as unknown as Record<string, unknown>)[key] = value;
	return next;
}

function materializeStream(
	draft: PerTitleGoal,
	rowId: string,
	proposal?: PerTitleProposal,
): PerTitleGoal {
	if (
		[...(draft.rows ?? []), ...(draft.automaticTemplates ?? [])].some(
			(r) => r.id === rowId,
		)
	)
		return draft;
	const template = (
		proposal ?? recommendPerTitleSettings(draft)
	).api.streams.find(
		(s) => s.rowId === rowId && s.mode === "PER_TITLE_TEMPLATE",
	);
	if (!template) return draft;
	return {
		...draft,
		automaticTemplates: [
			...(draft.automaticTemplates ?? []),
			{ id: rowId, height: template.height, width: template.width },
		],
	};
}

function putAdjustment(
	draft: PerTitleGoal,
	scope: PerTitleSettingScope,
	key: string,
	adjustment: PerTitleAdjustment,
	rowId?: string,
): PerTitleGoal {
	const old = draft.adjustments;
	return {
		...draft,
		adjustments:
			scope === "global"
				? { ...old, global: { ...old?.global, [key]: adjustment } }
				: {
						...old,
						streams: {
							...old?.streams,
							[rowId ?? ""]: {
								...old?.streams?.[rowId ?? ""],
								[key]: adjustment,
							},
						},
					},
	};
}

export function setPerTitleSetting(
	draft: PerTitleGoal,
	scope: PerTitleSettingScope,
	key: string,
	value: PerTitleSettingValue,
	rowId?: string,
): PerTitleGoal {
	if (!fieldsFor(draft.codec, scope).some((f) => f.key === key))
		throw new Error("Unsupported Per-Title setting.");
	const next =
		scope === "stream" && rowId ? materializeStream(draft, rowId) : draft;
	return putAdjustment(
		putValue(next, scope, key, value, rowId),
		scope,
		key,
		{ mode: "fixed" },
		rowId,
	);
}

export function setPerTitleAdjustment(
	draft: PerTitleGoal,
	proposal: PerTitleProposal,
	scope: PerTitleSettingScope,
	key: string,
	adjustment: PerTitleAdjustment,
	rowId?: string,
): PerTitleGoal {
	const descriptor = fieldsFor(draft.codec, scope).find((f) => f.key === key);
	if (
		!descriptor ||
		(adjustment.mode === "auto" &&
			!descriptor.methods.includes(adjustment.method))
	)
		throw new Error("Unsupported Per-Title adjustment.");
	let next =
		scope === "stream" && rowId
			? materializeStream(draft, rowId, proposal)
			: draft;
	if (adjustment.mode === "fixed") {
		let value = getPerTitleSetting(proposal, scope, key, rowId);
		const previous = getPerTitleAdjustment(draft, draft, scope, key, rowId);
		// Inactive fixed settings are parked in the input; an automatic provider
		// default must instead remain unset when the operator freezes it.
		if (value === undefined && previous.mode === "fixed")
			value = getPerTitleGoalSetting(draft, scope, key, rowId);
		next = putValue(next, scope, key, value, rowId);
	}
	return putAdjustment(next, scope, key, adjustment, rowId);
}

function validGlobal(goal: PerTitleGoal) {
	return (
		rate(goal.minBitrate) &&
		rate(goal.maxBitrate) &&
		goal.minBitrate >= PER_TITLE_MIN_BITRATE &&
		goal.minBitrate <= goal.maxBitrate
	);
}

function mapReference(
	value: PerTitleSettingValue,
	method: PerTitleAdjustmentMethod,
	goal: PerTitleGoal,
	anchor: PerTitleGoal,
): number | undefined {
	if (!rate(value) || !validGlobal(goal) || !validGlobal(anchor))
		return undefined;
	if (method === "proportional")
		return Math.round((value * goal.maxBitrate) / anchor.maxBitrate);
	const span = Math.log(anchor.maxBitrate / anchor.minBitrate);
	if (span === 0)
		return goal.minBitrate === anchor.minBitrate &&
			goal.maxBitrate === anchor.maxBitrate
			? value
			: undefined;
	return Math.round(
		Math.exp(
			Math.log(goal.minBitrate) +
				(Math.log(value / anchor.minBitrate) / span) *
					Math.log(goal.maxBitrate / goal.minBitrate),
		),
	);
}

function invalidAdjustments(goal: PerTitleGoal): string[] {
	const metadata: unknown = goal.adjustments;
	if (metadata === undefined) return [];
	const record = (value: unknown): value is Record<string, unknown> =>
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null);
	if (!record(metadata)) return ["adjustments"];
	const invalid: string[] = [];
	for (const key of Object.keys(metadata)) {
		if (
			!["global", "streams", "inactiveAutoRepresentationThreshold"].includes(
				key,
			)
		)
			invalid.push(key);
	}
	const parked = metadata.inactiveAutoRepresentationThreshold;
	if (
		parked !== undefined &&
		(typeof parked !== "number" ||
			!Number.isFinite(parked) ||
			parked < 0 ||
			parked > 1)
	)
		invalid.push(THRESHOLD);
	const checkFields = (settings: unknown, scope: PerTitleSettingScope) => {
		if (!record(settings)) {
			invalid.push(scope);
			return;
		}
		for (const [key, adjustment] of Object.entries(settings)) {
			const descriptor = fieldsFor(goal.codec, scope).find(
				(item) => item.key === key,
			);
			if (
				!descriptor ||
				!record(adjustment) ||
				(adjustment.mode === "fixed"
					? Object.keys(adjustment).some((name) => name !== "mode")
					: adjustment.mode !== "auto" ||
						!descriptor.methods.some(
							(method) => method === adjustment.method,
						) ||
						Object.keys(adjustment).some(
							(name) => name !== "mode" && name !== "method",
						))
			)
				invalid.push(key);
		}
	};
	if (metadata.global !== undefined) checkFields(metadata.global, "global");
	if (metadata.streams !== undefined) {
		if (!record(metadata.streams)) invalid.push("streams");
		else {
			const ids = new Set(
				[...(goal.rows ?? []), ...(goal.automaticTemplates ?? [])].map(
					(row) => row.id,
				),
			);
			for (const [id, settings] of Object.entries(metadata.streams)) {
				if (!ids.has(id)) invalid.push(id);
				checkFields(settings, "stream");
			}
		}
	}
	return invalid;
}

function rejectAdjustments(proposal: PerTitleProposal, invalid: string[]) {
	proposal.status = "conflict";
	proposal.applicable = false;
	delete proposal.derivation;
	proposal.scenarios = [];
	proposal.diagnostics.push({
		code: "invalid-setting",
		severity: "conflict",
		message: "Choose an adjustment method supported by each Per-Title field.",
		values: { fields: invalid.join(", ") },
	});
}

/** Resolve field policies before the solver, so every proof uses the final inputs. */
export function tunePerTitleSettings(
	input: PerTitleGoal,
	anchor: PerTitleGoal,
): { goal: PerTitleGoal; proposal: PerTitleProposal } {
	const draft = initializePerTitleSettings(input);
	let next = structuredClone(draft);
	delete next.settingLocks;
	const malformed = invalidAdjustments(draft);
	if (malformed.length) {
		const proposal = recommendPerTitleSettings(next);
		rejectAdjustments(proposal, malformed);
		return { goal: next, proposal };
	}
	const locks: { global: string[]; streams: Record<string, string[]> } = {
		global: [],
		streams: Object.create(null),
	};
	const invalid: string[] = [];
	const modeFor = (
		scope: PerTitleSettingScope,
		descriptor: PerTitleSettingField,
		rowId?: string,
	): PerTitleAdjustment => {
		const adjustment = getPerTitleAdjustment(
			draft,
			anchor,
			scope,
			descriptor.key,
			rowId,
		);
		if (
			(adjustment.mode !== "fixed" && adjustment.mode !== "auto") ||
			(adjustment.mode === "auto" &&
				!descriptor.methods.includes(adjustment.method))
		) {
			invalid.push(descriptor.key);
			return { mode: "fixed" };
		}
		return adjustment;
	};
	const lock = (scope: PerTitleSettingScope, key: string, rowId?: string) => {
		if (scope === "global") locks.global.push(key);
		else {
			const id = rowId ?? "";
			locks.streams[id] ??= [];
			locks.streams[id].push(key);
		}
	};
	const globalFields = perTitleGlobalFields(draft.codec);
	const automaticContainer = draft.autoRepresentations;
	const invalidFixedAutomaticContainer =
		getPerTitleAdjustment(draft, anchor, "global", "autoRepresentations")
			.mode === "fixed" &&
		automaticContainer !== undefined &&
		automaticContainer !== false &&
		!isContainer(automaticContainer);
	const forcedContainer = draft.fixedResolutionAndBitrateConfiguration;
	const invalidForcedContainer =
		forcedContainer !== undefined && !isContainer(forcedContainer);
	const minMode = getPerTitleAdjustment(draft, anchor, "global", "minBitrate");
	const maxMode = getPerTitleAdjustment(draft, anchor, "global", "maxBitrate");
	// Only a fixed peer drives an automatic bound. With two automatic bounds,
	// the loaded pair is the reference, independent of stale draft values.
	for (const key of ["minBitrate", "maxBitrate"] as const) {
		const mode = key === "minBitrate" ? minMode : maxMode;
		const peer = key === "minBitrate" ? maxMode : minMode;
		if (mode.mode !== "auto") continue;
		let value = anchor[key];
		if (
			mode.method === "proportional" &&
			peer.mode === "fixed" &&
			validGlobal(anchor)
		) {
			value =
				key === "minBitrate"
					? Math.round(
							(anchor.minBitrate * draft.maxBitrate) / anchor.maxBitrate,
						)
					: Math.round(
							(anchor.maxBitrate * draft.minBitrate) / anchor.minBitrate,
						);
		}
		next = putValue(next, "global", key, value);
	}
	for (const descriptor of globalFields) {
		const { key } = descriptor;
		const mode = modeFor("global", descriptor);
		// A child policy must not repair a malformed container held by its parent.
		if (
			(key === THRESHOLD && invalidFixedAutomaticContainer) ||
			(key.startsWith(RULE) && invalidForcedContainer)
		) {
			lock("global", key);
			continue;
		}
		if (mode.mode === "fixed") {
			if (key === THRESHOLD) {
				const hasAutomaticOutput =
					!["fixed-ranges", "fixed-resolutions"].includes(next.strategy) ||
					(next.automaticTemplates?.length ?? 0) > 0;
				const enabled =
					next.autoRepresentations !== false &&
					(next.autoRepresentations !== undefined ||
						(!locks.global.includes("autoRepresentations") &&
							hasAutomaticOutput));
				if (enabled)
					next = putValue(
						next,
						"global",
						THRESHOLD,
						getPerTitleGoalSetting(draft, "global", THRESHOLD),
					);
			}
			lock("global", key);
			continue;
		}
		if (key === "minBitrate" || key === "maxBitrate") {
			lock("global", key);
			continue;
		}
		if (mode.method === "constraints") {
			next = putValue(next, "global", key, undefined);
		} else {
			let value: PerTitleSettingValue;
			if (key === "minBitrateStepSize") value = 1.5;
			else if (key === "maxBitrateStepSize") value = 1.9;
			else if (key === "autoRepresentations") value = false;
			next = putValue(next, "global", key, value);
			lock("global", key);
		}
	}
	const manual: Record<string, { min?: boolean; max?: boolean }> =
		Object.create(null);
	for (const row of next.rows ?? []) {
		manual[row.id] = {
			min:
				getPerTitleAdjustment(draft, anchor, "stream", "minBitrate", row.id)
					.mode === "fixed",
			max:
				getPerTitleAdjustment(draft, anchor, "stream", "maxBitrate", row.id)
					.mode === "fixed",
		};
	}
	const logarithmic = autoTunePerTitleGoal(next, anchor, manual);
	const equalBands = autoTunePerTitleGoal(
		next,
		{ ...anchor, rows: [] },
		manual,
	);
	const streamFields = perTitleStreamFields(draft.codec);
	const deferred: Array<{
		key: string;
		rowId: string;
		method: PerTitleAdjustmentMethod;
	}> = [];
	for (const row of [
		...(next.rows ?? []),
		...(next.automaticTemplates ?? []),
	]) {
		const automatic =
			next.automaticTemplates?.some((r) => r.id === row.id) === true;
		const fixedMode = automatic
			? undefined
			: resolvePerTitleFixedMode(next, row);
		const resolutionOnly = fixedMode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION";
		for (const descriptor of streamFields) {
			const { key } = descriptor;
			const mode = modeFor("stream", descriptor, row.id);
			if (
				resolutionOnly &&
				[
					"minBitrate",
					"maxBitrate",
					"bitrateSelectionMode",
					"lowComplexityBoundaryForMaxBitrate",
					"highComplexityBoundaryForMaxBitrate",
				].includes(key)
			) {
				lock("stream", key, row.id);
				continue;
			}
			if (mode.mode === "fixed") {
				lock("stream", key, row.id);
				continue;
			}
			const bound = key === "minBitrate" || key === "maxBitrate";
			if (
				bound &&
				fixedMode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE"
			) {
				const source = (
					mode.method === "constraints" ? equalBands : logarithmic
				).rows?.find((r) => r.id === row.id);
				let value = source?.[key];
				if (mode.method === "proportional")
					value =
						mapReference(
							getPerTitleGoalSetting(anchor, "stream", key, row.id),
							mode.method,
							next,
							anchor,
						) ?? value;
				next = putValue(next, "stream", key, value, row.id);
				lock("stream", key, row.id);
			} else if (mode.method === "constraints") {
				next = putValue(next, "stream", key, undefined, row.id);
			} else if (mode.method === "default") {
				next = putValue(next, "stream", key, undefined, row.id);
				lock("stream", key, row.id);
			} else {
				const value = mapReference(
					getPerTitleGoalSetting(anchor, "stream", key, row.id),
					mode.method,
					next,
					anchor,
				);
				if (value !== undefined) {
					next = putValue(next, "stream", key, value, row.id);
					lock("stream", key, row.id);
				} else {
					next = putValue(next, "stream", key, undefined, row.id);
					deferred.push({ key, rowId: row.id, method: mode.method });
				}
			}
		}
	}
	if (deferred.length) {
		const original = recommendPerTitleSettings(
			autoTunePerTitleGoal(anchor, anchor, {}),
		);
		for (const item of deferred) {
			const value = mapReference(
				getPerTitleSetting(original, "stream", item.key, item.rowId),
				item.method,
				next,
				anchor,
			);
			if (value !== undefined) {
				next = putValue(next, "stream", item.key, value, item.rowId);
				lock("stream", item.key, item.rowId);
			}
		}
	}
	next.settingLocks = locks;
	const proposal = recommendPerTitleSettings(next);
	proposal.managedGlobalSettings = globalFields.map(
		(descriptor) => descriptor.key,
	);
	if (invalid.length) rejectAdjustments(proposal, invalid);
	return { goal: next, proposal };
}
