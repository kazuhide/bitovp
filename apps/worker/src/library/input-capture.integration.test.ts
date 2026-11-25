import { randomUUID } from "node:crypto";
import { encodingPlanSchema, hashEditingEvidence } from "@bitovp/core";
import { createPrismaClient, createTenantPrismaClient } from "@bitovp/db";
import { expect, it, vi } from "vitest";
import plan from "../../../../packages/core/src/testing/verified-audio-copy.plan.json";
import type { SdkOps } from "../orchestrator/sdk-ops";
import { createEncodingInputCapture } from "./input-capture";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
it.runIf(adminUrl && appUrl)(
	"resumes a previously admitted audio capture only for the literal object in the locked-in plan",
	async () => {
		const admin = createPrismaClient(adminUrl),
			runtime = createPrismaClient(appUrl);
		const org = randomUUID(),
			prisma = createTenantPrismaClient(runtime, org);
		const storage = vi.fn(async () => {
			throw new Error("retained capture must not reopen storage");
		});
		const sdk = { createHttpsInput: vi.fn(async () => randomUUID()) };
		const capture = createEncodingInputCapture({
			prisma,
			browserFor: storage,
			config: {
				baseUrl: "https://input.example.test",
				secret: "test-capture-key-with-at-least-thirty-two-chars",
			},
		});
		try {
			await admin.organization.create({
				data: { id: org, name: "Audio input receipt", slug: org },
			});
			const account = await prisma.bitmovinAccount.create({
				data: { label: "fixture", encryptedApiKey: "fixture" },
			});
			expect(encodingPlanSchema.safeParse(plan).success).toBe(true);
			for (const key of ["take.mov", "/take.mov"]) {
				const encodingId = randomUUID();
				const job = await prisma.encodingJob.create({
					data: {
						name: "Resumed capture",
						plan,
						status: "RUNNING",
						bitmovinEncodingId: encodingId,
						bitmovinAccountId: account.id,
					},
				});
				const proof = {
					schemaVersion: 1,
					profile: "PINNED_AUDIO_INPUT_V1",
					organizationId: org,
					jobId: job.id,
					encodingId,
					expiresAt: Math.floor(Date.now() / 1000) + 86400,
					planHash: hashEditingEvidence(plan),
					ingestKey: "audio",
					inspectionId: plan.renditions[0]?.inspectionId,
					track: { position: 1, sourceCodec: "AAC" },
					storage: {
						credentialId: plan.inputs[0]?.credentialId,
						bucket: "private",
						key,
						size: 8192,
						expect: { versionId: "fixed-version" },
					},
				};
				const receipt = await prisma.libraryEvidenceReceipt.create({
					data: {
						jobId: job.id,
						encodingId,
						kind: "INPUT_CAPTURE",
						proof: JSON.parse(JSON.stringify(proof)),
						proofHash: hashEditingEvidence(proof),
					},
				});
				const result = capture({
					organizationId: org,
					jobId: job.id,
					encodingId,
					sdk: sdk as unknown as SdkOps,
					checkpoint: async () => {},
					operation: {
						step: "ingest:audio",
						kind: "CREATE_INGEST_INPUT_STREAM",
						refs: {},
						payload: {
							requireAudioCapture: true,
							inputPath: "/take.mov",
							position: 1,
							selectionMode: "AUDIO_RELATIVE",
						},
					},
				});
				if (key !== "/take.mov") {
					await expect(result).rejects.toThrow("INPUT_CAPTURE_WAS_CHANGED");
					expect(sdk.createHttpsInput).not.toHaveBeenCalled();
				} else {
					await expect(result).resolves.toMatchObject({
						inputReceiptId: receipt.id,
					});
					expect(sdk.createHttpsInput).toHaveBeenCalledTimes(1);
				}
			}
			expect(storage).not.toHaveBeenCalled();
		} finally {
			try {
				await prisma.libraryEvidenceReceipt.deleteMany();
				await prisma.encodingJob.deleteMany();
				await prisma.bitmovinAccount.deleteMany();
				await admin.organization.deleteMany({ where: { id: org } });
			} finally {
				await Promise.all([runtime.$disconnect(), admin.$disconnect()]);
			}
		}
	},
);
