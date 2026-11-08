import { describe, expect, it } from "vitest";
import { generationTaskResultSchema } from "../content-production/schema";
import {
	automaticGenerationSchema,
	editingAnalysisBindingSchema,
} from "./automatic-binding";
import {
	isLocalStoryFlowDeliveryPolicy,
	LOCAL_STORY_FLOW_DELIVERY_HEADER_POLICY,
	LocalStoryFlowDeliveryHeaderError,
	localStoryFlowDeliveryHeaderSchema,
	parseLocalStoryFlowDeliveryHeader,
} from "./local-story-flow-delivery";
import { localStoryFlowIdentityForModelPin } from "./local-story-flow-stages";

const hash = "a".repeat(64);
const uuid = "00000000-0000-4000-8000-000000000001";
// Shape fixtures only. No native/DB/PLAN or compiled delivery admission is claimed.
function fixture() {
	return {
		version: "local-story-flow-delivery-v1" as const,
		generationTaskId: uuid,
		artifactRef: {
			kind: "LOCAL_FLOW_PLAN_V1" as const,
			receiptId: uuid,
			cacheHash: hash,
			inputKeyHash: hash,
			proofHash: hash,
		},
		artifactHash: hash,
		workflow: localStoryFlowIdentityForModelPin(
			{ profile: "nvidia", configId: uuid },
			"FLOW",
		),
		sourceBindingHash: hash,
		corpusHash: hash,
		manifestHash: hash,
		treeHash: hash,
		nativeTraceHash: "b".repeat(64),
		structuralTraceHash: "c".repeat(64),
		scopeHash: hash,
		planHash: hash,
		generationPolicyFingerprint: hash,
		originalBlueprintHash: hash,
		originalSelectionHash: hash,
		originalSelectedEventIds: ["l0_e0"],
		clock: {
			status: "LEGACY_FORWARD_COVERAGE_VALIDATED" as const,
			strictEventMomentOrder: "NOT_PROVEN" as const,
		},
	};
}
function fixedFailure(run: () => unknown) {
	let caught: unknown;
	try {
		run();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(LocalStoryFlowDeliveryHeaderError);
	expect(caught).toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		message: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(caught).not.toHaveProperty("cause");
	expect(String(caught)).not.toContain("PRIVATE");
}

describe("standalone FLOW delivery header", () => {
	it("keeps exact original-plan hash domains and one workflow model without admitting a source", () => {
		const value = fixture(),
			parsed = parseLocalStoryFlowDeliveryHeader(value);
		expect(parsed).toEqual(value);
		expect(localStoryFlowDeliveryHeaderSchema.parse(value)).toEqual(value);
		expect(parsed.nativeTraceHash).not.toBe(parsed.structuralTraceHash);
		expect(parsed).not.toHaveProperty("baseModel");
		expect(parsed).not.toHaveProperty("originalSelection");
		expect(LOCAL_STORY_FLOW_DELIVERY_HEADER_POLICY.maxWireUtf8Bytes).toBe(
			32_768,
		);
	});
	it("classifies only the two new literal policies without coercion", () => {
		for (const p of [
			"aisa-local-story-hierarchical-flow-v1",
			"aisa-prepared-local-story-hierarchical-flow-v1",
		])
			expect(isLocalStoryFlowDeliveryPolicy(p)).toBe(true);
		let reads = 0;
		for (const p of [
			"aisa-local-story-window-v1",
			"aisa-prepared-local-story-window-v1",
			null,
			undefined,
			{
				toString() {
					reads++;
					throw new Error("PRIVATE");
				},
			},
		])
			expect(isLocalStoryFlowDeliveryPolicy(p)).toBe(false);
		expect(reads).toBe(0);
	});
	it("does not enable the existing document or task-result acceptors", () => {
		const binding = editingAnalysisBindingSchema.parse({
			schemaVersion: 1,
			kind: "FIXTURE_AUTHORED",
			organizationId: uuid,
			sourceId: uuid,
			locale: "en",
			analysisRevisionId: uuid,
			analysisRawHash: hash,
			analysisDocumentHash: hash,
			mediaVersionId: uuid,
			mediaSha256: hash,
			timeMapId: uuid,
			timeMapHash: hash,
			sourceStartUs: 0,
			sourceEndUs: 1_000_000,
			width: 640,
			height: 360,
		});
		const automatic = {
			policyVersion: "aisa-shot-window-v1",
			requestHash: hash,
			requestedDurationFrames: 30,
			generatedDurationFrames: 30,
			reasonCodes: [],
			binding,
			renderMode: "DRAFT",
			draftPolicyVersion: "duration-review-v2",
		};
		const result = {
			policyVersion: "aisa-shot-window-v1",
			projectId: uuid,
			projectIds: [uuid],
			presetIds: ["portrait-clean"],
			requestedFrames: 30,
			actualFrames: 30,
			warnings: [],
			metrics: {},
			cacheable: false,
			renderMode: "DRAFT",
			draftPolicyVersion: "duration-review-v2",
		};
		expect(automaticGenerationSchema.safeParse(automatic).success).toBe(true);
		expect(generationTaskResultSchema.safeParse(result).success).toBe(true);
		for (const policyVersion of [
			"aisa-local-story-hierarchical-flow-v1",
			"aisa-prepared-local-story-hierarchical-flow-v1",
		])
			for (const [schema, base] of [
				[automaticGenerationSchema, automatic],
				[generationTaskResultSchema, result],
			] as const)
				expect(
					schema.safeParse({
						...base,
						policyVersion,
						localStoryFlowEvidence: fixture(),
					}).success,
				).toBe(false);
	});
	it("copies both caller and returned aliases", () => {
		const source = fixture(),
			first = parseLocalStoryFlowDeliveryHeader(source);
		first.originalSelectedEventIds[0] = "changed";
		first.workflow.baseModel.configId = "00000000-0000-4000-8000-000000000002";
		expect(source).toEqual(fixture());
		source.artifactHash = "f".repeat(64);
		expect(first.artifactHash).toBe(hash);
	});
	it("rejects accessors before reading them and maps schema/proxy errors to one code", () => {
		const value = fixture();
		let reads = 0;
		Object.defineProperty(value.workflow.baseModel, "configId", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("PRIVATE_GETTER");
			},
		});
		fixedFailure(() => parseLocalStoryFlowDeliveryHeader(value));
		expect(reads).toBe(0);
		fixedFailure(() =>
			parseLocalStoryFlowDeliveryHeader(
				new Proxy(fixture(), {
					getPrototypeOf() {
						throw new Error("PRIVATE_PROXY");
					},
				}),
			),
		);
	});
});

