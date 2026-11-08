import { randomUUID } from "node:crypto";
import {
	compositionDocumentSchema,
	GENERATION_POLICY_FINGERPRINT,
	hashEditingEvidence,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskIntentHash,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLibraryGenerationHandler } from "./generation";
import { createLibraryMediaTaskSweep } from "./media-task-sweep";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL,
	appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL speech selection publication and legacy claim",
	() => {
		const organizationId = randomUUID();
		let admin: AppPrismaClient,
			app: AppPrismaClient,
			db: AppPrismaClient,
			credentialId: string;
		beforeAll(async () => {
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
			db = createTenantPrismaClient(app, organizationId);
			await admin.organization.create({
				data: {
					id: organizationId,
					name: "Speech selection fixture",
					slug: `speech-${organizationId}`,
				},
			});
			credentialId = (
				await db.credential.create({
					data: {
						label: "Speech selection fixture",
						provider: "AWS_S3",
						encryptedSecret: "fixture",
					},
				})
			).id;
		});
		afterAll(async () => {
			try {
				if (!admin) return;
				const where = { organizationId };
				await admin.renderRun.deleteMany({ where });
				await admin.contentDerivation.deleteMany({ where });
				await admin.editProject.updateMany({
					where,
					data: { currentRevisionId: null },
				});
				await admin.editRevision.deleteMany({ where });
				await admin.editProjectResource.deleteMany({ where });
				await admin.editProject.deleteMany({ where });
				await admin.libraryMediaTask.deleteMany({ where });
				await admin.libraryAnalysisBinding.deleteMany({ where });
				await admin.sceneAnalysisRevision.deleteMany({ where });
				await admin.contentRevision.deleteMany({ where });
				await admin.content.deleteMany({ where });
				await admin.libraryMediaVersion.deleteMany({ where });
				await admin.librarySource.deleteMany({ where });
				await admin.credential.deleteMany({ where });
				await admin.organization.delete({ where: { id: organizationId } });
			} finally {
				await admin?.$disconnect();
				await app?.$disconnect();
			}
		});
		async function fixture(legacy = false) {
			const source = await db.librarySource.create({
				data: {
					sourceKey: randomUUID(),
					originalJobId: randomUUID(),
					encodingId: randomUUID(),
					accountId: randomUUID(),
					snapshot: {},
					locales: ["ja"],
				},
			});
			const content = await db.content.create({
				data: {
					registrationKey: randomUUID(),
					title: "Speech fixture",
					description: "",
					tags: [],
					locale: "ja",
				},
			});
			await db.contentRevision.create({
				data: {
					contentId: content.id,
					sourceId: source.id,
					revision: 1,
					title: content.title,
					description: "",
					tags: [],
					locale: "ja",
				},
			});
			const id = randomUUID(),
				map = {
					id,
					mediaVersionId: id,
					kind: "CFR",
					sourceStartUs: 0,
					sourceEndUs: 6_000_000,
					editingStartFrame: 0,
					editingEndFrame: 180,
					fps: { num: 30, den: 1 },
				};
			const media = await db.libraryMediaVersion.create({
				data: {
					id,
					sourceId: source.id,
					credentialId,
					outputCredentialId: credentialId,
					state: "READY",
					sha256: "a".repeat(64),
					width: 640,
					height: 360,
					durationUs: 6_000_000n,
					fpsNum: 30,
					fpsDen: 1,
					timeMap: map,
					probe: { streams: [{ codec_type: "audio" }] },
					storage: {
						source: { credentialId, bucket: "fixture", key: "source.mp4" },
						output: { credentialId, bucket: "fixture", prefix: "edits/" },
					},
				},
			});
			const raw = {
				metadata: { version: "authored-speech-postgres-fixture" },
				duration: 6,
				scenes: [
					{
						id: randomUUID(),
						type: "MAIN_CONTENT",
						title: "Speech fixture",
						startInSeconds: 0,
						endInSeconds: 6,
						shots: [
							[0, 1],
							[1, 3],
							[3, 4],
							[4, 6],
						].map(([from = 0, to = 0]) => ({
							startInSeconds: from,
							endInSeconds: to,
						})),
					},
				],
			};
			const analysis = await db.sceneAnalysisRevision.create({
				data: {
					sourceId: source.id,
					locale: "ja",
					providerVersion: "fixture",
					rawHash: hashEditingEvidence(raw),
					raw,
					document: normalizeSceneAnalysis(raw),
				},
			});
			const binding = {
				schemaVersion: 1,
				kind: "FIXTURE_AUTHORED",
				organizationId,
				sourceId: source.id,
				locale: "ja",
				analysisRevisionId: analysis.id,
				analysisRawHash: analysis.rawHash,
				analysisDocumentHash: hashEditingEvidence(analysis.document),
				mediaVersionId: id,
				mediaSha256: media.sha256,
				timeMapId: id,
				timeMapHash: hashEditingEvidence(map),
				sourceStartUs: 0,
				sourceEndUs: 6_000_000,
				width: 640,
				height: 360,
			};
			await db.libraryAnalysisBinding.create({
				data: {
					mediaVersionId: id,
					analysisRevisionId: analysis.id,
					proof: binding,
				},
			});
			const transcript = mediaTaskCreateSchema.parse({
				kind: "TRANSCRIBE",
				mediaVersionId: id,
				requestKey: randomUUID(),
				parameters: { language: "ja", sourceStartUs: 0, durationUs: 6_000_000 },
			});
			const transcriptIdentity = {
				organizationId,
				mediaSha256: media.sha256,
				modelSha256: "b".repeat(64),
				analysisDocumentHash: null,
				analysisRawHash: null,
				timeMapHash: binding.timeMapHash,
				bindingHash: null,
			};
			const dependency = await db.libraryMediaTask.create({
				data: {
					kind: "TRANSCRIBE",
					mediaVersionId: id,
					requestKey: transcript.requestKey,
					requestHash: mediaTaskIntentHash(transcript),
					cacheKey: mediaTaskCacheKey(transcript, transcriptIdentity),
					parameters: {
						schemaVersion: 1,
						input: transcript,
						identity: transcriptIdentity,
					},
					state: "SUCCEEDED",
					phase: "COMPLETE",
					finishedAt: new Date(),
					result: {
						schemaVersion: 1,
						engine: "whisper.cpp",
						engineVersion: "1.9.5",
						modelSha256: transcriptIdentity.modelSha256,
						mediaSha256: media.sha256,
						language: "ja",
						sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
						cacheKey: "c".repeat(64),
						warnings: [],
						segments: [
							{ startUs: 0, endUs: 500_000, text: "outside" },
							{ startUs: 1_500_000, endUs: 2_000_000, text: "inside" },
							{ startUs: 3_500_000, endUs: 4_500_000, text: "crosses end" },
						],
					},
				},
			});
			const input = mediaTaskCreateSchema.parse({
				kind: "GENERATE",
				mediaVersionId: id,
				analysisRevisionId: analysis.id,
				requestKey: randomUUID(),
				parameters: {
					contentId: content.id,
					targetDurationFrames: 120,
					variants: 3,
					policy: "DURATION",
					captions: "AUTO",
					language: "ja",
					transcriptionTaskId: dependency.id,
				},
			});
			if (input.kind !== "GENERATE") throw new Error("Expected generation");
			const identity = {
				organizationId,
				generationPolicyFingerprint: GENERATION_POLICY_FINGERPRINT,
				mediaSha256: media.sha256,
				modelSha256: "b".repeat(64),
				analysisDocumentHash: binding.analysisDocumentHash,
				analysisRawHash: analysis.rawHash,
				timeMapHash: binding.timeMapHash,
				bindingHash: hashEditingEvidence(binding),
				bindingSnapshot: binding,
				...(legacy
					? {}
					: { speechSelectionPolicyVersion: "asr-boundary-v1" as const }),
			};
			const leaseToken = randomUUID();
			const task = await db.libraryMediaTask.create({
				data: {
					kind: "GENERATE",
					mediaVersionId: id,
					analysisRevisionId: analysis.id,
					requestKey: input.requestKey,
					requestHash: mediaTaskIntentHash(input),
					cacheKey: mediaTaskCacheKey(input, identity),
					parameters: { schemaVersion: 1, input, identity },
					state: legacy ? "PENDING" : "RUNNING",
					phase: "QUEUED",
					attempts: legacy ? 0 : 1,
					leaseToken: legacy ? null : leaseToken,
					leaseUntil: legacy ? null : new Date(Date.now() + 120_000),
					createdBy: "fixture",
				},
			});
			return {
				content,
				media,
				analysis,
				binding,
				task,
				dependency,
				context: {
					taskId: task.id,
					organizationId,
					leaseToken,
					mediaVersionId: id,
					analysisRevisionId: analysis.id,
					parameters: input.parameters,
					sourcePath: "/owned/not-read-with-verified-transcript.mp4",
					media,
					createdBy: "fixture",
					signal: new AbortController().signal,
					onProgress: vi.fn(async () => {}),
				},
			};
		}
		it("commits an old unfinished AUTO as fenced ERROR and preserves its identity and completed dependency", async () => {
			const f = await fixture(true),
				browserFor = vi.fn(() => {
					throw new Error("must not download");
				});
			await createLibraryMediaTaskSweep({
				canClaim: async () => true,
				prisma: db,
				browserFor,
			})();
			const stored = await db.libraryMediaTask.findUniqueOrThrow({
				where: { id: f.task.id },
			});
			expect(stored).toMatchObject({
				state: "ERROR",
				phase: "FAILED",
				error: "SPEECH_SELECTION_POLICY_CHANGED",
				leaseToken: null,
				leaseUntil: null,
				result: null,
			});
			expect(stored.finishedAt).not.toBeNull();
			expect(hashEditingEvidence(stored.parameters)).toBe(
				hashEditingEvidence(f.task.parameters),
			);
			expect(stored.requestHash).toBe(f.task.requestHash);
			expect(stored.cacheKey).toBe(f.task.cacheKey);
			expect(browserFor).not.toHaveBeenCalled();
			expect(
				await db.libraryMediaTask.findUniqueOrThrow({
					where: { id: f.dependency.id },
				}),
			).toEqual(f.dependency);
			expect(
				await db.editProject.count({ where: { contentId: f.content.id } }),
			).toBe(0);
			await createLibraryMediaTaskSweep({
				canClaim: async () => true,
				prisma: db,
				browserFor,
			})();
			expect(
				await db.libraryMediaTask.findUniqueOrThrow({
					where: { id: f.task.id },
				}),
			).toEqual(stored);
		});
		it("publishes bounded speech evidence with all variants atomically, preserves immutable replay and rolls back failed export insertion", async () => {
			const f = await fixture(),
				handler = createLibraryGenerationHandler({ prisma: db }),
				result = await handler(f.context);
			expect(result).toMatchObject({
				actualFrames: 60,
				selectionEvidence: {
					status: "APPLIED",
					observedWindow: { fromFrame: 0, toFrame: 180 },
				},
			});
			expect(result.projectIds).toHaveLength(3);
			for (const [index, projectId] of result.projectIds.entries()) {
				const project = await db.editProject.findUniqueOrThrow({
					where: { id: projectId },
				});
				const document = compositionDocumentSchema.parse(project.draft);
				expect(document.clips[0]).toMatchObject({
					sourceInUs: 1_000_000,
					durationFrames: 60,
				});
				expect(document.captions?.[0]).toMatchObject({
					text: "inside",
					fromFrame: 15,
					toFrame: 30,
				});
				expect(document.autoGeneration?.requestHash).toBe(
					hashEditingEvidence({
						taskRequestHash: f.task.requestHash,
						generationPolicyFingerprint: GENERATION_POLICY_FINGERPRINT,
						presetId: result.presetIds[index],
						mediaSha256: f.media.sha256,
						analysisDocumentHash: f.binding.analysisDocumentHash,
						bindingHash: hashEditingEvidence(f.binding),
						modelSha256: "b".repeat(64),
						speechSelectionPolicyVersion: "asr-boundary-v1",
						selectionEvidenceHash: hashEditingEvidence(
							result.selectionEvidence,
						),
					}),
				);
				const runs = await db.renderRun.findMany({ where: { projectId } });
				expect(runs).toHaveLength(1);
				expect(runs[0]?.profile).toEqual({ kind: "EXPORT" });
			}
			expect(
				(
					await db.libraryMediaTask.findUniqueOrThrow({
						where: { id: f.task.id },
					})
				).result,
			).toEqual(result);
			await expect(
				db.libraryMediaTask.update({
					where: { id: f.task.id },
					data: { result: { altered: true } },
				}),
			).rejects.toThrow();
			expect(await handler(f.context)).toEqual(result);
			expect(
				await db.editProject.count({ where: { contentId: f.content.id } }),
			).toBe(3);
			const failed = await fixture();
			let reachedExport = false;
			const failing = new Proxy(db, {
				get(target, key) {
					if (key !== "$transaction") return Reflect.get(target, key);
					return (
						action: (tx: AppTransactionClient) => Promise<unknown>,
						options?: {
							maxWait?: number;
							timeout?: number;
							statementTimeoutMs?: number;
						},
					) =>
						target.$transaction(
							async (tx) =>
								action(
									new Proxy(tx, {
										get(transaction, property) {
											if (property !== "renderRun")
												return Reflect.get(transaction, property);
											return new Proxy(transaction.renderRun, {
												get(delegate, operation) {
													if (operation !== "create")
														return Reflect.get(delegate, operation);
													return async () => {
														reachedExport = true;
														await transaction.$executeRaw`SELECT 1 / 0`;
														throw new Error("Expected real PostgreSQL failure");
													};
												},
											});
										},
									}),
								),
							options,
						);
				},
			}) as AppPrismaClient;
			await expect(
				createLibraryGenerationHandler({ prisma: failing })(failed.context),
			).rejects.toThrow();
			expect(reachedExport).toBe(true);
			expect(
				await db.editProject.count({ where: { contentId: failed.content.id } }),
			).toBe(0);
			expect(
				await db.libraryMediaTask.findUniqueOrThrow({
					where: { id: failed.task.id },
				}),
			).toMatchObject({
				state: "RUNNING",
				result: null,
				leaseToken: failed.context.leaseToken,
			});
		});
	},
);
