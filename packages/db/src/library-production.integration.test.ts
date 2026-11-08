import { createHash, randomUUID } from "node:crypto";
import { canonicalEditingJson, hashEditingEvidence } from "@bitovp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppPrismaClient, createPrismaClient } from "./client";
import { createTenantPrismaClient } from "./tenant-client";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
const sha = () => createHash("sha256").update(randomUUID()).digest("hex");

describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL production task, receipt and image boundaries",
	() => {
		const orgA = randomUUID(),
			orgB = randomUUID();
		let admin: AppPrismaClient,
			app: AppPrismaClient,
			a: AppPrismaClient,
			b: AppPrismaClient;
		let first: Awaited<ReturnType<typeof fixture>>,
			second: Awaited<ReturnType<typeof fixture>>;
		async function fixture(db: AppPrismaClient) {
			const credential = await db.credential.create({
				data: {
					label: "Production fixture",
					provider: "AWS_S3",
					encryptedSecret: "fixture",
				},
			});
			const source = await db.librarySource.create({
				data: {
					sourceKey: randomUUID(),
					originalJobId: randomUUID(),
					encodingId: randomUUID(),
					accountId: randomUUID(),
					snapshot: {},
					locales: ["ja"],
					state: "READY",
				},
			});
			const media = await db.libraryMediaVersion.create({
				data: {
					sourceId: source.id,
					credentialId: credential.id,
					outputCredentialId: credential.id,
					storage: { output: { credentialId: credential.id } },
				},
			});
			const analysis = await db.sceneAnalysisRevision.create({
				data: {
					sourceId: source.id,
					locale: "ja",
					rawHash: sha(),
					providerVersion: "fixture",
					raw: {},
					document: {},
				},
			});
			const content = await db.content.create({
				data: {
					registrationKey: randomUUID(),
					title: "Production fixture",
					locale: "ja",
				},
			});
			const project = await db.editProject.create({
				data: {
					contentId: content.id,
					mediaVersionId: media.id,
					title: "Composition",
					variant: "PORTRAIT",
					draft: {},
				},
			});
			return { credential, source, media, analysis, content, project };
		}
		beforeAll(async () => {
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
			a = createTenantPrismaClient(app, orgA);
			b = createTenantPrismaClient(app, orgB);
			await admin.organization.createMany({
				data: [
					{ id: orgA, name: "Production A", slug: orgA },
					{ id: orgB, name: "Production B", slug: orgB },
				],
			});
			first = await fixture(a);
			second = await fixture(b);
		});
		afterAll(async () => {
			try {
				if (!admin) return;
				const where = { organizationId: { in: [orgA, orgB] } };
				await admin.editProjectResource.deleteMany({ where });
				await admin.libraryAnalysisBinding.deleteMany({ where });
				await admin.libraryEvidenceReceipt.deleteMany({ where });
				await admin.libraryMediaTask.deleteMany({ where });
				await admin.libraryImageAsset.deleteMany({ where });
				await admin.editProject.deleteMany({ where });
				await admin.libraryMediaVersion.deleteMany({ where });
				await admin.sceneAnalysisRevision.deleteMany({ where });
				await admin.librarySource.deleteMany({ where });
				await admin.content.deleteMany({ where });
				await admin.credential.deleteMany({ where });
				await admin.organization.deleteMany({
					where: { id: { in: [orgA, orgB] } },
				});
			} finally {
				await admin?.$disconnect();
				await app?.$disconnect();
			}
		});
		const taskData = () => ({
			mediaVersionId: first.media.id,
			kind: "TRANSCRIBE",
			requestKey: randomUUID(),
			requestHash: sha(),
			cacheKey: sha(),
			parameters: { language: "ja" },
		});
		it("isolates tasks and rejects cross-tenant media and parent references", async () => {
			const task = await a.libraryMediaTask.create({ data: taskData() });
			expect(await b.libraryMediaTask.findMany()).toEqual([]);
			expect(await app.libraryMediaTask.findMany()).toEqual([]);
			await expect(
				b.libraryMediaTask.create({
					data: { ...taskData(), mediaVersionId: first.media.id },
				}),
			).rejects.toThrow();
			await expect(
				b.libraryMediaTask.create({
					data: {
						...taskData(),
						mediaVersionId: second.media.id,
						parentTaskId: task.id,
					},
				}),
			).rejects.toThrow();
		});
		it("keeps request identity immutable while allowing a fenced lifecycle", async () => {
			const task = await a.libraryMediaTask.create({ data: taskData() });
			for (const data of [
				{ parameters: { language: "en" } },
				{ cacheKey: sha() },
				{ requestKey: randomUUID() },
				{ mediaVersionId: second.media.id },
			])
				await expect(
					a.libraryMediaTask.update({ where: { id: task.id }, data }),
				).rejects.toThrow();
			await expect(
				a.libraryMediaTask.update({
					where: { id: task.id },
					data: {
						state: "RUNNING",
						leaseToken: randomUUID(),
						leaseUntil: new Date(Date.now() + 60000),
					},
				}),
			).resolves.toMatchObject({ state: "RUNNING" });
		});
		it("freezes successful results and preserves canceled parents when retried as a child", async () => {
			const task = await a.libraryMediaTask.create({
				data: {
					...taskData(),
					state: "SUCCEEDED",
					result: { segments: [] },
					finishedAt: new Date(),
				},
			});
			await expect(
				a.libraryMediaTask.update({
					where: { id: task.id },
					data: { result: { segments: ["changed"] } },
				}),
			).rejects.toThrow();
			const canceled = await a.libraryMediaTask.create({
				data: { ...taskData(), state: "CANCELED", finishedAt: new Date() },
			});
			await expect(
				a.libraryMediaTask.update({
					where: { id: canceled.id },
					data: { state: "PENDING" },
				}),
			).rejects.toThrow();
			const retry = await a.libraryMediaTask.create({
				data: { ...taskData(), parentTaskId: canceled.id },
			});
			expect(retry.parentTaskId).toBe(canceled.id);
		});
		it("requires complete success evidence and unique org request keys", async () => {
			const data = taskData();
			await a.libraryMediaTask.create({ data });
			await expect(a.libraryMediaTask.create({ data })).rejects.toThrow();
			await expect(
				a.libraryMediaTask.create({
					data: { ...taskData(), state: "SUCCEEDED" },
				}),
			).rejects.toThrow();
		});
		async function receipt() {
			return a.libraryEvidenceReceipt.create({
				data: {
					sourceId: first.source.id,
					mediaVersionId: first.media.id,
					analysisRevisionId: first.analysis.id,
					kind: "EDITOR_ATTESTATION",
					proof: { confirmed: true },
					proofHash: sha(),
					createdBy: "test:operator",
				},
			});
		}
		it("round-trips canonical cache JSON text with exact derived floats and tenant isolation", async () => {
			const value = {
				rawSegments: [{ quality: { meanTokenLogProbability: Math.log(0.9) } }],
				confidence: -0.21932977413201898,
				tiny: Number("1.2345678901234568e-8"),
				text: "Synthetic 字幕 🙂",
			};
			const proof = {
				version: "local-story-cache-v2",
				cacheHash: sha(),
				valueJson: canonicalEditingJson(value),
			};
			const expected = hashEditingEvidence(proof);
			const written = await a.libraryEvidenceReceipt.create({
				data: {
					sourceId: first.source.id,
					mediaVersionId: first.media.id,
					analysisRevisionId: null,
					kind: "LOCAL_STORY_TRANSCRIPT_V1",
					proof,
					proofHash: expected,
				},
			});
			const read = await a.libraryEvidenceReceipt.findUnique({
				where: { id: written.id },
			});
			if (!read) throw Error("roundtrip receipt missing");
			expect(read.proof).toEqual(proof);
			expect(hashEditingEvidence(read.proof)).toBe(expected);
			const decoded = JSON.parse(
				(read.proof as { valueJson: string }).valueJson,
			);
			expect(canonicalEditingJson(decoded)).toBe(proof.valueJson);
			expect(
				Object.is(
					decoded.rawSegments[0].quality.meanTokenLogProbability,
					value.rawSegments[0]?.quality.meanTokenLogProbability,
				),
			).toBe(true);
			expect(Object.is(decoded.confidence, value.confidence)).toBe(true);
			expect(
				await b.libraryEvidenceReceipt.findUnique({
					where: { id: written.id },
				}),
			).toBeNull();
			await expect(
				a.libraryEvidenceReceipt.update({
					where: { id: written.id },
					data: { proof: { changed: true } },
				}),
			).rejects.toThrow();
		});
		it.each([
			"STORY_GRAPH_V1",
			"LOCAL_STORY_TRANSCRIPT_V1",
			"LOCAL_STORY_LEDGER_V1",
			"LOCAL_STORY_BLUEPRINT_V1",
			"LOCAL_CAPTION_TRANSLATION_V1",
			"LOCAL_FLOW_MANIFEST_V1",
			"LOCAL_FLOW_CONTEXT_V1",
			"LOCAL_FLOW_ROUTE_V1",
			"LOCAL_FLOW_PLAN_V1",
		])("stores immutable tenant-scoped %s while rejecting unknown evidence kinds", async (kind) => {
			const data = {
				sourceId: first.source.id,
				mediaVersionId: first.media.id,
				analysisRevisionId:
					kind === "LOCAL_STORY_TRANSCRIPT_V1" ? null : first.analysis.id,
				kind,
				proof: { version: "aisa-story-receipt-v1", artifact: {} },
				proofHash: sha(),
			};
			const row = await a.libraryEvidenceReceipt.create({ data });
			expect(row.kind).toBe(kind);
			expect(
				await b.libraryEvidenceReceipt.findUnique({ where: { id: row.id } }),
			).toBeNull();
			expect(
				await app.libraryEvidenceReceipt.findUnique({ where: { id: row.id } }),
			).toBeNull();
			await expect(
				a.libraryEvidenceReceipt.update({
					where: { id: row.id },
					data: { proof: { changed: true } },
				}),
			).rejects.toThrow();
			await expect(
				b.libraryEvidenceReceipt.create({
					data: {
						...data,
						proofHash: sha(),
					},
				}),
			).rejects.toThrow();
			await expect(
				a.libraryEvidenceReceipt.create({
					data: {
						...data,
						kind: "UNKNOWN_STORY_KIND",
						proofHash: sha(),
					},
				}),
			).rejects.toThrow();
		});
		it("preserves receipts against all updates and enforces their tenant references", async () => {
			const row = await receipt();
			await expect(
				a.libraryEvidenceReceipt.update({
					where: { id: row.id },
					data: { proof: { confirmed: false } },
				}),
			).rejects.toThrow();
			await expect(
				admin.$executeRaw`UPDATE "LibraryEvidenceReceipt" SET "createdAt" = "createdAt" WHERE "id" = ${row.id}::uuid`,
			).rejects.toThrow();
			expect(await b.libraryEvidenceReceipt.findMany()).toEqual([]);
			await expect(
				b.libraryEvidenceReceipt.create({
					data: {
						sourceId: first.source.id,
						kind: "EDITOR_ATTESTATION",
						proof: {},
						proofHash: sha(),
					},
				}),
			).rejects.toThrow();
		});
		it("binds an editor association to the exact immutable receipt tuple", async () => {
			const row = await receipt();
			const proof = {
				kind: "EDITOR_ATTESTED",
				attestation: { receiptId: row.id },
			};
			await expect(
				a.libraryAnalysisBinding.create({
					data: {
						mediaVersionId: first.media.id,
						analysisRevisionId: first.analysis.id,
						proof,
					},
				}),
			).rejects.toThrow();
			await expect(
				a.libraryAnalysisBinding.create({
					data: {
						mediaVersionId: first.media.id,
						analysisRevisionId: first.analysis.id,
						proof: { ...proof, attestation: { receiptId: randomUUID() } },
						attestationReceiptId: row.id,
					},
				}),
			).rejects.toThrow();
			const binding = await a.libraryAnalysisBinding.create({
				data: {
					mediaVersionId: first.media.id,
					analysisRevisionId: first.analysis.id,
					proof,
					attestationReceiptId: row.id,
				},
			});
			expect(binding.attestationReceiptId).toBe(row.id);
			await expect(
				a.libraryEvidenceReceipt.delete({ where: { id: row.id } }),
			).rejects.toThrow();
		});
		it("rejects an otherwise same-org receipt for another media tuple", async () => {
			const row = await receipt();
			const media = await a.libraryMediaVersion.create({
				data: {
					sourceId: first.source.id,
					credentialId: first.credential.id,
					outputCredentialId: first.credential.id,
					storage: { output: { credentialId: first.credential.id } },
				},
			});
			await expect(
				a.libraryAnalysisBinding.create({
					data: {
						mediaVersionId: media.id,
						analysisRevisionId: first.analysis.id,
						proof: {
							kind: "EDITOR_ATTESTED",
							attestation: { receiptId: row.id },
						},
						attestationReceiptId: row.id,
					},
				}),
			).rejects.toThrow();
		});
		it("keeps image evidence immutable and rejects foreign projects and oversized rasters", async () => {
			const data = {
				projectId: first.project.id,
				storage: {},
				sha256: sha(),
				size: 100n,
				width: 64,
				height: 64,
			};
			const asset = await a.libraryImageAsset.create({ data });
			expect(await b.libraryImageAsset.findMany()).toEqual([]);
			await expect(
				a.libraryImageAsset.update({
					where: { id: asset.id },
					data: { sha256: sha() },
				}),
			).rejects.toThrow();
			await expect(b.libraryImageAsset.create({ data })).rejects.toThrow();
			await expect(
				a.libraryImageAsset.create({ data: { ...data, width: 2049 } }),
			).rejects.toThrow();
		});
		it("retains additional sources and images even after a draft stops using them", async () => {
			const media = await a.libraryMediaVersion.create({
				data: {
					sourceId: first.source.id,
					credentialId: first.credential.id,
					outputCredentialId: first.credential.id,
					storage: { output: { credentialId: first.credential.id } },
				},
			});
			const ref = await a.editProjectResource.create({
				data: { projectId: first.project.id, mediaVersionId: media.id },
			});
			await expect(
				a.libraryMediaVersion.delete({ where: { id: media.id } }),
			).rejects.toThrow();
			await expect(
				a.editProjectResource.update({
					where: { id: ref.id },
					data: { mediaVersionId: first.media.id },
				}),
			).rejects.toThrow();
			await expect(
				b.editProjectResource.create({
					data: { projectId: second.project.id, mediaVersionId: media.id },
				}),
			).rejects.toThrow();
			const image = await a.libraryImageAsset.create({
				data: {
					projectId: first.project.id,
					storage: {},
					sha256: sha(),
					size: 64n,
					width: 8,
					height: 8,
				},
			});
			await a.editProjectResource.create({
				data: { projectId: first.project.id, imageAssetId: image.id },
			});
			await expect(
				a.libraryImageAsset.delete({ where: { id: image.id } }),
			).rejects.toThrow();
		});
	},
);
