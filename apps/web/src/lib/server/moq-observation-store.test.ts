import type { AppTransactionClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { writeMoqObservationStore } from "./moq-observation-store";

const ORG = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const scope = { organizationId: ORG, runId: RUN };
const store = {
	version: 1 as const,
	sessions: [
		{
			id: "00000000-0000-4000-8000-000000000003",
			actor: "user:owner",
			startedAt: "2026-11-17T20:00:00.000Z",
			endedAt: null,
			createdAt: "2026-11-17T20:00:00.000Z",
			updatedAt: "2026-11-17T20:00:00.000Z",
			archive: null,
			samples: [
				{
					elapsedMs: 1_000,
					fps: 1.9994801351648572,
					latencyMs: 1908,
					bufferSeconds: 0.6826660000000011,
					decodedFrames: null,
					droppedFrames: null,
					presentedFrames: null,
					totalFrames: null,
					resolution: null,
				},
			],
			events: [],
		},
	],
};
function client(execute: ReturnType<typeof vi.fn>) {
	return { $executeRaw: execute } as unknown as Pick<
		AppTransactionClient,
		"$executeRaw"
	>;
}

describe("lossless scoped MoQ observation store writes", () => {
	it("binds JSON as exact text and scopes the update to both run and tenant", async () => {
		const execute = vi.fn().mockResolvedValue(1);
		await writeMoqObservationStore(client(execute), scope, store);
		expect(execute).toHaveBeenCalledOnce();
		const call = execute.mock.calls[0];
		if (!call) throw new Error("Expected one store write");
		const [sql, json, updatedAt, runId, organizationId] = call;
		expect(sql.join("?")).toMatch(/SET\s+"moqObservations" = \?::jsonb/);
		expect(sql.join("?")).toMatch(/WHERE id = \?::uuid/);
		expect(sql.join("?")).toMatch(/AND "organizationId" = \?::uuid/);
		expect(sql.join("?")).toContain('"updatedAt" = ?');
		expect([runId, organizationId]).toEqual([RUN, ORG]);
		expect(updatedAt).toBeInstanceOf(Date);
		expect(typeof json).toBe("string");
		const persisted = JSON.parse(json);
		expect(persisted).toEqual(store);
		expect(persisted.sessions[0].samples[0].fps).toBe(1.9994801351648572);
	});

	it.each([
		0, 2,
	])("fails closed if the scoped write affects %i rows", async (rows) => {
		const execute = vi.fn().mockResolvedValue(rows);
		await expect(
			writeMoqObservationStore(client(execute), scope, store),
		).rejects.toThrow();
	});

	it("does not issue a write without the authenticated tenant", async () => {
		const execute = vi.fn();
		await expect(
			writeMoqObservationStore(
				client(execute),
				{ runId: RUN, organizationId: undefined },
				store,
			),
		).rejects.toThrow();
		expect(execute).not.toHaveBeenCalled();
	});
});
