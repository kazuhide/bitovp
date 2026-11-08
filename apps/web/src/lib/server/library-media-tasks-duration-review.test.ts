import { randomUUID } from "node:crypto";
import { mediaTaskCreateSchema, mediaTaskIntentHash } from "@bitovp/core";
import { matchesWhere } from "@bitovp/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import { createMediaTask } from "./library-media-tasks";

const holder = vi.hoisted(() => ({
	context: null as unknown as ServerContext,
}));
vi.mock("./context", () => ({ getServerContext: async () => holder.context }));
type Row = Record<string, unknown>;
const organizationId = randomUUID(),
	sourceId = randomUUID(),
	mediaVersionId = randomUUID(),
	analysisRevisionId = randomUUID(),
	contentId = randomUUID();
let rows: Row[];
beforeEach(() => {
	rows = [];
	const tx = {
		$executeRaw: vi.fn(async () => 1),
		libraryMediaVersion: {
			findUnique: async () => ({
				id: mediaVersionId,
				sourceId,
				organizationId,
				state: "PENDING",
				sha256: null,
				timeMap: null,
			}),
		},
		sceneAnalysisRevision: {
			findUnique: async () => ({
				id: analysisRevisionId,
				sourceId,
				organizationId,
				rawHash: "fixture",
				document: { fixture: true },
			}),
		},
		contentRevision: { findFirst: async () => ({ contentId, sourceId }) },
		libraryMediaTask: {
			findUnique: async ({ where }: { where: Row }) => {
				const compound = where.organizationId_requestKey;
				return (
					rows.find((row) =>
						matchesWhere(
							row,
							compound && typeof compound === "object"
								? (compound as Row)
								: where,
						),
					) ?? null
				);
			},
			create: async ({ data }: { data: Row }) => {
				const row = {
					id: randomUUID(),
					state: "PENDING",
					phase: "QUEUED",
					...data,
				};
				rows.push(row);
				return row;
			},
		},
	};
	holder.context = {
		tenant: { organizationId },
		prisma: {
			...tx,
			$transaction: async <T>(action: (db: typeof tx) => Promise<T>) =>
				action(tx),
		},
	} as unknown as ServerContext;
});
function request(versioned = true, requestKey = randomUUID()) {
	return {
		kind: "GENERATE",
		mediaVersionId,
		analysisRevisionId,
		requestKey,
		parameters: {
			contentId,
			targetDurationFrames: 900,
			renderMode: "DRAFT",
			captions: "AUTO",
			...(versioned ? { draftPolicyVersion: "duration-review-v2" } : {}),
		},
	};
}
describe("server intake of an explicitly versioned draft proposal", () => {
	it("stores the explicit version in its immutable envelope and replays an unknown response with the same key", async () => {
		const body = request(),
			first = await createMediaTask(body, "fixture");
		expect(await createMediaTask(body, "fixture")).toEqual(first);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			state: "PENDING",
			phase: "WAITING_FOR_MEDIA",
			requestHash: mediaTaskIntentHash(mediaTaskCreateSchema.parse(body)),
			parameters: {
				input: {
					parameters: {
						renderMode: "DRAFT",
						draftPolicyVersion: "duration-review-v2",
					},
				},
				identity: { mediaSha256: null },
			},
		});
	});
	it("does not upgrade an old same-key DRAFT or reuse its generation cache entry for a distinct versioned intent", async () => {
		const old = request(false);
		await createMediaTask(old, "fixture");
		const before = structuredClone(rows[0]);
		await expect(
			createMediaTask(request(true, old.requestKey), "fixture"),
		).rejects.toMatchObject({ status: 409, code: "REQUEST_KEY_REUSED" });
		expect(rows[0]).toEqual(before);
		await createMediaTask(request(), "fixture");
		expect(rows).toHaveLength(2);
		expect(rows[1]?.requestHash).not.toBe(rows[0]?.requestHash);
		expect(rows[1]?.cacheKey).not.toBe(rows[0]?.cacheKey);
		expect(rows[0]?.parameters).toEqual(before?.parameters);
	});
	it("rejects v2 EXPORT or implicit legacy mode before creating durable intent", async () => {
		for (const renderMode of ["EXPORT", undefined]) {
			const body = request();
			if (renderMode === undefined)
				delete (body.parameters as Record<string, unknown>).renderMode;
			else body.parameters.renderMode = renderMode;
			await expect(createMediaTask(body, "fixture")).rejects.toThrow();
		}
		expect(rows).toEqual([]);
	});
});
