import type {
	ExpectedArtefacts,
	ExpectedDrm,
	ExpectedMuxing,
	PerTitleActualDeliveryMuxing,
	PerTitleActualOutputLeg,
	PerTitleActualPopulations,
} from "@bitovp/core";
import { matchOneToOne } from "./one-to-one";

export type PerTitleDeliveryIssue = {
	code:
		| "delivery-leg-id-duplicate"
		| "delivery-path-duplicate"
		| "delivery-path-mismatch"
		| "fixed-result-missing"
		| "muxing-attribution-mismatch"
		| "provider-output-id-reused"
		| "provider-output-unverified"
		| "required-muxing-missing"
		| "required-output-leg-missing"
		| "result-stream-reused"
		| "result-template-unknown"
		| "result-unattributed"
		| "template-mode-conflict"
		| "unexpected-muxing"
		| "unexpected-output-leg";
	verdict: "FAIL" | "SKIP";
	detail: string;
};

export type PerTitleDeliveryBinding = {
	/** Required run-unique identity: template + provider RESULT + material leg. */
	id: string;
	templateRendition: string;
	expectedMuxing: ExpectedMuxing;
	expectedDrm?: ExpectedDrm;
	actual: PerTitleActualOutputLeg;
	/** Symbolic plan output key resolved from the provider output id. */
	outputKey: string;
};

export type PerTitleDeliveryBindingResult =
	| { status: "unverified"; reason: string }
	| {
			status: "complete";
			templates: Array<{
				templateRendition: string;
				mode: "FIXED" | "TEMPLATE";
				outcome: "generated" | "notGenerated" | "missing" | "unverified";
			}>;
			bindings: PerTitleDeliveryBinding[];
			issues: PerTitleDeliveryIssue[];
			/** Every eligible provider material leg; closure requires exact equality below. */
			eligibleLegIds: string[];
			/** Every material leg the engine is allowed to inspect. */
			checkedLegIds: string[];
			/** Leg identities selected by more than one binding; must remain empty. */
			reusedLegIds: string[];
	  };

type RequiredLeg = {
	key: string;
	outputKey: string;
	providerOutputId?: string;
	dirPattern: string;
	expectedDrm?: ExpectedDrm;
};

function normalizeDir(path: string): string {
	return path.endsWith("/") ? path : `${path}/`;
}

function directoryPatternMatches(pattern: string, resolved: string): boolean {
	const normalized = normalizeDir(pattern);
	const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const withHoles = escaped
		.replace(/%[a-zA-Z]+%/g, "[^/]+")
		.replace(/\\\{[a-zA-Z]+\\\}/g, "[^/]+");
	return new RegExp(`^${withHoles}$`).test(normalizeDir(resolved));
}

function providerMuxingTypes(expected: ExpectedMuxing): string[] {
	if (expected.muxingKind === "CMAF") return ["CMAF"];
	switch (expected.container) {
		case "FMP4_SEGMENTED":
			return ["FMP4"];
		case "TS_SEGMENTED":
			return ["TS"];
		case "WEBM_SEGMENTED":
			return ["WEBM"];
		case "TEXT_SINGLE":
		case "TEXT_SEGMENTED":
			return ["WEBVTT", "TEXT"];
		case "MP4_PROGRESSIVE":
		case "MP4_FRAGMENTED":
			return ["MP4"];
	}
}

function muxingCompatible(
	expected: ExpectedMuxing,
	actual: PerTitleActualDeliveryMuxing,
): boolean {
	return (
		providerMuxingTypes(expected).includes(actual.muxingType.toUpperCase()) &&
		(expected.filename === undefined || expected.filename === actual.filename)
	);
}

function legId(
	templateRendition: string,
	leg: PerTitleActualOutputLeg,
): string {
	return `${templateRendition}:${leg.streamId}:${leg.muxingId}:${leg.drmId ?? "clear"}:${leg.outputId}`;
}

function actualLegKey(leg: PerTitleActualOutputLeg): string {
	return [
		leg.streamId,
		leg.muxingId,
		leg.drmId ?? "clear",
		leg.outputId,
		leg.resolvedPath,
		leg.filename ?? "",
	].join("\0");
}

function drmMatches(
	required: RequiredLeg,
	actual: PerTitleActualOutputLeg,
): boolean {
	return required.expectedDrm
		? actual.drmId !== undefined &&
				actual.drmType?.toUpperCase() ===
					required.expectedDrm.kind.toUpperCase()
		: actual.drmId === undefined;
}

