import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
	AutomaticBindingError,
	anyEditingDocumentSchema,
	compileEditDocument,
	compositionRenderCanvas,
	type EditingObject,
	editingMediaStorageSchema,
	editingObjectSchema,
	editingRenderProfileSchema,
	verifyAutomaticAnalysisBinding,
} from "@bitovp/core";
import type {
	AppPrismaClient,
	LibraryMediaVersion,
	RenderRun,
} from "@bitovp/db";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { reconcileCapturedBindings } from "../library/captured-bindings";
import { resolveCompositionRenderInput } from "./composition-input";
import {
	adoptEditingArtifact,
	type EditingArtifactEvidence,
	LIBRARY_REGISTRATION_PENDING,
	promoteEditingArtifact,
} from "./derivatives";
import { HLS_PREPARATION_LIMITS, prepareHlsEditingSource } from "./hls-source";
import { downloadPinnedEditingMedia, probeEditingMedia } from "./media";
import { normalizeEditingMedia } from "./normalization";
import { persistPreparedMedia } from "./prepared-media";
import { MediaOperationError } from "./process";
import {
	type CompositionRenderImage,
	type CompositionRenderSource,
	editingRenderCanvas,
	renderCompositionRecipe,
	renderEditingRecipe,
} from "./render";
import {
	logRenderFailureDiagnostic,
	type RenderFailureOperation,
	type RenderFailureStage,
} from "./render-failure-diagnostics";

export const EDITING_HEARTBEAT_MS = 5_000;
export const EDITING_LEASE_MS = 120_000;
export const EDITING_MAX_ATTEMPTS = 3;
export const EDITING_RECOVERY_RETRY_MS = 30_000;
let processQueue: Promise<void> = Promise.resolve();
const activeRenderStates = ["PREPARING", "RENDERING", "VALIDATING"];

type Dependencies = {
	prisma: AppPrismaClient;
	browserFor(credentialId: string): Promise<ObjectStorageBrowser>;
	now?: () => Date;
	signal?: AbortSignal;
	ffmpegPath?: string;
	ffprobePath?: string;
};
type LeaseStatus = "OK" | "CANCELED" | "LEASE_LOST";

function leaseGuard(touch: () => Promise<LeaseStatus>, shutdown?: AbortSignal) {
	const controller = new AbortController();
	const stop = () => controller.abort(new MediaOperationError("LEASE_LOST"));
	shutdown?.addEventListener("abort", stop, { once: true });
	if (shutdown?.aborted) stop();
	let pending: Promise<void> | undefined;
	const checkpoint = (): Promise<void> => {
		if (controller.signal.aborted)
			return Promise.reject(controller.signal.reason);
		pending ??= Promise.resolve()
			.then(touch)
			.then((status) => {
				if (status !== "OK") {
					controller.abort(new MediaOperationError(status));
					throw controller.signal.reason;
				}
			})
			.catch(() => {
				if (!controller.signal.aborted)
					controller.abort(new MediaOperationError("LEASE_LOST"));
				throw controller.signal.reason;
			})
			.finally(() => {
				pending = undefined;
			});
		return pending;
	};
	const timer = setInterval(() => {
		void checkpoint().catch(() => {});
	}, EDITING_HEARTBEAT_MS);
	timer.unref?.();
	return {
		signal: controller.signal,
		checkpoint,
		async close() {
			clearInterval(timer);
			shutdown?.removeEventListener("abort", stop);
			await pending?.catch(() => {});
		},
	};
}

const failureCode = (error: unknown, fallback: string): string => {
	if (error instanceof AutomaticBindingError) return error.code;
	const codes = new Set([
		"CANCELED",
		"LEASE_LOST",
		"SOURCE_UNVERIFIED",
		"SOURCE_TOO_LARGE",
		"SOURCE_CHANGED",
		"SOURCE_INCOMPLETE",
		"HLS_UNSUPPORTED",
		"HLS_LIMIT",
		"UNSUPPORTED_MEDIA",
		"TIMED_OUT",
		"OUTPUT_LIMIT",
		"RENDER_VALIDATION_FAILED",
	]);
	return error instanceof MediaOperationError && codes.has(error.code)
		? error.code
		: fallback;
};
const keyFor = (prefix: string, suffix: string) =>
	`${prefix.replace(/\/+$/, "")}/${suffix}`.replace(/^\/+/, "");

