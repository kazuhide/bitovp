import { createHash } from "node:crypto";
import {
	buildLocalStoryChunks,
	buildLocalStoryInput,
	type CaptionTimingEvidence,
	type CompositionSourceSegment,
	type GenerationTaskParameters,
	hashEditingEvidence,
	LOCAL_STORY_FAILURE_RULES,
	LOCAL_STORY_PLAN_VALIDATION_POLICY,
	type LocalSemanticConfiguration,
	type LocalSemanticReceipt,
	LocalStoryError,
	type LocalStoryEvidence,
	type LocalStoryLedger,
	type LocalStoryModelIdentity,
	type LocalStorySelectionResult,
	localSemanticJobRequestSchema,
	localSemanticReceiptSchema,
	localSemanticStageRegistry,
	localStoryBlueprintCoherenceIssues,
	localStoryEvidenceSchema,
	localStoryIdentityForConfiguration,
	localStoryPlanNeedsExpansion,
	localStorySelectedPlanIssues,
	mergeLocalStoryLedgers,
	type PreparedShotPartition,
	type RevalidatedFlowLedgerRef,
	selectLocalStoryClips,
	TRANSCRIPTION_POLICY_FINGERPRINT,
	usesGeneratedCaptions,
	validateLocalStoryBlueprint,
	validateLocalStoryLedger,
} from "@bitovp/core";
import {
	createLocalStoryLegacyLedgerStageRecipe,
	LocalStoryLegacyLedgerError,
} from "@bitovp/core/local-story-flow-server";
import type { AppPrismaClient, LibraryMediaTask } from "@bitovp/db";
import {
	createLocalSemanticClient,
	localSemanticJobId,
} from "./local-semantic-client";
import { createLocalStoryArtifactStore } from "./local-story-artifacts";
import { localAsrQuoteRepairPrompt } from "./local-story-asr-quote-repair";
import { prepareLocalBlueprintPrompt } from "./local-story-blueprint-prompt";
import {
	type LocalStoryChoiceProbe,
	planLocalStoryChoice,
	requireLocalStoryChoiceGateway,
} from "./local-story-choice-plan";
import {
	createLegacyLocalStoryLedgerCache,
	createLegacyV2LocalStoryLedgerCache,
	createLegacyV3LocalStoryLedgerCache,
	createLocalStoryLedgerCache,
	LOCAL_STORY_LEDGER_VALIDATION_POLICY,
} from "./local-story-ledger-cache";
import {
	LOCAL_LEDGER_GENERIC_REPAIR_SUFFIX,
	type LocalBlueprintRepairMeta,
	localBlueprintCoherenceRepairInstruction,
	localBlueprintExpansionRepairInstruction,
	localBlueprintFitRepairInstruction,
	localBlueprintRoleConflicts,
	localBlueprintRoleRepairInstruction,
	localBlueprintSchemaRepairInstruction,
	localLedgerPrompt,
	localNumericLedgerRepairPrompt,
	localStructuredLedgerRepairPrompt,
} from "./local-story-prompts";
import {
	diagnoseLocalStoryQuotes,
	type LocalStoryLedgerAttemptFamily,
	type LocalStoryQuoteDiagnostic,
	localStoryQuoteDiagnosticsProgress,
} from "./local-story-quote-diagnostics";
import { prepareLocalStoryTranscript } from "./local-story-transcript";
import type { VerifiedMediaTask } from "./media-task-execution";
import { MediaOperationError } from "./process";

type LegacyStoryStage = "LOCAL_LEDGER_V1" | "LOCAL_BLUEPRINT_V1";
class NativeBlueprintSchemaError extends LocalStoryError {
	constructor() {
		super(
			"LOCAL_STORY_BLUEPRINT_INVALID",
			"BLUEPRINT_REFS_OR_DEPENDENCIES_INVALID",
		);
	}
}
type StoredLegacyStoryStage<T> = {
	version: "local-semantic-stage-result-v1";
	requestKey: string;
	output: T;
	receipt: LocalSemanticReceipt;
};
type SharedLedgerStageRecipe<T> = {
	key: ReturnType<typeof createLocalStoryLegacyLedgerStageRecipe>["key"];
	bodyFor: ReturnType<
		typeof createLocalStoryLegacyLedgerStageRecipe
	>["bodyFor"];
	parse(value: unknown): StoredLegacyStoryStage<T>;
};
function legacyLedgerStage<T>(work: () => T): T {
	try {
		return work();
	} catch (error) {
		if (error instanceof LocalStoryLegacyLedgerError)
			throw new MediaOperationError(error.code);
		throw error;
	}
}

