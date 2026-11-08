import { expect, it, vi } from "vitest";
import { localStoryFlowGenerationPolicyFingerprint } from "../content-production/local-story-workflow";
import { mediaTaskEnvelopeSchema } from "../content-production/schema";
import { canonicalEditingJson } from "./automatic-binding";
import {
	localStoryIdentityForModelPin,
	localStoryStageRegistry,
} from "./local-semantic-stages";
import type { LocalStoryInput } from "./local-story-contracts";
import { LOCAL_STORY_FLOW_CLOSURE_POLICY } from "./local-story-flow-closure";
import {
	LOCAL_STORY_FLOW_CONTEXT_POLICY,
	prepareLocalStoryFlowContextSourceFromPin,
} from "./local-story-flow-context";
import { LOCAL_STORY_FLOW_H1_POLICY } from "./local-story-flow-contracts";
import {
	buildLocalStoryFlowLeafPages,
	buildLocalStoryFlowManifest,
} from "./local-story-flow-manifest";
import {
	contextNativeExpectation,
	LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY,
	localStoryFlowNativeExpectationEvidence,
	nativeRequestForOrigin,
} from "./local-story-flow-native";
import { LOCAL_STORY_FLOW_ROUTE_POLICY } from "./local-story-flow-route";
import * as history from "./local-story-flow-runtime-history";
import {
	type BoundLocalStoryFlowSealedRecord,
	type LocalStoryFlowRecordKey,
	type LocalStoryFlowRecordRef,
	type LocalStoryFlowSourceTuple,
	localStoryFlowRecordIdentity,
	localStoryFlowSealedRecordEvidence,
	readLocalStoryFlowSealedRecord,
} from "./local-story-flow-seals";
import { localStoryFlowIdentityForModelPin } from "./local-story-flow-stages";
import { buildLocalStoryChunks } from "./local-story-input";
import { cfrTimeMapSchema } from "./schema";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";

const org = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
function ownedInput() {
	const pin = {
		profile: "nvidia" as const,
		configId: "44444444-4444-4444-8444-444444444444",
	};
	const model = localStoryIdentityForModelPin(pin),
		workflow = localStoryFlowIdentityForModelPin(pin, "FLOW");
	const map = cfrTimeMapSchema.parse({
		id: "22222222-2222-4222-8222-222222222222",
		mediaVersionId: "33333333-3333-4333-8333-333333333333",
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: 3_000_000,
		editingStartFrame: 0,
		editingEndFrame: 90,
		fps: { num: 30, den: 1 },
	});
	const input: LocalStoryInput = {
		version: "local-story-input-v1",
		title: "合成の鍵",
		description: "合成の人物が鍵を見つける。",
		timeMap: map,
		timeMapHash: hash(map),
		segments: [],
		scenes: [{ sceneId: "scene", text: "合成の場面", fields: [] }],
		shots: [
			{
				ref: "s0",
				sceneId: "scene",
				shotIndex: 0,
				fromFrame: 0,
				toFrame: 90,
				text: "合成の人物は鍵を見つける。",
				fields: [
					{
						kind: "AISA",
						pointer: "/shots/0",
						text: "合成の人物は鍵を見つける。",
					},
				],
			},
		],
		coverage: [{ ref: "s0", status: "ELIGIBLE" }],
	};
	const chunks = buildLocalStoryChunks(input),
		transcriptFingerprint = hash("synthetic transcript");
	const ledgers = [
		{
			summary: "人物が鍵を見つける。",
			events: [
				{
					id: "e0",
					label: "鍵を見つける",
					role: "ACTION" as const,
					refs: ["s0"],
					quotes: [{ ref: "s0", quote: "鍵を見つける。" }],
					subjects: ["人物"],
					uncertainty: "合成",
				},
			],
		},
	];
	const schemaHash =
		localStoryStageRegistry().stages.LOCAL_LEDGER_V1.schemaHash;
	const ledgerRefs = chunks.map((chunk, chunkIndex) => {
		const stageInputHash = hash({ chunk, transcriptFingerprint }),
			promptHash = hash("synthetic accepted prompt");
		return {
			chunkIndex,
			stageInputHash,
			promptHash,
			schemaHash,
			ledgerHash: hash(ledgers[chunkIndex]),
			stageKeyHash: hash({
				identity: model,
				stage: "LOCAL_LEDGER_V1",
				inputHash: stageInputHash,
				promptHash,
				schemaHash,
			}),
		};
	});
	const h0 = {
			input,
			chunks,
			ledgers,
			model,
			transcriptFingerprint,
			ledgerRefs,
		},
		manifest = buildLocalStoryFlowManifest(h0),
		pages = buildLocalStoryFlowLeafPages(manifest);
	const source = prepareLocalStoryFlowContextSourceFromPin({
		h0,
		manifest,
		pages,
		workflow,
		pin,
		mode: "FLOW",
	});
	const policies = {
		version: "local-story-flow-task-policies-v1" as const,
		workflowPolicyHash: hash(LOCAL_STORY_FLOW_H1_POLICY),
		contextPolicyHash: hash(LOCAL_STORY_FLOW_CONTEXT_POLICY),
		closurePolicyHash: hash(LOCAL_STORY_FLOW_CLOSURE_POLICY),
		routePolicyHash: hash(LOCAL_STORY_FLOW_ROUTE_POLICY),
		promptPolicyHash: hash(LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY),
		scopePolicyHash: hash("synthetic scope"),
		engineValidationPolicyHash: hash(
			"synthetic unimplemented engine, not READY",
		),
		deliveryPolicyHash: hash("synthetic unimplemented delivery, not READY"),
	};
	const expectation = contextNativeExpectation({
		source,
		nodeId: "n0",
		children: [],
		pin: { modelPin: pin, policies },
	});
	return { map, model, workflow, policies, expectation, source, pin };
}