async function outputObject(
	browser: ObjectStorageBrowser,
	credentialId: string,
	bucket: string,
	key: string,
	bytes?: number,
): Promise<EditingObject> {
	if (!browser.headObject) throw new MediaOperationError("OUTPUT_UNVERIFIED");
	const head = await browser.headObject({ bucket, key });
	const versionId =
		head.versionId && head.versionId !== "null" ? head.versionId : undefined;
	if (
		(bytes !== undefined && head.size !== bytes) ||
		!(head.etag || versionId || head.generation)
	)
		throw new MediaOperationError("OUTPUT_UNVERIFIED");
	return editingObjectSchema.parse({
		credentialId,
		bucket,
		key,
		size: head.size,
		expect: {
			...(head.etag ? { etag: head.etag } : {}),
			...(versionId ? { versionId } : {}),
			...(head.generation ? { generation: head.generation } : {}),
		},
	});
}

async function taskResources(deps: Dependencies, signal?: AbortSignal) {
	const directory = await mkdtemp(join(tmpdir(), "bitovp-library-editing-"));
	try {
		await chmod(directory, 0o700);
	} catch {
		await rm(directory, { recursive: true, force: true });
		throw new MediaOperationError("SCRATCH_UNAVAILABLE");
	}
	const browsers = new Map<string, ObjectStorageBrowser>();
	const disposed = new Set<ObjectStorageBrowser>();
	const dispose = (browser: ObjectStorageBrowser) => {
		if (disposed.has(browser)) return;
		disposed.add(browser);
		try {
			browser.dispose?.();
		} catch {
			/* Disposal must not hide file cleanup. */
		}
	};
	const stop = () => {
		for (const browser of browsers.values()) dispose(browser);
	};
	signal?.addEventListener("abort", stop, { once: true });
	if (signal?.aborted) stop();
	return {
		directory,
		async browser(id: string) {
			signal?.throwIfAborted();
			let result = browsers.get(id);
			if (!result) {
				result = await deps.browserFor(id);
				if (signal?.aborted) {
					dispose(result);
					signal.throwIfAborted();
				}
				browsers.set(id, result);
			}
			return result;
		},
		async close() {
			signal?.removeEventListener("abort", stop);
			stop();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

/** The HLS total deadline also covers browser acquisition/PUT, not only downloads and ffmpeg. */
function untilEditingSignal<T>(
	pending: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () =>
			reject(signal.reason ?? new MediaOperationError("CANCELED"));
		signal.addEventListener("abort", abort, { once: true });
		pending.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				if (signal.aborted) abort();
				else resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
		if (signal.aborted) abort();
	});
}

async function prepareMedia(
	deps: Dependencies,
	row: LibraryMediaVersion,
	leaseToken: string,
) {
	const now = deps.now ?? (() => new Date());
	const fence = () => ({
		id: row.id,
		state: "RUNNING",
		leaseToken,
		leaseUntil: { gt: now() },
	});
	const guard = leaseGuard(async () => {
		const owned = await deps.prisma.libraryMediaVersion.updateMany({
			where: fence(),
			data: { leaseUntil: new Date(now().getTime() + EDITING_LEASE_MS) },
		});
		return owned.count ? "OK" : "LEASE_LOST";
	}, deps.signal);
	let resources: Awaited<ReturnType<typeof taskResources>> | undefined;
	let timeoutSignal: AbortSignal | undefined;
	try {
		const storage = editingMediaStorageSchema.parse(row.storage);
		if (storage.sourceFormat === "HLS")
			timeoutSignal = AbortSignal.timeout(HLS_PREPARATION_LIMITS.timeoutMs);
		const signal = timeoutSignal
			? AbortSignal.any([guard.signal, timeoutSignal])
			: guard.signal;
		const awaitOperation = <T>(pending: Promise<T>) =>
			storage.sourceFormat === "HLS"
				? untilEditingSignal(pending, signal)
				: pending;
		resources = await taskResources(deps, signal);
		if (!storage.source.size || !storage.source.expect)
			throw new MediaOperationError("SOURCE_UNVERIFIED");
		const sourceBrowser = await awaitOperation(
			resources.browser(storage.source.credentialId),
		);
		const sourcePath = join(resources.directory, "source.mp4");
		await guard.checkpoint();
		const capturedHls =
			storage.sourceFormat === "HLS"
				? await prepareHlsEditingSource({
						browser: sourceBrowser,
						source: storage.source,
						rootPrefix: storage.hlsRootPrefix ?? "",
						directory: resources.directory,
						signal,
						...(deps.ffmpegPath ? { ffmpegPath: deps.ffmpegPath } : {}),
						...(deps.ffprobePath ? { ffprobePath: deps.ffprobePath } : {}),
					})
				: undefined;
		const downloaded =
			capturedHls ??
			(await downloadPinnedEditingMedia({
				browser: sourceBrowser,
				bucket: storage.source.bucket,
				key: storage.source.key,
				destinationPath: sourcePath,
				expectedIdentity: {
					...storage.source.expect,
					size: storage.source.size,
				},
				signal: guard.signal,
			}));
		await guard.checkpoint();
		const normalized = await normalizeEditingMedia({
			sourcePath,
			destinationPath: join(resources.directory, "normalized.mp4"),
			expectedSourceSha256: downloaded.sha256,
			signal,
			...(deps.ffmpegPath ? { ffmpegPath: deps.ffmpegPath } : {}),
			...(deps.ffprobePath ? { ffprobePath: deps.ffprobePath } : {}),
		});
		const facts = capturedHls
			? {
					...normalized.facts,
					probe: {
						...normalized.facts.probe,
						sourceMaterialization: capturedHls.witness,
					},
				}
			: normalized.facts;
		await guard.checkpoint();
		const outputBrowser = await awaitOperation(
			resources.browser(storage.output.credentialId),
		);
		if (!outputBrowser.putObject)
			throw new MediaOperationError("OUTPUT_UNVERIFIED");
		const key = keyFor(
			storage.output.prefix,
			`media/${row.id}/${leaseToken}/source.mp4`,
		);
		await awaitOperation(
			outputBrowser.putObject({
				bucket: storage.output.bucket,
				key,
				filePath: normalized.path,
				contentType: "video/mp4",
			}),
		);
		const prepared = await awaitOperation(
			outputObject(
				outputBrowser,
				storage.output.credentialId,
				storage.output.bucket,
				key,
				normalized.bytes,
			),
		);
		await guard.checkpoint();
		await guard.close();
		await persistPreparedMedia({
			prisma: deps.prisma,
			mediaVersionId: row.id,
			organizationId: row.organizationId,
			sourceId: row.sourceId,
			leaseToken,
			now,
			storage,
			prepared,
			facts,
			normalization: normalized.normalization,
			...(storage.sourceFormat === "HLS" ? { signal } : {}),
		});
		if (storage.sourceFormat !== "HLS") {
			await reconcileCapturedBindings({
				prisma: deps.prisma,
				organizationId: row.organizationId,
				sourceId: row.sourceId,
			});
		}
	} catch (error) {
		await guard.close();
		if (!deps.signal?.aborted)
			await deps.prisma.libraryMediaVersion.updateMany({
				where: { id: row.id, state: "RUNNING", leaseToken },
				data: {
					state: "ERROR",
					leaseToken: null,
					leaseUntil: null,
					error:
						timeoutSignal?.aborted && !guard.signal.aborted
							? "TIMED_OUT"
							: failureCode(error, "MEDIA_PREPARATION_FAILED"),
				},
			});
	} finally {
		await guard.close();
		await resources?.close();
	}
}

const isNotFound = (error: unknown): boolean => {
	const value = error as {
		statusCode?: number;
		status?: number;
		$metadata?: { httpStatusCode?: number };
	};
	return (
		value?.statusCode === 404 ||
		value?.status === 404 ||
		value?.$metadata?.httpStatusCode === 404
	);
};

async function renderRun(
	deps: Dependencies,
	previous: RenderRun,
	leaseToken: string,
) {
	const diagnosticStartedAt = performance.now();
	let diagnosticStage: RenderFailureStage = "PREPARING";
	let diagnosticOperation: RenderFailureOperation = "RESOURCE_PREPARATION";
	let diagnosticSchemaVersion: 1 | 2 | null = null;
	const now = deps.now ?? (() => new Date());
	const fence = () => ({
		id: previous.id,
		state: { in: activeRenderStates },
		leaseToken,
		leaseUntil: { gt: now() },
		cancelRequestedAt: null,
	});
	const guard = leaseGuard(async () => {
		const run = await deps.prisma.renderRun.findUnique({
			where: { id: previous.id },
			select: { state: true, cancelRequestedAt: true, leaseToken: true },
		});
		if (!run || run.leaseToken !== leaseToken) return "LEASE_LOST";
		if (run.state === "CANCEL_REQUESTED" || run.cancelRequestedAt)
			return "CANCELED";
		const owned = await deps.prisma.renderRun.updateMany({
			where: fence(),
			data: { leaseUntil: new Date(now().getTime() + EDITING_LEASE_MS) },
		});
		return owned.count ? "OK" : "LEASE_LOST";
	}, deps.signal);
	let resources: Awaited<ReturnType<typeof taskResources>> | undefined;
	let evidence: EditingArtifactEvidence | undefined;
	const artifactToken =
		previous.pendingArtifactToken ??
		(previous.state === "VALIDATING" ? previous.leaseToken : null);
	let uploadMayExist = artifactToken !== null;
	const phase = async (
		state: RenderFailureStage,
		pendingArtifactToken?: string,
	) => {
		diagnosticOperation = "STATE_TRANSITION";
		await guard.checkpoint();
		const changed = await deps.prisma.renderRun.updateMany({
			where: fence(),
			data: {
				state,
				...(pendingArtifactToken ? { pendingArtifactToken } : {}),
			},
		});
		if (!changed.count) {
			await guard.checkpoint();
			throw new MediaOperationError("LEASE_LOST");
		}
		diagnosticStage = state;
	};
	try {
		resources = await taskResources(deps, guard.signal);
		diagnosticOperation = "INPUT_RESOLUTION";
		const [project, revision] = await Promise.all([
			deps.prisma.editProject.findUnique({
				where: { id: previous.projectId },
				include: { mediaVersion: true },
			}),
			deps.prisma.editRevision.findUnique({
				where: { id: previous.revisionId },
			}),
		]);
		if (
			!project ||
			project.archived ||
			!revision ||
			revision.projectId !== project.id ||
			project.mediaVersion.state !== "READY"
		)
			throw new MediaOperationError("INVALID_RENDER_INPUT");
		const media = project.mediaVersion;
		const storage = editingMediaStorageSchema.parse(media.storage);
		const prepared = storage.prepared;
		if (!prepared?.expect || !prepared.size || !media.sha256)
			throw new MediaOperationError("SOURCE_UNVERIFIED");
		const document = anyEditingDocumentSchema.parse(revision.document);
		diagnosticSchemaVersion = document.schemaVersion;
		if (document.autoGeneration) {
			diagnosticOperation = "AUTOMATIC_BINDING";
			if (
				project.organizationId !== previous.organizationId ||
				revision.organizationId !== previous.organizationId
			)
				throw new AutomaticBindingError();
			const binding = document.autoGeneration.binding;
			const [analysis, bindings] = await Promise.all([
				deps.prisma.sceneAnalysisRevision.findUnique({
					where: { id: binding.analysisRevisionId },
				}),
				deps.prisma.libraryAnalysisBinding.findMany({
					where: {
						organizationId: previous.organizationId,
						mediaVersionId: media.id,
						analysisRevisionId: binding.analysisRevisionId,
					},
					select: { proof: true },
					take: 26,
				}),
			]);
			if (!analysis) throw new AutomaticBindingError();
			verifyAutomaticAnalysisBinding({
				organizationId: previous.organizationId,
				media,
				analysis,
				binding,
				bindings: bindings.map((row) => row.proof),
			});
		}
		diagnosticOperation = "COMPOSITION_INPUT";
		const composition =
			document.schemaVersion === 2
				? await resolveCompositionRenderInput({
						prisma: deps.prisma,
						organizationId: previous.organizationId,
						projectId: project.id,
						primary: media,
						document,
					})
				: undefined;
		const recipe =
			document.schemaVersion === 1
				? compileEditDocument(document, media.timeMap)
				: undefined;
		if (
			(recipe?.mediaVersionId ?? composition?.plan.document.mediaVersionId) !==
				media.id ||
			(composition &&
				(project.organizationId !== previous.organizationId ||
					revision.organizationId !== previous.organizationId))
		)
			throw new MediaOperationError("INVALID_RENDER_INPUT");
		const recipeHash =
			composition?.recipeHash ??
			createHash("sha256").update(JSON.stringify(recipe)).digest("hex");
		// A V2 upload may survive a worker/policy update. Only recover bytes
		// from this exact recipe; legacy unbound objects remain untouched.
		const artifactKey = (token: string) =>
			keyFor(
				previous.outputPrefix,
				composition
					? `renders/${previous.id}/${token}/recipes/${recipeHash}/artifact.mp4`
					: `renders/${previous.id}/${token}/artifact.mp4`,
			);
		const profile = editingRenderProfileSchema.parse(previous.profile);
		const canvas = composition
			? compositionRenderCanvas(composition.plan.document.canvas, profile.kind)
			: recipe
				? editingRenderCanvas(recipe.canvas, profile.kind)
				: (() => {
						throw new MediaOperationError("INVALID_RENDER_INPUT");
					})();
		const durationFrames =
			composition?.plan.durationFrames ?? recipe?.durationFrames;
		diagnosticOperation = "OUTPUT_STORAGE";
		const outputBrowser = await resources.browser(previous.outputCredentialId);
		diagnosticOperation = "LEASE_CHECKPOINT";
		await guard.checkpoint();
		// The uploaded attempt survives a new owner and even a crash during recovery.
		if (artifactToken) {
			const oldKey = artifactKey(artifactToken);
			let restored: EditingObject | undefined;
			try {
				diagnosticOperation = "RECOVERY_HEAD";
				restored = await outputObject(
					outputBrowser,
					previous.outputCredentialId,
					previous.outputBucket,
					oldKey,
				);
			} catch (error) {
				if (!isNotFound(error)) throw error;
				uploadMayExist = false;
			}
			if (restored?.size && restored.expect) {
				const destinationPath = join(resources.directory, "artifact.mp4");
				diagnosticOperation = "RECOVERY_DOWNLOAD";
				const downloaded = await downloadPinnedEditingMedia({
					browser: outputBrowser,
					bucket: restored.bucket,
					key: restored.key,
					destinationPath,
					expectedIdentity: { ...restored.expect, size: restored.size },
					signal: guard.signal,
				});
				diagnosticOperation = "RECOVERY_PROBE";
				const facts = await probeEditingMedia({
					sourcePath: destinationPath,
					signal: guard.signal,
				});
				if (
					facts.frameCount !== durationFrames ||
					facts.width !== canvas.width ||
					facts.height !== canvas.height ||
					!facts.hasAudio
				)
					throw new MediaOperationError("RENDER_VALIDATION_FAILED");
				evidence = {
					storage: restored,
					sha256: downloaded.sha256,
					bytes: downloaded.bytes,
					probe: { ...facts.probe, frameCount: facts.frameCount },
					recipeHash,
				};
				await phase("VALIDATING");
			}
		}
		if (!evidence) {
			if (artifactToken) {
				diagnosticOperation = "ATTEMPT_RESUMPTION";
				// Only a confirmed missing object requires another render attempt.
				if (previous.attempts >= EDITING_MAX_ATTEMPTS) {
					const exhausted = await deps.prisma.renderRun.updateMany({
						where: fence(),
						data: {
							state: "FAILED",
							error: "RENDER_ATTEMPTS_EXHAUSTED",
							leaseToken: null,
							leaseUntil: null,
							finishedAt: now(),
							pendingArtifactToken: null,
						},
					});
					if (!exhausted.count) throw new MediaOperationError("LEASE_LOST");
					return;
				}
				const resumed = await deps.prisma.renderRun.updateMany({
					where: { ...fence(), attempts: { lt: EDITING_MAX_ATTEMPTS } },
					data: { attempts: { increment: 1 }, pendingArtifactToken: null },
				});
				if (!resumed.count) throw new MediaOperationError("LEASE_LOST");
			}
			const destinationPath = join(resources.directory, "artifact.mp4");
			let result: Awaited<ReturnType<typeof renderEditingRecipe>>;
			if (composition) {
				const sources: CompositionRenderSource[] = [];
				for (const [index, source] of composition.sources.entries()) {
					const object = editingMediaStorageSchema.parse(
						source.storage,
					).prepared;
					if (!object?.expect || !object.size || !source.sha256)
						throw new MediaOperationError("SOURCE_UNVERIFIED");
					const sourcePath = join(resources.directory, `source-${index}.mp4`);
					diagnosticOperation = "SOURCE_STORAGE";
					const browser = await resources.browser(object.credentialId);
					diagnosticOperation = "SOURCE_DOWNLOAD";
					await downloadPinnedEditingMedia({
						browser,
						bucket: object.bucket,
						key: object.key,
						destinationPath: sourcePath,
						expectedIdentity: { ...object.expect, size: object.size },
						expectedSha256: source.sha256,
						signal: guard.signal,
					});
					diagnosticOperation = "SOURCE_PROBE";
					const sourceFacts = await probeEditingMedia({
						sourcePath,
						signal: guard.signal,
					});
					sources.push({ mediaVersionId: source.id, sourcePath, sourceFacts });
					diagnosticOperation = "LEASE_CHECKPOINT";
					await guard.checkpoint();
				}
				const images: CompositionRenderImage[] = [];
				for (const [index, image] of composition.images.entries()) {
					const object = editingObjectSchema.parse(image.storage);
					if (!object.expect || !object.size)
						throw new MediaOperationError("SOURCE_UNVERIFIED");
					const sourcePath = join(resources.directory, `image-${index}.png`);
					diagnosticOperation = "IMAGE_STORAGE";
					const browser = await resources.browser(object.credentialId);
					diagnosticOperation = "IMAGE_DOWNLOAD";
					await downloadPinnedEditingMedia({
						browser,
						bucket: object.bucket,
						key: object.key,
						destinationPath: sourcePath,
						expectedIdentity: { ...object.expect, size: object.size },
						expectedSha256: image.sha256,
						maxBytes: 8 * 1024 * 1024,
						signal: guard.signal,
					});
					images.push({ assetId: image.id, sourcePath });
					diagnosticOperation = "LEASE_CHECKPOINT";
					await guard.checkpoint();
				}
				await phase("RENDERING");
				diagnosticOperation = "COMPOSITION_RENDER";
				result = await renderCompositionRecipe({
					plan: composition.plan,
					sources,
					images,
					destinationPath,
					mode: profile.kind,
					fontPath: process.env.EDITING_FONT_PATH,
					signal: guard.signal,
				});
			} else if (recipe) {
				const sourcePath = join(resources.directory, "source.mp4");
				diagnosticOperation = "SOURCE_STORAGE";
				const sourceBrowser = await resources.browser(prepared.credentialId);
				diagnosticOperation = "SOURCE_DOWNLOAD";
				await downloadPinnedEditingMedia({
					browser: sourceBrowser,
					bucket: prepared.bucket,
					key: prepared.key,
					destinationPath: sourcePath,
					expectedIdentity: { ...prepared.expect, size: prepared.size },
					expectedSha256: media.sha256,
					signal: guard.signal,
				});
				diagnosticOperation = "SOURCE_PROBE";
				const sourceFacts = await probeEditingMedia({
					sourcePath,
					signal: guard.signal,
				});
				await phase("RENDERING");
				diagnosticOperation = "LEGACY_RENDER";
				result = await renderEditingRecipe({
					sourcePath,
					destinationPath,
					recipe,
					sourceFacts,
					mode: profile.kind,
					signal: guard.signal,
				});
			} else throw new MediaOperationError("INVALID_RENDER_INPUT");
			await phase("VALIDATING", leaseToken);
			diagnosticOperation = "ARTIFACT_UPLOAD";
			if (!outputBrowser.putObject)
				throw new MediaOperationError("OUTPUT_UNVERIFIED");
			const key = artifactKey(leaseToken);
			uploadMayExist = true;
			await outputBrowser.putObject({
				bucket: previous.outputBucket,
				key,
				filePath: destinationPath,
				contentType: "video/mp4",
			});
			diagnosticOperation = "ARTIFACT_HEAD";
			const output = await outputObject(
				outputBrowser,
				previous.outputCredentialId,
				previous.outputBucket,
				key,
				result.bytes,
			);
			evidence = {
				storage: output,
				sha256: result.sha256,
				bytes: result.bytes,
				probe: { ...result, fps: { num: 30, den: 1 } },
				recipeHash,
			};
		}
		diagnosticOperation = "LEASE_CHECKPOINT";
		await guard.checkpoint();
		await guard.close();
		diagnosticOperation = "ARTIFACT_ADOPTION";
		const adopted = await adoptEditingArtifact({
			prisma: deps.prisma,
			runId: previous.id,
			leaseToken,
			evidence,
			now,
		});
		if (!adopted) throw new MediaOperationError("LEASE_LOST");
		if (profile.kind === "EXPORT") {
			try {
				await promoteEditingArtifact({
					prisma: deps.prisma,
					runId: previous.id,
					recipeHash,
				});
			} catch {
				await deps.prisma.renderRun.updateMany({
					where: {
						id: previous.id,
						state: "SUCCEEDED",
						error: LIBRARY_REGISTRATION_PENDING,
					},
					data: {
						availableAt: new Date(now().getTime() + EDITING_RECOVERY_RETRY_MS),
					},
				});
			}
		}
	} catch (error) {
		try {
			logRenderFailureDiagnostic(
				{
					runId: previous.id,
					organizationId: previous.organizationId,
					projectId: previous.projectId,
					revisionId: previous.revisionId,
					stage: diagnosticStage,
					operation: diagnosticOperation,
					schemaVersion: diagnosticSchemaVersion,
					previousAttempts: previous.attempts,
					elapsedMs: performance.now() - diagnosticStartedAt,
				},
				error,
			);
		} catch {
			// Diagnostics cannot change cancellation, failure or recovery decisions.
		}
		await guard.close();
		// This is reached only after download/render helpers have stopped their process/streams.
		const canceled = await deps.prisma.renderRun.updateMany({
			where: { id: previous.id, state: "CANCEL_REQUESTED", leaseToken },
			data: {
				state: "CANCELED",
				leaseToken: null,
				leaseUntil: null,
				finishedAt: now(),
				error: null,
			},
		});
		if (!canceled.count && !deps.signal?.aborted) {
			if (
				!(error instanceof AutomaticBindingError) &&
				(evidence || uploadMayExist)
			) {
				await deps.prisma.renderRun.updateMany({
					where: {
						id: previous.id,
						state: { in: activeRenderStates },
						leaseToken,
						cancelRequestedAt: null,
					},
					data: {
						state: "VALIDATING",
						error: "ARTIFACT_ADOPTION_PENDING",
						leaseUntil: new Date(now().getTime() - 1),
						availableAt: new Date(now().getTime() + EDITING_RECOVERY_RETRY_MS),
					},
				});
			} else {
				await deps.prisma.renderRun.updateMany({
					where: {
						id: previous.id,
						state: { in: activeRenderStates },
						leaseToken,
					},
					data: {
						state: "FAILED",
						leaseToken: null,
						leaseUntil: null,
						finishedAt: now(),
						error: failureCode(error, "RENDER_FAILED"),
					},
				});
			}
		}
	} finally {
		await guard.close();
		await resources?.close();
	}
}

/** FIFO across tenants; interval calls share each tenant's queued or active sweep. */
export function createLibraryEditingSweep(deps: Dependencies) {
	const now = deps.now ?? (() => new Date());
	let pending: Promise<void> | undefined;
	let captureCursor: string | undefined;
	const sweep = async () => {
		if (deps.signal?.aborted) return;
		try {
			const pending = await deps.prisma.renderRun.findMany({
				where: {
					state: "SUCCEEDED",
					error: LIBRARY_REGISTRATION_PENDING,
					availableAt: { lte: now() },
				},
				orderBy: { createdAt: "asc" },
				take: 5,
				select: { id: true },
			});
			for (const row of pending) {
				try {
					await promoteEditingArtifact({ prisma: deps.prisma, runId: row.id });
				} catch {
					await deps.prisma.renderRun.updateMany({
						where: {
							id: row.id,
							state: "SUCCEEDED",
							error: LIBRARY_REGISTRATION_PENDING,
						},
						data: {
							availableAt: new Date(
								now().getTime() + EDITING_RECOVERY_RETRY_MS,
							),
						},
					});
				}
			}
			await deps.prisma.libraryMediaVersion.updateMany({
				where: {
					state: "RUNNING",
					attempts: { gte: EDITING_MAX_ATTEMPTS },
					leaseUntil: { lte: now() },
				},
				data: {
					state: "ERROR",
					leaseToken: null,
					leaseUntil: null,
					error: "MEDIA_ATTEMPTS_EXHAUSTED",
				},
			});
			const eligible = {
				attempts: { lt: EDITING_MAX_ATTEMPTS },
				OR: [
					{ state: "PENDING", availableAt: { lte: now() } },
					{ state: "RUNNING", leaseUntil: { lte: now() } },
				],
			};
			const rows = await deps.prisma.libraryMediaVersion.findMany({
				where: eligible,
				orderBy: { availableAt: "asc" },
				take: 1,
			});
			for (const row of rows) {
				if (deps.signal?.aborted) break;
				const leaseToken = randomUUID();
				const claimed = await deps.prisma.libraryMediaVersion.updateMany({
					where: { id: row.id, ...eligible },
					data: {
						state: "RUNNING",
						attempts: { increment: 1 },
						leaseToken,
						leaseUntil: new Date(now().getTime() + EDITING_LEASE_MS),
						error: null,
					},
				});
				if (claimed.count) await prepareMedia(deps, row, leaseToken);
			}
			if (deps.signal?.aborted) return;
			await deps.prisma.renderRun.updateMany({
				where: { state: "CANCEL_REQUESTED", leaseUntil: { lte: now() } },
				data: { error: "PROCESS_STOP_UNCONFIRMED" },
			});
			await deps.prisma.renderRun.updateMany({
				where: {
					state: { in: activeRenderStates },
					attempts: { gte: EDITING_MAX_ATTEMPTS },
					leaseUntil: { lte: now() },
					cancelRequestedAt: null,
					pendingArtifactToken: null,
					NOT: { state: "VALIDATING", leaseToken: { not: null } },
				},
				data: {
					state: "FAILED",
					leaseToken: null,
					leaseUntil: null,
					finishedAt: now(),
					error: "RENDER_ATTEMPTS_EXHAUSTED",
				},
			});
			const renderEligible = {
				cancelRequestedAt: null,
				availableAt: { lte: now() },
				AND: [
					{
						OR: [
							{ attempts: { lt: EDITING_MAX_ATTEMPTS } },
							{ pendingArtifactToken: { not: null } },
							{ state: "VALIDATING", leaseToken: { not: null } },
						],
					},
				],
				OR: [
					{ state: "QUEUED" },
					{ state: { in: activeRenderStates }, leaseUntil: { lte: now() } },
				],
			};
			const renders = await deps.prisma.renderRun.findMany({
				where: renderEligible,
				orderBy: { availableAt: "asc" },
				take: 1,
			});
			for (const row of renders) {
				if (deps.signal?.aborted) break;
				const previous = { ...row };
				const pendingArtifactToken =
					row.pendingArtifactToken ??
					(row.state === "VALIDATING" ? row.leaseToken : null);
				const leaseToken = randomUUID();
				const claimed = await deps.prisma.renderRun.updateMany({
					where: { id: row.id, ...renderEligible },
					data: {
						state: "PREPARING",
						...(!pendingArtifactToken ? { attempts: { increment: 1 } } : {}),
						leaseToken,
						pendingArtifactToken,
						leaseUntil: new Date(now().getTime() + EDITING_LEASE_MS),
						startedAt: now(),
						error: null,
					},
				});
				if (claimed.count) await renderRun(deps, previous, leaseToken);
			}
			if (deps.signal?.aborted) return;
			// A crash after READY but before binding publication is repairable. The
			// cursor advances across bounded pages so a corrupt source cannot starve
			// later tenants/sources; failures still reach the worker's sweep logger.
			const receipts = await deps.prisma.libraryEvidenceReceipt.findMany({
				where: {
					kind: "NORMALIZATION_CAPTURE",
					sourceId: { not: null },
					mediaVersion: { state: "READY" },
					...(captureCursor ? { id: { gt: captureCursor } } : {}),
				},
				orderBy: { id: "asc" },
				take: 10,
				select: { id: true, organizationId: true, sourceId: true },
			});
			const visited = new Set<string>();
			let reconciliationFailed = false;
			for (const receipt of receipts) {
				if (deps.signal?.aborted) return;
				if (!receipt.sourceId || visited.has(receipt.sourceId)) continue;
				visited.add(receipt.sourceId);
				try {
					await reconcileCapturedBindings({
						prisma: deps.prisma,
						organizationId: receipt.organizationId,
						sourceId: receipt.sourceId,
					});
				} catch {
					reconciliationFailed = true;
				}
			}
			captureCursor = receipts.at(-1)?.id;
			if (reconciliationFailed)
				throw new MediaOperationError("BINDING_RECONCILIATION_DEFERRED");
		} catch {
			throw new MediaOperationError("EDITING_SWEEP_FAILED");
		}
	};
	return () => {
		if (deps.signal?.aborted) return Promise.resolve();
		if (pending) return pending;
		let started = false;
		let removeAbort = () => {};
		const skipped = new Promise<void>((resolve) => {
			const stop = () => {
				// Active work must finish stopping its processes before drain resolves.
				if (!started) resolve();
			};
			deps.signal?.addEventListener("abort", stop, { once: true });
			removeAbort = () => deps.signal?.removeEventListener("abort", stop);
		});
		const queued = processQueue.then(() => {
			started = true;
			return sweep();
		});
		// A failed tenant must not prevent the next tenant's turn.
		processQueue = queued.catch(() => {});
		pending = Promise.race([queued, skipped]).finally(() => {
			removeAbort();
			pending = undefined;
		});
		return pending;
	};
}
