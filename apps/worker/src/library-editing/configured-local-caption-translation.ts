import {
	applyLocalCaptionTranslation,
	buildContextualLocalCaptionBatch,
	buildLocalCaptionTranslationBatches,
	captionTranslationConsistencyKey,
	hashEditingEvidence,
	type LocalSemanticConfiguration,
	localCaptionBatchSource,
	localPlamoCaptionJobRequestSchema,
	localPlamoCaptionReceiptSchema,
	TRANSCRIPTION_POLICY_FINGERPRINT,
	validateContextualLocalCaptionTranslation,
} from "@bitovp/core";
import type { LocalCaptionTranslationSelection } from "@bitovp/core/local-caption-config";
import type { AppPrismaClient } from "@bitovp/db";
import { buildLocalCaptionSceneContexts } from "./local-caption-context";
import {
	createLocalCaptionTranslator,
	type LocalCaptionTranslator,
} from "./local-caption-translation";
import { createLocalPlamoCaptionClient } from "./local-plamo-caption-client";
import { localSemanticJobId } from "./local-semantic-client";
import { createLocalStoryArtifactStore } from "./local-story-artifacts";
import {
	buildPlamoCaptionRequest,
	parsePlamoCaptionOutput,
} from "./plamo-caption-adapter";
import { MediaOperationError } from "./process";