function fixture() {
	const real = ownedInput();
	const sourceTuple: LocalStoryFlowSourceTuple = {
		version: "local-story-flow-source-tuple-v1",
		organizationId: org,
		sourceId: "66666666-6666-4666-8666-666666666666",
		mediaVersionId: real.map.mediaVersionId,
		mediaSha256: hash("synthetic media"),
		timeMapHash: hash(real.map),
		analysisRevisionId: "55555555-5555-4555-8555-555555555555",
		analysisRawHash: hash("raw"),
		analysisDocumentHash: hash("document"),
		bindingHash: hash("independent binding"),
		preparedShotClockHash: null,
		normalizationReceiptHash: null,
	};
	const taskParameters = mediaTaskEnvelopeSchema.parse({
		schemaVersion: 1,
		input: {
			kind: "GENERATE",
			mediaVersionId: sourceTuple.mediaVersionId,
			analysisRevisionId: sourceTuple.analysisRevisionId,
			requestKey: taskId,
			parameters: {
				contentId: "77777777-7777-4777-8777-777777777777",
				policy: "LOCAL_STORY",
				storyMode: "FLOW",
				renderMode: "DRAFT",
				storyWorkflowVersion: "hierarchical-flow-v1",
				targetDurationFrames: 90,
			},
		},
		identity: {
			organizationId: org,
			mediaSha256: sourceTuple.mediaSha256,
			modelSha256: null,
			analysisRawHash: sourceTuple.analysisRawHash,
			analysisDocumentHash: sourceTuple.analysisDocumentHash,
			timeMapHash: sourceTuple.timeMapHash,
			bindingHash: sourceTuple.bindingHash,
			localStoryModel: real.model,
			localStoryWorkflow: real.workflow,
			generationPolicyFingerprint: localStoryFlowGenerationPolicyFingerprint(
				real.policies,
			),
		},
	});
	const input = {
		taskId,
		organizationId: org,
		taskParameters,
		startedAtMs: 1000,
		sourceTuple,
		policies: real.policies,
	};
	return { real, input };
}

