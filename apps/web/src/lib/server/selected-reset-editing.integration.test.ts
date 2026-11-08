import { randomBytes, randomUUID } from "node:crypto";
import { AesGcmCipher } from "@bitovp/core";
import {
	type AppPrismaClient,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requiredResetCategories } from "@/lib/reset-selection";
import { countResetCategories, deleteSelectedData } from "./selected-reset";

vi.mock("server-only", () => ({}));

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;

describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL editing reset protection",
	() => {
		let admin: AppPrismaClient;
		let app: AppPrismaClient;
		const organizations: string[] = [];
		const cipher = new AesGcmCipher(randomBytes(32));

		beforeAll(() => {
			for (const value of [adminUrl, appUrl]) {
				if (
					!value ||
					!["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname)
				)
					throw new Error(
						"Editing reset tests require dedicated loopback PostgreSQL URLs",
					);
			}
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
		});

		afterAll(async () => {
			try {
				if (!admin) return;
				for (const organizationId of organizations) {
					const where = { organizationId };
					await admin.libraryAnalysisBinding.deleteMany({ where });
					await admin.editProjectResource.deleteMany({ where });
					await admin.libraryEvidenceReceipt.deleteMany({ where });
					await admin.libraryMediaTask.deleteMany({ where });
					await admin.libraryImageAsset.deleteMany({ where });
					await admin.sceneAnalysisRevision.deleteMany({ where });
					await admin.contentDerivation.deleteMany({ where });
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
					await admin.content.deleteMany({ where });
					await admin.librarySource.deleteMany({ where });
					await admin.credential.deleteMany({ where });
					await admin.resetCleanupTask.deleteMany({ where });
					await admin.organization.delete({ where: { id: organizationId } });
				}
			} finally {
				await app?.$disconnect();
				await admin?.$disconnect();
			}
		});

		async function fixture(editing: boolean) {
			const organizationId = randomUUID();
			organizations.push(organizationId);
			await admin.organization.create({
				data: {
					id: organizationId,
					slug: organizationId,
					name: "Editing reset fixture",
				},
			});
			const prisma = createTenantPrismaClient(app, organizationId);
			const credential = await prisma.credential.create({
				data: {
					label: "Fixture",
					provider: "AWS_S3",
					encryptedSecret: "fixture",
				},
			});
			const source = await prisma.librarySource.create({
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
			const content = await prisma.content.create({
				data: {
					registrationKey: randomUUID(),
					title: "Fixture film",
					locale: "und",
				},
			});
			await prisma.contentRevision.create({
				data: {
					contentId: content.id,
					sourceId: source.id,
					revision: 1,
					title: content.title,
					description: "",
					tags: [],
					locale: "und",
				},
			});
			if (editing) {
				const media = await prisma.libraryMediaVersion.create({
					data: {
						sourceId: source.id,
						credentialId: credential.id,
						outputCredentialId: credential.id,
						storage: { output: { credentialId: credential.id } },
						state: "READY",
						sha256: "a".repeat(64),
						durationUs: 1_000_000n,
						width: 640,
						height: 360,
						fpsNum: 30,
						fpsDen: 1,
						timeMap: {},
						probe: {},
					},
				});
				const analysis = await prisma.sceneAnalysisRevision.create({
					data: {
						sourceId: source.id,
						locale: "und",
						rawHash: randomUUID(),
						providerVersion: "binding-reset-fixture",
						raw: {},
						document: {},
					},
				});
				await prisma.libraryAnalysisBinding.create({
					data: {
						mediaVersionId: media.id,
						analysisRevisionId: analysis.id,
						proof: { fixture: true },
					},
				});
				const project = await prisma.editProject.create({
					data: {
						contentId: content.id,
						mediaVersionId: media.id,
						title: "Clip",
						variant: "PORTRAIT",
						draft: {},
					},
				});
				const revision = await prisma.editRevision.create({
					data: { projectId: project.id, revision: 1, document: {} },
				});
				await prisma.libraryEvidenceReceipt.create({
					data: {
						sourceId: source.id,
						mediaVersionId: media.id,
						kind: "NORMALIZATION_CAPTURE",
						proof: {},
						proofHash: "e".repeat(64),
					},
				});
				await prisma.libraryMediaTask.create({
					data: {
						mediaVersionId: media.id,
						kind: "TRANSCRIBE",
						requestKey: randomUUID(),
						requestHash: "d".repeat(64),
						cacheKey: "f".repeat(64),
						parameters: {},
					},
				});
				const image = await prisma.libraryImageAsset.create({
					data: {
						projectId: project.id,
						storage: {},
						sha256: "a".repeat(64),
						size: 100n,
						width: 8,
						height: 8,
					},
				});
				await prisma.editProjectResource.create({
					data: { projectId: project.id, imageAssetId: image.id },
				});
				await prisma.editProject.update({
					where: { id: project.id },
					data: { currentRevisionId: revision.id },
				});
				const run = await prisma.renderRun.create({
					data: {
						projectId: project.id,
						revisionId: revision.id,
						profile: { kind: "EXPORT" },
						generation: 1,
						requestKey: randomUUID(),
						requestHash: "b".repeat(64),
						outputCredentialId: credential.id,
						outputBucket: "fixture",
						outputPrefix: "renders/",
						state: "SUCCEEDED",
					},
				});
				const artifact = await prisma.renderArtifact.create({
					data: {
						runId: run.id,
						storage: {},
						sha256: "c".repeat(64),
						size: 100n,
						probe: {},
					},
				});
				await prisma.contentDerivation.create({
					data: {
						projectId: project.id,
						variant: "PORTRAIT",
						desiredGeneration: 1,
						activeGeneration: 1,
						activeArtifactId: artifact.id,
					},
				});
			}
			return { prisma, source, content, credential };
		}

		it.each([
			"contentLibrary",
			"credentials",
		] as const)("retains all eleven editing model rows and their Library and credential during %s reset", async (category) => {
			const { prisma, source, content, credential } = await fixture(true);
			expect(await countResetCategories(prisma)).toContainEqual({
				category: "contentLibrary",
				count: 15,
				protectedCount: 11,
			});
			await expect(
				deleteSelectedData(prisma, requiredResetCategories([category]), cipher),
			).rejects.toMatchObject({
				code: "RESET_LIBRARY_EDITING_REFERENCES",
				protectedCount: 11,
			});
			expect(
				await Promise.all([
					prisma.editProjectResource.count(),
					prisma.libraryEvidenceReceipt.count(),
					prisma.libraryMediaTask.count(),
					prisma.libraryImageAsset.count(),
					prisma.libraryAnalysisBinding.count(),
					prisma.libraryMediaVersion.count(),
					prisma.editProject.count(),
					prisma.editRevision.count(),
					prisma.renderRun.count(),
					prisma.renderArtifact.count(),
					prisma.contentDerivation.count(),
				]),
			).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
			expect(await prisma.sceneAnalysisRevision.count()).toBe(1);
			expect(
				await prisma.librarySource.findUnique({ where: { id: source.id } }),
			).not.toBeNull();
			expect(
				await prisma.content.findUnique({ where: { id: content.id } }),
			).not.toBeNull();
			expect(
				await prisma.credential.findUnique({ where: { id: credential.id } }),
			).not.toBeNull();
			expect(await prisma.resetCleanupTask.count()).toBe(0);
		});

		it("deletes an editing-free Library while another organization has protected editing data", async () => {
			const other = await fixture(true);
			const { prisma } = await fixture(false);
			expect(await countResetCategories(prisma)).toContainEqual({
				category: "contentLibrary",
				count: 3,
			});
			const result = await deleteSelectedData(
				prisma,
				["contentLibrary"],
				cipher,
			);
			expect(result.deletedCounts).toEqual([
				{ category: "contentLibrary", count: 3 },
			]);
			expect(await prisma.librarySource.count()).toBe(0);
			expect(await prisma.content.count()).toBe(0);
			expect(await other.prisma.editProject.count()).toBe(1);
			expect(await other.prisma.librarySource.count()).toBe(1);
		});
	},
);
