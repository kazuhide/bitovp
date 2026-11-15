import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient, createTenantPrismaClient } from "@bitovp/db";
import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { createVodInputPreviewSweep } from "./cleanup";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL,
	appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;

describe.runIf(Boolean(adminUrl && appUrl))(
	"prepared input PostgreSQL retention",
	() => {
		it("retains completed and canceled input receipts after editor expiry while deleting ordinary previews only within its tenant", async () => {
			const admin = createPrismaClient(adminUrl),
				app = createPrismaClient(appUrl);
			const org = randomUUID(),
				foreign = randomUUID();
			const scoped = createTenantPrismaClient(app, org);
			const directory = await mkdtemp(
				join(tmpdir(), "bitovp-preparation-retention-"),
			);
			try {
				await admin.organization.createMany({
					data: [org, foreign].map((id) => ({
						id,
						name: "Preparation retention",
						slug: `prepare-${id}`,
					})),
				});
				const expired = new Date(Date.now() - 3600_000);
				const prepared = await Promise.all(
					["SUCCEEDED", "FAILED", "CANCELED", "PENDING"].map((status) =>
						scoped.vodInputPreviewTask.create({
							data: {
								kind: "TIMELINE_PREPARE",
								status,
								stage: status,
								request: { fixture: "retained preparation intent" },
								requestHash: "a".repeat(64),
								expiresAt: expired,
							},
						}),
					),
				);
				const ordinary = await scoped.vodInputPreviewTask.create({
					data: {
						kind: "PROBE",
						status: "SUCCEEDED",
						stage: "READY",
						request: {},
						requestHash: "b".repeat(64),
						expiresAt: expired,
					},
				});
				const other = await admin.vodInputPreviewTask.create({
					data: {
						organizationId: foreign,
						kind: "PROBE",
						status: "SUCCEEDED",
						stage: "READY",
						request: {},
						requestHash: "c".repeat(64),
						expiresAt: expired,
					},
				});
				const queue = { getJob: vi.fn(), add: vi.fn() } as unknown as Queue;
				await createVodInputPreviewSweep({
					prisma: scoped,
					queue,
					workDir: directory,
					organizationId: org,
				})();
				const pending = prepared.find((task) => task.status === "PENDING");
				if (!pending) throw new Error("Expected pending preparation");
				expect(
					await scoped.vodInputPreviewTask.findUnique({
						where: { id: ordinary.id },
					}),
				).toBeNull();
				for (const task of prepared)
					expect(
						await scoped.vodInputPreviewTask.findUnique({
							where: { id: task.id },
						}),
					).not.toBeNull();
				expect(
					(
						await scoped.vodInputPreviewTask.findUnique({
							where: { id: pending.id },
						})
					)?.status,
				).toBe("CANCELED");
				expect(
					await admin.vodInputPreviewTask.findUnique({
						where: { id: other.id },
					}),
				).not.toBeNull();
				expect(queue.add).not.toHaveBeenCalled();
			} finally {
				await admin.vodInputPreviewTask.deleteMany({
					where: { organizationId: { in: [org, foreign] } },
				});
				await admin.organization.deleteMany({
					where: { id: { in: [org, foreign] } },
				});
				await app.$disconnect();
				await admin.$disconnect();
				await rm(directory, { recursive: true, force: true });
			}
		});
	},
);