it("preserves the runtime policy literal and derives the old START bytes from independent task facts", () => {
	const f = fixture(),
		handle = history.prepareLocalStoryFlowRuntimeIdentity(f.input);
	expect(history.LOCAL_STORY_FLOW_RUNTIME_POLICY).toEqual({
		version: "local-story-flow-runtime-policy-v1",
		deadlineMs: 5400000,
		contextReservations: 63,
		routeReservations: 64,
		totalReservations: 127,
		acceptedRouteSteps: 64,
		knownRuntimeKeys: 382,
		reservationRule: "commit-before-native-no-refund-v1",
		recoveryRule: "cleanup-only-no-success-adoption-v1",
		clockRule: "original-task-start-db-clock-v1",
	});
	const evidence = history.localStoryFlowRuntimeIdentityEvidence(handle);
	const taskPin = {
		version: "local-story-flow-task-pin-v1",
		parameters: f.input.taskParameters.input.parameters,
		identity: f.input.taskParameters.identity,
		policies: f.input.policies,
	};
	expect(evidence).toEqual({
		taskId,
		organizationId: org,
		sourceTuple: f.input.sourceTuple,
		taskPin,
		taskPinHash: hash(taskPin),
		taskPayloadHash: hash(f.input.taskParameters),
		startedAtMs: 1000,
		deadlineAtMs: 5401000,
	});
	const body = {
		version: "local-story-flow-runtime-start-v1",
		purpose: "START",
		taskId,
		organizationId: org,
		sourceTuple: f.input.sourceTuple,
		taskPin,
		taskPinHash: hash(taskPin),
		taskPayloadHash: hash(f.input.taskParameters),
		startedAtMs: 1000,
		deadlineAtMs: 5401000,
		caps: {
			contextReservations: 63,
			routeReservations: 64,
			totalReservations: 127,
			acceptedRouteSteps: 64,
		},
		budgetCategory: "HIERARCHY_CONTEXT_ROUTE_ONLY",
		nativeConnectionHash: hash("original connection"),
	};
	expect(
		history.localStoryFlowRuntimeStartRecord(
			handle,
			hash("original connection"),
		),
	).toEqual({
		kind: "LOCAL_FLOW_PLAN_V1",
		key: {
			version: "local-story-flow-record-key-v1",
			purpose: "START",
			keyBody: { taskId },
		},
		payload: { ...body, startHash: hash(body) },
	});
});
it("returns detached owned identity evidence and rejects copied handles", () => {
	const f = fixture(),
		handle = history.prepareLocalStoryFlowRuntimeIdentity(f.input);
	const a = history.localStoryFlowRuntimeIdentityEvidence(handle);
	a.sourceTuple.sourceId = taskId;
	expect(
		history.localStoryFlowRuntimeIdentityEvidence(handle).sourceTuple,
	).toEqual(f.input.sourceTuple);
	expect(() =>
		history.localStoryFlowRuntimeIdentityEvidence({ ...handle }),
	).toThrowError(history.LocalStoryFlowRuntimeHistoryError);
});
it("retains all382 keys in old worker order with strict locators", () => {
	const id = history.prepareLocalStoryFlowRuntimeIdentity(fixture().input);
	const keys = history.localStoryFlowRuntimeKeys(id),
		sourceTuple = fixture().input.sourceTuple;
	expect(keys).toHaveLength(382);
	expect(keys[0]?.purpose).toBe("START");
	expect(keys[127]?.keyBody).toEqual({ taskId, slot: 127 });
	expect(keys[128]?.purpose).toBe("OUTCOME");
	expect(keys[255]?.purpose).toBe("ROUTE_PREFIX");
	expect(keys[381]?.keyBody).toEqual({ taskId, nodeId: "n62" });
	expect(
		new Set(
			keys.map(
				(k) =>
					localStoryFlowRecordIdentity({
						sourceTuple,
						kind: "LOCAL_FLOW_PLAN_V1",
						key: k,
					}).receiptId,
			),
		).size,
	).toBe(382);
	expect(() =>
		history.localStoryFlowRuntimeKey(id, { purpose: "ATTEMPT", slot: 128 }),
	).toThrowError(history.LocalStoryFlowRuntimeHistoryError);
	expect(() =>
		history.localStoryFlowRuntimeKey(id, {
			purpose: "CONTEXT_BINDING",
			nodeId: "n01",
		}),
	).toThrowError(history.LocalStoryFlowRuntimeHistoryError);
});
it.each([
	"startedAt",
	"organization",
	"source",
	"policy",
	"mode",
	"schema-loss",
] as const)("rejects independent identity %s changes", (change) => {
	const f = fixture(),
		input: Record<string, unknown> = structuredClone(f.input);
	if (change === "startedAt") input.startedAtMs = Number.MAX_SAFE_INTEGER;
	if (change === "organization") input.organizationId = taskId;
	if (change === "source") f.input.sourceTuple.mediaSha256 = hash("wrong");
	if (change === "source") input.sourceTuple = f.input.sourceTuple;
	if (change === "policy") f.input.policies.contextPolicyHash = hash("wrong");
	if (change === "policy") input.policies = f.input.policies;
	if (change === "mode")
		Reflect.set(f.input.taskParameters.input.parameters, "storyMode", "THEME");
	if (change === "mode") input.taskParameters = f.input.taskParameters;
	if (change === "schema-loss") {
		Reflect.deleteProperty(f.input.taskParameters.input.parameters, "captions");
		input.taskParameters = f.input.taskParameters;
	}
	expect(() =>
		history.prepareLocalStoryFlowRuntimeIdentity(input),
	).toThrowError(history.LocalStoryFlowRuntimeHistoryError);
});
it("rejects accessors without invoking them, cycles, symbols and hidden field loss", () => {
	const f = fixture(),
		get = vi.fn(() => f.input.taskParameters);
	expect(() =>
		history.prepareLocalStoryFlowRuntimeIdentity({
			...f.input,
			get taskParameters() {
				return get();
			},
		}),
	).toThrowError(history.LocalStoryFlowRuntimeHistoryError);
	expect(get).not.toHaveBeenCalled();
	const cycle = { ...f.input, extra: {} };
	cycle.extra = cycle;
	expect(() =>
		history.prepareLocalStoryFlowRuntimeIdentity(cycle),
	).toThrowError(history.LocalStoryFlowRuntimeHistoryError);
	expect(() =>
		history.prepareLocalStoryFlowRuntimeIdentity({
			...f.input,
			[Symbol("hidden")]: 1,
		}),
	).toThrowError(history.LocalStoryFlowRuntimeHistoryError);
	const proto = JSON.parse(JSON.stringify(f.input));
	Object.defineProperty(proto.taskParameters, "__proto__", {
		value: { sentinel: "PRIVATE" },
		enumerable: true,
	});
	expect(() =>
		history.prepareLocalStoryFlowRuntimeIdentity(proto),
	).toThrowError(history.LocalStoryFlowRuntimeHistoryError);
});

