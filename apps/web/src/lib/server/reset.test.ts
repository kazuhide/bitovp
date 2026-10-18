import { createHash } from "node:crypto";
import { fieldRefs } from "@bitovp/core/testing";
import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { AisaSnapshotRequired } from "./delete-jobs";
import { deleteOperationalData, RESET_DELETES } from "./reset";

function fixture(captured: boolean) {
	const writes: string[] = [];
	const job = {
		id: "job-1",
		bitmovinEncodingId: "encoding-1",
		plan: { aiSceneAnalysis: {} },
	};
	const hash = (value: unknown) =>
		createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const sourceKey = hash([job.id, job.bitmovinEncodingId, hash(job.plan)]);
	const model = (name: string) => ({
		fields: fieldRefs(name[0]?.toUpperCase() + name.slice(1), [
			"bitmovinEncodingId",
		]),
		findMany: vi.fn(async (args?: { select?: { plan?: boolean } }) =>
			name === "encodingJob" && args?.select?.plan ? [job] : [],
		),
		count: vi.fn(async () => 0),
		deleteMany: vi.fn(async () => {
			writes.push(name);
			return { count: 0 };
		}),
		updateMany: vi.fn(async () => {
			writes.push(name);
			return { count: 0 };
		}),
	});
	const client = {
		...Object.fromEntries(
			[
				...RESET_DELETES,
				"watchRule",
				"alertRule",
				"verificationResourceIntent",
			].map((name) => [name, model(name)]),
		),
		$queryRaw: vi.fn(async () => []),
		librarySource: {
			findUnique: vi.fn(async (args: { where: { sourceKey: string } }) =>
				captured && args.where.sourceKey === sourceKey
					? { id: "source-1" }
					: null,
			),
		},
		$transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
	};
	return { client: client as unknown as AppPrismaClient, writes, job };
}

describe("reset AISA snapshot boundary", () => {
	it("rejects before any reset mutation if the completed analysis has no snapshot", async () => {
		const { client, writes } = fixture(false);
		await expect(deleteOperationalData(client)).rejects.toBeInstanceOf(
			AisaSnapshotRequired,
		);
		expect(writes).toEqual([]);
		expect(client.$queryRaw).toHaveBeenCalledTimes(1);
	});
	it("allows captured history deletion while preserving the durable source", async () => {
		const { client, writes } = fixture(true);
		await deleteOperationalData(client);
		expect(writes).toContain("encodingJob");
		expect(writes).not.toContain("librarySource");
	});
	it("does not accept a snapshot for a different plan", async () => {
		const { client, writes, job } = fixture(true);
		job.plan.aiSceneAnalysis = { outputLanguageCodes: ["ja"] };
		await expect(deleteOperationalData(client)).rejects.toBeInstanceOf(
			AisaSnapshotRequired,
		);
		expect(writes).toEqual([]);
	});
});