function requiredLegs(
	expected: ExpectedArtefacts,
	muxing: ExpectedMuxing,
	providerOutputIds: Readonly<Record<string, string>>,
): RequiredLeg[] {
	const mirrors = expected.deliveryMirrorOutputKeys ?? [];
	const routes: Array<{
		key: string;
		outputKey: string;
		dirPattern: string;
		expectedDrm?: ExpectedDrm;
	}> = [];
	if (muxing.outputKey !== "") {
		routes.push({
			key: "clear",
			outputKey: muxing.outputKey,
			dirPattern: muxing.dir.pattern,
		});
		for (const outputKey of mirrors) {
			routes.push({
				key: "clear",
				outputKey,
				dirPattern: muxing.dir.pattern,
			});
		}
	}
	for (const drm of expected.drm.filter((row) =>
		row.muxingKeys.includes(muxing.muxingKey),
	)) {
		if (!drm.outputKey || !drm.dir) {
			continue;
		}
		routes.push({
			key: drm.drmKey,
			outputKey: drm.outputKey,
			dirPattern: drm.dir.pattern,
			expectedDrm: drm,
		});
		for (const outputKey of mirrors) {
			routes.push({
				key: drm.drmKey,
				outputKey,
				dirPattern: drm.dir.pattern,
				expectedDrm: drm,
			});
		}
	}
	return routes.map((route) => ({
		...route,
		key: `${muxing.muxingKey}:${route.key}:${route.outputKey}`,
		...(providerOutputIds[route.outputKey]
			? { providerOutputId: providerOutputIds[route.outputKey] }
			: {}),
	}));
}

function muxingCost(
	expected: ExpectedArtefacts,
	muxing: ExpectedMuxing,
	actual: PerTitleActualDeliveryMuxing,
	providerOutputIds: Readonly<Record<string, string>>,
): number {
	const required = requiredLegs(expected, muxing, providerOutputIds);
	const result = matchOneToOne({
		expected: required,
		observed: actual.legs,
		expectedKey: (leg) => leg.key,
		observedKey: actualLegKey,
		compatible: (want, got) =>
			want.providerOutputId !== undefined &&
			want.providerOutputId === got.outputId &&
			drmMatches(want, got),
		cost: (want, got) =>
			directoryPatternMatches(want.dirPattern, got.resolvedPath) ? 0 : 1,
	});
	return (
		result.unmatchedExpected.length * 10 +
		result.unmatchedObserved.length * 10 +
		result.pairs.reduce((sum, pair) => sum + pair.cost, 0)
	);
}

/**
 * Bind the provider's actual RESULT muxings and output legs to plan constraints.
 *
 * The provider population is enumerated once. Templates constrain attribution
 * and material topology; they never trigger their own shared-prefix scan.
 */