function ref(
	kind: LocalStoryFlowRecordRef["kind"],
	label: string,
): LocalStoryFlowRecordRef {
	const d = hash(label);
	return {
		kind,
		receiptId:
			d.slice(0, 8) +
			"-" +
			d.slice(8, 12) +
			"-5" +
			d.slice(13, 16) +
			"-8" +
			d.slice(17, 20) +
			"-" +
			d.slice(20, 32),
		cacheHash: hash(`${label}:cache`),
		inputKeyHash: hash(`${label}:key`),
		proofHash: hash(`${label}:proof`),
	};
}
function sealed(
	f: ReturnType<typeof fixture>,
	key: LocalStoryFlowRecordKey,
	payload: Record<string, unknown>,
	kind: LocalStoryFlowRecordRef["kind"] = "LOCAL_FLOW_PLAN_V1",
) {
	const id = localStoryFlowRecordIdentity({
		sourceTuple: f.input.sourceTuple,
		kind,
		key,
	});
	const proof = {
			version: "local-story-cache-v2",
			cacheHash: id.cacheHash,
			valueJson: canonicalEditingJson(payload),
		},
		proofHash = hash(proof);
	return readLocalStoryFlowSealedRecord({
		sourceTuple: f.input.sourceTuple,
		kind,
		key,
		ref: { kind, ...id, proofHash },
		row: {
			id: id.receiptId,
			organizationId: org,
			sourceId: f.input.sourceTuple.sourceId,
			mediaVersionId: f.input.sourceTuple.mediaVersionId,
			analysisRevisionId: f.input.sourceTuple.analysisRevisionId,
			kind,
			proof,
			proofHash,
		},
	});
}
function runtimeFixture(slot = 1) {
	const f = fixture(),
		identity = history.prepareLocalStoryFlowRuntimeIdentity(f.input);
	const startRecord = history.localStoryFlowRuntimeStartRecord(
		identity,
		hash("original connection"),
	);
	const start = sealed(f, startRecord.key, startRecord.payload),
		startRef = localStoryFlowSealedRecordEvidence(start).ref;
	const native = localStoryFlowNativeExpectationEvidence(f.real.expectation),
		request = nativeRequestForOrigin(f.real.expectation, {
			organizationId: org,
			originTaskId: taskId,
		});
	const a = {
		version: "local-story-flow-runtime-attempt-v1",
		purpose: "ATTEMPT",
		taskId,
		startRef,
		slot,
		category: "CONTEXT",
		nativeKeyHash: native.nativeKeyHash,
		requestKey: request.body.requestKey,
		jobId: request.jobId,
		requestHash: request.requestHash,
		coreInputHash: native.nativeKey.coreInputHash,
		promptHash: native.promptHash,
		expectedTailPrefixRef: null,
		reservedAtMs: 1001,
		nativeKey: native.nativeKey,
		requestBody: request.body,
	};
	const attempt = sealed(
		f,
		history.localStoryFlowRuntimeKey(identity, { purpose: "ATTEMPT", slot }),
		{ ...a, attemptHash: hash(a) },
	);
	const attemptRef = localStoryFlowSealedRecordEvidence(attempt).ref;
	const origin = {
		organizationId: org,
		originTaskId: taskId,
		startRef,
		attemptRef,
		slot,
	};
	const obs = {
		version: "local-story-flow-native-observation-v1",
		purpose: "NATIVE_OBSERVATION",
		nativeKey: native.nativeKey,
		origin,
		requestBody: request.body,
		requestHash: request.requestHash,
		requestKey: request.body.requestKey,
		jobId: request.jobId,
		terminalJob: { synthetic: "outer only; P0 terminal admission is separate" },
	};
	const observation = sealed(
		f,
		{
			version: "local-story-flow-record-key-v1",
			purpose: "NATIVE_OBSERVATION",
			keyBody: {
				nativeKeyHash: native.nativeKeyHash,
				originTaskId: taskId,
				slot,
			},
		},
		{ ...obs, observationHash: hash(obs) },
		"LOCAL_FLOW_CONTEXT_V1",
	);
	const observationRef = localStoryFlowSealedRecordEvidence(observation).ref,
		artifactRef = ref("LOCAL_FLOW_CONTEXT_V1", "artifact");
	const o = {
		version: "local-story-flow-runtime-outcome-v1",
		purpose: "OUTCOME",
		taskId,
		startRef,
		attemptRef,
		slot,
		completedAtMs: 1002,
		status: "ACCEPTED",
		observationRef,
		acceptedArtifactRef: artifactRef,
		acceptedArtifactHash: hash("artifact"),
	};
	const outcome = sealed(
		f,
		history.localStoryFlowRuntimeKey(identity, { purpose: "OUTCOME", slot }),
		o,
	);
	const binding = sealed(
		f,
		history.localStoryFlowRuntimeKey(identity, {
			purpose: "CONTEXT_BINDING",
			nodeId: "n0",
		}),
		{
			version: "local-story-flow-runtime-context-binding-v1",
			purpose: "CONTEXT_BINDING",
			startRef,
			nodeRef: artifactRef,
			nodeHash: hash("artifact"),
			observationRef,
		},
	);
	const records = [start, attempt, outcome, binding];
	const pins = (rows = records) =>
		rows.map((r) => ({
			organizationId: org,
			taskId,
			receiptId: localStoryFlowSealedRecordEvidence(r).ref.receiptId,
		}));
	const read = (rows = records, actualPins = pins(rows)) =>
		history.readLocalStoryFlowRuntimeHistory({
			identity,
			records: rows,
			pins: actualPins,
		});
	const original = () =>
		history.admitLocalStoryFlowAcceptedOrigin({
			identity,
			expectation: f.real.expectation,
			start,
			attempt,
			outcome,
			observation,
		});
	return {
		...f,
		identity,
		start,
		attempt,
		outcome,
		binding,
		observation,
		records,
		pins,
		read,
		original,
	};
}
function changed(
	f: ReturnType<typeof fixture>,
	handle: BoundLocalStoryFlowSealedRecord,
	mutate: (p: Record<string, unknown>) => void,
) {
	const r = localStoryFlowSealedRecordEvidence(handle);
	mutate(r.payload);
	for (const field of [
		"startHash",
		"attemptHash",
		"prefixHash",
		"observationHash",
	]) {
		if (Object.hasOwn(r.payload, field)) {
			delete r.payload[field];
			r.payload[field] = hash(r.payload);
		}
	}
	return sealed(f, r.key, r.payload, r.kind);
}
it("uses the exact old semantic signature independent of binding-only metadata", () => {
	const f = fixture(),
		id = history.prepareLocalStoryFlowRuntimeIdentity(f.input);
	const e = localStoryFlowNativeExpectationEvidence(f.real.expectation),
		r = nativeRequestForOrigin(f.real.expectation, {
			organizationId: org,
			originTaskId: taskId,
		});
	const expected = hash({
		stage: e.nativeKey.stage,
		profile: f.real.model.profile,
		modelIdentityHash: hash(f.real.model),
		promptVersion: e.nativeKey.promptVersion,
		schemaHash: e.nativeKey.schemaHash,
		promptHash: e.nativeKey.promptHash,
		dataHash: hash(e.data),
		controlHash: hash(e.control),
	});
	expect(history.localStoryFlowRuntimeSignature(id, e.nativeKey, r.body)).toBe(
		expected,
	);
	expect(
		history.localStoryFlowRuntimeSignature(
			id,
			{ ...e.nativeKey, nodeId: "n1" },
			r.body,
		),
	).toBe(expected);
	expect(() =>
		history.localStoryFlowRuntimeSignature(id, e.nativeKey, {
			...r.body,
			prompt: `${r.body.prompt} `,
		}),
	).toThrowError(history.LocalStoryFlowRuntimeHistoryError);
	const n = structuredClone(e.nativeKey);
	n.relevantPolicyHashes.contextPolicyHash = hash("wrong");
	expect(() =>
		history.requireLocalStoryFlowRuntimeNativeKey(id, n),
	).toThrowError(history.LocalStoryFlowRuntimeHistoryError);
});
it("reads a complete accounting history with detached382 cells and actual pin triples", () => {
	const f = runtimeFixture(),
		e = history.localStoryFlowRuntimeHistoryEvidence(f.read());
	expect(e.counts).toEqual({ context: 1, route: 0, total: 1 });
	expect(e.cells).toHaveLength(382);
	expect(e.outcomes).toHaveLength(1);
	expect(e.bindings).toHaveLength(1);
	expect(e.stopCode).toBe(null);
	expect(e.unconfirmedSlot).toBe(null);
	expect(e.tailRef).toBe(null);
	e.start.payload.startedAtMs = 0;
	expect(
		history.localStoryFlowRuntimeHistoryEvidence(f.read()).start.payload
			.startedAtMs,
	).toBe(1000);
	expect(() => history.localStoryFlowRuntimeHistoryEvidence({})).toThrowError(
		history.LocalStoryFlowRuntimeHistoryError,
	);
});
it("keeps an actual missing final outcome as unconfirmed rather than closing holes", () => {
	const f = runtimeFixture(),
		e = history.localStoryFlowRuntimeHistoryEvidence(
			f.read([f.start, f.attempt]),
		);
	expect(e.counts.total).toBe(1);
	expect(e.unconfirmedSlot).toBe(1);
	expect(e.stopCode).toBe(null);
	expect(e.cells.filter((c) => c.record !== null)).toHaveLength(2);
});
it.each([
	"missing-pin",
	"extra-pin",
	"foreign-pin",
	"extra-field",
	"binding-missing",
	"attempt-hole",
	"duplicate-record",
	"foreign-handle",
	"start-selfhash",
] as const)("rejects whole history %s", (change) => {
	const f = runtimeFixture();
	let rows = f.records,
		pins = f.pins();
	if (change === "missing-pin") pins = pins.slice(1);
	if (change === "extra-pin")
		pins = [...pins, { organizationId: org, taskId, receiptId: taskId }];
	if (change === "foreign-pin")
		pins[0] = {
			organizationId: taskId,
			taskId,
			receiptId: pins[0]?.receiptId ?? "",
		};
	if (change === "extra-field")
		Object.assign(pins[0] ?? {}, { hidden: "PRIVATE" });
	if (change === "binding-missing") {
		rows = rows.slice(0, 3);
		pins = f.pins(rows);
	}
	if (change === "attempt-hole") {
		const h = runtimeFixture(2);
		rows = h.records;
		pins = h.pins();
	}
	if (change === "duplicate-record") {
		rows = [...rows, f.start];
	}
	if (change === "foreign-handle") {
		rows = [{}, ...rows.slice(1)];
	}
	if (change === "start-selfhash") {
		rows = [
			changed(f, f.start, (p) => {
				p.startedAtMs = 0;
			}),
			...rows.slice(1),
		];
		pins = f.pins(rows);
	}
	expect(() => f.read(rows, pins)).toThrowError(
		history.LocalStoryFlowRuntimeHistoryError,
	);
});
it.each([
	"CONFIRMED",
	"UNCONFIRMED",
] as const)("retains sealed FAILED %s as a valid stop state", (cleanupStatus) => {
	const f = runtimeFixture(),
		a = localStoryFlowSealedRecordEvidence(f.attempt),
		s = localStoryFlowSealedRecordEvidence(f.start);
	const outcome = sealed(
		f,
		history.localStoryFlowRuntimeKey(f.identity, {
			purpose: "OUTCOME",
			slot: 1,
		}),
		{
			version: "local-story-flow-runtime-outcome-v1",
			purpose: "OUTCOME",
			taskId,
			startRef: s.ref,
			attemptRef: a.ref,
			slot: 1,
			completedAtMs: 999999999,
			status: "FAILED",
			failureCode: "CANCELED",
			cleanupStatus,
			observationRef: null,
		},
	);
	const e = history.localStoryFlowRuntimeHistoryEvidence(
		f.read([f.start, f.attempt, outcome]),
	);
	expect(e.stopCode).toBe(
		cleanupStatus === "UNCONFIRMED"
			? "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED"
			: "CANCELED",
	);
	expect(e.unconfirmedSlot).toBe(null);
});
it("admits fixed original slot19 without requiring slots1..18, bindings or prefixes", () => {
	const f = runtimeFixture(19),
		origin = f.original(),
		e = history.localStoryFlowAcceptedOriginEvidence(origin);
	expect(e.kind).toBe("SEALED_ACCEPTED");
	expect(e.origin.slot).toBe(19);
	expect(e.origin.startRef).toEqual(
		localStoryFlowSealedRecordEvidence(f.start).ref,
	);
	expect(e.accepted.observationHash).toBe(
		localStoryFlowSealedRecordEvidence(f.observation).payload.observationHash,
	);
	expect(() =>
		history.localStoryFlowAcceptedOriginEvidence({ ...origin }),
	).toThrowError(history.LocalStoryFlowRuntimeHistoryError);
	expect(() => f.read()).toThrowError(
		history.LocalStoryFlowRuntimeHistoryError,
	);
});
it.each([
	"original-time",
	"request",
	"policy",
	"observation",
	"outcome",
	"fake-expectation",
] as const)("rejects fixed origin %s mismatch", (change) => {
	const f = runtimeFixture(19);
	const input = {
		identity: f.identity,
		expectation: f.real.expectation,
		start: f.start,
		attempt: f.attempt,
		outcome: f.outcome,
		observation: f.observation,
	};
	if (change === "original-time")
		input.start = changed(f, f.start, (p) => {
			p.startedAtMs = 0;
		});
	if (change === "request")
		input.attempt = changed(f, f.attempt, (p) => {
			p.requestHash = hash("forged");
		});
	if (change === "policy")
		input.attempt = changed(f, f.attempt, (p) => {
			const n = structuredClone(
				localStoryFlowNativeExpectationEvidence(f.real.expectation).nativeKey,
			);
			n.relevantPolicyHashes.contextPolicyHash = hash("wrong");
			p.nativeKeyHash = hash(n);
		});
	if (change === "observation")
		input.observation = changed(f, f.observation, (p) => {
			p.jobId = taskId;
		});
	if (change === "outcome")
		input.outcome = changed(f, f.outcome, (p) => {
			p.observationRef = ref("LOCAL_FLOW_CONTEXT_V1", "wrong");
		});
	if (change === "fake-expectation")
		input.expectation = { ...f.real.expectation };
	expect(() => history.admitLocalStoryFlowAcceptedOrigin(input)).toThrowError(
		history.LocalStoryFlowRuntimeHistoryError,
	);
});

