import { randomUUID } from "node:crypto";
import {
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

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL,
	appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL production generation publication",
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
					name: "Generation fixture",
					slug: `generation-${organizationId}`,
				},
			});
			credentialId = (
				await db.credential.create({
					data: {
						label: "Generation fixture",
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
		async function fixture(renderMode?: "DRAFT" | "EXPORT") {
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
					title: "Generation",
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
					probe: {},
					storage: {
						source: { credentialId, bucket: "fixture", key: "original.mp4" },
						output: {
							credentialId,
							bucket: "fixture",
							prefix: "edits/",
						},
					},
				},
			});
			const raw = {
				metadata: { version: "generation-integration-fixture" },
				duration: 6,
				scenes: [
					{
						id: randomUUID(),
						type: "MAIN_CONTENT",
						title: "Interview",
						startInSeconds: 0,
						endInSeconds: 6,
						shots: [0, 2, 4].map((startInSeconds) => ({
							startInSeconds,
							endInSeconds: startInSeconds + 2,
						})),
					},
				],
			};
			const analysis = await db.sceneAnalysisRevision.create({
				data: {
					sourceId: source.id,
					locale: "ja",
					rawHash: hashEditingEvidence(raw),
					providerVersion: "fixture",
					raw,
					document: normalizeSceneAnalysis(raw),
				},
			});
			const binding = {
				schemaVersion: 1,
				kind: "FIXTURE_AUTHORED",
				organizationId,
				sourceId: source.id,
				locale: analysis.locale,
				analysisRevisionId: analysis.id,
				analysisRawHash: analysis.rawHash,
				analysisDocumentHash: hashEditingEvidence(analysis.document),
				mediaVersionId: media.id,
				mediaSha256: media.sha256,
				timeMapId: map.id,
				timeMapHash: hashEditingEvidence(map),
				sourceStartUs: 0,
				sourceEndUs: 6_000_000,
				width: 640,
				height: 360,
			};
			const proof = await db.libraryAnalysisBinding.create({
				data: {
					mediaVersionId: media.id,
					analysisRevisionId: analysis.id,
					proof: binding,
				},
			});
			const input = mediaTaskCreateSchema.parse({
				kind: "GENERATE",
				mediaVersionId: media.id,
				analysisRevisionId: analysis.id,
				requestKey: randomUUID(),
				parameters: {
					contentId: content.id,
					targetDurationFrames: 120,
					variants: 3,
					...(renderMode ? { renderMode } : {}),
				},
			});
			if (input.kind !== "GENERATE")
				throw new Error("Generation input required");
			const identity = {
				organizationId,
				generationPolicyFingerprint: GENERATION_POLICY_FINGERPRINT,
				mediaSha256: media.sha256,
				modelSha256: null,
				analysisDocumentHash: hashEditingEvidence(analysis.document),
				analysisRawHash: analysis.rawHash,
				timeMapHash: hashEditingEvidence(map),
				bindingHash: hashEditingEvidence(binding),
				bindingSnapshot: binding,
			};
			const leaseToken = randomUUID(),
				task = await db.libraryMediaTask.create({
					data: {
						mediaVersionId: media.id,
						analysisRevisionId: analysis.id,
						kind: input.kind,
						requestKey: input.requestKey,
						requestHash: mediaTaskIntentHash(input),
						cacheKey: mediaTaskCacheKey(input, identity),
						parameters: { schemaVersion: 1, input, identity },
						state: "RUNNING",
						attempts: 1,
						leaseToken,
						leaseUntil: new Date(Date.now() + 120_000),
						createdBy: "fixture",
					},
				});
			const context = {
				taskId: task.id,
				organizationId,
				leaseToken,
				mediaVersionId: media.id,
				analysisRevisionId: analysis.id,
				parameters: input.parameters,
				sourcePath: "/owned/not-read-when-captions-and-tracking-off.mp4",
				media,
				createdBy: task.createdBy,
				signal: new AbortController().signal,
				onProgress: vi.fn(async (_phase: string) => {}),
			};
			return { content, task, proof, context };
		}
		const handler = () => createLibraryGenerationHandler({ prisma: db });
		async function expectUnpublished(f: Awaited<ReturnType<typeof fixture>>) {
			expect(
				await db.editProject.count({ where: { contentId: f.content.id } }),
			).toBe(0);
			expect(
				await db.renderRun.count({
					where: { project: { contentId: f.content.id } },
				}),
			).toBe(0);
			expect(
				await db.libraryMediaTask.findUnique({ where: { id: f.task.id } }),
			).toMatchObject({
				state: "RUNNING",
				phase: "QUEUED",
				result: null,
				leaseToken: f.context.leaseToken,
			});
		}
		it("publishes all variants with one immutable task result and replays without another export", async () => {
			const f = await fixture(),
				first = await handler()(f.context),
				second = await handler()(f.context);
			expect(second).toEqual(first);
			expect(first.projectIds).toHaveLength(3);
			const projects = await db.editProject.findMany({
				where: { contentId: f.content.id },
				include: { revisions: true, renderRuns: true, derivations: true },
			});
			expect(projects).toHaveLength(3);
			for (const project of projects) {
				expect(project.currentRevisionId).toBe(project.revisions[0]?.id);
				expect(project.revisions).toHaveLength(1);
				expect(project.renderRuns).toHaveLength(1);
				expect(project.renderRuns[0]).toMatchObject({
					state: "QUEUED",
					generation: 1,
					profile: { kind: "EXPORT" },
				});
				expect(project.derivations[0]).toMatchObject({ desiredGeneration: 1 });
			}
			expect(
				await db.libraryMediaTask.findUnique({ where: { id: f.task.id } }),
			).toMatchObject({ state: "SUCCEEDED", result: first });
			await expect(
				db.libraryMediaTask.update({
					where: { id: f.task.id },
					data: { result: {} },
				}),
			).rejects.toThrow("Completed media task results are immutable");
		});
		it("rechecks the stored proof immediately before publishing", async () => {
			const f = await fixture();
			f.context.onProgress.mockImplementation(async (phase) => {
				if (phase === "PUBLISHING")
					await db.libraryAnalysisBinding.delete({ where: { id: f.proof.id } });
			});
			await expect(handler()(f.context)).rejects.toMatchObject({
				code: "ANALYSIS_BINDING_UNVERIFIED",
			});
			await expectUnpublished(f);
		});
		it("rolls back projects, revisions, derivations and task completion when export insertion fails", async () => {
			const f = await fixture();
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
														throw new Error(
															"Expected PostgreSQL division by zero",
														);
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
				createLibraryGenerationHandler({ prisma: failing })(f.context),
			).rejects.toThrow();
			expect(reachedExport).toBe(true);
			await expectUnpublished(f);
		});
		it("rolls back a publication whose lease expires at the final database fence", async () => {
			const f = await fixture();
			let calls = 0;
			const normal = new Date(),
				expired = new Date((f.task.leaseUntil?.getTime() ?? 0) + 1);
			await expect(
				createLibraryGenerationHandler({
					prisma: db,
					now: () => (++calls >= 3 ? expired : normal),
				})(f.context),
			).rejects.toMatchObject({ code: "LEASE_LOST" });
			await expectUnpublished(f);
		});
		it("rejects a foreign task context without creating output", async () => {
			const f = await fixture();
			await expect(
				handler()({ ...f.context, organizationId: randomUUID() }),
			).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
			await expectUnpublished(f);
		});
		it("publishes DRAFT revisions and a same-key result without any render or derived reservation", async () => {
			const f = await fixture("DRAFT"),
				[first, concurrent] = await Promise.all([
					handler()(f.context),
					handler()(f.context),
				]),
				second = await handler()(f.context);
			expect(first.renderMode).toBe("DRAFT");
			expect(concurrent).toEqual(first);
			expect(second).toEqual(first);
			const projects = await db.editProject.findMany({
				where: { contentId: f.content.id },
				include: { revisions: true, renderRuns: true, derivations: true },
			});
			expect(projects).toHaveLength(3);
			for (const project of projects) {
				expect(project.revisions).toHaveLength(1);
				expect(project.currentRevisionId).toBe(project.revisions[0]?.id);
				expect(project.draft).toEqual(project.revisions[0]?.document);
				expect(project.renderRuns).toEqual([]);
				expect(project.derivations).toEqual([]);
			}
			expect(
				await db.libraryMediaTask.findUnique({ where: { id: f.task.id } }),
			).toMatchObject({ state: "SUCCEEDED", result: first });
		});
		it("keeps DRAFT publication empty when its proof is revoked before the transaction", async () => {
			const f = await fixture("DRAFT");
			f.context.onProgress.mockImplementation(async (phase) => {
				if (phase === "PUBLISHING")
					await db.libraryAnalysisBinding.delete({ where: { id: f.proof.id } });
			});
			await expect(handler()(f.context)).rejects.toMatchObject({
				code: "ANALYSIS_BINDING_UNVERIFIED",
			});
			await expectUnpublished(f);
		});
		it("rolls back a DRAFT whose lease expires at the final task fence", async () => {
			const f = await fixture("DRAFT");
			let calls = 0;
			const normal = new Date(),
				expired = new Date((f.task.leaseUntil?.getTime() ?? 0) + 1);
			await expect(
				createLibraryGenerationHandler({
					prisma: db,
					now: () => (++calls >= 3 ? expired : normal),
				})(f.context),
			).rejects.toMatchObject({ code: "LEASE_LOST" });
			await expectUnpublished(f);
			expect(
				await db.editRevision.count({
					where: { project: { contentId: f.content.id } },
				}),
			).toBe(0);
		});
		it("rolls back DRAFT project insertion when its immutable revision cannot be inserted", async () => {
			const f = await fixture("DRAFT");
			let reachedRevision = false;
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
											if (property !== "editRevision")
												return Reflect.get(transaction, property);
											return new Proxy(transaction.editRevision, {
												get(delegate, operation) {
													if (operation !== "create")
														return Reflect.get(delegate, operation);
													return async () => {
														reachedRevision = true;
														await transaction.$executeRaw`SELECT 1 / 0`;
														throw new Error(
															"Expected PostgreSQL division by zero",
														);
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
				createLibraryGenerationHandler({ prisma: failing })(f.context),
			).rejects.toThrow();
			expect(reachedRevision).toBe(true);
			await expectUnpublished(f);
		});
	},
);