describe("header bounded unknown-input boundary", () => {
	it("preserves object-order independence and maximum bounded IDs/current workflow width", () => {
		const value = fixture();
		value.originalSelectedEventIds = Array.from(
			{ length: 5 },
			(_, i) => `A${"x".repeat(62)}${i}`,
		);
		expect(new TextEncoder().encode(JSON.stringify(value)).length).toBe(2756);
		expect(
			parseLocalStoryFlowDeliveryHeader(
				Object.fromEntries(Object.entries(value).reverse()),
			),
		).toEqual(value);
		// Native admission is deliberately separate from this generic identity shape.
		value.workflow.baseModel.model = "m".repeat(128);
		expect(
			parseLocalStoryFlowDeliveryHeader(value).workflow.baseModel.model.length,
		).toBe(128);
	});
	it("rejects a wire-oversize semver-shaped input without pretending it is a valid native pin", () => {
		const value = fixture();
		const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
		value.workflow.baseModel.runtimeVersion = `${"1".repeat(7 + 32_800 - bytes - 4)}.0.0`;
		expect(new TextEncoder().encode(JSON.stringify(value)).length).toBe(32_800);
		fixedFailure(() => parseLocalStoryFlowDeliveryHeader(value));
	});
	it.each([
		"header",
		"ref",
		"workflow",
		"model",
		"clock",
	] as const)("rejects an own __proto__ field on %s instead of accepting schema field loss", (where) => {
		const value = fixture(),
			target =
				where === "header"
					? value
					: where === "ref"
						? value.artifactRef
						: where === "workflow"
							? value.workflow
							: where === "model"
								? value.workflow.baseModel
								: value.clock;
		Object.defineProperty(target, "__proto__", {
			value: { private: true },
			enumerable: true,
		});
		fixedFailure(() => parseLocalStoryFlowDeliveryHeader(value));
	});
	it.each([
		"missing",
		"undefined",
		"extra",
		"symbol",
		"hidden",
		"prototype",
		"nullPrototype",
		"cycle",
		"hole",
		"arrayExtra",
		"nonfinite",
		"bigint",
	] as const)("rejects %s unknown header without normalization or fallback", (change) => {
		const value = fixture();
		if (change === "missing") Reflect.deleteProperty(value, "artifactHash");
		if (change === "undefined") Reflect.set(value, "artifactHash", undefined);
		if (change === "extra")
			Reflect.set(value, "baseModel", value.workflow.baseModel);
		if (change === "symbol")
			Reflect.set(value.workflow, Symbol("PRIVATE"), true);
		if (change === "hidden")
			Object.defineProperty(value.clock, "extra", { value: true });
		if (change === "prototype")
			Object.setPrototypeOf(value.artifactRef, { inherited: true });
		if (change === "nullPrototype") Object.setPrototypeOf(value.clock, null);
		if (change === "cycle") Reflect.set(value.workflow, "self", value);
		if (change === "hole") delete value.originalSelectedEventIds[0];
		if (change === "arrayExtra")
			Reflect.set(value.originalSelectedEventIds, "extra", true);
		if (change === "nonfinite") value.workflow.baseModel.context = NaN as 8192;
		if (change === "bigint") Reflect.set(value, "planHash", 1n);
		fixedFailure(() => parseLocalStoryFlowDeliveryHeader(value));
	});
	it.each([
		"version",
		"kind",
		"hash",
		"empty",
		"duplicate",
		"tooMany",
		"tooLong",
		"clock",
		"moment",
		"mode",
	] as const)("rejects %s contract mismatch", (change) => {
		const value = fixture();
		if (change === "version")
			Reflect.set(value, "version", "local-story-evidence-v1");
		if (change === "kind")
			Reflect.set(value.artifactRef, "kind", "LOCAL_FLOW_CONTEXT_V1");
		if (change === "hash") value.planHash = "A".repeat(64);
		if (change === "empty") value.originalSelectedEventIds = [];
		if (change === "duplicate")
			value.originalSelectedEventIds = ["l0_e0", "l0_e0"];
		if (change === "tooMany")
			value.originalSelectedEventIds = Array.from(
				{ length: 6 },
				(_, i) => `l${i}_e0`,
			);
		if (change === "tooLong") value.originalSelectedEventIds = ["A".repeat(65)];
		if (change === "clock") Reflect.set(value.clock, "status", "VERIFIED");
		if (change === "moment")
			Reflect.set(value.clock, "strictEventMomentOrder", "VERIFIED");
		if (change === "mode") Reflect.set(value.workflow, "mode", "THEME");
		fixedFailure(() => parseLocalStoryFlowDeliveryHeader(value));
	});
	it("keeps safeParse fixed and never reads nested array/getter values", () => {
		let reads = 0;
		const value = fixture();
		Object.defineProperty(value.originalSelectedEventIds, "0", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("PRIVATE_ARRAY");
			},
		});
		const result = localStoryFlowDeliveryHeaderSchema.safeParse(value);
		expect(result.success).toBe(false);
		expect(JSON.stringify(result)).not.toContain("PRIVATE_ARRAY");
		expect(reads).toBe(0);
		const wide = fixture();
		Reflect.set(wide, "extra", "界".repeat(11_000));
		expect("界".repeat(11_000).length).toBeLessThan(32_768);
		expect(
			new TextEncoder().encode("界".repeat(11_000)).length,
		).toBeGreaterThan(32_768);
		fixedFailure(() => parseLocalStoryFlowDeliveryHeader(wide));
	});
});