it("rejects a self-rehashed START-only row against independent original startedAt", () => {
	const f = runtimeFixture(),
		wrong = changed(f, f.start, (p) => {
			p.startedAtMs = 0;
		});
	expect(() => f.read([wrong])).toThrowError(
		history.LocalStoryFlowRuntimeHistoryError,
	);
	const independent = history.prepareLocalStoryFlowRuntimeIdentity({
		...f.input,
		startedAtMs: 999,
	});
	expect(() =>
		history.readLocalStoryFlowRuntimeHistory({
			identity: independent,
			records: [f.start],
			pins: f.pins([f.start]),
		}),
	).toThrowError(history.LocalStoryFlowRuntimeHistoryError);
});
it("never invokes ownership-bearing input or array getters", () => {
	const f = runtimeFixture(),
		get = vi.fn(() => f.records);
	expect(() =>
		history.readLocalStoryFlowRuntimeHistory({
			identity: f.identity,
			get records() {
				return get();
			},
			pins: f.pins(),
		}),
	).toThrowError(history.LocalStoryFlowRuntimeHistoryError);
	expect(get).not.toHaveBeenCalled();
	const records = [f.start];
	Object.defineProperty(records, "0", { get: () => get(), enumerable: true });
	expect(() => f.read(records, f.pins([f.start]))).toThrowError(
		history.LocalStoryFlowRuntimeHistoryError,
	);
	expect(get).not.toHaveBeenCalled();
});
it("rejects a fixed accepted origin completed outside its historical deadline", () => {
	const f = runtimeFixture(19),
		outcome = changed(f, f.outcome, (p) => {
			p.completedAtMs = 5401000;
		});
	expect(() =>
		history.admitLocalStoryFlowAcceptedOrigin({
			identity: f.identity,
			expectation: f.real.expectation,
			start: f.start,
			attempt: f.attempt,
			outcome,
			observation: f.observation,
		}),
	).toThrowError(history.LocalStoryFlowRuntimeHistoryError);
});
it("keeps only the nine fixed failure codes", () => {
	for (const code of [
		"LOCAL_STORY_FLOW_NATIVE_UNCONFIRMED",
		"LOCAL_STORY_FLOW_NO_PROGRESS",
		"LOCAL_STORY_FLOW_BUDGET_EXHAUSTED",
		"LOCAL_STORY_FLOW_DEADLINE_EXCEEDED",
		"LOCAL_STORY_ARTIFACT_UNVERIFIED",
		"LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		"LOCAL_SEMANTIC_JOB_FAILED",
		"CANCELED",
		"SOURCE_CHANGED",
	]) {
		expect(history.isLocalStoryFlowRuntimeFailureCode(code)).toBe(true);
	}
	for (const value of ["PRIVATE_SENTINEL", null, {}, 17])
		expect(history.isLocalStoryFlowRuntimeFailureCode(value)).toBe(false);
});

