import { randomUUID } from "node:crypto";
import {
	compositionDocumentSchema,
	GENERATION_POLICY_FINGERPRINT,
	hashEditingEvidence,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskEnvelopeSchema,
	mediaTaskIntentHash,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import {
	type AppPrismaClient,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createLibraryGenerationHandler } from "../../../../worker/src/library-editing/generation";
import type { executeMediaTask } from "../../../../worker/src/library-editing/media-task-execution";
import { createLibraryMediaTaskSweep } from "../../../../worker/src/library-editing/media-task-sweep";
import type { ServerContext } from "./context";
import {
	confirmEditingRevision,
	saveEditingDraft,
} from "./library-editing-projects";
import { requestEditingRender } from "./library-editing-renders";
import {
	cancelMediaTask,
	createMediaTask,
	readMediaTask,
} from "./library-media-tasks";

const holder = vi.hoisted(() => ({
	context: null as unknown as ServerContext,
}));
const execute = vi.hoisted(() => vi.fn());
vi.mock("./context", () => ({ getServerContext: async () => holder.context }));
vi.mock(
	"../../../../worker/src/library-editing/media-task-execution",
	async (original) => ({
		...(await original<object>()),
		executeMediaTask: execute,
	}),
);
afterEach(() => execute.mockReset());
const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL,
	appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL generation cache project isolation",
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
					name: "Generation cache fixture",
					slug: `generation-cache-${organizationId}`,
				},
			});
			credentialId = (
				await db.credential.create({
					data: {
						label: "Generation cache fixture",
						provider: "AWS_S3",
						encryptedSecret: "fixture",
					},
				})
			).id;
			holder.context = {
				prisma: db,
				tenant: { organizationId },
			} as unknown as ServerContext;
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
		async function fixture() {
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
					variants: 1,
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
		async function editGeneratedProject(projectId: string) {
			const original = await db.editProject.findUniqueOrThrow({
				where: { id: projectId },
			});
			const document = compositionDocumentSchema.parse(original.draft);
			const clip = document.clips[0];
			if (!clip) throw new Error("Missing generated clip");
			clip.opacity = 0.5;
			const saved = await saveEditingDraft(projectId, {
				expectedRevision: original.draftRevision,
				document,
			});
			const confirmed = await confirmEditingRevision(
				projectId,
				{ expectedRevision: saved.draftRevision, confirmSuggestions: false },
				"fixture-editor",
			);
			if (!confirmed.currentRevisionId)
				throw new Error("Missing edited revision");
			await requestEditingRender(projectId, {
				revisionId: confirmed.currentRevisionId,
				kind: "EXPORT",
				requestKey: randomUUID(),
			});
			return db.editProject.findUniqueOrThrow({ where: { id: projectId } });
		}
		it("queues a distinct request after normal edit/confirm/export and keeps same-key replay", async () => {
			const f = await fixture(),
				original = await handler()(f.context);
			const edited = await editGeneratedProject(original.projectId);
			const input = mediaTaskEnvelopeSchema.parse(f.task.parameters).input;
			const next = await createMediaTask(
				{ ...input, requestKey: randomUUID() },
				"fixture-editor",
			);
			expect(next).toMatchObject({ state: "PENDING", cached: false });
			expect(next.taskId).not.toBe(f.task.id);
			expect((await readMediaTask(next.taskId)).result).toBeNull();
			expect(await createMediaTask(input, "fixture-editor")).toMatchObject({
				taskId: f.task.id,
				state: "SUCCEEDED",
			});
			expect(
				await db.editProject.findUniqueOrThrow({ where: { id: edited.id } }),
			).toEqual(edited);
			expect(
				await db.editProject.count({ where: { contentId: f.content.id } }),
			).toBe(1);
			expect(
				await db.renderRun.count({ where: { projectId: edited.id } }),
			).toBe(2);
			await cancelMediaTask(next.taskId);
		});
		it("executes a queued request instead of adopting the older editable project result", async () => {
			const f = await fixture(),
				original = await handler()(f.context);
			const edited = await editGeneratedProject(original.projectId);
			const input = mediaTaskEnvelopeSchema.parse(f.task.parameters).input;
			const next = await createMediaTask(
				{ ...input, requestKey: randomUUID() },
				"fixture-editor",
			);
			execute.mockImplementation(
				async ({
					task,
					verified,
					dependencies,
					signal,
					onProgress,
				}: Parameters<typeof executeMediaTask>[0]) => {
					const request = verified.envelope.input;
					if (
						request.kind !== "GENERATE" ||
						!dependencies.generate ||
						!task.leaseToken
					)
						throw new Error("Missing generation lease");
					return dependencies.generate({
						taskId: task.id,
						organizationId: task.organizationId,
						leaseToken: task.leaseToken,
						mediaVersionId: task.mediaVersionId,
						analysisRevisionId: request.analysisRevisionId,
						parameters: request.parameters,
						sourcePath: "/owned/not-read-without-asr-or-tracking.mp4",
						media: verified.media,
						createdBy: task.createdBy,
						signal,
						onProgress,
					});
				},
			);
			await createLibraryMediaTaskSweep({
				canClaim: async () => true,
				prisma: db,
				browserFor: vi.fn(),
				generate: handler(),
			})();
			const completed = await db.libraryMediaTask.findUniqueOrThrow({
				where: { id: next.taskId },
			});
			expect(completed).toMatchObject({
				state: "SUCCEEDED",
				phase: "COMPLETE",
			});
			const result = completed.result as { projectId: string };
			expect(result.projectId).not.toBe(original.projectId);
			expect(
				await db.editProject.count({ where: { contentId: f.content.id } }),
			).toBe(2);
			expect(
				await db.editProject.findUniqueOrThrow({ where: { id: edited.id } }),
			).toEqual(edited);
			expect(
				(
					await db.libraryMediaTask.findUniqueOrThrow({
						where: { id: f.task.id },
					})
				).result,
			).toEqual(original);
		});
	},
);