export function bindPerTitleDelivery(
	expected: ExpectedArtefacts,
	population: PerTitleActualPopulations,
	providerOutputIds: Readonly<Record<string, string>>,
): PerTitleDeliveryBindingResult {
	if (population.status !== "complete") {
		return { status: "unverified", reason: population.reason };
	}

	const issues: PerTitleDeliveryIssue[] = [];
	const addIssue = (
		code: PerTitleDeliveryIssue["code"],
		verdict: PerTitleDeliveryIssue["verdict"],
		detail: string,
	) => issues.push({ code, verdict, detail });
	const perTitleMuxings = expected.muxings.filter((muxing) => muxing.perTitle);
	const templateMuxings = new Map<string, ExpectedMuxing[]>();
	for (const muxing of perTitleMuxings) {
		templateMuxings.set(muxing.renditionKey, [
			...(templateMuxings.get(muxing.renditionKey) ?? []),
			muxing,
		]);
	}

	const outputKeysByProviderId = new Map<string, string[]>();
	for (const [outputKey, providerId] of Object.entries(providerOutputIds)) {
		outputKeysByProviderId.set(providerId, [
			...(outputKeysByProviderId.get(providerId) ?? []),
			outputKey,
		]);
	}
	for (const [providerId, outputKeys] of outputKeysByProviderId) {
		if (outputKeys.length > 1) {
			addIssue(
				"provider-output-id-reused",
				"FAIL",
				`provider output ${providerId} is mapped to multiple plan outputs: ${outputKeys.sort().join(", ")}`,
			);
		}
	}

	const resultRowsByStream = new Map<
		string,
		Array<{ streamId: string; templateRendition?: string }>
	>();
	for (const row of population.results) {
		resultRowsByStream.set(row.streamId, [
			...(resultRowsByStream.get(row.streamId) ?? []),
			row,
		]);
	}
	const reusedStreams = new Set(
		[...resultRowsByStream].flatMap(([streamId, rows]) =>
			rows.length > 1 ? [streamId] : [],
		),
	);
	for (const streamId of [...reusedStreams].sort()) {
		const templates = (resultRowsByStream.get(streamId) ?? [])
			.map((row) => row.templateRendition ?? "unattributed")
			.join(", ");
		addIssue(
			"result-stream-reused",
			"FAIL",
			`provider RESULT ${streamId} appears ${resultRowsByStream.get(streamId)?.length ?? 0} times (${templates}); one rung cannot satisfy two templates`,
		);
	}

	const validResults = population.results.filter(
		(row) => !reusedStreams.has(row.streamId),
	);
	for (const row of validResults) {
		if (row.templateRendition === undefined) {
			addIssue(
				"result-unattributed",
				"FAIL",
				`provider RESULT ${row.streamId} is not attributed to a plan template`,
			);
		} else if (!templateMuxings.has(row.templateRendition)) {
			addIssue(
				"result-template-unknown",
				"FAIL",
				`provider RESULT ${row.streamId} is attributed to unknown template ${row.templateRendition}`,
			);
		}
	}

	const generatedByTemplate = new Map<string, number>();
	for (const row of validResults) {
		if (row.templateRendition && templateMuxings.has(row.templateRendition)) {
			generatedByTemplate.set(
				row.templateRendition,
				(generatedByTemplate.get(row.templateRendition) ?? 0) + 1,
			);
		}
	}
	const hasUnattributedResult = validResults.some(
		(row) => row.templateRendition === undefined,
	);
	const templates = [...templateMuxings]
		.map(([templateRendition, muxings]) => {
			const modes = new Set(
				muxings.map((muxing) => muxing.perTitleMode ?? "TEMPLATE"),
			);
			if (modes.size !== 1) {
				addIssue(
					"template-mode-conflict",
					"FAIL",
					`template ${templateRendition} has inconsistent per-title modes across its muxings: ${[...modes].join(", ")}`,
				);
			}
			const mode = modes.has("FIXED")
				? ("FIXED" as const)
				: ("TEMPLATE" as const);
			const generated = generatedByTemplate.get(templateRendition) ?? 0;
			const outcome =
				generated > 0
					? ("generated" as const)
					: mode === "FIXED"
						? ("missing" as const)
						: hasUnattributedResult
							? ("unverified" as const)
							: ("notGenerated" as const);
			if (outcome === "missing") {
				addIssue(
					"fixed-result-missing",
					"FAIL",
					`fixed per-title template ${templateRendition} has no attributed provider RESULT`,
				);
			}
			return { templateRendition, mode, outcome };
		})
		.sort((a, b) => a.templateRendition.localeCompare(b.templateRendition));

	const allLegs = population.deliveryMuxings.flatMap((muxing) => muxing.legs);
	const duplicatePaths = new Map<string, PerTitleActualOutputLeg[]>();
	for (const actual of allLegs) {
		const key = `${actual.outputId}\0${normalizeDir(actual.resolvedPath)}\0${actual.filename ?? ""}`;
		duplicatePaths.set(key, [...(duplicatePaths.get(key) ?? []), actual]);
	}
	for (const [key, rows] of duplicatePaths) {
		if (rows.length > 1) {
			const [outputId, path] = key.split("\0");
			addIssue(
				"delivery-path-duplicate",
				"FAIL",
				`${rows.length} material legs resolve to the same provider output/path ${outputId}:${path}`,
			);
		}
	}

	const bindings: PerTitleDeliveryBinding[] = [];
	const eligibleLegIds: string[] = [];
	for (const result of validResults) {
		const template = result.templateRendition;
		if (!template || !templateMuxings.has(template)) {
			continue;
		}
		const actualMuxings = population.deliveryMuxings.filter(
			(muxing) => muxing.streamId === result.streamId,
		);
		for (const actualMuxing of actualMuxings) {
			if (
				actualMuxing.templateRendition !== undefined &&
				actualMuxing.templateRendition !== template
			) {
				addIssue(
					"muxing-attribution-mismatch",
					"FAIL",
					`RESULT ${result.streamId} is attributed to ${template}, but muxing ${actualMuxing.muxingId} carries ${actualMuxing.templateRendition}`,
				);
			}
			for (const actual of actualMuxing.legs) {
				eligibleLegIds.push(legId(template, actual));
			}
		}

		const muxingMatch = matchOneToOne({
			expected: templateMuxings.get(template) ?? [],
			observed: actualMuxings,
			expectedKey: (muxing) => muxing.muxingKey,
			observedKey: (muxing) => `${muxing.streamId}\0${muxing.muxingId}`,
			compatible: muxingCompatible,
			cost: (want, got) => muxingCost(expected, want, got, providerOutputIds),
		});
		for (const duplicate of muxingMatch.duplicates) {
			addIssue(
				"delivery-leg-id-duplicate",
				"FAIL",
				`provider RESULT ${result.streamId} repeats muxing identity ${duplicate.key} ${duplicate.rows.length} times`,
			);
		}
		for (const missing of muxingMatch.unmatchedExpected) {
			addIssue(
				"required-muxing-missing",
				"FAIL",
				`RESULT ${result.streamId} for ${template} has no ${missing.container} muxing for plan muxing ${missing.muxingKey}`,
			);
		}
		for (const extra of muxingMatch.unmatchedObserved) {
			addIssue(
				"unexpected-muxing",
				"FAIL",
				`RESULT ${result.streamId} carries unexpected ${extra.muxingType} muxing ${extra.muxingId}`,
			);
		}

		for (const pair of muxingMatch.pairs) {
			const required = requiredLegs(expected, pair.expected, providerOutputIds);
			const hasUnverifiedOutputIdentity = required.some(
				(leg) => leg.providerOutputId === undefined,
			);
			const legMatch = matchOneToOne({
				expected: required,
				observed: pair.observed.legs,
				expectedKey: (leg) => leg.key,
				observedKey: actualLegKey,
				compatible: (want, got) =>
					want.providerOutputId !== undefined &&
					want.providerOutputId === got.outputId &&
					drmMatches(want, got),
				cost: (want, got) =>
					directoryPatternMatches(want.dirPattern, got.resolvedPath) ? 0 : 1,
			});
			for (const duplicate of legMatch.duplicates) {
				addIssue(
					"delivery-leg-id-duplicate",
					"FAIL",
					`provider RESULT ${result.streamId} repeats material leg ${duplicate.key} ${duplicate.rows.length} times`,
				);
			}
			for (const missing of legMatch.unmatchedExpected) {
				if (missing.providerOutputId === undefined) {
					addIssue(
						"provider-output-unverified",
						"SKIP",
						`plan output ${missing.outputKey} has no provider output id, so ${missing.key} is UNVERIFIED`,
					);
				} else {
					addIssue(
						"required-output-leg-missing",
						"FAIL",
						`RESULT ${result.streamId} muxing ${pair.observed.muxingId} lacks required ${missing.expectedDrm?.kind ?? "clear"} leg on ${missing.outputKey} (${missing.providerOutputId})`,
					);
				}
			}
			for (const extra of legMatch.unmatchedObserved) {
				if (hasUnverifiedOutputIdentity) {
					continue;
				}
				addIssue(
					"unexpected-output-leg",
					"FAIL",
					`RESULT ${result.streamId} muxing ${pair.observed.muxingId} has unexpected material leg ${extra.drmId ?? "clear"}:${extra.outputId}:${extra.resolvedPath}`,
				);
			}
			for (const legPair of legMatch.pairs) {
				if (
					!directoryPatternMatches(
						legPair.expected.dirPattern,
						legPair.observed.resolvedPath,
					)
				) {
					addIssue(
						"delivery-path-mismatch",
						"FAIL",
						`RESULT ${result.streamId} muxing ${pair.observed.muxingId} resolved ${legPair.observed.resolvedPath}; expected ${legPair.expected.dirPattern}`,
					);
				}
				bindings.push({
					id: legId(template, legPair.observed),
					templateRendition: template,
					expectedMuxing: pair.expected,
					...(legPair.expected.expectedDrm
						? { expectedDrm: legPair.expected.expectedDrm }
						: {}),
					actual: legPair.observed,
					outputKey: legPair.expected.outputKey,
				});
			}
		}
	}

	bindings.sort((a, b) => a.id.localeCompare(b.id));
	const bindingCounts = new Map<string, number>();
	for (const binding of bindings) {
		bindingCounts.set(binding.id, (bindingCounts.get(binding.id) ?? 0) + 1);
	}
	const reusedLegIds = [...bindingCounts]
		.filter(([, count]) => count > 1)
		.map(([id]) => id)
		.sort();
	for (const id of reusedLegIds) {
		addIssue(
			"delivery-leg-id-duplicate",
			"FAIL",
			`material leg ${id} was selected by ${bindingCounts.get(id)} bindings`,
		);
	}
	const checkedLegIds = [
		...new Set(bindings.map((binding) => binding.id)),
	].sort();
	const eligible = [...new Set(eligibleLegIds)].sort();
	issues.sort((a, b) =>
		`${a.code}\0${a.detail}`.localeCompare(`${b.code}\0${b.detail}`),
	);
	return {
		status: "complete",
		templates,
		bindings,
		issues,
		eligibleLegIds: eligible,
		checkedLegIds,
		reusedLegIds,
	};
}
