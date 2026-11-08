import { randomUUID } from "node:crypto";
import {
	compositionDocumentSchema,
	hashEditingEvidence,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import {
	type AppPrismaClient,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import {
	confirmEditingRevision,
	saveEditingDraft,
} from "./library-editing-projects";
import { requestEditingRender } from "./library-editing-renders";

const holder = vi.hoisted(() => ({
	context: null as unknown as ServerContext,
}));
vi.mock("./context", () => ({ getServerContext: async () => holder.context }));
const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;

describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL portrait presentation confirmation",
	() => {
		const organizationId = randomUUID();
		let admin: AppPrismaClient;
		let app: AppPrismaClient;
		let prisma: AppPrismaClient;
		let credentialId: string;
		beforeAll(async () => {
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
			prisma = createTenantPrismaClient(app, organizationId);
			await admin.organization.create({
				data: {
					id: organizationId,
					slug: organizationId,
					name: "Presentation confirmation fixture",
				},
			});
			credentialId = (
				await prisma.credential.create({
					data: {
						label: "Fixture",
						provider: "AWS_S3",
						encryptedSecret: "fixture",
					},
				})
			).id;
			holder.context = {
				prisma,
				tenant: { organizationId },
			} as unknown as ServerContext;
		});
		afterAll(async () => {
			try {
				if (!admin) return;
				const where = { organizationId };
				await admin.libraryAnalysisBinding.deleteMany({ where });
				await admin.editProjectResource.deleteMany({ where });
				await admin.contentDerivation.deleteMany({ where });
				await admin.editProject.updateMany({
					where,
					data: { currentRevisionId: null },
				});
				await admin.renderRun.deleteMany({ where });
				await admin.editRevision.deleteMany({ where });
				await admin.editProject.deleteMany({ where });
				await admin.libraryMediaVersion.deleteMany({ where });
				await admin.sceneAnalysisRevision.deleteMany({ where });
				await admin.content.deleteMany({ where });
				await admin.librarySource.deleteMany({ where });
				await admin.credential.deleteMany({ where });
				await admin.organization.deleteMany({ where: { id: organizationId } });
			} finally {
				await app?.$disconnect();
				await admin?.$disconnect();
			}
		});
		async function fixture() {
			const source = await prisma.librarySource.create({
				data: {
					sourceKey: randomUUID(),
					originalJobId: randomUUID(),
					encodingId: randomUUID(),
					accountId: randomUUID(),
					snapshot: {},
					locales: ["en"],
					state: "READY",
				},
			});
			const content = await prisma.content.create({
				data: {
					registrationKey: randomUUID(),
					title: "Reviewable full portrait fixture",
					locale: "en",
				},
			});
			const id = randomUUID();
			const map = {
				id,
				mediaVersionId: id,
				kind: "CFR",
				sourceStartUs: 0,
				sourceEndUs: 6_000_000,
				editingStartFrame: 0,
				editingEndFrame: 180,
				fps: { num: 30, den: 1 },
			};
			const media = await prisma.libraryMediaVersion.create({
				data: {
					id,
					sourceId: source.id,
					credentialId,
					outputCredentialId: credentialId,
					state: "READY",
					sha256: "a".repeat(64),
					durationUs: 6_000_000n,
					width: 640,
					height: 360,
					fpsNum: 30,
					fpsDen: 1,
					probe: { streams: [{ codec_type: "audio" }] },
					timeMap: map,
					storage: {
						source: { credentialId, bucket: "fixture", key: "input.mp4" },
						output: { credentialId, bucket: "fixture", prefix: "edits/" },
						prepared: {
							credentialId,
							bucket: "fixture",
							key: "fixed.mp4",
							size: 100,
							expect: { etag: "fixture" },
						},
					},
				},
			});
			const sceneId = randomUUID();
			const raw = {
				metadata: { version: "presentation-confirmation-fixture" },
				duration: 6,
				scenes: [
					{
						id: sceneId,
						type: "MAIN_CONTENT",
						startInSeconds: 0,
						endInSeconds: 6,
						shots: [{ startInSeconds: 0, endInSeconds: 6 }],
					},
				],
			};
			const analysis = await prisma.sceneAnalysisRevision.create({
				data: {
					sourceId: source.id,
					locale: "en",
					rawHash: hashEditingEvidence(raw),
					providerVersion: "presentation-confirmation-fixture",
					raw,
					document: normalizeSceneAnalysis(raw),
				},
			});
			const binding = {
				schemaVersion: 1,
				kind: "FIXTURE_AUTHORED",
				organizationId,
				sourceId: source.id,
				locale: "en",
				analysisRevisionId: analysis.id,
				analysisRawHash: analysis.rawHash,
				analysisDocumentHash: hashEditingEvidence(analysis.document),
				mediaVersionId: media.id,
				mediaSha256: media.sha256,
				timeMapId: id,
				timeMapHash: hashEditingEvidence(media.timeMap),
				sourceStartUs: 0,
				sourceEndUs: 6_000_000,
				width: 640,
				height: 360,
			};
			await prisma.libraryAnalysisBinding.create({
				data: {
					mediaVersionId: media.id,
					analysisRevisionId: analysis.id,
					proof: binding,
				},
			});
			const document = compositionDocumentSchema.parse({
				schemaVersion: 2,
				mediaVersionId: media.id,
				analysisRevisionId: analysis.id,
				locale: "en",
				sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
				timeMapId: id,
				canvas: { width: 1080, height: 1920 },
				fps: { num: 30, den: 1 },
				presentation: {
					version: "portrait-layout-v1",
					videoFit: "FILL",
					captionPlacement: "OVERLAY",
					centerCropConfirmed: false,
				},
				autoGeneration: {
					policyVersion: "aisa-shot-window-v1",
					requestHash: "b".repeat(64),
					requestedDurationFrames: 60,
					generatedDurationFrames: 60,
					reasonCodes: ["TRACKING_FIT_FALLBACK"],
					binding,
				},
				clips: [
					{
						id: randomUUID(),
						sourceInUs: 0,
						durationFrames: 60,
						timelineStartFrame: 0,
						framing: [
							{
								fromFrame: 0,
								toFrame: 60,
								mode: "FIT",
								origin: "AUTO_POLICY",
							},
						],
						evidence: { sceneId, shotIndex: 0 },
						audio: { mode: "SOURCE" },
					},
				],
			});
			const project = await prisma.editProject.create({
				data: {
					contentId: content.id,
					mediaVersionId: media.id,
					title: content.title,
					variant: "PORTRAIT",
					draft: JSON.parse(JSON.stringify(document)),
				},
			});
			return { project, document };
		}

		it("refuses an unconfirmed immutable draft, retains confirmation through a saved version, and reserves only the explicitly requested export", async () => {
			const f = await fixture();
			const original = await prisma.editRevision.create({
				data: {
					projectId: f.project.id,
					revision: 1,
					document: JSON.parse(JSON.stringify(f.document)),
				},
			});
			await prisma.editProject.update({
				where: { id: f.project.id },
				data: { currentRevisionId: original.id },
			});
			const originalHash = hashEditingEvidence(original.document);
			await expect(
				requestEditingRender(f.project.id, {
					revisionId: original.id,
					kind: "EXPORT",
					requestKey: randomUUID(),
				}),
			).rejects.toMatchObject({ code: "UNCONFIRMED_FRAMING" });
			const saved = await saveEditingDraft(f.project.id, {
				expectedRevision: 1,
				document: f.document,
			});
			const manualized = compositionDocumentSchema.parse(saved.draft);
			expect(manualized.clips[0]?.framing[0]?.origin).toBe("MANUAL");
			expect(manualized.presentation?.centerCropConfirmed).toBe(false);
			await expect(
				confirmEditingRevision(
					f.project.id,
					{ expectedRevision: 2, confirmSuggestions: false },
					"fixture",
				),
			).rejects.toMatchObject({ code: "UNCONFIRMED_FRAMING" });
			expect(
				await prisma.renderRun.count({ where: { projectId: f.project.id } }),
			).toBe(0);
			expect(
				await prisma.contentDerivation.count({
					where: { projectId: f.project.id },
				}),
			).toBe(0);
			const confirmed = await confirmEditingRevision(
				f.project.id,
				{ expectedRevision: 2, confirmSuggestions: true },
				"fixture",
			);
			expect(confirmed.draftRevision).toBe(3);
			expect(confirmed.currentRevisionMatchesDraft).toBe(true);
			expect(
				compositionDocumentSchema.parse(confirmed.draft).presentation
					?.centerCropConfirmed,
			).toBe(true);
			const revision = await prisma.editRevision.findUniqueOrThrow({
				where: { id: confirmed.currentRevisionId ?? "" },
			});
			expect(revision.document).toEqual(confirmed.draft);
			expect(
				hashEditingEvidence(
					(
						await prisma.editRevision.findUniqueOrThrow({
							where: { id: original.id },
						})
					).document,
				),
			).toBe(originalHash);
			const request = {
				revisionId: revision.id,
				kind: "EXPORT",
				requestKey: randomUUID(),
			};
			const render = await requestEditingRender(f.project.id, request);
			expect(render.kind).toBe("EXPORT");
			expect(render.generation).toBe(1);
			expect(render.revisionId).toBe(revision.id);
			expect((await requestEditingRender(f.project.id, request)).id).toBe(
				render.id,
			);
			expect(
				await prisma.renderRun.count({ where: { projectId: f.project.id } }),
			).toBe(1);
			expect(
				await prisma.contentDerivation.count({
					where: { projectId: f.project.id },
				}),
			).toBe(1);
		});
		it("rolls back a stale confirmation without modifying a newer unconfirmed document or its immutable history", async () => {
			const f = await fixture();
			const next = structuredClone(f.document);
			const clip = next.clips[0];
			if (!clip) throw Error("Fixture clip required");
			clip.sourceInUs = 1_000_000;
			await saveEditingDraft(f.project.id, {
				expectedRevision: 1,
				document: next,
			});
			const before = await prisma.editProject.findUniqueOrThrow({
				where: { id: f.project.id },
			});
			const resources = await prisma.editProjectResource.findMany({
				where: { projectId: f.project.id },
				orderBy: { id: "asc" },
			});
			await expect(
				confirmEditingRevision(
					f.project.id,
					{ expectedRevision: 1, confirmSuggestions: true },
					"fixture",
				),
			).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
			expect(
				await prisma.editProject.findUniqueOrThrow({
					where: { id: f.project.id },
				}),
			).toEqual(before);
			expect(
				await prisma.editProjectResource.findMany({
					where: { projectId: f.project.id },
					orderBy: { id: "asc" },
				}),
			).toEqual(resources);
			expect(
				compositionDocumentSchema.parse(before.draft).presentation
					?.centerCropConfirmed,
			).toBe(false);
			expect(
				await prisma.editRevision.count({ where: { projectId: f.project.id } }),
			).toBe(0);
			expect(
				await prisma.renderRun.count({ where: { projectId: f.project.id } }),
			).toBe(0);
			expect(
				await prisma.contentDerivation.count({
					where: { projectId: f.project.id },
				}),
			).toBe(0);
		});
	},
);
