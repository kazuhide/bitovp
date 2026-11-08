import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppPrismaClient, createPrismaClient } from "./client";
import { createTenantPrismaClient } from "./tenant-client";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
const sha256 = "1".repeat(64);

describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL Library editing persistence boundaries",
	() => {
		const orgA = randomUUID();
		const orgB = randomUUID();
		let admin: AppPrismaClient;
		let app: AppPrismaClient;
		let a: AppPrismaClient;
		let b: AppPrismaClient;
		let credentialA: string;
		let credentialB: string;

		beforeAll(async () => {
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
			a = createTenantPrismaClient(app, orgA);
			b = createTenantPrismaClient(app, orgB);
			await admin.organization.createMany({
				data: [
					{ id: orgA, name: "Edit A", slug: `edit-${orgA}` },
					{ id: orgB, name: "Edit B", slug: `edit-${orgB}` },
				],
			});
			const credential = async (client: AppPrismaClient) =>
				(
					await client.credential.create({
						data: {
							label: "Editing fixture",
							provider: "AWS_S3",
							encryptedSecret: "fixture-encrypted-secret",
						},
					})
				).id;
			credentialA = await credential(a);
			credentialB = await credential(b);
		});

		afterAll(async () => {
			try {
				if (!admin) return;
				const where = { organizationId: { in: [orgA, orgB] } };
				await admin.libraryAnalysisBinding.deleteMany({ where });
				await admin.sceneAnalysisRevision.deleteMany({ where });
				await admin.contentDerivation.deleteMany({ where });
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
				await admin.libraryMediaVersion.deleteMany({ where });
				await admin.contentRevision.deleteMany({ where });
				await admin.librarySource.deleteMany({ where });
				await admin.content.deleteMany({ where });
				await admin.credential.deleteMany({ where });
				await admin.organization.deleteMany({
					where: { id: { in: [orgA, orgB] } },
				});
			} finally {
				if (admin) await admin.$disconnect();
				if (app) await app.$disconnect();
			}
		});

		async function fixture(
			client = a,
			credentialId = credentialA,
			outputCredentialId = credentialId,
		) {
			const source = await client.librarySource.create({
				data: {
					sourceKey: randomUUID(),
					originalJobId: randomUUID(),
					encodingId: randomUUID(),
					accountId: randomUUID(),
					snapshot: {},
					locales: [],
					state: "READY",
				},
			});
			const content = await client.content.create({
				data: {
					registrationKey: randomUUID(),
					title: "Editing fixture",
					locale: "und",
				},
			});
			const media = await client.libraryMediaVersion.create({
				data: {
					sourceId: source.id,
					credentialId,
					outputCredentialId,
					storage: { output: { credentialId: outputCredentialId } },
				},
			});
			const project = await client.editProject.create({
				data: {
					contentId: content.id,
					mediaVersionId: media.id,
					title: "Edit",
					variant: "LANDSCAPE",
					draft: {},
				},
			});
			const revision = await client.editRevision.create({
				data: { projectId: project.id, revision: 1, document: {} },
			});
			return { source, content, media, project, revision };
		}

		async function execution(f: Awaited<ReturnType<typeof fixture>>) {
			const run = await a.renderRun.create({
				data: {
					projectId: f.project.id,
					revisionId: f.revision.id,
					profile: { kind: "EXPORT" },
					requestKey: randomUUID(),
					requestHash: sha256,
					generation: 1,
					outputCredentialId: credentialA,
					outputBucket: "fixture-output",
					outputPrefix: "clips/",
				},
			});
			const artifact = await a.renderArtifact.create({
				data: { runId: run.id, storage: {}, sha256, size: 1n, probe: {} },
			});
			return { run, artifact };
		}

		async function analysisFor(sourceId: string, client = a) {
			return client.sceneAnalysisRevision.create({
				data: {
					sourceId,
					locale: "ja",
					rawHash: randomUUID(),
					providerVersion: "binding-fixture",
					raw: {},
					document: {},
				},
			});
		}

		it("creates isolated binding proof without changing READY media or immutable analysis", async () => {
			const f = await fixture();
			const media = await a.libraryMediaVersion.update({
				where: { id: f.media.id },
				data: {
					state: "READY",
					sha256,
					durationUs: 1_000_000n,
					width: 1920,
					height: 1080,
					fpsNum: 30,
					fpsDen: 1,
					timeMap: {},
					probe: { originalEvidence: true },
				},
			});
			const analysis = await analysisFor(f.source.id);
			const binding = await a.libraryAnalysisBinding.create({
				data: {
					mediaVersionId: media.id,
					analysisRevisionId: analysis.id,
					proof: { fixture: true },
				},
			});
			expect(binding).toMatchObject({
				organizationId: orgA,
				proof: { fixture: true },
			});
			expect(binding.createdAt).toBeInstanceOf(Date);
			expect(
				await a.libraryMediaVersion.findUnique({ where: { id: media.id } }),
			).toEqual(media);
			expect(
				await a.sceneAnalysisRevision.findUnique({
					where: { id: analysis.id },
				}),
			).toEqual(analysis);
			expect(await b.libraryAnalysisBinding.findMany()).toEqual([]);
			expect(await app.libraryAnalysisBinding.findMany()).toEqual([]);
			await expect(
				app.libraryAnalysisBinding.create({
					data: {
						mediaVersionId: media.id,
						analysisRevisionId: analysis.id,
						proof: {},
					},
				}),
			).rejects.toThrow();
		});

		it("rejects all binding UPDATEs and duplicate tuple proofs while permitting a different tuple", async () => {
			const f = await fixture();
			const analysis = await analysisFor(f.source.id);
			const data = {
				mediaVersionId: f.media.id,
				analysisRevisionId: analysis.id,
				proof: { fixture: true },
			};
			const binding = await a.libraryAnalysisBinding.create({ data });
			await expect(
				a.libraryAnalysisBinding.update({
					where: { id: binding.id },
					data: { proof: { replacement: true } },
				}),
			).rejects.toThrow();
			await expect(
				a.libraryAnalysisBinding.update({
					where: { id: binding.id },
					data: { proof: data.proof },
				}),
			).rejects.toThrow();
			await expect(
				admin.$executeRaw`UPDATE "LibraryAnalysisBinding" SET "createdAt" = "createdAt" WHERE "id" = ${binding.id}::uuid`,
			).rejects.toThrow();
			await expect(
				a.libraryAnalysisBinding.create({
					data: { ...data, proof: { duplicate: true } },
				}),
			).rejects.toMatchObject({ code: "P2002" });
			const otherAnalysis = await analysisFor(f.source.id);
			await expect(
				a.libraryAnalysisBinding.create({
					data: { ...data, analysisRevisionId: otherAnalysis.id },
				}),
			).resolves.toMatchObject({ analysisRevisionId: otherAnalysis.id });
			expect(
				await a.libraryAnalysisBinding.findUnique({
					where: { id: binding.id },
				}),
			).toEqual(binding);
		});

		it("rejects cross-organization binding parents in PostgreSQL and hides foreign DELETEs", async () => {
			const first = await fixture();
			const second = await fixture(b, credentialB);
			let foreignAnalysisId: string | undefined;
			try {
				const ownAnalysis = await analysisFor(first.source.id);
				const foreignAnalysis = await analysisFor(second.source.id, b);
				foreignAnalysisId = foreignAnalysis.id;
				await expect(
					a.libraryAnalysisBinding.create({
						data: {
							mediaVersionId: second.media.id,
							analysisRevisionId: ownAnalysis.id,
							proof: {},
						},
					}),
				).rejects.toThrow();
				await expect(
					a.libraryAnalysisBinding.create({
						data: {
							mediaVersionId: first.media.id,
							analysisRevisionId: foreignAnalysis.id,
							proof: {},
						},
					}),
				).rejects.toThrow();
				await expect(
					admin.libraryAnalysisBinding.create({
						data: {
							organizationId: orgA,
							mediaVersionId: second.media.id,
							analysisRevisionId: ownAnalysis.id,
							proof: {},
						},
					}),
				).rejects.toThrow();
				const binding = await a.libraryAnalysisBinding.create({
					data: {
						mediaVersionId: first.media.id,
						analysisRevisionId: ownAnalysis.id,
						proof: {},
					},
				});
				expect(
					await b.libraryAnalysisBinding.deleteMany({
						where: { id: binding.id },
					}),
				).toEqual({ count: 0 });
				expect(
					await a.libraryAnalysisBinding.findUnique({
						where: { id: binding.id },
					}),
				).not.toBeNull();
			} finally {
				// Restore the shared foreign tenant's empty editing-table invariant.
				// Every predicate is restricted to UUIDs created by this test.
				await admin.libraryAnalysisBinding.deleteMany({
					where: {
						OR: [
							{ mediaVersionId: second.media.id },
							...(foreignAnalysisId
								? [{ analysisRevisionId: foreignAnalysisId }]
								: []),
						],
					},
				});
				await admin.editRevision.delete({ where: { id: second.revision.id } });
				await admin.editProject.delete({ where: { id: second.project.id } });
				await admin.libraryMediaVersion.delete({
					where: { id: second.media.id },
				});
				await admin.sceneAnalysisRevision.deleteMany({
					where: { sourceId: second.source.id },
				});
				await admin.content.delete({ where: { id: second.content.id } });
				await admin.librarySource.delete({ where: { id: second.source.id } });
			}
		});

		it("requires explicit child deletion before either binding parent and permits DELETE", async () => {
			const f = await fixture();
			const media = await a.libraryMediaVersion.create({
				data: {
					sourceId: f.source.id,
					credentialId: credentialA,
					outputCredentialId: credentialA,
					storage: { output: { credentialId: credentialA } },
				},
			});
			const analysis = await analysisFor(f.source.id);
			const binding = await a.libraryAnalysisBinding.create({
				data: {
					mediaVersionId: media.id,
					analysisRevisionId: analysis.id,
					proof: {},
				},
			});
			await expect(
				a.libraryMediaVersion.delete({ where: { id: media.id } }),
			).rejects.toThrow();
			await expect(
				a.sceneAnalysisRevision.delete({ where: { id: analysis.id } }),
			).rejects.toThrow();
			await a.libraryAnalysisBinding.delete({ where: { id: binding.id } });
			await a.libraryMediaVersion.delete({ where: { id: media.id } });
			await a.sceneAnalysisRevision.delete({ where: { id: analysis.id } });
			expect(
				await a.librarySource.findUnique({ where: { id: f.source.id } }),
			).not.toBeNull();
			expect(
				await a.editProject.findUnique({ where: { id: f.project.id } }),
			).not.toBeNull();
		});

		it("leaves same-source verification to the caller while preserving same-tenant foreign keys", async () => {
			const first = await fixture();
			const second = await fixture();
			const analysis = await analysisFor(second.source.id);
			await expect(
				a.libraryAnalysisBinding.create({
					data: {
						mediaVersionId: first.media.id,
						analysisRevisionId: analysis.id,
						proof: {},
					},
				}),
			).resolves.toMatchObject({
				organizationId: orgA,
				mediaVersionId: first.media.id,
				analysisRevisionId: analysis.id,
			});
		});

		it("isolates every editing table and rejects cross-organization references", async () => {
			const f = await fixture();
			const { run, artifact } = await execution(f);
			await a.contentDerivation.create({
				data: { projectId: f.project.id, variant: "LANDSCAPE" },
			});
			expect(
				await Promise.all([
					b.libraryMediaVersion.count(),
					b.editProject.count(),
					b.editRevision.count(),
					b.renderRun.count(),
					b.renderArtifact.count(),
					b.contentDerivation.count(),
				]),
			).toEqual([0, 0, 0, 0, 0, 0]);
			expect(await app.editProject.findMany()).toEqual([]);
			await expect(
				a.libraryMediaVersion.create({
					data: {
						sourceId: f.source.id,
						credentialId: credentialB,
						outputCredentialId: credentialA,
						storage: { output: { credentialId: credentialA } },
					},
				}),
			).rejects.toThrow();
			await expect(
				a.renderArtifact.update({
					where: { id: artifact.id },
					data: { organizationId: orgB },
				}),
			).rejects.toThrow();
			expect(
				await b.renderRun.findUnique({ where: { id: run.id } }),
			).toBeNull();
		});

		it("protects a separate prepared output credential before any render exists", async () => {
			const output = await a.credential.create({
				data: {
					label: "Separate output",
					provider: "AWS_S3",
					encryptedSecret: "fixture-output",
				},
			});
			const f = await fixture(a, credentialA, output.id);
			await expect(
				a.libraryMediaVersion.update({
					where: { id: f.media.id },
					data: {
						outputCredentialId: credentialB,
						storage: { output: { credentialId: credentialB } },
					},
				}),
			).rejects.toThrow();
			await expect(
				a.libraryMediaVersion.update({
					where: { id: f.media.id },
					data: {
						storage: {
							output: { credentialId: output.id },
							prepared: { credentialId: credentialA },
						},
					},
				}),
			).rejects.toThrow();
			await a.libraryMediaVersion.update({
				where: { id: f.media.id },
				data: {
					state: "READY",
					sha256,
					durationUs: 1_000_000n,
					width: 640,
					height: 360,
					fpsNum: 30,
					fpsDen: 1,
					timeMap: {},
					probe: {},
					storage: {
						output: { credentialId: output.id },
						prepared: { credentialId: output.id },
					},
				},
			});
			expect(
				await a.renderRun.count({ where: { projectId: f.project.id } }),
			).toBe(0);
			await expect(
				a.credential.delete({ where: { id: output.id } }),
			).rejects.toThrow();
			expect(
				await a.libraryMediaVersion.findUnique({ where: { id: f.media.id } }),
			).toMatchObject({
				state: "READY",
				credentialId: credentialA,
				outputCredentialId: output.id,
			});
		});

		it("registers one real derived origin and rejects absent or fabricated origins", async () => {
			const f = await fixture();
			const { artifact } = await execution(f);
			const base = {
				sourceKey: randomUUID(),
				sourceKind: "DERIVED_RENDER" as const,
				renderArtifactId: artifact.id,
				snapshot: {},
				locales: [],
				state: "READY",
			};
			await expect(
				a.librarySource.create({
					data: { ...base, originalJobId: randomUUID() },
				}),
			).rejects.toThrow();
			await expect(
				a.librarySource.create({ data: { ...base, renderArtifactId: null } }),
			).rejects.toThrow();
			const derived = await a.librarySource.create({ data: base });
			expect(derived).toMatchObject({
				originalJobId: null,
				encodingId: null,
				accountId: null,
			});
			await expect(
				a.librarySource.create({ data: { ...base, sourceKey: randomUUID() } }),
			).rejects.toThrow();
		});

		it("requires complete READY media and keeps media, revision and artifact evidence immutable", async () => {
			const f = await fixture();
			await expect(
				a.libraryMediaVersion.update({
					where: { id: f.media.id },
					data: { state: "READY" },
				}),
			).rejects.toThrow();
			await a.libraryMediaVersion.update({
				where: { id: f.media.id },
				data: {
					state: "READY",
					sha256,
					durationUs: 1_000_000n,
					width: 1920,
					height: 1080,
					fpsNum: 30,
					fpsDen: 1,
					timeMap: {},
					probe: {},
				},
			});
			await expect(
				a.libraryMediaVersion.update({
					where: { id: f.media.id },
					data: { state: "RUNNING", storage: { key: "replacement" } },
				}),
			).rejects.toThrow();
			await expect(
				a.editRevision.update({
					where: { id: f.revision.id },
					data: { document: { clips: ["replacement"] } },
				}),
			).rejects.toThrow();
			const { artifact } = await execution(f);
			await expect(
				a.renderArtifact.update({
					where: { id: artifact.id },
					data: { storage: { key: "replacement" } },
				}),
			).rejects.toThrow();
			await expect(
				a.renderArtifact.update({
					where: { id: artifact.id },
					data: { reviewState: "ACCEPTED" },
				}),
			).resolves.toMatchObject({ reviewState: "ACCEPTED" });
		});

		it("refuses another project's current, parent and render revision even in the same organization", async () => {
			const first = await fixture();
			const second = await fixture();
			await expect(
				a.editProject.update({
					where: { id: first.project.id },
					data: { currentRevisionId: second.revision.id },
				}),
			).rejects.toThrow();
			await expect(
				a.editRevision.create({
					data: {
						projectId: first.project.id,
						revision: 2,
						document: {},
						parentRevisionId: second.revision.id,
					},
				}),
			).rejects.toThrow();
			await expect(
				a.renderRun.create({
					data: {
						projectId: first.project.id,
						revisionId: second.revision.id,
						profile: { kind: "PREVIEW" },
						requestKey: randomUUID(),
						requestHash: sha256,
						outputCredentialId: credentialA,
						outputBucket: "fixture-output",
						outputPrefix: "clips/",
					},
				}),
			).rejects.toThrow();
		});

		it("allows independent previews but uniquely claims each export generation and request key", async () => {
			const f = await fixture();
			const base = {
				projectId: f.project.id,
				revisionId: f.revision.id,
				profile: { kind: "PREVIEW" },
				requestHash: sha256,
				outputCredentialId: credentialA,
				outputBucket: "fixture-output",
				outputPrefix: "clips/",
			};
			const key = randomUUID();
			const artifactToken = randomUUID();
			const first = await a.renderRun.create({
				data: {
					...base,
					requestKey: key,
					leaseToken: artifactToken,
					pendingArtifactToken: artifactToken,
				},
			});
			const reclaimed = await a.renderRun.update({
				where: { id: first.id },
				data: { leaseToken: randomUUID() },
			});
			expect(reclaimed.pendingArtifactToken).toBe(artifactToken);
			await expect(
				a.renderRun.update({
					where: { id: first.id },
					data: { pendingArtifactToken: "../untrusted-key" },
				}),
			).rejects.toThrow();
			await expect(
				a.renderRun.create({ data: { ...base, requestKey: key } }),
			).rejects.toThrow();
			await a.renderRun.create({ data: { ...base, requestKey: randomUUID() } });
			await a.renderRun.create({
				data: {
					...base,
					requestKey: randomUUID(),
					profile: { kind: "EXPORT" },
					generation: 1,
				},
			});
			await expect(
				a.renderRun.create({
					data: {
						...base,
						requestKey: randomUUID(),
						profile: { kind: "EXPORT" },
						generation: 1,
					},
				}),
			).rejects.toThrow();
			await expect(
				a.renderRun.create({
					data: { ...base, requestKey: randomUUID(), profile: {} },
				}),
			).rejects.toThrow();
		});

		it("keeps one derivative target and monotonic desired/current generation", async () => {
			const f = await fixture();
			const { artifact } = await execution(f);
			const target = await a.contentDerivation.create({
				data: {
					projectId: f.project.id,
					variant: "LANDSCAPE",
					desiredGeneration: 2,
				},
			});
			await expect(
				a.contentDerivation.create({
					data: { projectId: f.project.id, variant: "LANDSCAPE" },
				}),
			).rejects.toThrow();
			await a.contentDerivation.update({
				where: { id: target.id },
				data: { activeGeneration: 2, activeArtifactId: artifact.id },
			});
			await expect(
				a.contentDerivation.update({
					where: { id: target.id },
					data: { activeGeneration: 1 },
				}),
			).rejects.toThrow();
			await expect(
				a.contentDerivation.update({
					where: { id: target.id },
					data: { desiredGeneration: 1 },
				}),
			).rejects.toThrow();
		});
	},
);
