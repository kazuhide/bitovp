import { randomUUID } from "node:crypto";
import {
	hashEditingEvidence,
	normalizeSceneAnalysis,
	toCompositionDocument,
} from "@bitovp/core";
import { authoredNormalizationReceipt } from "@bitovp/core/testing";
import {
	type AppPrismaClient,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import { updateContent } from "./library";
import { confirmAnalysisAssociation } from "./library-analysis-associations";
import { createAutomaticPortrait } from "./library-automatic-portrait";
import { listContents, listQuery } from "./library-catalog";
import {
	confirmEditingRevision,
	createEditingProject,
	readEditingProject,
	saveEditingDraft,
} from "./library-editing-projects";
import { requestEditingRender } from "./library-editing-renders";
import {
	contentParent,
	listEditingProjectSummaries,
} from "./library-hierarchy";

const holder = vi.hoisted(() => ({
	context: null as unknown as ServerContext,
}));
vi.mock("./context", () => ({ getServerContext: async () => holder.context }));
const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL editing API invariants",
	() => {
		const org = randomUUID();
		const otherOrg = randomUUID();
		let admin: AppPrismaClient;
		let app: AppPrismaClient;
		let prisma: AppPrismaClient;
		let credentialId: string;
		beforeAll(async () => {
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
			prisma = createTenantPrismaClient(app, org);
			await admin.organization.createMany({
				data: [
					{ id: org, slug: org, name: "Editing API" },
					{ id: otherOrg, slug: otherOrg, name: "Other editing org" },
				],
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
				tenant: { organizationId: org },
			} as unknown as ServerContext;
		});
		afterAll(async () => {
			try {
				if (!admin) return;
				const where = { organizationId: org };
				await admin.libraryAnalysisBinding.deleteMany({ where });
				await admin.libraryEvidenceReceipt.deleteMany({ where });
				await admin.editProjectResource.deleteMany({ where });
				await admin.contentDerivation.deleteMany({ where });
				await admin.editProject.updateMany({
					where,
					data: { currentRevisionId: null },
				});
				await admin.contentRevision.deleteMany({ where });
				await admin.librarySource.deleteMany({
					where: { ...where, sourceKind: "DERIVED_RENDER" },
				});
				await admin.renderArtifact.deleteMany({ where });
				await admin.renderRun.deleteMany({ where });
				await admin.editRevision.deleteMany({ where });
				await admin.editProject.deleteMany({ where });
				await admin.libraryMediaVersion.deleteMany({ where });
				await admin.sceneAnalysisRevision.deleteMany({ where });
				await admin.contentRevision.deleteMany({ where });
				await admin.content.deleteMany({ where });
				await admin.librarySource.deleteMany({ where });
				await admin.credential.deleteMany({ where });
				await admin.organization.deleteMany({
					where: { id: { in: [org, otherOrg] } },
				});
			} finally {
				await app?.$disconnect();
				await admin?.$disconnect();
			}
		});
		async function fixture() {
			holder.context = {
				prisma,
				tenant: { organizationId: org },
			} as unknown as ServerContext;
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
					probe: {},
					timeMap: map,
					storage: {
						source: { credentialId, bucket: "fixture", key: "input.mp4" },
						output: {
							credentialId,
							bucket: "fixture",
							prefix: "edits/",
						},
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
			const project = await createEditingProject(
				{
					contentId: content.id,
					mediaVersionId: media.id,
					title: "Clip",
					variant: "PORTRAIT",
				},
				"fixture",
			);
			return { content, media, project };
		}
		it("archives and restores a Library registration without losing a queued render or retained media", async () => {
			const { content, media, project } = await fixture();
			expect(
				(await listContents(prisma, listQuery.parse({}), org)).items.some(
					(row) => row.id === content.id,
				),
			).toBe(true);
			const confirmed = await confirmEditingRevision(
				project.id,
				{ expectedRevision: 1, confirmSuggestions: false },
				"fixture",
			);
			const render = await requestEditingRender(project.id, {
				revisionId: confirmed.currentRevisionId,
				kind: "EXPORT",
				requestKey: randomUUID(),
			});
			await updateContent(
				prisma,
				content.id,
				{ expectedRevision: 1, archived: true },
				"fixture",
			);
			expect(
				(await listContents(prisma, listQuery.parse({}), org)).items.some(
					(row) => row.id === content.id,
				),
			).toBe(false);
			const archived = await listContents(
				prisma,
				listQuery.parse({ archived: "true" }),
				org,
			);
			expect(
				archived.items.find((row) => row.id === content.id)?.archived,
			).toBe(true);
			expect(
				await prisma.renderRun.findUnique({ where: { id: render.id } }),
			).toMatchObject({ state: "QUEUED", projectId: project.id });
			expect(
				await prisma.libraryMediaVersion.findUnique({
					where: { id: media.id },
				}),
			).toMatchObject({ state: "READY" });
			expect((await readEditingProject(project.id)).draft).toEqual(
				confirmed.draft,
			);
			await updateContent(
				prisma,
				content.id,
				{ expectedRevision: 2, archived: false },
				"fixture",
			);
			expect(
				(await listContents(prisma, listQuery.parse({}), org)).items.find(
					(row) => row.id === content.id,
				),
			).toMatchObject({ archived: false, revision: 3 });
			expect(
				await prisma.contentRevision.count({
					where: { contentId: content.id },
				}),
			).toBe(3);
			expect(
				await prisma.renderRun.findUnique({ where: { id: render.id } }),
			).toMatchObject({ state: "QUEUED" });
		});
		it("rejects foreign and stale registration removal or restoration without appending history", async () => {
			const { content } = await fixture();
			const foreign = createTenantPrismaClient(app, otherOrg);
			await expect(
				updateContent(
					foreign,
					content.id,
					{ expectedRevision: 1, archived: true },
					"foreign",
				),
			).rejects.toMatchObject({ status: 404 });
			await updateContent(
				prisma,
				content.id,
				{ expectedRevision: 1, archived: true },
				"fixture",
			);
			await expect(
				updateContent(
					prisma,
					content.id,
					{ expectedRevision: 1, archived: false },
					"fixture",
				),
			).rejects.toMatchObject({ status: 409 });
			expect(
				await prisma.content.findUnique({ where: { id: content.id } }),
			).toMatchObject({ archived: true, revision: 2 });
			expect(
				await prisma.contentRevision.count({
					where: { contentId: content.id },
				}),
			).toBe(2);
		});
		it("saves and renders a V2 composition while retaining removed historical source references", async () => {
			const { media, project } = await fixture(),
				id = randomUUID();
			const extra = await prisma.libraryMediaVersion.create({
				data: {
					id,
					sourceId: media.sourceId,
					credentialId,
					outputCredentialId: credentialId,
					state: "READY",
					sha256: "b".repeat(64),
					width: 640,
					height: 360,
					durationUs: 6_000_000n,
					fpsNum: 30,
					fpsDen: 1,
					probe: {},
					storage: media.storage as object,
					timeMap: { ...(media.timeMap as object), id, mediaVersionId: id },
				},
			});
			const document = toCompositionDocument(project.draft);
			document.clips = document.clips.map((clip) => ({
				...clip,
				audio: { mode: "MUTE" },
			}));
			document.sources = [{ mediaVersionId: extra.id, timeMapId: extra.id }];
			document.videoTracks = [
				{ id: "main", name: "Main", order: 0 },
				{ id: "pip", name: "PIP", order: 1 },
			];
			document.clips.push({
				...(document.clips.at(0) ??
					(() => {
						throw new Error("Missing clip");
					})()),
				id: randomUUID(),
				mediaVersionId: extra.id,
				trackId: "pip",
				layout: { x: 0.7, y: 0.05, w: 0.25, h: 0.25 },
			});
			const saved = await saveEditingDraft(project.id, {
				expectedRevision: 1,
				document,
			});
			expect(saved.draft.schemaVersion).toBe(2);
			expect(saved.additionalMedia?.map((row) => row.id)).toEqual([extra.id]);
			expect(JSON.stringify(saved)).not.toContain("fixed.mp4");
			const confirmed = await confirmEditingRevision(
				project.id,
				{ expectedRevision: 2, confirmSuggestions: false },
				"fixture",
			);
			const render = await requestEditingRender(project.id, {
				revisionId: confirmed.currentRevisionId,
				kind: "EXPORT",
				requestKey: randomUUID(),
			});
			expect(render.durationFrames).toBe(180);
			await expect(
				prisma.libraryMediaVersion.delete({ where: { id: extra.id } }),
			).rejects.toThrow();
			await saveEditingDraft(project.id, {
				expectedRevision: confirmed.draftRevision,
				document: {
					...document,
					sources: [],
					clips: document.clips.filter(
						(clip) => clip.mediaVersionId !== extra.id,
					),
				},
			});
			expect(
				await prisma.editProjectResource.count({
					where: { projectId: project.id, mediaVersionId: extra.id },
				}),
			).toBe(1);
			await expect(
				prisma.libraryMediaVersion.delete({ where: { id: extra.id } }),
			).rejects.toThrow();
		});
		it("rolls back V2 drafts that reference unavailable media", async () => {
			const { project } = await fixture(),
				document = toCompositionDocument(project.draft);
			document.sources = [
				{ mediaVersionId: randomUUID(), timeMapId: randomUUID() },
			];
			await expect(
				saveEditingDraft(project.id, { expectedRevision: 1, document }),
			).rejects.toMatchObject({ code: "COMPOSITION_SOURCE_UNAVAILABLE" });
			expect((await readEditingProject(project.id)).draftRevision).toBe(1);
			expect(
				await prisma.editProjectResource.count({
					where: { projectId: project.id },
				}),
			).toBe(0);
		});
		it("records explicit editor attestation once and replays simultaneous confirmations", async () => {
			const { input, media } = await automaticFixture();
			await prisma.libraryAnalysisBinding.deleteMany({
				where: { mediaVersionId: media.id },
			});
			const confirmation = {
				mediaVersionId: media.id,
				analysisRevisionId: input.analysisRevisionId,
				requestKey: randomUUID(),
				confirmation: { time: true, geometry: true, content: true },
			};
			const [a, b] = await Promise.all([
				confirmAnalysisAssociation(confirmation, "editor@example.test"),
				confirmAnalysisAssociation(confirmation, "editor@example.test"),
			]);
			expect(a.bindingKind).toBe("EDITOR_ATTESTED");
			expect(b.bindingKind).toBe("EDITOR_ATTESTED");
			expect(
				await prisma.libraryEvidenceReceipt.count({
					where: { mediaVersionId: media.id, kind: "EDITOR_ATTESTATION" },
				}),
			).toBe(1);
			const row = await prisma.libraryAnalysisBinding.findFirstOrThrow({
				where: { mediaVersionId: media.id },
			});
			expect(row.attestationReceiptId).toBeTruthy();
			expect(JSON.stringify(row.proof)).toContain("editor@example.test");
			expect(
				(await createAutomaticPortrait(input, "fixture")).projectId,
			).toBeTruthy();
		});
		it("rejects incomplete human confirmation without persisting evidence", async () => {
			const { input, media } = await automaticFixture(),
				before = await prisma.libraryEvidenceReceipt.count();
			await expect(
				confirmAnalysisAssociation(
					{
						mediaVersionId: media.id,
						analysisRevisionId: input.analysisRevisionId,
						requestKey: randomUUID(),
						confirmation: { time: true, geometry: false, content: true },
					},
					"fixture",
				),
			).rejects.toThrow();
			expect(await prisma.libraryEvidenceReceipt.count()).toBe(before);
		});
		it("creates a fixed manual draft and reads it without storage locators", async () => {
			const { project } = await fixture();
			const view = await readEditingProject(project.id);
			expect(view.draft).toEqual(project.draft);
			expect(view.media.url).toContain(`expectedOrganizationId=${org}`);
			expect(JSON.stringify(view)).not.toContain("fixed.mp4");
			expect(JSON.stringify(view)).not.toContain("credentialId");
		});
		it("allows exactly one simultaneous save at an expected revision", async () => {
			const { project } = await fixture();
			const results = await Promise.allSettled([
				saveEditingDraft(project.id, {
					expectedRevision: 1,
					document: project.draft,
				}),
				saveEditingDraft(project.id, {
					expectedRevision: 1,
					document: project.draft,
				}),
			]);
			expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
			expect(results.find((r) => r.status === "rejected")).toMatchObject({
				reason: { status: 409, code: "EDIT_CONFLICT" },
			});
			expect((await readEditingProject(project.id)).draftRevision).toBe(2);
		});
		it("confirms an immutable revision from the saved draft", async () => {
			const { project } = await fixture();
			const confirmed = await confirmEditingRevision(
				project.id,
				{ expectedRevision: 1, confirmSuggestions: false },
				"fixture",
			);
			if (!confirmed.currentRevisionId)
				throw new Error("A confirmed revision is required");
			const revision = await prisma.editRevision.findUnique({
				where: { id: confirmed.currentRevisionId },
			});
			if (!revision) throw new Error("The immutable revision must exist");
			expect(revision?.document).toEqual(project.draft);
			await expect(
				prisma.editRevision.update({
					where: { id: revision.id },
					data: { document: {} },
				}),
			).rejects.toThrow();
		});
		it("replays simultaneous export requests and reserves one generation", async () => {
			const { project } = await fixture();
			const confirmed = await confirmEditingRevision(
				project.id,
				{ expectedRevision: 1, confirmSuggestions: false },
				"fixture",
			);
			const request = {
				revisionId: confirmed.currentRevisionId,
				kind: "EXPORT",
				requestKey: randomUUID(),
			};
			const results = await Promise.all([
				requestEditingRender(project.id, request),
				requestEditingRender(project.id, request),
			]);
			expect(results[0]?.id).toBe(results[1]?.id);
			expect(
				await prisma.renderRun.count({ where: { projectId: project.id } }),
			).toBe(1);
			expect(
				(
					await prisma.contentDerivation.findFirst({
						where: { projectId: project.id },
					})
				)?.desiredGeneration,
			).toBe(1);
		});
		it("rejects an idempotency key reused with another payload", async () => {
			const { project } = await fixture();
			const confirmed = await confirmEditingRevision(
				project.id,
				{ expectedRevision: 1, confirmSuggestions: false },
				"fixture",
			);
			const request = {
				revisionId: confirmed.currentRevisionId,
				kind: "PREVIEW",
				requestKey: randomUUID(),
			};
			await requestEditingRender(project.id, request);
			await expect(
				requestEditingRender(project.id, { ...request, kind: "EXPORT" }),
			).rejects.toMatchObject({ status: 409, code: "REQUEST_KEY_REUSED" });
		});
		async function automaticFixture() {
			const base = await fixture();
			const raw = {
				metadata: { version: "manual-integration-fixture-v1" },
				duration: 6,
				scenes: [
					{
						id: randomUUID(),
						startInSeconds: 0,
						endInSeconds: 6,
						type: "MAIN_CONTENT",
						title: "Three whole shots",
						shots: [0, 2, 4].map((start) => ({
							startInSeconds: start,
							endInSeconds: start + 2,
						})),
					},
				],
			};
			const analysis = await prisma.sceneAnalysisRevision.create({
				data: {
					sourceId: base.media.sourceId,
					locale: "und",
					rawHash: hashEditingEvidence(raw),
					providerVersion: "manual-integration-fixture-v1",
					raw,
					document: normalizeSceneAnalysis(raw),
				},
			});
			const binding = {
				schemaVersion: 1,
				kind: "FIXTURE_AUTHORED",
				organizationId: org,
				sourceId: base.media.sourceId,
				locale: analysis.locale,
				analysisRevisionId: analysis.id,
				analysisRawHash: analysis.rawHash,
				analysisDocumentHash: hashEditingEvidence(analysis.document),
				mediaVersionId: base.media.id,
				mediaSha256: base.media.sha256,
				timeMapId: base.media.id,
				timeMapHash: hashEditingEvidence(base.media.timeMap),
				sourceStartUs: 0,
				sourceEndUs: 6_000_000,
				width: 640,
				height: 360,
			};
			await prisma.libraryAnalysisBinding.create({
				data: {
					mediaVersionId: base.media.id,
					analysisRevisionId: analysis.id,
					proof: binding,
				},
			});
			const input = {
				contentId: base.content.id,
				mediaVersionId: base.media.id,
				analysisRevisionId: analysis.id,
				targetDurationFrames: 120,
				requestKey: randomUUID(),
			};
			return { ...base, analysis, binding, input };
		}
		async function preparedClockFixture() {
			const f = await automaticFixture();
			if (!f.media.sha256) throw new Error("Fixture media hash required");
			const proof = authoredNormalizationReceipt({
				organizationId: org,
				sourceId: f.media.sourceId,
				mediaVersionId: f.media.id,
				preparedSha256: f.media.sha256,
			});
			const receipt = await prisma.libraryEvidenceReceipt.create({
				data: {
					organizationId: org,
					sourceId: f.media.sourceId,
					mediaVersionId: f.media.id,
					kind: "NORMALIZATION_CAPTURE",
					proof,
					proofHash: hashEditingEvidence(proof),
				},
			});
			return { ...f, proof, receipt };
		}
		it("uses the prepared clock for a new automatic project and preserves exact intent replay", async () => {
			const f = await preparedClockFixture();
			const created = await createAutomaticPortrait(f.input, "fixture");
			const view = await readEditingProject(created.projectId);
			expect(view.draft.autoGeneration).toMatchObject({
				policyVersion: "aisa-prepared-shot-window-v3",
				normalizationReceiptHash: f.receipt.proofHash,
				generatedDurationFrames: 120,
			});
			expect(await createAutomaticPortrait(f.input, "fixture")).toEqual(
				created,
			);
			expect(
				await prisma.renderRun.count({
					where: { projectId: created.projectId },
				}),
			).toBe(1);
			expect(
				await prisma.libraryEvidenceReceipt.findUnique({
					where: { id: f.receipt.id },
				}),
			).toEqual(f.receipt);
			const composition = await saveEditingDraft(created.projectId, {
				expectedRevision: view.draftRevision,
				document: toCompositionDocument(view.draft),
			});
			expect(composition.draft.schemaVersion).toBe(2);
			expect(await createAutomaticPortrait(f.input, "fixture")).toEqual(
				created,
			);
			await expect(
				createAutomaticPortrait(
					{
						...f.input,
						targetDurationFrames: f.input.targetDurationFrames + 30,
					},
					"fixture",
				),
			).rejects.toMatchObject({
				status: 409,
				code: "REQUEST_KEY_REUSED",
			});
			expect(await readEditingProject(created.projectId)).toEqual(composition);
			expect(
				await prisma.renderRun.count({
					where: { projectId: created.projectId },
				}),
			).toBe(1);
		});
		it("refuses ambiguous normalization witnesses for a fresh intent without changing a completed project", async () => {
			const f = await preparedClockFixture();
			const created = await createAutomaticPortrait(f.input, "fixture");
			const saved = await readEditingProject(created.projectId);
			const proof = { ...f.proof, originalSha256: "e".repeat(64) };
			await prisma.libraryEvidenceReceipt.create({
				data: {
					organizationId: org,
					sourceId: f.media.sourceId,
					mediaVersionId: f.media.id,
					kind: "NORMALIZATION_CAPTURE",
					proof,
					proofHash: hashEditingEvidence(proof),
				},
			});
			const before = await prisma.editProject.count();
			await expect(
				createAutomaticPortrait(
					{ ...f.input, requestKey: randomUUID() },
					"fixture",
				),
			).rejects.toMatchObject({
				status: 422,
				code: "NORMALIZATION_EVIDENCE_UNVERIFIED",
			});
			expect(await prisma.editProject.count()).toBe(before);
			expect(await readEditingProject(created.projectId)).toEqual(saved);
			expect(await createAutomaticPortrait(f.input, "fixture")).toEqual(
				created,
			);
		});
		it("returns the bounded selection error when a prepared analysis exceeds the global shot limit", async () => {
			const f = await preparedClockFixture();
			const raw = {
				metadata: { version: "authored-prepared-limit-regression" },
				duration: 6,
				scenes: [0, 2, 4].map((start) => ({
					id: randomUUID(),
					type: "MAIN_CONTENT",
					title: "Many tiny shots",
					startInSeconds: start,
					endInSeconds: start + 2,
					shots: Array.from({ length: 3334 }, (_, index) => ({
						startInSeconds: start + (index * 2) / 3334,
						endInSeconds: start + ((index + 1) * 2) / 3334,
					})),
				})),
			};
			const analysis = await prisma.sceneAnalysisRevision.create({
				data: {
					sourceId: f.media.sourceId,
					locale: "und",
					raw,
					providerVersion: "authored-prepared-limit-regression",
					rawHash: hashEditingEvidence(raw),
					document: normalizeSceneAnalysis(raw),
				},
			});
			await prisma.libraryAnalysisBinding.create({
				data: {
					mediaVersionId: f.media.id,
					analysisRevisionId: analysis.id,
					proof: {
						...f.binding,
						analysisRevisionId: analysis.id,
						analysisRawHash: analysis.rawHash,
						analysisDocumentHash: hashEditingEvidence(analysis.document),
					},
				},
			});
			const before = await prisma.editProject.count();
			await expect(
				createAutomaticPortrait(
					{ ...f.input, analysisRevisionId: analysis.id },
					"fixture",
				),
			).rejects.toMatchObject({ status: 422, code: "AUTO_SELECTION_LIMIT" });
			expect(await prisma.editProject.count()).toBe(before);
		});
		it("creates an editable automatic revision and queues its MP4 atomically", async () => {
			const f = await automaticFixture();
			const created = await createAutomaticPortrait(f.input, "fixture");
			const view = await readEditingProject(created.projectId);
			expect(view.currentRevisionId).toBeTruthy();
			expect(view.draft.clips.map((clip) => clip.durationFrames)).toEqual([
				60, 60,
			]);
			expect(
				view.draft.clips.every(
					(clip) => clip.framing[0]?.origin === "AUTO_POLICY",
				),
			).toBe(true);
			expect(view.draft.autoGeneration?.requestedDurationFrames).toBe(120);
			expect(view.renders).toHaveLength(1);
			expect(view.renders[0]).toMatchObject({
				state: "QUEUED",
				kind: "EXPORT",
				generation: 1,
				durationFrames: 120,
			});
			expect((await readEditingProject(f.project.id)).draft).toEqual(
				f.project.draft,
			);
		});
		it("claims a simultaneous automatic intent once and replays after a lost response", async () => {
			const { input } = await automaticFixture();
			const [a, b] = await Promise.all([
				createAutomaticPortrait(input, "fixture"),
				createAutomaticPortrait(input, "fixture"),
			]);
			expect(a.projectId).toBe(b.projectId);
			expect(await createAutomaticPortrait(input, "fixture")).toEqual(a);
			expect(
				await prisma.renderRun.count({ where: { projectId: a.projectId } }),
			).toBe(1);
			expect(
				(
					await prisma.contentDerivation.findFirst({
						where: { projectId: a.projectId },
					})
				)?.desiredGeneration,
			).toBe(1);
		});
		it("rejects a generation key reused for a different length", async () => {
			const { input } = await automaticFixture();
			const original = await createAutomaticPortrait(input, "fixture");
			await expect(
				createAutomaticPortrait(
					{ ...input, targetDurationFrames: 90 },
					"fixture",
				),
			).rejects.toMatchObject({ status: 409, code: "REQUEST_KEY_REUSED" });
			expect(
				await prisma.renderRun.count({
					where: { projectId: original.projectId },
				}),
			).toBe(1);
		});
		it("does not auto-accept matching source IDs without byte and analysis evidence", async () => {
			const { input, media } = await automaticFixture();
			await prisma.libraryAnalysisBinding.deleteMany({
				where: { mediaVersionId: media.id },
			});
			const before = await prisma.editProject.count();
			await expect(
				createAutomaticPortrait(input, "fixture"),
			).rejects.toMatchObject({
				status: 422,
				code: "ANALYSIS_BINDING_UNVERIFIED",
			});
			expect(await prisma.editProject.count()).toBe(before);
		});
		it("rejects impossible whole-shot lengths without creating a project", async () => {
			const { input } = await automaticFixture();
			const before = await prisma.editProject.count();
			await expect(
				createAutomaticPortrait(
					{ ...input, targetDurationFrames: 30 },
					"fixture",
				),
			).rejects.toMatchObject({ status: 422, code: "NO_ELIGIBLE_WINDOW" });
			expect(await prisma.editProject.count()).toBe(before);
		});
		it("rolls back the project and revision when reserving its render fails", async () => {
			const { input } = await automaticFixture();
			const before = await prisma.editProject.count();
			const revisions = await prisma.editRevision.count();
			const derivations = await prisma.contentDerivation.count();
			const renders = await prisma.renderRun.count();
			// The isolated fixture database owns these objects. Names and predicate
			// come only from randomUUID(), never external request data.
			const trigger = `portrait_test_${randomUUID().replaceAll("-", "")}`;
			const procedure = `${trigger}_fn`;
			await admin.$executeRawUnsafe(
				`CREATE FUNCTION "${procedure}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'AUTO_TEST_RENDER_FAILURE'; END; $$`,
			);
			try {
				await admin.$executeRawUnsafe(
					`CREATE TRIGGER "${trigger}" BEFORE INSERT ON "RenderRun" FOR EACH ROW WHEN (NEW."requestKey" = '${input.requestKey}'::text) EXECUTE FUNCTION "${procedure}"()`,
				);
				try {
					await expect(
						createAutomaticPortrait(input, "fixture"),
					).rejects.toThrow("AUTO_TEST_RENDER_FAILURE");
					expect(await prisma.editProject.count()).toBe(before);
					expect(await prisma.editRevision.count()).toBe(revisions);
					expect(await prisma.contentDerivation.count()).toBe(derivations);
					expect(await prisma.renderRun.count()).toBe(renders);
				} finally {
					await admin.$executeRawUnsafe(
						`DROP TRIGGER "${trigger}" ON "RenderRun"`,
					);
				}
			} finally {
				await admin.$executeRawUnsafe(`DROP FUNCTION "${procedure}"()`);
			}
		});
		it("protects automatic provenance while saving subsequent human edits", async () => {
			const { input } = await automaticFixture();
			const created = await createAutomaticPortrait(input, "fixture");
			const view = await readEditingProject(created.projectId);
			const forged = structuredClone(view.draft);
			if (!forged.autoGeneration)
				throw new Error("Automatic evidence required");
			forged.autoGeneration.requestedDurationFrames = 150;
			await expect(
				saveEditingDraft(view.id, { expectedRevision: 1, document: forged }),
			).rejects.toMatchObject({
				status: 422,
				code: "AUTO_GENERATION_IMMUTABLE",
			});
			const saved = await saveEditingDraft(view.id, {
				expectedRevision: 1,
				document: view.draft,
			});
			expect(saved.draft.autoGeneration).toEqual(view.draft.autoGeneration);
			expect(
				saved.draft.clips.every((clip) =>
					clip.framing.every((part) => part.origin === "MANUAL"),
				),
			).toBe(true);
		});
		it("rechecks binding before a later render request", async () => {
			const { input, media } = await automaticFixture();
			const created = await createAutomaticPortrait(input, "fixture");
			const view = await readEditingProject(created.projectId);
			await prisma.libraryAnalysisBinding.deleteMany({
				where: { mediaVersionId: media.id },
			});
			await expect(
				requestEditingRender(view.id, {
					revisionId: view.currentRevisionId,
					kind: "EXPORT",
					requestKey: randomUUID(),
				}),
			).rejects.toMatchObject({
				status: 422,
				code: "ANALYSIS_BINDING_UNVERIFIED",
			});
		});
		it("keeps prepared media and sealed binding evidence immutable", async () => {
			const { input, media } = await automaticFixture();
			const sealed = await prisma.libraryAnalysisBinding.findFirstOrThrow({
				where: { mediaVersionId: media.id },
			});
			await expect(
				prisma.libraryMediaVersion.update({
					where: { id: media.id },
					data: { probe: {} },
				}),
			).rejects.toThrow("Prepared media versions are immutable");
			await expect(
				prisma.libraryAnalysisBinding.update({
					where: { id: sealed.id },
					data: { proof: {} },
				}),
			).rejects.toThrow();
			expect(
				(await createAutomaticPortrait(input, "fixture")).projectId,
			).toBeTruthy();
		});
		it("keeps the highest export visible after twenty-five newer previews", async () => {
			const { input } = await automaticFixture();
			const created = await createAutomaticPortrait(input, "fixture");
			const initial = await readEditingProject(created.projectId);
			for (let index = 0; index < 25; index++) {
				await requestEditingRender(initial.id, {
					revisionId: initial.currentRevisionId,
					kind: "PREVIEW",
					requestKey: randomUUID(),
				});
			}
			const current = await readEditingProject(initial.id);
			expect(
				current.renders.find((run) => run.id === initial.renders[0]?.id),
			).toMatchObject({ kind: "EXPORT", state: "QUEUED", generation: 1 });
			expect(
				current.renders.filter((run) => run.kind === "PREVIEW"),
			).toHaveLength(25);
			expect(current.renders).toHaveLength(26);
		});
		async function hierarchyExecution(
			project: { id: string; currentRevisionId: string | null },
			kind: "PREVIEW" | "EXPORT",
			state: "SUCCEEDED" | "FAILED",
			generation: number,
		) {
			if (!project.currentRevisionId)
				throw new Error("Confirmed fixture revision required");
			const run = await prisma.renderRun.create({
				data: {
					projectId: project.id,
					revisionId: project.currentRevisionId,
					profile: { kind },
					state,
					generation,
					requestKey: randomUUID(),
					requestHash: "d".repeat(64),
					outputCredentialId: credentialId,
					outputBucket: "synthetic-output",
					outputPrefix: "clips/",
					finishedAt: new Date(),
				},
			});
			const artifact =
				state === "SUCCEEDED"
					? await prisma.renderArtifact.create({
							data: {
								runId: run.id,
								storage: {},
								sha256: "d".repeat(64),
								size: 1n,
								probe: {},
							},
						})
					: null;
			return { run, artifact };
		}
		it("classifies originals before paging and keeps legacy originals, orphan-derived sources and durable lineage distinct", async () => {
			const f = await fixture();
			const token = `hierarchy-${randomUUID()}`;
			const at = new Date("2026-11-05T01:00:00Z");
			await prisma.content.update({
				where: { id: f.content.id },
				data: { title: `${token} parent`, updatedAt: at },
			});
			const originals = [
				f.content.id,
				...Array.from({ length: 30 }, () => randomUUID()),
			];
			await prisma.content.createMany({
				data: originals.slice(1).map((id) => ({
					id,
					registrationKey: `manual:${id}`,
					title: `${token} original`,
					locale: "und",
					updatedAt: at,
				})),
			});
			await prisma.contentRevision.createMany({
				data: originals.slice(1).map((contentId) => ({
					contentId,
					sourceId: f.media.sourceId,
					revision: 1,
					title: "legacy manual",
					description: "",
					tags: [],
					locale: "und",
				})),
			});
			const confirmed = await confirmEditingRevision(
				f.project.id,
				{ expectedRevision: 1, confirmSuggestions: false },
				"fixture",
			);
			const execution = await hierarchyExecution(
				confirmed,
				"EXPORT",
				"SUCCEEDED",
				1,
			);
			if (!execution.artifact) throw new Error("Expected fixture artifact");
			const child = await prisma.content.create({
				data: {
					registrationKey: randomUUID(),
					title: `${token} renamed clip`,
					locale: "und",
				},
			});
			// The current source was replaced; the stable publication relation still owns this child.
			await prisma.contentRevision.create({
				data: {
					contentId: child.id,
					sourceId: f.media.sourceId,
					revision: 1,
					title: child.title,
					description: "",
					tags: [],
					locale: "und",
				},
			});
			await prisma.contentDerivation.create({
				data: {
					projectId: f.project.id,
					variant: "PORTRAIT",
					derivedContentId: child.id,
					desiredGeneration: 1,
					activeGeneration: 1,
					activeArtifactId: execution.artifact.id,
				},
			});
			const derivedSource = await prisma.librarySource.create({
				data: {
					sourceKey: randomUUID(),
					sourceKind: "DERIVED_RENDER",
					renderArtifactId: execution.artifact.id,
					locales: [],
					state: "READY",
					snapshot: {},
				},
			});
			const orphan = await prisma.content.create({
				data: {
					registrationKey: randomUUID(),
					title: `${token} clip missing derivation`,
					locale: "und",
				},
			});
			await prisma.contentRevision.create({
				data: {
					contentId: orphan.id,
					sourceId: derivedSource.id,
					revision: 1,
					title: orphan.title,
					description: "",
					tags: [],
					locale: "und",
				},
			});
			const all = await listContents(
				prisma,
				listQuery.parse({ q: token }),
				org,
			);
			expect(all.total).toBe(33);
			const first = await listContents(
				prisma,
				listQuery.parse({ q: token, scope: "originals" }),
				org,
			);
			const second = await listContents(
				prisma,
				listQuery.parse({ q: token, scope: "originals", offset: 25 }),
				org,
			);
			expect(first.counts).toEqual({ all: 31, playback: 0, metadata: 31 });
			expect(first.total).toBe(31);
			expect(first.items).toHaveLength(25);
			expect(second.items).toHaveLength(6);
			expect([...first.items, ...second.items].map((x) => x.id)).toEqual(
				[...originals].sort().reverse(),
			);
			expect(
				[...first.items, ...second.items].find((x) => x.id === f.content.id)
					?.clipProjectCount,
			).toBe(1);
			expect(await contentParent(prisma, child.id)).toEqual({
				contentId: f.content.id,
				title: `${token} parent`,
				projectId: f.project.id,
			});
			expect(await contentParent(prisma, orphan.id)).toBeNull();
			const foreign = createTenantPrismaClient(app, otherOrg);
			expect(await contentParent(foreign, child.id)).toBeNull();
			expect(
				await listContents(
					foreign,
					listQuery.parse({ q: token, scope: "originals" }),
					otherOrg,
				),
			).toMatchObject({ total: 0, items: [] });
		});
		it("summarizes the last successful export independently of later failures and previews under tenant scope", async () => {
			const f = await fixture();
			const confirmed = await confirmEditingRevision(
				f.project.id,
				{ expectedRevision: 1, confirmSuggestions: false },
				"fixture",
			);
			const good = await hierarchyExecution(
				confirmed,
				"EXPORT",
				"SUCCEEDED",
				1,
			);
			const failed = await hierarchyExecution(confirmed, "EXPORT", "FAILED", 2);
			await hierarchyExecution(confirmed, "PREVIEW", "SUCCEEDED", 0);
			await prisma.renderRun.createMany({
				data: Array.from({ length: 25 }, () => ({
					projectId: confirmed.id,
					revisionId: confirmed.currentRevisionId as string,
					profile: { kind: "PREVIEW" },
					generation: 0,
					requestKey: randomUUID(),
					requestHash: "e".repeat(64),
					outputCredentialId: credentialId,
					outputBucket: "synthetic-output",
					outputPrefix: "previews/",
				})),
			});
			const page = await listEditingProjectSummaries(
				holder.context,
				f.content.id,
				0,
			);
			expect(page.items[0]).toMatchObject({
				durationFrames: 180,
				currentRevisionMatchesDraft: true,
				latestExport: { id: failed.run.id, state: "FAILED", artifact: null },
				latestSuccessfulExport: {
					id: good.run.id,
					state: "SUCCEEDED",
					matchesCurrentDraft: true,
					artifact: { id: good.artifact?.id },
				},
			});
			expect(JSON.stringify(page)).not.toContain("synthetic-output");
			expect(page.items[0]).not.toHaveProperty("draft");
			const next = structuredClone(confirmed.draft);
			const clip = next.clips[0];
			const framing = clip?.framing[0];
			if (!clip || !framing) throw new Error("Expected fixture framing");
			clip.durationFrames = 60;
			framing.toFrame = 60;
			await saveEditingDraft(f.project.id, {
				expectedRevision: confirmed.draftRevision,
				document: next,
			});
			const edited = await listEditingProjectSummaries(
				holder.context,
				f.content.id,
				0,
			);
			expect(edited.items[0]).toMatchObject({
				durationFrames: 60,
				currentRevisionMatchesDraft: false,
				latestSuccessfulExport: { matchesCurrentDraft: false },
			});
			const foreign = {
				prisma: createTenantPrismaClient(app, otherOrg),
				tenant: { organizationId: otherOrg },
			} as unknown as ServerContext;
			expect(
				await listEditingProjectSummaries(foreign, f.content.id, 0),
			).toEqual({ items: [], offset: 0, total: 0 });
		});
		it("paginates multiple same-format alternatives deterministically and counts archived projects consistently", async () => {
			const f = await fixture();
			const at = new Date("2026-11-05T01:00:00Z");
			const ids = [
				f.project.id,
				...Array.from({ length: 27 }, () => randomUUID()),
			]
				.sort()
				.reverse();
			await prisma.editProject.createMany({
				data: ids
					.filter((id) => id !== f.project.id)
					.map((id) => ({
						id,
						contentId: f.content.id,
						mediaVersionId: f.media.id,
						title: "Another portrait",
						variant: "PORTRAIT",
						draft: f.project.draft,
						updatedAt: at,
					})),
			});
			await prisma.editProject.updateMany({
				where: { contentId: f.content.id },
				data: { updatedAt: at },
			});
			await prisma.editProject.update({
				where: { id: ids[0] },
				data: { archived: true, updatedAt: at },
			});
			const first = await listEditingProjectSummaries(
				holder.context,
				f.content.id,
				0,
			);
			const second = await listEditingProjectSummaries(
				holder.context,
				f.content.id,
				25,
			);
			expect(first.total).toBe(28);
			expect(first.items.map((x) => x.id)).toEqual(ids.slice(0, 25));
			expect(first.items[0]?.archived).toBe(true);
			expect(second.items.map((x) => x.id)).toEqual(ids.slice(25));
			expect(
				(await listContents(prisma, listQuery.parse({}), org)).items.find(
					(x) => x.id === f.content.id,
				)?.clipProjectCount,
			).toBe(28);
		});
		it("never replays or creates an automatic project across organizations", async () => {
			const { input } = await automaticFixture();
			await createAutomaticPortrait(input, "fixture");
			holder.context = {
				prisma: createTenantPrismaClient(app, otherOrg),
				tenant: { organizationId: otherOrg },
			} as unknown as ServerContext;
			await expect(
				createAutomaticPortrait(input, "fixture"),
			).rejects.toMatchObject({ status: 422, code: "MEDIA_NOT_READY" });
		});
		it("never reads an editing project through another organization", async () => {
			const { project } = await fixture();
			holder.context = {
				prisma: createTenantPrismaClient(app, otherOrg),
				tenant: { organizationId: otherOrg },
			} as unknown as ServerContext;
			await expect(readEditingProject(project.id)).rejects.toMatchObject({
				status: 404,
				code: "EDIT_NOT_FOUND",
			});
		});
	},
);
