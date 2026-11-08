import { describe, expect, it } from "vitest";
import type { LocalSemanticConfiguration } from "../content-editing/local-semantic-config";
import { localStoryIdentityForConfiguration } from "../content-editing/local-semantic-stages";
import { LOCAL_STORY_FLOW_H1_POLICY } from "../content-editing/local-story-flow-contracts";
import { hashEditingEvidence } from "../content-editing/verify-automatic-binding";
import {
	generationTaskResultSchema,
	LOCAL_TRACKING_ALGORITHM_VERSION,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskIntentHash,
	mediaTaskReceiptSchema,
} from "./index";
import { localStoryFlowTaskIdentityForConfiguration } from "./local-story-workflow";
import { mediaTaskEnvelopeSchema } from "./schema";

const id = "00000000-0000-4000-8000-000000000001";
describe("durable media production task contracts", () => {
	it("normalizes generation defaults and preserves a stable replay intent", () => {
		const input = {
			kind: "GENERATE",
			mediaVersionId: id,
			analysisRevisionId: id,
			requestKey: id,
			parameters: { contentId: id, targetDurationFrames: 900 },
		};
		const parsed = mediaTaskCreateSchema.parse(input);
		expect(parsed.parameters).toMatchObject({
			policy: "COHESION",
			variants: 1,
			captions: "OFF",
			tracking: false,
			language: "auto",
		});
		expect(mediaTaskIntentHash(parsed)).toBe(
			mediaTaskIntentHash(
				mediaTaskCreateSchema.parse({
					...input,
					parameters: { ...input.parameters, policy: "COHESION", variants: 1 },
				}),
			),
		);
	});
	it.each([
		{
			kind: "TRANSCRIBE",
			mediaVersionId: id,
			requestKey: id,
			parameters: { language: "ja", sourcePath: "/private/source" },
		},
		{ kind: "TRACK", mediaVersionId: id, requestKey: id, parameters: {} },
		{
			kind: "GENERATE",
			mediaVersionId: id,
			analysisRevisionId: id,
			requestKey: id,
			parameters: { contentId: id, targetDurationFrames: 0 },
		},
		{
			kind: "GENERATE",
			mediaVersionId: id,
			analysisRevisionId: id,
			requestKey: id,
			parameters: {
				contentId: id,
				targetDurationFrames: 900,
				templateId: "invented",
			},
		},
		{
			kind: "GENERATE",
			mediaVersionId: id,
			analysisRevisionId: id,
			requestKey: id,
			parameters: {
				contentId: id,
				targetDurationFrames: 900,
				policy: "DURATION",
				query: "ignored context",
			},
		},
		{
			kind: "TRANSCRIBE",
			mediaVersionId: id,
			requestKey: id,
			parameters: { durationUs: 180_000_001 },
		},
	])("rejects untrusted paths, missing fixed analysis, invalid bounds and unknown presets %j", (input) => {
		expect(mediaTaskCreateSchema.safeParse(input).success).toBe(false);
	});
	it("binds cache reuse to actual byte/model/analysis identities and organization", () => {
		const task = mediaTaskCreateSchema.parse({
			kind: "TRANSCRIBE",
			mediaVersionId: id,
			requestKey: id,
			parameters: { language: "ja" },
		});
		const facts = {
			organizationId: id,
			mediaSha256: "a".repeat(64),
			modelSha256: "b".repeat(64),
			analysisDocumentHash: null,
			analysisRawHash: null,
			timeMapHash: "c".repeat(64),
		};
		const key = mediaTaskCacheKey(task, facts);
		for (const delta of [
			{ organizationId: "other" },
			{ mediaSha256: "d".repeat(64) },
			{ modelSha256: "d".repeat(64) },
			{ analysisDocumentHash: "d".repeat(64) },
			{ timeMapHash: "d".repeat(64) },
		])
			expect(mediaTaskCacheKey(task, { ...facts, ...delta })).not.toBe(key);
		expect(mediaTaskCacheKey(task, { ...facts, mediaSha256: null })).not.toBe(
			key,
		);
	});
	it("verifies task receipts and rejects inconsistent immutable generation results", () => {
		expect(
			mediaTaskReceiptSchema.safeParse({
				taskId: id,
				state: "PENDING",
				cached: false,
			}).success,
		).toBe(true);
		expect(
			mediaTaskReceiptSchema.safeParse({
				taskId: "/private",
				state: "PENDING",
				cached: false,
			}).success,
		).toBe(false);
		const result = {
			projectId: id,
			projectIds: [id],
			requestedFrames: 900,
			actualFrames: 870,
			warnings: [],
			policyVersion: "aisa-scene-cohesion-v2",
			presetIds: ["portrait-clean"],
			metrics: {},
			cacheable: true,
		};
		expect(generationTaskResultSchema.safeParse(result).success).toBe(true);
		for (const altered of [
			{ ...result, actualFrames: 901 },
			{
				...result,
				projectIds: [id, id],
				presetIds: ["portrait-clean", "square-clean"],
			},
			{ ...result, projectId: "00000000-0000-4000-8000-000000000002" },
			{ ...result, presetIds: [] },
		])
			expect(generationTaskResultSchema.safeParse(altered).success).toBe(false);
	});
	it("separates new measured-scale tracking cache identities from legacy v1 results", () => {
		const task = mediaTaskCreateSchema.parse({
			kind: "TRACK",
			mediaVersionId: id,
			analysisRevisionId: id,
			requestKey: id,
			parameters: {},
		});
		const legacy = {
			organizationId: id,
			mediaSha256: "a".repeat(64),
			modelSha256: null,
			analysisDocumentHash: "b".repeat(64),
			analysisRawHash: "c".repeat(64),
			timeMapHash: "d".repeat(64),
			bindingHash: null,
		};
		expect(LOCAL_TRACKING_ALGORITHM_VERSION).toBe("template-ncc-v2");
		expect(
			mediaTaskCacheKey(task, {
				...legacy,
				trackingAlgorithmVersion: LOCAL_TRACKING_ALGORITHM_VERSION,
			}),
		).not.toBe(mediaTaskCacheKey(task, legacy));
	});
});

