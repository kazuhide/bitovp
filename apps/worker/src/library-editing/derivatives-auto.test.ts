import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { promoteEditingArtifact } from "./derivatives";

function automaticAdmissionFixture(document: unknown) {
	const tx = {
		renderRun: {
			findUnique: vi.fn(async () => ({
				id: "run",
				state: "SUCCEEDED",
				profile: { kind: "EXPORT" },
				artifact: {
					id: "artifact",
					storage: {
						credentialId: "00000000-0000-4000-8000-000000000001",
						bucket: "output",
						key: "artifact.mp4",
						size: 20,
						expect: { etag: '"fixed"' },
					},
					probe: { recipeHash: "2".repeat(64) },
				},
				projectId: "project",
				generation: 1,
				project: { variant: "PORTRAIT", content: {} },
				revision: { document },
			})),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		contentDerivation: {
			findFirst: vi.fn(async () => ({ id: "target" })),
			updateMany: vi.fn(async () => ({ count: 0 })),
		},
	};
	const prisma = {
		$transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
	} as unknown as AppPrismaClient;
	return {
		tx,
		promote: () => promoteEditingArtifact({ prisma, runId: "run" }),
	};
}

describe("automatic derivative promotion document admission", () => {
	it.each([
		{ locale: "ja", autoGeneration: null },
		{ locale: "ja", autoGeneration: {} },
		{ locale: "ja", clips: [{ framing: [{ origin: "AUTO_POLICY" }] }] },
	])("rejects incomplete automatic evidence before promotion writes: %j", async (document) => {
		const f = automaticAdmissionFixture(document);
		await expect(f.promote()).rejects.toMatchObject({
			code: "ANALYSIS_BINDING_UNVERIFIED",
		});
		expect(f.tx.contentDerivation.updateMany).not.toHaveBeenCalled();
		expect(f.tx.renderRun.updateMany).not.toHaveBeenCalled();
	});
	it("retains the existing partial legacy document admission", async () => {
		const f = automaticAdmissionFixture({ locale: "ja" });
		expect(await f.promote()).toBe(false);
		expect(f.tx.renderRun.updateMany).toHaveBeenCalledWith({
			where: { id: "run", state: "SUCCEEDED" },
			data: { error: null },
		});
	});
});
