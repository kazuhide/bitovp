import { randomUUID } from "node:crypto";
import { hashEditingEvidence, normalizeSceneAnalysis } from "@bitovp/core";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	adoptEditingArtifact,
	type EditingArtifactEvidence,
	LIBRARY_REGISTRATION_PENDING,
	promoteEditingArtifact,
} from "./derivatives";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
const sha256 = "1".repeat(64);
const recipeHash = "2".repeat(64);

function barrier() {
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { ready, release };
}

function instrumentTransactions(
	base: AppPrismaClient,
	decorate: (tx: AppTransactionClient) => Promise<AppTransactionClient>,
): AppPrismaClient {
	return new Proxy(base, {
		get(target, key) {
			if (key === "$transaction")
				return (
					fn: (tx: AppTransactionClient) => Promise<unknown>,
					options?: {
						maxWait?: number;
						timeout?: number;
						statementTimeoutMs?: number;
					},
				) => target.$transaction(async (tx) => fn(await decorate(tx)), options);
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL editing artifact and derivative transactions",
	() => {
		const organizationId = randomUUID();
		let admin: AppPrismaClient;
		let app: AppPrismaClient;
		let a: AppPrismaClient;
		let credentialId: string;
		beforeAll(async () => {
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
			a = createTenantPrismaClient(app, organizationId);
			await admin.organization.create({
				data: {
					id: organizationId,
					name: "Editing transaction fixture",
					slug: `editing-${organizationId}`,
				},
			});
			credentialId = (
				await a.credential.create({
					data: {
						label: "Editing fixture",
						provider: "AWS_S3",
						encryptedSecret: "fixture-encrypted",
					},
				})
			).id;
		});
		afterAll(async () => {
			try {
				if (!admin) return;
				const where = { organizationId };
				await admin.contentDerivation.deleteMany({ where });
				await admin.contentRevision.deleteMany({ where });
				await admin.librarySource.deleteMany({
					where: { ...where, sourceKind: "DERIVED_RENDER" },
				});
				await admin.editProject.updateMany({
					where,
					data: { currentRevisionId: null },
				});
				await admin.renderArtifact.deleteMany({ where });
				await admin.renderRun.deleteMany({ where });
				await admin.editRevision.deleteMany({ where });
				await admin.editProject.deleteMany({ where });
				await admin.libraryAnalysisBinding.deleteMany({ where });
				await admin.libraryMediaVersion.deleteMany({ where });
				await admin.sceneAnalysisRevision.deleteMany({ where });
				await admin.librarySource.deleteMany({ where });
				await admin.content.deleteMany({ where });
				await admin.credential.deleteMany({ where });
				await admin.organization.delete({ where: { id: organizationId } });
			} finally {
				if (admin) await admin.$disconnect();
				if (app) await app.$disconnect();
			}
		});
		async function fixture(desiredGeneration = 2) {
			const source = await a.librarySource.create({
				data: {
					sourceKey: randomUUID(),
					originalJobId: randomUUID(),
					encodingId: randomUUID(),
					accountId: randomUUID(),
					snapshot: {},
					locales: [],
				},
			});
			const content = await a.content.create({
				data: {
					registrationKey: randomUUID(),
					title: "Original",
					locale: "ja",
					description: "Source description",
					tags: ["source-tag"],
				},
			});
			const media = await a.libraryMediaVersion.create({
				data: {
					sourceId: source.id,
					credentialId,
					outputCredentialId: credentialId,
					storage: { output: { credentialId } },
				},
			});
			const project = await a.editProject.create({
				data: {
					contentId: content.id,
					mediaVersionId: media.id,
					title: "Highlight",
					variant: "PORTRAIT",
					draft: {},
				},
			});
			const revision = await a.editRevision.create({
				data: {
					projectId: project.id,
					revision: 1,
					document: { locale: "ja" },
				},
			});
			const target = await a.contentDerivation.create({
				data: {
					projectId: project.id,
					variant: project.variant,
					desiredGeneration,
				},
			});
			return { source, content, media, project, revision, target };
		}
		async function runFor(
			f: Awaited<ReturnType<typeof fixture>>,
			generation: number,
		) {
			const artifactToken = randomUUID();
			return a.renderRun.create({
				data: {
					projectId: f.project.id,
					revisionId: f.revision.id,
					generation,
					profile: { kind: "EXPORT" },
					requestKey: randomUUID(),
					requestHash: sha256,
					state: "VALIDATING",
					leaseToken: artifactToken,
					pendingArtifactToken: artifactToken,
					leaseUntil: new Date(Date.now() + 120_000),
					outputCredentialId: credentialId,
					outputBucket: "output",
					outputPrefix: "clips/",
				},
			});
		}
		async function automaticFixture() {
			const f = await fixture(1);
			const map = {
				id: f.media.id,
				mediaVersionId: f.media.id,
				kind: "CFR",
				sourceStartUs: 0,
				sourceEndUs: 2_000_000,
				editingStartFrame: 0,
				editingEndFrame: 60,
				fps: { num: 30, den: 1 },
			};
			const media = await a.libraryMediaVersion.update({
				where: { id: f.media.id },
				data: {
					state: "READY",
					sha256,
					width: 1280,
					height: 720,
					durationUs: 2_000_000n,
					fpsNum: 30,
					fpsDen: 1,
					timeMap: map,
					probe: { supported: true },
				},
			});
			const sceneId = randomUUID();
			const raw = {
				metadata: { version: "promotion-fixture" },
				duration: 2,
				scenes: [
					{
						id: sceneId,
						startInSeconds: 0,
						endInSeconds: 2,
						shots: [{ startInSeconds: 0, endInSeconds: 2 }],
					},
				],
			};
			const document = normalizeSceneAnalysis(raw);
			const analysis = await a.sceneAnalysisRevision.create({
				data: {
					sourceId: f.source.id,
					locale: "ja",
					rawHash: sha256,
					providerVersion: "promotion-fixture",
					raw,
					document,
				},
			});
			const proof = {
				schemaVersion: 1,
				kind: "FIXTURE_AUTHORED",
				organizationId,
				sourceId: f.source.id,
				locale: "ja",
				analysisRevisionId: analysis.id,
				analysisRawHash: analysis.rawHash,
				analysisDocumentHash: hashEditingEvidence(document),
				mediaVersionId: media.id,
				mediaSha256: sha256,
				timeMapId: map.id,
				timeMapHash: hashEditingEvidence(map),
				sourceStartUs: 0,
				sourceEndUs: 2_000_000,
				width: 1280,
				height: 720,
			};
			const binding = await a.libraryAnalysisBinding.create({
				data: {
					mediaVersionId: media.id,
					analysisRevisionId: analysis.id,
					proof,
				},
			});
			const revision = await a.editRevision.create({
				data: {
					projectId: f.project.id,
					revision: 2,
					document: {
						schemaVersion: 1,
						mediaVersionId: media.id,
						analysisRevisionId: analysis.id,
						locale: "ja",
						sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
						timeMapId: map.id,
						canvas: { width: 1080, height: 1920 },
						fps: { num: 30, den: 1 },
						autoGeneration: {
							policyVersion: "aisa-shot-window-v1",
							requestHash: recipeHash,
							requestedDurationFrames: 30,
							generatedDurationFrames: 30,
							reasonCodes: [],
							binding: proof,
						},
						clips: [
							{
								id: randomUUID(),
								sourceInUs: 0,
								durationFrames: 30,
								timelineStartFrame: 0,
								framing: [
									{
										fromFrame: 0,
										toFrame: 30,
										mode: "FIT",
										origin: "AUTO_POLICY",
									},
								],
								audio: { mode: "SOURCE" },
								evidence: { sceneId },
							},
						],
					},
				},
			});
			return { ...f, media, revision, analysis, binding };
		}
		const evidence = (runId: string): EditingArtifactEvidence => ({
			storage: {
				credentialId,
				bucket: "output",
				key: `clips/renders/${runId}/artifact.mp4`,
				size: 20,
				expect: { etag: '"fixed"' },
			},
			sha256,
			bytes: 20,
			probe: { frameCount: 30 },
			recipeHash,
		});
		async function adopt(run: Awaited<ReturnType<typeof runFor>>) {
			if (!run.leaseToken) throw new Error("Expected an owned run");
			return adoptEditingArtifact({
				prisma: a,
				runId: run.id,
				leaseToken: run.leaseToken,
				evidence: evidence(run.id),
			});
		}

		it("fences a late lease and atomically accepts only one of two completion attempts", async () => {
			const f = await fixture();
			const run = await runFor(f, 2);
			const replacement = randomUUID();
			await a.renderRun.update({
				where: { id: run.id },
				data: { leaseToken: replacement },
			});
			expect(
				await a.renderRun.findUnique({ where: { id: run.id } }),
			).toMatchObject({
				pendingArtifactToken: run.pendingArtifactToken,
			});
			expect(await adopt(run)).toBeNull();
			const attempts = await Promise.all(
				[1, 2].map(() =>
					adoptEditingArtifact({
						prisma: a,
						runId: run.id,
						leaseToken: replacement,
						evidence: evidence(run.id),
					}),
				),
			);
			expect(attempts.filter(Boolean)).toHaveLength(1);
			expect(await a.renderArtifact.count({ where: { runId: run.id } })).toBe(
				1,
			);
			expect(
				await a.renderRun.findUnique({ where: { id: run.id } }),
			).toMatchObject({
				state: "SUCCEEDED",
				leaseToken: null,
				pendingArtifactToken: null,
				error: LIBRARY_REGISTRATION_PENDING,
			});
		});

		it("keeps the newer derivative current when an older generation finishes last", async () => {
			const f = await fixture();
			const older = await runFor(f, 1);
			const newer = await runFor(f, 2);
			const newerArtifact = await adopt(newer);
			expect(await promoteEditingArtifact({ prisma: a, runId: newer.id })).toBe(
				true,
			);
			await adopt(older);
			expect(await promoteEditingArtifact({ prisma: a, runId: older.id })).toBe(
				false,
			);
			const target = await a.contentDerivation.findUnique({
				where: { id: f.target.id },
			});
			expect(target).toMatchObject({
				activeGeneration: 2,
				activeArtifactId: newerArtifact,
			});
			if (!target?.derivedContentId)
				throw new Error("Expected a promoted Content");
			const revisions = await a.contentRevision.findMany({
				where: { contentId: target.derivedContentId },
				include: { source: true },
			});
			expect(revisions).toHaveLength(1);
			expect(revisions[0]?.source.renderArtifactId).toBe(newerArtifact);
		});

		it("retains operator-edited metadata when advancing an existing derivative", async () => {
			const f = await fixture(1);
			const first = await runFor(f, 1);
			await adopt(first);
			await promoteEditingArtifact({ prisma: a, runId: first.id });
			const target = await a.contentDerivation.findUnique({
				where: { id: f.target.id },
			});
			if (!target?.derivedContentId)
				throw new Error("Expected a promoted Content");
			await a.$transaction(async (tx) => {
				const content = await tx.content.findUnique({
					where: { id: target.derivedContentId ?? "" },
				});
				if (!content) throw new Error("Expected an existing Content");
				const previous = await tx.contentRevision.findFirst({
					where: { contentId: content.id, revision: content.revision },
				});
				if (!previous) throw new Error("Expected current source revision");
				await tx.content.update({
					where: { id: content.id },
					data: {
						title: "Editor title",
						description: "Editor description",
						tags: ["editor-tag"],
						revision: 2,
					},
				});
				await tx.contentRevision.create({
					data: {
						contentId: content.id,
						revision: 2,
						sourceId: previous.sourceId,
						title: "Editor title",
						description: "Editor description",
						tags: ["editor-tag"],
						locale: content.locale,
					},
				});
			});
			await a.contentDerivation.update({
				where: { id: f.target.id },
				data: { desiredGeneration: 2 },
			});
			const second = await runFor(f, 2);
			await adopt(second);
			await promoteEditingArtifact({ prisma: a, runId: second.id });
			expect(
				await a.content.findUnique({ where: { id: target.derivedContentId } }),
			).toMatchObject({
				title: "Editor title",
				description: "Editor description",
				tags: ["editor-tag"],
				revision: 3,
			});
			expect(
				await a.contentRevision.findFirst({
					where: { contentId: target.derivedContentId, revision: 3 },
				}),
			).toMatchObject({ title: "Editor title", tags: ["editor-tag"] });
		});

		it("rolls back failed Library registration and retries the already adopted artifact", async () => {
			const f = await fixture(1);
			const run = await runFor(f, 1);
			const artifactId = await adopt(run);
			const collision = await a.content.create({
				data: {
					registrationKey: `edit:${organizationId}:${f.project.id}:${f.project.variant}`,
					title: "Collision",
					locale: "und",
				},
			});
			await expect(
				promoteEditingArtifact({ prisma: a, runId: run.id }),
			).rejects.toThrow();
			expect(await a.renderArtifact.count({ where: { runId: run.id } })).toBe(
				1,
			);
			expect(
				await a.librarySource.count({
					where: { renderArtifactId: artifactId },
				}),
			).toBe(0);
			expect(
				await a.contentDerivation.findUnique({ where: { id: f.target.id } }),
			).toMatchObject({ activeGeneration: 0, derivedContentId: null });
			expect(
				await a.renderRun.findUnique({ where: { id: run.id } }),
			).toMatchObject({
				state: "SUCCEEDED",
				error: LIBRARY_REGISTRATION_PENDING,
			});
			await a.content.delete({ where: { id: collision.id } });
			expect(await promoteEditingArtifact({ prisma: a, runId: run.id })).toBe(
				true,
			);
			expect(
				await a.renderArtifact.findUnique({ where: { runId: run.id } }),
			).toMatchObject({ id: artifactId, sha256 });
		});

		it("promotes an automatic export with its live fixed binding", async () => {
			const f = await automaticFixture();
			const run = await runFor(f, 1);
			const artifactId = await adopt(run);
			expect(
				await a.renderRun.findUnique({ where: { id: run.id } }),
			).toMatchObject({
				state: "SUCCEEDED",
				error: LIBRARY_REGISTRATION_PENDING,
			});
			expect(await promoteEditingArtifact({ prisma: a, runId: run.id })).toBe(
				true,
			);
			expect(
				await a.contentDerivation.findUnique({ where: { id: f.target.id } }),
			).toMatchObject({ activeGeneration: 1, activeArtifactId: artifactId });
			expect(
				await a.librarySource.findUnique({
					where: { renderArtifactId: artifactId ?? "" },
				}),
			).toMatchObject({
				sourceKind: "DERIVED_RENDER",
				snapshot: { identity: "VERIFIED" },
			});
			expect(
				await a.renderRun.findUnique({ where: { id: run.id } }),
			).toMatchObject({ state: "SUCCEEDED", error: null });
		});

		it("refuses pending automatic registration after its binding is deleted", async () => {
			const f = await automaticFixture();
			const run = await runFor(f, 1);
			const artifactId = await adopt(run);
			const collision = await a.content.create({
				data: {
					registrationKey: `edit:${organizationId}:${f.project.id}:${f.project.variant}`,
					title: "Collision",
					locale: "und",
				},
			});
			await expect(
				promoteEditingArtifact({ prisma: a, runId: run.id }),
			).rejects.toThrow();
			await a.content.delete({ where: { id: collision.id } });
			await a.libraryAnalysisBinding.delete({ where: { id: f.binding.id } });
			await expect(
				promoteEditingArtifact({ prisma: a, runId: run.id }),
			).rejects.toMatchObject({ code: "ANALYSIS_BINDING_UNVERIFIED" });
			expect(
				await a.librarySource.count({
					where: { renderArtifactId: artifactId },
				}),
			).toBe(0);
			expect(
				await a.contentDerivation.findUnique({ where: { id: f.target.id } }),
			).toMatchObject({
				activeGeneration: 0,
				activeArtifactId: null,
				derivedContentId: null,
			});
			expect(
				await a.renderRun.findUnique({ where: { id: run.id } }),
			).toMatchObject({
				state: "SUCCEEDED",
				error: LIBRARY_REGISTRATION_PENDING,
			});
			expect(
				await a.renderArtifact.findUnique({ where: { runId: run.id } }),
			).toMatchObject({ id: artifactId, sha256 });
		});

		it("holds the live binding against DELETE until automatic promotion commits", async () => {
			const f = await automaticFixture();
			const run = await runFor(f, 1);
			const artifactId = await adopt(run);
			const atWrite = barrier();
			const release = barrier();
			const deleteStarted = barrier();
			let promotionPid = 0;
			let deletePid = 0;
			let promotion: Promise<PromiseSettledResult<boolean>[]> | undefined;
			let deletion: Promise<PromiseSettledResult<unknown>[]> | undefined;
			try {
				const promoter = instrumentTransactions(a, async (tx) => {
					promotionPid =
						(
							await tx.$queryRaw<
								{ pid: number }[]
							>`SELECT pg_backend_pid() AS pid`
						)[0]?.pid ?? 0;
					return new Proxy(tx, {
						get(target, key) {
							if (key === "contentDerivation")
								return new Proxy(target.contentDerivation, {
									get(delegate, method) {
										if (method === "updateMany")
											return async (
												...args: Parameters<typeof delegate.updateMany>
											) => {
												atWrite.release();
												await release.ready;
												return delegate.updateMany(...args);
											};
										return Reflect.get(delegate, method);
									},
								});
							return Reflect.get(target, key);
						},
					});
				});
				promotion = Promise.allSettled([
					promoteEditingArtifact({ prisma: promoter, runId: run.id }),
				]);
				await Promise.race([
					atWrite.ready,
					promotion.then((result) => {
						throw new Error("Promotion ended before write barrier", {
							cause: result,
						});
					}),
				]);
				deletion = Promise.allSettled([
					a.$transaction(async (tx) => {
						deletePid =
							(
								await tx.$queryRaw<
									{ pid: number }[]
								>`SELECT pg_backend_pid() AS pid`
							)[0]?.pid ?? 0;
						deleteStarted.release();
						return tx.libraryAnalysisBinding.delete({
							where: { id: f.binding.id },
						});
					}),
				]);
				await deleteStarted.ready;
				let settled = false;
				void deletion.then(() => {
					settled = true;
				});
				let blocked = false;
				const deadline = Date.now() + 3000;
				while (Date.now() < deadline && !settled) {
					blocked =
						(
							await admin.$queryRaw<
								{ blocked: boolean }[]
							>`SELECT ${promotionPid}::integer = ANY(pg_blocking_pids(${deletePid}::integer)) AS blocked`
						)[0]?.blocked ?? false;
					if (blocked) break;
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
				expect(blocked).toBe(true);
				release.release();
				expect((await promotion)[0]).toMatchObject({
					status: "fulfilled",
					value: true,
				});
				expect((await deletion)[0]?.status).toBe("fulfilled");
				expect(
					await a.contentDerivation.findUnique({ where: { id: f.target.id } }),
				).toMatchObject({ activeGeneration: 1, activeArtifactId: artifactId });
				expect(
					await a.libraryAnalysisBinding.findUnique({
						where: { id: f.binding.id },
					}),
				).toBeNull();
			} finally {
				release.release();
				await promotion;
				await deletion;
			}
		});

		it("refuses artifact adoption when the automatic binding expires during render", async () => {
			const f = await automaticFixture();
			const run = await runFor(f, 1);
			await a.libraryAnalysisBinding.delete({ where: { id: f.binding.id } });
			await expect(adopt(run)).rejects.toMatchObject({
				code: "ANALYSIS_BINDING_UNVERIFIED",
			});
			expect(await a.renderArtifact.count({ where: { runId: run.id } })).toBe(
				0,
			);
			expect(
				await a.renderRun.findUnique({ where: { id: run.id } }),
			).toMatchObject({
				state: "VALIDATING",
				leaseToken: run.leaseToken,
				pendingArtifactToken: run.pendingArtifactToken,
				error: null,
			});
			expect(
				await a.contentDerivation.findUnique({ where: { id: f.target.id } }),
			).toMatchObject({
				activeGeneration: 0,
				activeArtifactId: null,
				derivedContentId: null,
			});
		});
	},
);
