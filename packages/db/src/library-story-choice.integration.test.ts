import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppPrismaClient, createPrismaClient } from "./client";
import { createTenantPrismaClient } from "./tenant-client";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
const legacyKinds = [
	"INPUT_CAPTURE",
	"ANALYSIS_CAPTURE",
	"NORMALIZATION_CAPTURE",
	"EDITOR_ATTESTATION",
	"STORY_GRAPH_V1",
	"LOCAL_STORY_TRANSCRIPT_V1",
	"LOCAL_STORY_LEDGER_V1",
	"LOCAL_STORY_BLUEPRINT_V1",
	"LOCAL_CAPTION_TRANSLATION_V1",
	"LOCAL_FLOW_MANIFEST_V1",
	"LOCAL_FLOW_CONTEXT_V1",
	"LOCAL_FLOW_ROUTE_V1",
	"LOCAL_FLOW_PLAN_V1",
] as const;
const proofHash = () => createHash("sha256").update(randomUUID()).digest("hex");

describe.runIf(Boolean(adminUrl && appUrl))(
	"dedicated PostgreSQL story-choice receipts",
	() => {
		const orgA = randomUUID(),
			orgB = randomUUID();
		let admin: AppPrismaClient,
			app: AppPrismaClient,
			a: AppPrismaClient,
			b: AppPrismaClient;
		let choiceId: string;
		let sourceId: string;
		let jobId: string;
		beforeAll(async () => {
			for (const value of [adminUrl, appUrl]) {
				const url = new URL(value ?? "");
				expect(url.hostname).toBe("127.0.0.1");
				expect(url.pathname).toMatch(/^\/bitovp_integration_[a-f0-9]{32}$/);
			}
			expect(new URL(adminUrl ?? "").username).not.toBe(
				new URL(appUrl ?? "").username,
			);
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
			a = createTenantPrismaClient(app, orgA);
			b = createTenantPrismaClient(app, orgB);
			await admin.organization.createMany({
				data: [
					{ id: orgA, name: "Choice A", slug: `choice-${orgA}` },
					{ id: orgB, name: "Choice B", slug: `choice-${orgB}` },
				],
			});
			const job = await a.encodingJob.create({
				data: { name: "Choice receipt fixture", plan: {} },
			});
			jobId = job.id;
			const source = await a.librarySource.create({
				data: {
					sourceKey: randomUUID(),
					originalJobId: job.id,
					encodingId: randomUUID(),
					accountId: randomUUID(),
					snapshot: {},
					locales: ["ja"],
					state: "READY",
				},
			});
			sourceId = source.id;
		});
		afterAll(async () => {
			try {
				if (!admin) return;
				await admin.libraryEvidenceReceipt.deleteMany({
					where: { organizationId: { in: [orgA, orgB] } },
				});
				await admin.librarySource.deleteMany({
					where: { organizationId: { in: [orgA, orgB] } },
				});
				await admin.encodingJob.deleteMany({
					where: { organizationId: { in: [orgA, orgB] } },
				});
				await admin.organization.deleteMany({
					where: { id: { in: [orgA, orgB] } },
				});
			} finally {
				await app?.$disconnect();
				await admin?.$disconnect();
			}
		});
		it("admits a choice receipt and every pre-existing receipt kind", async () => {
			const choice = await a.libraryEvidenceReceipt.create({
				data: {
					sourceId,
					kind: "LOCAL_STORY_CHOICE_V1",
					proof: { version: "owned-choice-fixture-v1" },
					proofHash: proofHash(),
				},
			});
			choiceId = choice.id;
			expect(choice.organizationId).toBe(orgA);
			for (const kind of legacyKinds) {
				const row = await a.libraryEvidenceReceipt.create({
					data: {
						sourceId,
						kind,
						proof: {},
						proofHash: proofHash(),
						...(kind === "INPUT_CAPTURE"
							? { jobId, encodingId: "owned-input-fixture" }
							: {}),
					},
				});
				expect(row.kind).toBe(kind);
			}
			expect(await a.libraryEvidenceReceipt.count()).toBe(
				legacyKinds.length + 1,
			);
		});
		it("rejects unknown kinds and retains tenant isolation for the new kind", async () => {
			await expect(
				a.libraryEvidenceReceipt.create({
					data: {
						sourceId,
						kind: "LOCAL_STORY_CHOICE_V999",
						proof: {},
						proofHash: proofHash(),
					},
				}),
			).rejects.toThrow();
			expect(
				await b.libraryEvidenceReceipt.findMany({ where: { id: choiceId } }),
			).toEqual([]);
			expect(
				(
					await a.libraryEvidenceReceipt.findMany({ where: { id: choiceId } })
				).map((r) => r.kind),
			).toEqual(["LOCAL_STORY_CHOICE_V1"]);
		});
	},
);