it.each([
	{ field: "cleanupStatus", value: ["UNCONFIRMED"] },
	{ field: "cleanupStatus", value: { state: "UNCONFIRMED" } },
	{ field: "failureCode", value: ["CANCELED"] },
	{ field: "failureCode", value: { code: "CANCELED" } },
])("rejects malformed FAILED $field without coercing an array/object", ({
	field,
	value,
}) => {
	const f = runtimeFixture(),
		a = localStoryFlowSealedRecordEvidence(f.attempt),
		s = localStoryFlowSealedRecordEvidence(f.start);
	const body: Record<string, unknown> = {
		version: "local-story-flow-runtime-outcome-v1",
		purpose: "OUTCOME",
		taskId,
		startRef: s.ref,
		attemptRef: a.ref,
		slot: 1,
		completedAtMs: 1002,
		status: "FAILED",
		failureCode: "CANCELED",
		cleanupStatus: "UNCONFIRMED",
		observationRef: null,
	};
	body[field] = value;
	const outcome = sealed(
		f,
		history.localStoryFlowRuntimeKey(f.identity, {
			purpose: "OUTCOME",
			slot: 1,
		}),
		body,
	);
	expect(() => f.read([f.start, f.attempt, outcome])).toThrowError(
		history.LocalStoryFlowRuntimeHistoryError,
	);
});