/** Selection is fixed once at worker startup; explicit PLaMo never falls back to Qwen. */
export function createConfiguredLocalCaptionTranslator(options: {
	prisma: AppPrismaClient;
	config: LocalSemanticConfiguration;
	selection: LocalCaptionTranslationSelection;
	plamoClient?: ReturnType<typeof createLocalPlamoCaptionClient>;
}): LocalCaptionTranslator {
	if (options.selection.provider === "QWEN") {
		const translator = createLocalCaptionTranslator(options);
		if (
			hashEditingEvidence(translator.identity) !==
			hashEditingEvidence(options.selection.identity)
		)
			throw new MediaOperationError("LOCAL_CAPTION_MODEL_CHANGED");
		return translator;
	}
	const identity = options.selection.identity;
	if (
		identity.profile !== options.config.profile ||
		identity.manifestHash !== options.selection.manifestHash
	)
		throw new MediaOperationError("LOCAL_CAPTION_MODEL_CHANGED");
	const client =
		options.plamoClient ??
		createLocalPlamoCaptionClient(options.config, identity);
	return {
		identity,
		async translate(context) {
			const started = performance.now(),
				{ signal, task, verified } = context;
			signal.throwIfAborted();
			if (
				hashEditingEvidence(
					verified.envelope.identity.captionTranslationModel,
				) !== hashEditingEvidence(identity)
			)
				throw new MediaOperationError("LOCAL_CAPTION_MODEL_CHANGED");
			if (
				verified.envelope.identity.transcriptionPolicyFingerprint !==
				TRANSCRIPTION_POLICY_FINGERPRINT
			)
				throw new MediaOperationError("ASR_QUALITY_POLICY_CHANGED");
			const batches = buildLocalCaptionTranslationBatches({
				captions: (context.document.captions ?? []).filter(
					(c) =>
						!(
							c.translation?.origin === "MANUAL" &&
							c.translation.sourceText === c.text &&
							c.translation.sourceTextHash === hashEditingEvidence(c.text)
						),
				),
				sourceLanguage: context.sourceLanguage,
				qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
			});
			const store = batches.length
					? createLocalStoryArtifactStore({
							prisma: options.prisma,
							task,
							verified,
							leaseToken: context.leaseToken,
							signal,
						})
					: undefined,
				contexts = buildLocalCaptionSceneContexts({
					document: context.document,
					analysis: verified.analysisDocument,
					mediaVersionId: verified.media.id,
					timeMapId: verified.map.id,
				}),
				acceptedWording = new Map<string, string>(),
				artifactHashes: string[] = [];
			let captions = context.document.captions ?? [],
				cached = 0,
				executed = 0;
			for (const [index, source] of batches.entries()) {
				const batch = buildContextualLocalCaptionBatch({
						batch: source,
						contexts,
						accepted: acceptedWording,
					}),
					inputHash = hashEditingEvidence(batch);
				await context.onProgress("TRANSLATING_CAPTIONS", {
					completedBatches: index,
					totalBatches: batches.length,
				});
				const prepared = batch.cues.map((cue) => {
					const binding = batch.bindings.find((b) => b.id === cue.id);
					if (!binding)
						throw new MediaOperationError("LOCAL_CAPTION_SOURCE_CHANGED");
					const memory = batch.memory.find((m) => m.id === cue.id),
						fields = batch.contextFields.filter((f) =>
							binding.fieldIds.includes(f.id),
						);
					return {
						cue,
						request: buildPlamoCaptionRequest({
							identity,
							cueId: cue.id,
							sourceText: cue.text,
							sourceLanguage: batch.sourceLanguage,
							sourceBindingHash: hashEditingEvidence({
								inputHash,
								cue,
								binding,
							}),
							contextScopeHash: binding.scopeHash,
							...(fields.length
								? {
										context: JSON.stringify(
											fields.map(({ kind, text }) => ({ kind, text })),
										),
									}
								: {}),
							glossary: [],
							history: memory
								? [
										{
											sourceText: cue.text,
											translatedText: memory.text,
											contextScopeHash: binding.scopeHash,
										},
									]
								: [],
						}),
					};
				});
				const key = {
					version: "local-caption-stage-key-v3",
					identity,
					inputHash,
					requests: prepared.map(({ cue, request }) => ({
						id: cue.id,
						inputHash: request.inputHash,
						promptHash: request.promptHash,
					})),
				};
				const body = (index: number, requestKey: string) => {
					const item = prepared[index];
					if (!item)
						throw new MediaOperationError("LOCAL_CAPTION_ARTIFACT_UNVERIFIED");
					return localPlamoCaptionJobRequestSchema.parse({
						version: "bitovp-plamo-caption-job-v1",
						organizationId: task.organizationId,
						requestKey,
						profile: identity.profile,
						stage: "LOCAL_PLAMO_CAPTION_JA_V1",
						prompt: item.request.prompt,
						inputHash: item.request.inputHash,
						promptVersion: identity.promptVersion,
						schemaHash: identity.schemaHash,
						manifestHash: identity.manifestHash,
					});
				};
				const parse = (value: unknown) => {
					try {
						if (
							!value ||
							typeof value !== "object" ||
							Array.isArray(value) ||
							Object.keys(value).sort().join(",") !== "batch,items,version"
						)
							throw Error("shape");
						const raw = value as {
							version: unknown;
							batch: unknown;
							items: unknown;
						};
						if (
							raw.version !== "local-caption-stage-result-v3" ||
							hashEditingEvidence(raw.batch) !== inputHash ||
							!Array.isArray(raw.items) ||
							raw.items.length !== prepared.length
						)
							throw Error("binding");
						const items = raw.items.map((value: unknown, i) => {
							if (
								!value ||
								typeof value !== "object" ||
								Array.isArray(value) ||
								Object.keys(value).sort().join(",") !==
									"content,id,receipt,requestKey"
							)
								throw Error("item");
							const item = value as {
									id: unknown;
									content: unknown;
									receipt: unknown;
									requestKey: unknown;
								},
								expected = prepared[i];
							if (
								!expected ||
								item.id !== expected.cue.id ||
								typeof item.requestKey !== "string" ||
								typeof item.content !== "string"
							)
								throw Error("id");
							const receipt = localPlamoCaptionReceiptSchema.parse(
									item.receipt,
								),
								request = body(i, item.requestKey);
							if (
								hashEditingEvidence(receipt.identity) !==
									hashEditingEvidence(identity) ||
								receipt.requestHash !== hashEditingEvidence(request) ||
								receipt.inputHash !== request.inputHash ||
								receipt.promptHash !== expected.request.promptHash ||
								receipt.schemaHash !== identity.schemaHash ||
								receipt.manifestHash !== identity.manifestHash
							)
								throw Error("proof");
							return {
								id: expected.cue.id,
								requestKey: item.requestKey,
								content: item.content,
								receipt,
							};
						});
						validateContextualLocalCaptionTranslation(batch, {
							translations: items.map((item) =>
								parsePlamoCaptionOutput(item.id, item.content),
							),
						});
						return {
							version: "local-caption-stage-result-v3" as const,
							batch,
							items,
						};
					} catch {
						throw new MediaOperationError("LOCAL_CAPTION_ARTIFACT_UNVERIFIED");
					}
				};
				if (!store)
					throw new MediaOperationError("LOCAL_CAPTION_ARTIFACT_UNVERIFIED");
				const artifact = await store.load({
					kind: "LOCAL_CAPTION_TRANSLATION_V1",
					key,
					parse,
					async build() {
						const items = [];
						for (const [i, item] of prepared.entries()) {
							signal.throwIfAborted();
							const requestKey = localSemanticJobId(
									task.organizationId,
									`plamo-caption:${task.id}:${hashEditingEvidence(key)}:${i}`,
								),
								result = await client.run({
									request: body(i, requestKey),
									signal,
								});
							items.push({ id: item.cue.id, requestKey, ...result });
						}
						return parse({
							version: "local-caption-stage-result-v3",
							batch,
							items,
						});
					},
				});
				const output = validateContextualLocalCaptionTranslation(batch, {
					translations: artifact.value.items.map((item) =>
						parsePlamoCaptionOutput(item.id, item.content),
					),
				});
				if (artifact.cached) cached++;
				else executed += prepared.length;
				captions = applyLocalCaptionTranslation({
					captions,
					batch: localCaptionBatchSource(batch),
					output,
					evidenceHash: artifact.hash,
				});
				artifactHashes.push(artifact.hash);
				for (const translated of output.translations)
					acceptedWording.set(
						captionTranslationConsistencyKey(batch, translated.id),
						translated.text,
					);
			}
			signal.throwIfAborted();
			return {
				document: {
					...context.document,
					captions,
					captionDisplayLanguage: "ja",
				},
				artifactHashes,
				metrics: {
					captionTranslationMs: Math.round(performance.now() - started),
					captionTranslationCachedStages: cached,
					captionTranslationExecutedStages: executed,
				},
			};
		},
	};
}