const flowConfig: LocalSemanticConfiguration = {
	url: "https://fixture.invalid/",
	token: "synthetic-test-token-".repeat(3),
	caFile: "/never-read/fixture.pem",
	profile: "nvidia",
	configId: "44444444-4444-4444-8444-444444444444",
};
const flowParts = {
	version: "local-story-flow-task-policies-v1",
	workflowPolicyHash: hashEditingEvidence(LOCAL_STORY_FLOW_H1_POLICY),
	contextPolicyHash: "1".repeat(64),
	closurePolicyHash: "2".repeat(64),
	routePolicyHash: "3".repeat(64),
	scopePolicyHash: "4".repeat(64),
	promptPolicyHash: "5".repeat(64),
	engineValidationPolicyHash: "6".repeat(64),
	deliveryPolicyHash: "7".repeat(64),
};
const flowParameters = {
	contentId: id,
	targetDurationFrames: 900,
	policy: "LOCAL_STORY",
	storyMode: "FLOW",
	renderMode: "DRAFT",
	storyWorkflowVersion: "hierarchical-flow-v1",
};
const flowInput = (parameters: unknown = flowParameters) => ({
	kind: "GENERATE",
	mediaVersionId: id,
	analysisRevisionId: id,
	requestKey: id,
	parameters,
});
const localIdentity = {
	organizationId: id,
	mediaSha256: "a".repeat(64),
	modelSha256: "b".repeat(64),
	analysisDocumentHash: "c".repeat(64),
	analysisRawHash: "d".repeat(64),
	timeMapHash: "e".repeat(64),
	localStoryModel: localStoryIdentityForConfiguration(flowConfig),
};
const flowPin = () =>
	localStoryFlowTaskIdentityForConfiguration(flowConfig, flowParts);