export type LocalStoryPlanContext = {
	task: LibraryMediaTask;
	verified: VerifiedMediaTask;
	parameters: GenerationTaskParameters;
	leaseToken: string;
	sourcePath: string;
	hasAudio: boolean;
	preparedPartition?: PreparedShotPartition;
	signal: AbortSignal;
	onProgress(phase: string, progress?: Record<string, unknown>): Promise<void>;
};
export type LocalStoryGeneration = {
	selection: LocalStorySelectionResult;
	evidence: LocalStoryEvidence;
	segments: CompositionSourceSegment[];
	transcriptLanguage?: string;
	transcriptLanguageWindows?: readonly {
		startUs: number;
		endUs: number;
		language: string;
	}[];
	captionTimingEvidence?: CaptionTimingEvidence;
	speechIntervals?: { startUs: number; endUs: number }[];
	warnings: string[];
	metrics: Record<string, number>;
};
export type LocalStoryEngine = {
	identity: LocalStoryModelIdentity;
	plan(context: LocalStoryPlanContext): Promise<LocalStoryGeneration>;
};
export type PreparedLocalStoryFullSource = {
	model: LocalStoryModelIdentity;
	input: ReturnType<typeof buildLocalStoryInput>;
	inputHash: string;
	chunks: ReturnType<typeof buildLocalStoryChunks>;
	ledgers: LocalStoryLedger[];
	ledger: LocalStoryEvidence["ledger"];
	ledgerHash: string;
	ledgerRefs: RevalidatedFlowLedgerRef[];
	transcript: Awaited<ReturnType<typeof prepareLocalStoryTranscript>>;
	store: ReturnType<typeof createLocalStoryArtifactStore>;
	metrics: Record<string, number>;
	counters: { cachedStages: number; executedStages: number };
};
export function localStoryArtifactHash(
	evidence: Pick<
		LocalStoryEvidence,
		"model" | "inputHash" | "ledgerHash" | "blueprintHash"
	>,
) {
	return hashEditingEvidence({
		version: "local-story-artifact-v1",
		model: evidence.model,
		inputHash: evidence.inputHash,
		ledgerHash: evidence.ledgerHash,
		blueprintHash: evidence.blueprintHash,
	});
}
const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

