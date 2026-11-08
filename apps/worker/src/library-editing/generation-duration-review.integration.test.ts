import {
	compositionDocumentSchema,
	hashEditingEvidence,
	mediaTaskCreateSchema,
	mediaTaskEnvelopeSchema,
	mediaTaskIntentHash,
} from "@bitovp/core";
import {
	type AppPrismaClient,
	createPrismaClient,
	createTenantPrismaClient,
	type Prisma,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLibraryGenerationHandler } from "./generation";
import { durationReviewFixture } from "./generation-duration-review-fixture";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL,
	appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
const json = (value: unknown): Prisma.InputJsonValue =>
	JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL duration-review-v2 immutable draft publication",
	() => {
		let admin: AppPrismaClient, app: AppPrismaClient;
		const organizations: string[] = [];
		beforeAll(() => {
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
		});
		afterAll(async () => {
			try {
				for (const organizationId of organizations) {
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
				}
			} finally {
				await admin?.$disconnect();
				await app?.$disconnect();
			}
		});
		async function fixture(
			versioned = true,
			mode: "DRAFT" | "EXPORT" = "DRAFT",
		) {
			const f = durationReviewFixture(89, versioned, mode),
				organizationId = f.task.organizationId;
			await admin.organization.create({
				data: {
					id: organizationId,
					name: "Duration review fixture",
					slug: `duration-review-${organizationId}`,
				},
			});
			organizations.push(organizationId);
			const db = createTenantPrismaClient(app, organizationId),
				credentialId = f.media.storage.output.credentialId,
				contentId = f.task.parameters.input.parameters.contentId;
			await db.credential.create({
				data: {
					id: credentialId,
					label: "Local test only",
					provider: "AWS_S3",
					encryptedSecret: "fixture",
				},
			});
			await db.librarySource.create({
				data: {
					id: f.media.sourceId,
					sourceKey: f.media.sourceId,
					originalJobId: f.media.sourceId,
					encodingId: f.media.sourceId,
					accountId: f.media.sourceId,
					snapshot: { fixture: true },
					locales: ["ja"],
				},
			});
			await db.content.create({
				data: {
					id: contentId,
					registrationKey: contentId,
					title: "Duration review fixture",
					description: "",
					tags: [],
					locale: "ja",
				},
			});
			await db.contentRevision.create({
				data: {
					contentId,
					sourceId: f.media.sourceId,
					revision: 1,
					title: "Duration review fixture",
					description: "",
					tags: [],
					locale: "ja",
				},
			});
			const media = await db.libraryMediaVersion.create({
				data: {
					id: f.media.id,
					sourceId: f.media.sourceId,
					credentialId,
					outputCredentialId: credentialId,
					state: "READY",
					sha256: f.media.sha256,
					width: f.media.width,
					height: f.media.height,
					durationUs: f.media.durationUs,
					fpsNum: 30,
					fpsDen: 1,
					timeMap: json(f.media.timeMap),
					probe: json(f.media.probe),
					storage: json(f.media.storage),
				},
			});
			const persistedAnalysis = await db.sceneAnalysisRevision.create({
				data: {
					id: f.analysis.id,
					sourceId: f.media.sourceId,
					locale: "ja",
					providerVersion: "authored-duration-review-fixture",
					rawHash: f.analysis.rawHash,
					raw: json(f.raw),
					document: json(f.analysis.document),
				},
			});
			// Authored proof hashes must match the actual persisted JSON representation.
			expect(persistedAnalysis.document).toEqual(json(f.analysis.document));
			expect({
				organizationMatches:
					persistedAnalysis.organizationId === f.task.organizationId,
				sourceMatches: persistedAnalysis.sourceId === f.media.sourceId,
				documentHashMatches:
					hashEditingEvidence(persistedAnalysis.document) ===
					f.task.parameters.identity.analysisDocumentHash,
				rawHashMatches:
					persistedAnalysis.rawHash ===
					f.task.parameters.identity.analysisRawHash,
			}).toEqual({
				organizationMatches: true,
				sourceMatches: true,
				documentHashMatches: true,
				rawHashMatches: true,
			});
			await db.libraryAnalysisBinding.create({
				data: {
					mediaVersionId: media.id,
					analysisRevisionId: f.analysis.id,
					proof: json(f.binding),
				},
			});
			await db.libraryMediaTask.create({
				data: {
					id: f.dependency.id,
					kind: "TRANSCRIBE",
					mediaVersionId: media.id,
					requestKey: f.dependency.requestKey,
					requestHash: f.dependency.requestHash,
					cacheKey: f.dependency.cacheKey,
					parameters: json(f.dependency.parameters),
					state: "SUCCEEDED",
					phase: "COMPLETE",
					result: json(f.dependency.result),
					finishedAt: new Date(),
					createdBy: "fixture",
				},
			});
			const task = await db.libraryMediaTask.create({
				data: {
					id: f.task.id,
					kind: "GENERATE",
					mediaVersionId: media.id,
					analysisRevisionId: f.analysis.id,
					requestKey: f.task.requestKey,
					requestHash: f.task.requestHash,
					cacheKey: f.task.cacheKey,
					parameters: json(f.task.parameters),
					state: "RUNNING",
					phase: "QUEUED",
					attempts: 1,
					leaseToken: f.task.leaseToken,
					leaseUntil: f.task.leaseUntil,
					createdBy: "fixture",
				},
			});
			const context = { ...f.context, media };
			return {
				...f,
				db,
				task,
				context,
				handler: createLibraryGenerationHandler({ prisma: db }),
			};
		}
		it("commits the 100f reviewable anchor and exact evidence without a render, preserves its immutable result/revision and replays once", async () => {
			const f = await fixture(),
				result = await f.handler(f.context);
			expect(result).toMatchObject({
				renderMode: "DRAFT",
				draftPolicyVersion: "duration-review-v2",
				requestedFrames: 100,
				actualFrames: 100,
				selectionEvidence: {
					status: "FALLBACK",
					reason: "SPEECH_DURATION_REVIEW_REQUIRED",
					draftPolicyVersion: "duration-review-v2",
					intervals: [
						{ startUs: 400000, endUs: 600000 },
						{ startUs: 3500000, endUs: 4500000 },
					],
				},
			});
			expect(result.selectionEvidence?.rejectedBoundaryCount).toBe(1);
			const project = await f.db.editProject.findUniqueOrThrow({
					where: { id: result.projectId },
				}),
				document = compositionDocumentSchema.parse(project.draft);
			expect(document.clips.map((c) => c.durationFrames)).toEqual([89, 11]);
			expect(document.autoGeneration).toMatchObject({
				renderMode: "DRAFT",
				draftPolicyVersion: "duration-review-v2",
				generatedDurationFrames: 100,
			});
			expect(document.autoGeneration?.reasonCodes).toContain(
				"SPEECH_DURATION_REVIEW_REQUIRED",
			);
			expect(document.captions?.map((c) => c.text)).toContain(
				"measured speech across anchor end",
			);
			expect(project.currentRevisionId).not.toBeNull();
			expect(
				await f.db.renderRun.count({ where: { projectId: project.id } }),
			).toBe(0);
			expect(
				await f.db.contentDerivation.count({
					where: { projectId: project.id },
				}),
			).toBe(0);
			const stored = await f.db.libraryMediaTask.findUniqueOrThrow({
				where: { id: f.task.id },
			});
			expect(stored.result).toEqual(result);
			expect(stored.parameters).toEqual(f.task.parameters);
			await expect(
				f.db.libraryMediaTask.update({
					where: { id: f.task.id },
					data: { result: json({ ...result, actualFrames: 89 }) },
				}),
			).rejects.toThrow();
			expect(await f.handler(f.context)).toEqual(result);
			expect(
				await f.db.editProject.count({
					where: { contentId: f.context.parameters.contentId },
				}),
			).toBe(1);
			expect(
				await f.db.editRevision.count({ where: { projectId: project.id } }),
			).toBe(1);
			expect(
				(
					await f.db.editRevision.findFirstOrThrow({
						where: { projectId: project.id, revision: 1 },
					})
				).document,
			).toEqual(project.draft);
		});
		it("keeps missing-version DRAFT/EXPORT at 89f and refuses an in-place policy upgrade of durable intent", async () => {
			for (const mode of ["DRAFT", "EXPORT"] as const) {
				const f = await fixture(false, mode),
					result = await f.handler(f.context);
				expect(result.actualFrames).toBe(89);
				expect(result.selectionEvidence?.status).toBe("APPLIED");
				expect(Object.hasOwn(result, "draftPolicyVersion")).toBe(false);
				expect(
					await f.db.renderRun.count({
						where: { projectId: result.projectId },
					}),
				).toBe(mode === "EXPORT" ? 1 : 0);
				expect(
					await f.db.contentDerivation.count({
						where: { projectId: result.projectId },
					}),
				).toBe(mode === "EXPORT" ? 1 : 0);
				const original = mediaTaskEnvelopeSchema.parse(f.task.parameters);
				if (original.input.kind !== "GENERATE")
					throw new Error("Expected a generation fixture");
				const changedIntent = {
					...original.input,
					parameters: {
						...original.input.parameters,
						draftPolicyVersion: "duration-review-v2" as const,
					},
				};
				const parsed = mediaTaskCreateSchema.safeParse(changedIntent);
				expect(parsed.success).toBe(mode === "DRAFT");
				if (parsed.success)
					expect(mediaTaskIntentHash(parsed.data)).not.toBe(f.task.requestHash);
				await expect(
					f.db.libraryMediaTask.update({
						where: { id: f.task.id },
						data: { parameters: json({ ...original, input: changedIntent }) },
					}),
				).rejects.toThrow();
				expect(
					hashEditingEvidence(
						(
							await f.db.libraryMediaTask.findUniqueOrThrow({
								where: { id: f.task.id },
							})
						).parameters,
					),
				).toBe(hashEditingEvidence(f.task.parameters));
				expect(await f.handler(f.context)).toEqual(result);
			}
		});
	},
);