describe("explicit hierarchical FLOW task contracts", () => {
	it("retains an explicit version only for LOCAL_STORY FLOW DRAFT without upgrading old input", () => {
		const parsed = mediaTaskCreateSchema.parse(flowInput());
		expect(parsed.parameters).toMatchObject(flowParameters);
		const { storyWorkflowVersion: _version, ...legacy } = flowParameters;
		const previous = mediaTaskCreateSchema.parse(flowInput(legacy));
		expect(previous.parameters).not.toHaveProperty("storyWorkflowVersion");
		expect(
			mediaTaskEnvelopeSchema.parse({
				schemaVersion: 1,
				input: previous,
				identity: localIdentity,
			}).identity,
		).not.toHaveProperty("localStoryWorkflow");
		expect(mediaTaskIntentHash(parsed)).not.toBe(mediaTaskIntentHash(previous));
	});

	it("rejects incompatible explicit markers, modes and outer policies without coercion", () => {
		for (const change of [
			{ storyWorkflowVersion: null },
			{ storyWorkflowVersion: undefined },
			{ storyWorkflowVersion: "hierarchical-flow-v2" },
			{ storyMode: "AUTO" },
			{ storyMode: "THEME" },
			{ storyMode: undefined },
			{ renderMode: "EXPORT" },
			{ renderMode: undefined },
			{ policy: "AUTO" },
			{ policy: "STORY" },
			{ policy: "COHESION" },
			{ policy: "DURATION" },
			{ transcriptionTaskId: id },
			{ query: "synthetic context" },
		])
			expect(
				mediaTaskCreateSchema.safeParse(
					flowInput({ ...flowParameters, ...change }),
				).success,
			).toBe(false);
		for (const kind of ["TRANSCRIBE", "TRACK"])
			expect(
				mediaTaskCreateSchema.safeParse({
					kind,
					mediaVersionId: id,
					requestKey: id,
					...(kind === "TRACK" ? { analysisRevisionId: id } : {}),
					parameters: { storyWorkflowVersion: "hierarchical-flow-v1" },
				}).success,
			).toBe(false);
	});

	it("requires marker and workflow identity in both directions with an exact pinned leaf model", () => {
		const pin = flowPin();
		const envelope = {
			schemaVersion: 1,
			input: flowInput(),
			identity: { ...localIdentity, ...pin },
		};
		expect(mediaTaskEnvelopeSchema.parse(envelope).identity).toEqual(
			envelope.identity,
		);
		const { storyWorkflowVersion: _marker, ...legacy } = flowParameters;
		const { generationPolicyFingerprint: _policy, ...noPolicy } =
			envelope.identity;
		for (const invalid of [
			{ ...envelope, identity: localIdentity },
			{ ...envelope, identity: noPolicy },
			{ ...envelope, input: flowInput(legacy) },
			{
				...envelope,
				identity: { ...envelope.identity, localStoryWorkflow: undefined },
			},
			{
				...envelope,
				identity: { ...envelope.identity, localStoryWorkflow: null },
			},
			{
				...envelope,
				identity: {
					...envelope.identity,
					localStoryModel: localStoryIdentityForConfiguration({
						...flowConfig,
						profile: "amd",
					}),
				},
			},
			{
				...envelope,
				identity: {
					...envelope.identity,
					localStoryModel: { ...localIdentity.localStoryModel, configId: id },
				},
			},
		])
			expect(mediaTaskEnvelopeSchema.safeParse(invalid).success).toBe(false);
		expect(
			mediaTaskEnvelopeSchema.safeParse({
				...envelope,
				input: flowInput(legacy),
				identity: { ...localIdentity, localStoryWorkflow: undefined },
			}).success,
		).toBe(false);
	});

	it("rejects workflow pins on independent tasks and nonlocal generation", () => {
		const { localStoryModel: _model, ...nonlocalIdentity } = localIdentity;
		const {
			storyWorkflowVersion: _workflow,
			storyMode: _mode,
			...nonlocal
		} = flowParameters;
		for (const input of [
			flowInput({ ...nonlocal, policy: "COHESION" }),
			{
				kind: "TRANSCRIBE",
				mediaVersionId: id,
				requestKey: id,
				parameters: {},
			},
			{
				kind: "TRACK",
				mediaVersionId: id,
				analysisRevisionId: id,
				requestKey: id,
				parameters: {},
			},
		])
			expect(
				mediaTaskEnvelopeSchema.safeParse({
					schemaVersion: 1,
					input,
					identity: { ...nonlocalIdentity, ...flowPin() },
				}).success,
			).toBe(false);
	});

	it("naturally binds the workflow and every policy component into the existing cache formula", () => {
		const input = mediaTaskCreateSchema.parse(flowInput());
		const original = mediaTaskCacheKey(input, {
			...localIdentity,
			...flowPin(),
		});
		for (const [field] of Object.entries(flowParts)) {
			if (field === "version") continue;
			const pin = localStoryFlowTaskIdentityForConfiguration(flowConfig, {
				...flowParts,
				[field]: "f".repeat(64),
			});
			expect(mediaTaskCacheKey(input, { ...localIdentity, ...pin })).not.toBe(
				original,
			);
		}
	});
});