/** Full-source semantic work lives outside the publication transaction and editor gestures. */
export function createLocalStoryEngine(options: {
	prisma: AppPrismaClient;
	config: LocalSemanticConfiguration;
	model?: { path: string; sha256: string };
	ffmpegPath?: string;
	client?: Pick<ReturnType<typeof createLocalSemanticClient>, "run">;
	env?: Record<string, string | undefined>;
	choiceProbe?: LocalStoryChoiceProbe;
}): LocalStoryEngine & {
	prepareFullSource(
		context: LocalStoryPlanContext,
	): Promise<PreparedLocalStoryFullSource>;
} {
	const identity = Object.freeze(
		localStoryIdentityForConfiguration(options.config),
	);
	const stages = localSemanticStageRegistry().stages;
	const client = options.client ?? createLocalSemanticClient(options.config);
	async function prepare(
		context: LocalStoryPlanContext,
		requireReadyTranscript: boolean,
	) {
		const { task, verified, parameters, signal } = context;
		signal.throwIfAborted();
		if (!verified.media.sha256 || parameters.policy !== "LOCAL_STORY")
			throw new MediaOperationError("TASK_INTENT_INVALID");
		if (
			verified.envelope.identity.transcriptionPolicyFingerprint !== undefined &&
			verified.envelope.identity.transcriptionPolicyFingerprint !==
				TRANSCRIPTION_POLICY_FINGERPRINT
		)
			throw new MediaOperationError("ASR_QUALITY_POLICY_CHANGED");
		if (
			options.model &&
			options.model.sha256 !== verified.envelope.identity.modelSha256
		)
			throw new MediaOperationError("ASR_MODEL_CHANGED");
		const store = createLocalStoryArtifactStore({
			prisma: options.prisma,
			task,
			verified,
			leaseToken: context.leaseToken,
			signal,
		});
		const metrics: Record<string, number> = {};
		const transcript = await prepareLocalStoryTranscript({
			store,
			sourcePath: context.sourcePath,
			mediaSha256: verified.media.sha256,
			timeMap: verified.map,
			model: options.model,
			language: parameters.language,
			signal,
			hasAudio: context.hasAudio,
			// Keep the shared FLOW/historical full-source projection unchanged.
			includeSpeechIntervals: !requireReadyTranscript,
			includeCaptionLanguage:
				!requireReadyTranscript && usesGeneratedCaptions(parameters.captions),
			ffmpegPath: options.ffmpegPath,
			onProgress: (progress) =>
				context.onProgress("TRANSCRIBING_STORY", progress),
		});
		if (requireReadyTranscript) signal.throwIfAborted();
		if (
			verified.envelope.identity.transcriptionPolicyFingerprint !== undefined &&
			transcript.qualityPolicyFingerprint !==
				verified.envelope.identity.transcriptionPolicyFingerprint
		)
			throw new MediaOperationError("ASR_QUALITY_POLICY_CHANGED");
		if (
			requireReadyTranscript &&
			context.hasAudio &&
			transcript.status !== "READY"
		)
			throw new MediaOperationError("LOCAL_STORY_TRANSCRIPT_REQUIRED");
		metrics.localStoryTranscriptCached = transcript.cached ? 1 : 0;
		const input = buildLocalStoryInput({
			analysis: verified.analysisDocument,
			timeMap: verified.map,
			preparedPartition: context.preparedPartition,
			segments: transcript.segments,
		});
		const chunks = buildLocalStoryChunks(input),
			inputHash = hashEditingEvidence(input);
		if (!chunks.length)
			throw new MediaOperationError("LOCAL_STORY_PLAN_UNAVAILABLE");
		let cachedStages = 0,
			executedStages = 0;
		async function terminalFailure(
			error: unknown,
			stage: "LOCAL_LEDGER_V1" | "LOCAL_BLUEPRINT_V1" | "LOCAL_STORY_CHOICE_V1",
			chunkIndex?: number,
			diagnostics: readonly LocalStoryQuoteDiagnostic[] = [],
		): Promise<never> {
			// Preserve abort/cleanup precedence and the callback's lease/cancel fence.
			if (
				signal.aborted ||
				(object(error) && error.code === "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED")
			)
				throw error;
			const rule =
				error instanceof LocalStoryError
					? (LOCAL_STORY_FAILURE_RULES.find((rule) => rule === error.rule) ??
						"UNCLASSIFIED")
					: error instanceof Error && error.name === "ZodError"
						? "SCHEMA_INVALID"
						: "UNCLASSIFIED";
			let quoteAttempts: ReturnType<typeof localStoryQuoteDiagnosticsProgress>;
			try {
				quoteAttempts = localStoryQuoteDiagnosticsProgress(diagnostics);
			} catch {
				// A diagnostic projection cannot replace validation or cleanup failures.
			}
			await context.onProgress(
				stage === "LOCAL_LEDGER_V1"
					? "ANALYZING_LOCAL_STORY"
					: "PLANNING_LOCAL_STORY",
				{
					completedChunks: chunkIndex ?? chunks.length,
					totalChunks: chunks.length,
					cachedStages,
					localStoryFailure: {
						stage,
						...(chunkIndex === undefined ? {} : { chunkIndex }),
						rule,
						...(quoteAttempts ? { quoteAttempts } : {}),
					},
				},
			);
			throw error;
		}
		async function stageArtifact<T>(
			stageName: LegacyStoryStage,
			stageInput: unknown,
			prompt: string,
			parseOutput: (value: unknown) => T,
			cacheOnly = false,
			onOutputRejected?: (error: unknown, value: unknown) => void,
			sharedRecipe?: SharedLedgerStageRecipe<T>,
			decodeNativeOutput?: (value: unknown) => unknown,
		) {
			const definition = stages[stageName],
				stageInputHash = hashEditingEvidence(stageInput);
			const promptHash = createHash("sha256").update(prompt).digest("hex");
			const key = sharedRecipe?.key ?? {
				identity,
				stage: stageName,
				inputHash: stageInputHash,
				promptHash,
				schemaHash: definition.schemaHash,
			};
			const requestKey = localSemanticJobId(task.id, hashEditingEvidence(key));
			const legacyBody = (key: string) =>
				localSemanticJobRequestSchema.parse({
					version: "bitovp-semantic-job-v1",
					organizationId: task.organizationId,
					requestKey: key,
					profile: identity.profile,
					stage: stageName,
					prompt,
					inputHash: stageInputHash,
					promptVersion: identity.promptVersion,
					schemaHash: definition.schemaHash,
				});
			const body = sharedRecipe?.bodyFor ?? legacyBody;
			type Stored = StoredLegacyStoryStage<T>;
			const legacyParse = (value: unknown): Stored => {
				if (
					!object(value) ||
					Object.keys(value).length !== 4 ||
					value.version !== "local-semantic-stage-result-v1" ||
					typeof value.requestKey !== "string"
				)
					throw new MediaOperationError("LOCAL_STORY_ARTIFACT_UNVERIFIED");
				const request = body(value.requestKey),
					receipt = localSemanticReceiptSchema.parse(value.receipt);
				if (
					receipt.profile !== identity.profile ||
					receipt.promptHash !== promptHash ||
					receipt.inputHash !== stageInputHash ||
					receipt.schemaHash !== definition.schemaHash ||
					receipt.requestHash !== hashEditingEvidence(request) ||
					receipt.promptVersion !== identity.promptVersion ||
					receipt.maxOutputTokens !== definition.maxOutputTokens
				)
					throw new MediaOperationError("LOCAL_STORY_ARTIFACT_UNVERIFIED");
				return {
					version: "local-semantic-stage-result-v1",
					requestKey: value.requestKey,
					output: parseOutput(value.output),
					receipt,
				};
			};
			const parse = sharedRecipe?.parse ?? legacyParse;
			const artifact = await store.load({
				kind:
					stageName === "LOCAL_LEDGER_V1"
						? "LOCAL_STORY_LEDGER_V1"
						: "LOCAL_STORY_BLUEPRINT_V1",
				key,
				parse,
				build: async () => {
					if (cacheOnly)
						throw new MediaOperationError("LOCAL_STORY_ARTIFACT_UNVERIFIED");
					const result = await client.run({ ...body(requestKey), signal });
					let output: T;
					try {
						const decoded = decodeNativeOutput
							? decodeNativeOutput(result.content)
							: result.content;
						output = parseOutput(decoded);
					} catch (error) {
						try {
							onOutputRejected?.(error, result.content);
						} catch {
							// Best-effort observers never alter the rejected result or its error.
						}
						if (
							stageName === "LOCAL_BLUEPRINT_V1" &&
							error instanceof Error &&
							error.name === "ZodError"
						)
							throw new NativeBlueprintSchemaError();
						throw error;
					}
					return {
						version: "local-semantic-stage-result-v1" as const,
						requestKey,
						output,
						receipt: result.receipt,
					};
				},
			});
			return artifact;
		}
		async function stage<T>(
			stageName: LegacyStoryStage,
			stageInput: unknown,
			prompt: string,
			parseOutput: (value: unknown) => T,
			decodeNativeOutput?: (value: unknown) => unknown,
		) {
			const result = await stageArtifact(
				stageName,
				stageInput,
				prompt,
				parseOutput,
				false,
				undefined,
				undefined,
				decodeNativeOutput,
			);
			if (result.cached) cachedStages++;
			else executedStages++;
			return result.value.output;
		}
		const ledgers: LocalStoryLedger[] = [],
			ledgerRefs: RevalidatedFlowLedgerRef[] = [];
		for (const [index, chunk] of chunks.entries()) {
			await context.onProgress("ANALYZING_LOCAL_STORY", {
				completedChunks: index,
				totalChunks: chunks.length,
				cachedStages,
			});
			const cache = createLocalStoryLedgerCache({
				identity,
				input,
				chunk,
				transcriptFingerprint: transcript.fingerprint,
				definition: stages.LOCAL_LEDGER_V1,
				validationPolicyVersion: LOCAL_STORY_LEDGER_VALIDATION_POLICY,
			});
			const legacyOptions = {
				identity,
				input,
				chunk,
				transcriptFingerprint: transcript.fingerprint,
				definition: stages.LOCAL_LEDGER_V1,
			};
			const predecessors = [
				createLegacyV3LocalStoryLedgerCache(legacyOptions),
				createLegacyV2LocalStoryLedgerCache(legacyOptions),
				createLegacyLocalStoryLedgerCache(legacyOptions),
			];

			const ledgerStageArtifact = (
				prompt: string,
				parseOutput: (value: unknown) => LocalStoryLedger,
				cacheOnly = false,
				onOutputRejected?: (error: unknown, value: unknown) => void,
			) => {
				const recipe = legacyLedgerStage(() =>
					createLocalStoryLegacyLedgerStageRecipe({
						identity,
						input,
						chunk,
						transcriptFingerprint: transcript.fingerprint,
						definition: stages.LOCAL_LEDGER_V1,
						organizationId: task.organizationId,
						prompt,
					}),
				);
				return stageArtifact(
					"LOCAL_LEDGER_V1",
					cache.stageInput,
					prompt,
					parseOutput,
					cacheOnly,
					onOutputRejected,
					{
						...recipe,
						parse: (value: unknown) =>
							legacyLedgerStage(() => recipe.parse(value)),
					},
				);
			};
			const built: {
				value?: { prompt: string; ledger: LocalStoryLedger; cached: boolean };
			} = {};
			const diagnostics: LocalStoryQuoteDiagnostic[] = [];
			const observeQuoteFailure = (
				error: unknown,
				ledger: unknown,
				attempt: 1 | 2 | 3,
				family: LocalStoryLedgerAttemptFamily,
			) => {
				if (
					signal.aborted ||
					diagnostics.length === 3 ||
					!(error instanceof LocalStoryError) ||
					error.code !== "LOCAL_STORY_EVIDENCE_INVALID" ||
					error.rule !== "QUOTE_NOT_EXACT_SOURCE_SUBSTRING"
				)
					return;
				try {
					const diagnostic = diagnoseLocalStoryQuotes({
						error,
						ledger,
						input,
						chunk,
						attempt,
						family,
					});
					if (diagnostic) diagnostics.push(diagnostic);
				} catch {
					// Preserve the original validation error and the existing repair control flow.
				}
			};
			const pending = store.load({
				kind: "LOCAL_STORY_LEDGER_V1",
				key: cache.key,
				parse: cache.parse,
				build: async () => {
					const accept = (
						result: {
							value: { output: LocalStoryLedger };
							cached: boolean;
						},
						prompt: string,
					) => {
						built.value = {
							prompt,
							ledger: result.value.output,
							cached: result.cached,
						};
						return cache.pointer(prompt);
					};
					// This build runs only after a valid absence of the NEW pointer.
					// Only this invocation's build sentinel means the old pointer is absent.
					for (const legacy of predecessors) {
						const missing = {};
						const previous = await store
							.load({
								kind: "LOCAL_STORY_LEDGER_V1",
								key: legacy.key,
								parse: legacy.parse,
								build: async () => {
									throw missing;
								},
							})
							.catch((error: unknown) => {
								if (error === missing) return undefined;
								throw error;
							});
						if (previous) {
							const prompt = previous.value.prompt;
							return accept(
								await ledgerStageArtifact(
									prompt,
									(value) =>
										validateLocalStoryLedger({ input, chunk, ledger: value }),
									true,
								),
								prompt,
							);
						}
					}
					let invalidLedger: unknown;
					let firstEvidenceFailure = false;
					let numericRepair: string | undefined;
					let quoteRepair: string | undefined;
					for (let attempt = 0; attempt < 2; attempt++) {
						invalidLedger = undefined;
						const parseLedger = (value: unknown) => {
							invalidLedger = value;
							return validateLocalStoryLedger({
								input,
								chunk,
								ledger: value,
							});
						};
						try {
							const family: LocalStoryLedgerAttemptFamily =
								attempt === 0
									? "BASE"
									: numericRepair
										? "NUMERIC"
										: quoteRepair
											? "QUOTE"
											: "GENERIC";
							const prompt =
								numericRepair ??
								quoteRepair ??
								localLedgerPrompt(chunk) +
									(attempt ? LOCAL_LEDGER_GENERIC_REPAIR_SUFFIX : "");
							return accept(
								await ledgerStageArtifact(
									prompt,
									parseLedger,
									false,
									(error, value) =>
										observeQuoteFailure(
											error,
											value,
											attempt === 0 ? 1 : 2,
											family,
										),
								),
								prompt,
							);
						} catch (error) {
							if (
								!attempt &&
								error instanceof LocalStoryError &&
								error.code === "LOCAL_STORY_EVIDENCE_UNSUPPORTED"
							) {
								signal.throwIfAborted();
								numericRepair = localNumericLedgerRepairPrompt(chunk);
								if (numericRepair) continue;
							}
							const evidenceInvalid =
								error instanceof LocalStoryError &&
								error.code === "LOCAL_STORY_EVIDENCE_INVALID";
							if (
								!attempt &&
								evidenceInvalid &&
								error.rule === "QUOTE_NOT_EXACT_SOURCE_SUBSTRING"
							) {
								signal.throwIfAborted();
								quoteRepair = localStructuredLedgerRepairPrompt({
									input,
									chunk,
									family: "QUOTE",
								});
								if (!quoteRepair)
									throw new MediaOperationError("LOCAL_STORY_CONTEXT_LIMIT");
							}
							if (attempt && firstEvidenceFailure && evidenceInvalid) {
								signal.throwIfAborted();
								const eligibleAsrPrompt = localAsrQuoteRepairPrompt({
									input,
									chunk,
									ledger: invalidLedger,
								});
								if (eligibleAsrPrompt) {
									const prompt = localStructuredLedgerRepairPrompt({
										input,
										chunk,
										family: "ASR",
									});
									if (!prompt)
										throw new MediaOperationError("LOCAL_STORY_CONTEXT_LIMIT");
									return accept(
										await ledgerStageArtifact(
											prompt,
											parseLedger,
											false,
											(error, value) =>
												observeQuoteFailure(error, value, 3, "ASR"),
										),
										prompt,
									);
								}
							}
							firstEvidenceFailure = !attempt && evidenceInvalid;
							if (
								attempt ||
								!(
									(error instanceof LocalStoryError &&
										error.code === "LOCAL_STORY_EVIDENCE_INVALID") ||
									(error instanceof Error && error.name === "ZodError")
								)
							)
								throw error;
						}
					}
					throw new MediaOperationError("LOCAL_STORY_PLAN_UNAVAILABLE");
				},
			});
			const accepted = await pending.catch((error: unknown) =>
				terminalFailure(error, "LOCAL_LEDGER_V1", index, diagnostics),
			);
			const created = built.value;
			const resolved =
				created?.prompt === accepted.value.prompt
					? created
					: {
							ledger: (
								await ledgerStageArtifact(
									accepted.value.prompt,
									(value) =>
										validateLocalStoryLedger({ input, chunk, ledger: value }),
									true,
								).catch((error: unknown) =>
									terminalFailure(error, "LOCAL_LEDGER_V1", index),
								)
							).value.output,
							cached: true,
						};
			if (accepted.cached || resolved.cached) cachedStages++;
			else executedStages++;
			ledgers.push(resolved.ledger);
			const reference: RevalidatedFlowLedgerRef = {
				chunkIndex: index,
				stageInputHash: hashEditingEvidence(cache.stageInput),
				promptHash: createHash("sha256")
					.update(accepted.value.prompt)
					.digest("hex"),
				schemaHash: stages.LOCAL_LEDGER_V1.schemaHash,
				stageKeyHash: accepted.value.stageKeyHash,
				ledgerHash: hashEditingEvidence(resolved.ledger),
			};
			if (
				reference.stageKeyHash !==
				hashEditingEvidence({
					identity,
					stage: "LOCAL_LEDGER_V1",
					inputHash: reference.stageInputHash,
					promptHash: reference.promptHash,
					schemaHash: reference.schemaHash,
				})
			)
				throw new MediaOperationError("LOCAL_STORY_ARTIFACT_UNVERIFIED");
			ledgerRefs.push(reference);
		}
		const ledger = mergeLocalStoryLedgers({ input, chunks, ledgers }),
			ledgerHash = hashEditingEvidence(ledger);
		const full: PreparedLocalStoryFullSource = {
			model: identity,
			input,
			inputHash,
			chunks,
			ledgers,
			ledger,
			ledgerHash,
			ledgerRefs,
			transcript,
			store,
			metrics,
			counters: { cachedStages, executedStages },
		};
		return {
			full,
			stage,
			terminalFailure,
			getCounters: () => ({ cachedStages, executedStages }),
		};
	}
	return {
		identity,
		async prepareFullSource(context) {
			const { full } = await prepare(context, true);
			const { store, ...data } = full;
			return { ...structuredClone(data), store };
		},
		async plan(context) {
			if (context.parameters.storyPlanner === "FEASIBLE_CHOICE_V1")
				await requireLocalStoryChoiceGateway({
					config: options.config,
					signal: context.signal,
					env: options.env ?? process.env,
					probe: options.choiceProbe,
				});
			const { full, stage, terminalFailure, getCounters } = await prepare(
				context,
				false,
			);
			if (context.parameters.storyPlanner === "FEASIBLE_CHOICE_V1") {
				try {
					return await planLocalStoryChoice({
						context,
						full,
						identity,
						client,
						artifactHash: localStoryArtifactHash,
					});
				} catch (error) {
					return terminalFailure(error, "LOCAL_STORY_CHOICE_V1");
				}
			}
			const {
				input,
				inputHash,
				chunks,
				ledger,
				ledgerHash,
				transcript,
				metrics,
			} = full;
			const { parameters, signal } = context;
			let repair: string | undefined;
			let repairMeta: LocalBlueprintRepairMeta | undefined;
			let bestShortPlan: LocalStoryGeneration | undefined;
			let roleConflicts: ReturnType<typeof localBlueprintRoleConflicts>;
			for (let attempt = 0; attempt < 3; attempt++) {
				metrics.localStoryPlanRepairs = attempt;
				await context.onProgress("PLANNING_LOCAL_STORY", {
					completedChunks: chunks.length,
					totalChunks: chunks.length,
					attempt,
				});
				const promptOptions = {
					input,
					ledger,
					mode: parameters.storyMode ?? "AUTO",
					targetDurationFrames: parameters.targetDurationFrames,
					...(repair ? { repair } : {}),
					...(repairMeta ? { repairMeta } : {}),
					...(roleConflicts ? { roleConflicts } : {}),
				};
				let invalidBlueprint: unknown;
				try {
					const preparedPrompt = prepareLocalBlueprintPrompt(promptOptions);
					const blueprint = await stage(
						"LOCAL_BLUEPRINT_V1",
						{
							planningPolicyVersion: LOCAL_STORY_PLAN_VALIDATION_POLICY,
							inputHash,
							ledgerHash,
							mode: promptOptions.mode,
							targetDurationFrames: parameters.targetDurationFrames,
							repair: repair ?? null,
							...(roleConflicts ? { roleConflicts } : {}),
						},
						preparedPrompt.prompt,
						(value) => {
							invalidBlueprint = value;
							const parsed = validateLocalStoryBlueprint({
								ledger,
								blueprint: value,
							});
							if (
								promptOptions.mode !== "AUTO" &&
								parsed.mode !== promptOptions.mode
							)
								throw new MediaOperationError("LOCAL_STORY_MODE_MISMATCH");
							if (localStoryBlueprintCoherenceIssues(parsed).length)
								throw new LocalStoryError(
									"LOCAL_STORY_BLUEPRINT_COHERENCE_INVALID",
								);
							return parsed;
						},
						preparedPrompt.decodeNativeOutput,
					);
					const selection = selectLocalStoryClips({
						input,
						ledger,
						blueprint,
						targetDurationFrames: parameters.targetDurationFrames,
					});
					if (
						localStorySelectedPlanIssues({
							input,
							ledger,
							blueprint,
							selection,
						}).length
					)
						throw new LocalStoryError(
							"LOCAL_STORY_SELECTION_COHERENCE_INVALID",
						);
					const blueprintHash = hashEditingEvidence(blueprint);
					const evidence = localStoryEvidenceSchema.parse({
						version: "local-story-evidence-v1",
						method: "LOCAL_LLM_BEAT_PLAN",
						model: identity,
						inputHash,
						ledgerHash,
						blueprintHash,
						artifactHash: localStoryArtifactHash({
							model: identity,
							inputHash,
							ledgerHash,
							blueprintHash,
						}),
						ledger,
						blueprint,
						selection: selection.localStorySelection,
						inputCoverage: {
							totalShots: input.coverage.length,
							eligibleShots: input.shots.length,
							processedShots: ledger.coveredRefs.length,
							excludedShots: input.coverage.length - input.shots.length,
							truncated: false,
						},
					});
					Object.assign(metrics, {
						localStoryChunks: chunks.length,
						localStoryStagesExecuted: getCounters().executedStages,
						localStoryStagesCached: getCounters().cachedStages,
						localStoryPlanRepairs: attempt,
						localStorySourceShots: input.coverage.length,
						localStoryProcessedShots: ledger.coveredRefs.length,
					});
					const candidate: LocalStoryGeneration = {
						selection,
						evidence,
						segments: transcript.segments,
						...(transcript.language
							? { transcriptLanguage: transcript.language }
							: {}),
						...(transcript.languageWindows
							? { transcriptLanguageWindows: transcript.languageWindows }
							: {}),
						...(transcript.captionTimingEvidence
							? { captionTimingEvidence: transcript.captionTimingEvidence }
							: {}),
						...(transcript.speechIntervals
							? { speechIntervals: transcript.speechIntervals }
							: {}),
						warnings: [
							...transcript.warnings,
							"LOCAL_STORY_VISUAL_GROUNDING_PENDING",
						],
						metrics,
					};
					if (localStoryPlanNeedsExpansion(input, ledger, selection)) {
						if (
							!bestShortPlan ||
							candidate.selection.actualDurationFrames >
								bestShortPlan.selection.actualDurationFrames
						)
							bestShortPlan = candidate;
						if (attempt < 2) {
							repairMeta = {
								kind: "EXPAND",
								attempt: attempt + 1,
								actualDurationFrames: selection.actualDurationFrames,
							};
							repair = localBlueprintExpansionRepairInstruction({
								actualDurationFrames: selection.actualDurationFrames,
								targetDurationFrames: parameters.targetDurationFrames,
								attempt: attempt + 1,
							});
							roleConflicts = undefined;
							continue;
						}
						return {
							...bestShortPlan,
							warnings: [
								...bestShortPlan.warnings,
								"LOCAL_STORY_DURATION_LIMITED_BY_EVIDENCE",
							],
						};
					}
					return candidate;
				} catch (error) {
					const schemaMismatch = error instanceof NativeBlueprintSchemaError;
					const roleMismatch =
						error instanceof LocalStoryError &&
						error.code === "LOCAL_STORY_BLUEPRINT_ROLE_MISMATCH";
					const coherenceMismatch =
						error instanceof LocalStoryError &&
						(error.code === "LOCAL_STORY_BLUEPRINT_COHERENCE_INVALID" ||
							error.code === "LOCAL_STORY_SELECTION_COHERENCE_INVALID");
					if (
						!schemaMismatch &&
						!roleMismatch &&
						!coherenceMismatch &&
						(!object(error) || error.code !== "LOCAL_STORY_NO_FITTING_PLAN")
					)
						return terminalFailure(error, "LOCAL_BLUEPRINT_V1");
					signal.throwIfAborted();
					if (attempt === 2) {
						if (bestShortPlan)
							return {
								...bestShortPlan,
								warnings: [
									...bestShortPlan.warnings,
									"LOCAL_STORY_DURATION_LIMITED_BY_EVIDENCE",
								],
							};
						return terminalFailure(error, "LOCAL_BLUEPRINT_V1");
					}
					roleConflicts = roleMismatch
						? localBlueprintRoleConflicts(ledger, invalidBlueprint)
						: undefined;
					if (roleMismatch && !roleConflicts)
						return terminalFailure(error, "LOCAL_BLUEPRINT_V1");
					repairMeta = roleMismatch
						? undefined
						: {
								kind: schemaMismatch
									? "SCHEMA"
									: coherenceMismatch
										? "COHERENCE"
										: "FIT",
								attempt: attempt + 1,
							};
					repair = roleMismatch
						? localBlueprintRoleRepairInstruction(attempt + 1)
						: schemaMismatch
							? localBlueprintSchemaRepairInstruction(attempt + 1)
							: coherenceMismatch
								? localBlueprintCoherenceRepairInstruction(attempt + 1)
								: localBlueprintFitRepairInstruction({
										targetDurationFrames: parameters.targetDurationFrames,
										attempt: attempt + 1,
									});
				}
			}
			throw new MediaOperationError("LOCAL_STORY_PLAN_UNAVAILABLE");
		},
	};
}
