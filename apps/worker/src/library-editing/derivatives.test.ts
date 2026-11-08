import { matchesWhere } from "@bitovp/core/testing";
import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { adoptEditingArtifact, promoteEditingArtifact } from "./derivatives";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date("2026-11-01T00:00:00Z");
const output = {
	credentialId: id(8),
	bucket: "out",
	key: "clips/output.mp4",
	size: 20,
	expect: { etag: '"version"' },
};
const evidence = {
	storage: output,
	sha256: "1".repeat(64),
	bytes: 20,
	probe: { frameCount: 30 },
	recipeHash: "2".repeat(64),
};

function setup(generation = 2) {
	const state = {
		run: {
			id: id(1),
			organizationId: id(9),
			projectId: id(2),
			revisionId: id(3),
			generation,
			profile: { kind: "EXPORT" },
			state: "VALIDATING",
			leaseToken: id(7),
			pendingArtifactToken: id(20) as string | null,
			leaseUntil: new Date(now.getTime() + 1000),
			cancelRequestedAt: null,
			error: null,
		},
		project: {
			id: id(2),
			organizationId: id(9),
			contentId: id(4),
			title: "Highlight",
			variant: "PORTRAIT",
			archived: false,
		},
		revision: { id: id(3), document: { locale: "ja" } },
		parent: {
			id: id(4),
			title: "Original",
			description: "Original description",
			tags: ["tag"],
			locale: "ja",
			revision: 1,
		},
		target: {
			id: id(5),
			projectId: id(2),
			variant: "PORTRAIT",
			desiredGeneration: 2,
			activeGeneration: 0,
			activeArtifactId: null as string | null,
			derivedContentId: null as string | null,
		},
		artifacts: [] as Record<string, unknown>[],
		sources: [] as Record<string, unknown>[],
		contents: [] as Record<string, unknown>[],
		contentRevisions: [] as Record<string, unknown>[],
	};
	const update = (
		row: Record<string, unknown>,
		data: Record<string, unknown>,
	) => {
		for (const [key, value] of Object.entries(data))
			row[key] =
				value && typeof value === "object" && "increment" in value
					? Number(row[key]) + Number(value.increment)
					: value;
	};
	const db = {
		renderRun: {
			updateMany: vi.fn(async ({ where, data }) => {
				if (!matchesWhere(state.run, where)) return { count: 0 };
				update(state.run, data);
				return { count: 1 };
			}),
			findUnique: vi.fn(async () => ({
				...state.run,
				project: { ...state.project, content: state.parent },
				revision: state.revision,
				artifact: state.artifacts[0] ?? null,
			})),
		},
		renderArtifact: {
			create: vi.fn(async ({ data }) => {
				const row = { id: id(10), ...data };
				state.artifacts.push(row);
				return row;
			}),
		},
		contentDerivation: {
			findFirst: vi.fn(async () => state.target),
			updateMany: vi.fn(async ({ where, data }) => {
				if (!matchesWhere(state.target, where)) return { count: 0 };
				update(state.target, data);
				return { count: 1 };
			}),
			update: vi.fn(async ({ data }) => {
				update(state.target, data);
				return state.target;
			}),
		},
		librarySource: {
			upsert: vi.fn(async ({ create }) => {
				const row = { id: id(11), ...create };
				state.sources.push(row);
				return row;
			}),
		},
		content: {
			findUnique: vi.fn(async () => state.contents[0]),
			create: vi.fn(async ({ data }) => {
				const row = { id: id(12), revision: 1, ...data };
				state.contents.push(row);
				return row;
			}),
			updateMany: vi.fn(async ({ where, data }) => {
				const row = state.contents[0];
				if (!row || !matchesWhere(row, where)) return { count: 0 };
				update(row, data);
				return { count: 1 };
			}),
		},
		contentRevision: {
			create: vi.fn(async ({ data }) => {
				state.contentRevisions.push(data);
				return data;
			}),
		},
		$queryRaw: vi.fn(async () => [{ id: state.target.derivedContentId }]),
		$transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
	};
	return { state, db, prisma: db as unknown as AppPrismaClient };
}

describe("editing artifact adoption", () => {
	it("does not adopt a late or canceled worker's output", async () => {
		const f = setup();
		f.state.run.leaseToken = "new-owner";
		expect(
			await adoptEditingArtifact({
				prisma: f.prisma,
				runId: id(1),
				leaseToken: id(7),
				now: () => now,
				evidence,
			}),
		).toBeNull();
		expect(f.state.artifacts).toEqual([]);
		f.state.run.leaseToken = id(7);
		f.state.run.state = "CANCEL_REQUESTED";
		expect(
			await adoptEditingArtifact({
				prisma: f.prisma,
				runId: id(1),
				leaseToken: id(7),
				now: () => now,
				evidence,
			}),
		).toBeNull();
	});
	it("adopts an artifact only once and records pending Library registration separately", async () => {
		const f = setup();
		const result = await adoptEditingArtifact({
			prisma: f.prisma,
			runId: id(1),
			leaseToken: id(7),
			now: () => now,
			evidence,
		});
		expect(result).toBe(id(10));
		expect(f.state.run).toMatchObject({
			state: "SUCCEEDED",
			error: "LIBRARY_REGISTRATION_PENDING",
			pendingArtifactToken: null,
		});
		expect(
			await adoptEditingArtifact({
				prisma: f.prisma,
				runId: id(1),
				leaseToken: id(7),
				now: () => now,
				evidence,
			}),
		).toBeNull();
		expect(f.state.artifacts).toHaveLength(1);
	});
	it("keeps a superseded generation in history without rolling the Library head back", async () => {
		const f = setup(1);
		await adoptEditingArtifact({
			prisma: f.prisma,
			runId: id(1),
			leaseToken: id(7),
			now: () => now,
			evidence,
		});
		expect(
			await promoteEditingArtifact({
				prisma: f.prisma,
				runId: id(1),
				recipeHash: evidence.recipeHash,
			}),
		).toBe(false);
		expect(f.state.sources).toHaveLength(0);
		expect(f.state.contents).toHaveLength(0);
		expect(f.state.target.activeGeneration).toBe(0);
	});
	it("promotes the current generation with a real derived source and one Content revision", async () => {
		const f = setup();
		await adoptEditingArtifact({
			prisma: f.prisma,
			runId: id(1),
			leaseToken: id(7),
			now: () => now,
			evidence,
		});
		expect(
			await promoteEditingArtifact({
				prisma: f.prisma,
				runId: id(1),
				recipeHash: evidence.recipeHash,
			}),
		).toBe(true);
		expect(f.state.target).toMatchObject({
			activeGeneration: 2,
			activeArtifactId: id(10),
			derivedContentId: id(12),
		});
		expect(f.state.sources[0]).toMatchObject({
			sourceKind: "DERIVED_RENDER",
			originalJobId: null,
			encodingId: null,
			accountId: null,
			renderArtifactId: id(10),
		});
		expect(f.state.contentRevisions).toHaveLength(1);
	});
	it("does not create Library sources for a preview", async () => {
		const f = setup(0);
		f.state.run.profile.kind = "PREVIEW";
		await adoptEditingArtifact({
			prisma: f.prisma,
			runId: id(1),
			leaseToken: id(7),
			now: () => now,
			evidence,
		});
		expect(f.state.run.error).toBeNull();
		expect(
			await promoteEditingArtifact({
				prisma: f.prisma,
				runId: id(1),
				recipeHash: evidence.recipeHash,
			}),
		).toBe(false);
		expect(f.state.sources).toEqual([]);
	});
});
