import { randomUUID } from "node:crypto";
import { anyEditingDocumentSchema, toCompositionDocument } from "@bitovp/core";
import { beforeEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/library/edits/route";
import { enableClipEditingForTests } from "@/test/clip-editing-env";
import type { ServerContext } from "./context";
import { readContent } from "./library";
import { initialEditingDocument } from "./library-editing-common";

enableClipEditingForTests();

const holder = vi.hoisted(() => ({
	context: null as unknown as ServerContext,
}));
vi.mock("./context", () => ({ getServerContext: async () => holder.context }));
const contentId = randomUUID(),
	mediaId = randomUUID(),
	org = randomUUID();
const revisionId = randomUUID();
const map = {
	id: mediaId,
	mediaVersionId: mediaId,
	kind: "CFR",
	sourceStartUs: 0,
	sourceEndUs: 6_000_000,
	editingStartFrame: 0,
	editingEndFrame: 180,
	fps: { num: 30, den: 1 },
};
const draft = initialEditingDocument({ id: mediaId, timeMap: map }, "PORTRAIT");
const updatedAt = new Date("2026-11-05T01:00:00Z");
type ProjectRow = ReturnType<typeof project>;
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing fixture entry");
	return value;
}
function project(index = 0, document: unknown = draft) {
	return {
		id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
		contentId,
		title: `案 ${index}`,
		variant: "PORTRAIT",
		updatedAt,
		archived: false,
		draftRevision: 2,
		draft: document,
		currentRevisionId: revisionId,
		currentRevision: { document },
	};
}
let projects: ProjectRow[] = [];
let latest: Record<string, unknown>[] = [],
	successful: Record<string, unknown>[] = [];
function exported(projectId: string, state: string, revision = revisionId) {
	return {
		id: randomUUID(),
		projectId,
		revisionId: revision,
		generation: state === "FAILED" ? 4 : 3,
		state,
		finishedAt: updatedAt,
		document: draft,
		artifactId: state === "SUCCEEDED" ? randomUUID() : null,
		derivedContentId: state === "SUCCEEDED" ? randomUUID() : null,
	};
}
beforeEach(() => {
	projects = [project()];
	latest = [];
	successful = [];
	holder.context = {
		tenant: { organizationId: org },
		prisma: {
			$transaction: async (action: (tx: unknown) => unknown) =>
				action(holder.context.prisma),
			$queryRaw: vi.fn(
				async (_sql: TemplateStringsArray, ...values: unknown[]) =>
					values.includes(true) ? successful : latest,
			),
			editProject: {
				findMany: vi.fn(
					async ({
						skip = 0,
						take = 25,
						orderBy,
						select,
					}: {
						skip?: number;
						take?: number;
						orderBy: unknown;
						select: Record<string, unknown>;
					}) => {
						const ordered = [...projects];
						if (Array.isArray(orderBy))
							ordered.sort((a, b) => b.id.localeCompare(a.id));
						return ordered
							.slice(skip, skip + take)
							.map((row) =>
								Object.fromEntries(
									Object.entries(row).filter(([key]) => key in select),
								),
							);
					},
				),
				count: vi.fn(async () => projects.length),
			},
			content: {
				findUnique: async () => ({
					id: contentId,
					title: "派生動画を改名",
					description: "",
					tags: [],
					locale: "und",
					revision: 2,
					archived: false,
					updatedAt,
				}),
			},
			contentRevision: {
				findUnique: async () => ({ sourceId: mediaId }),
				findMany: async () => [],
			},
			librarySource: {
				findUnique: async () => ({
					id: mediaId,
					locales: [],
					state: "READY",
					snapshot: {
						schemaVersion: 1,
						kind: "VOD_JOB",
						name: "rebound source",
						planHash: "x",
						identity: "UNVERIFIED",
						inputs: [],
						playbackLinks: [],
						qcVerdict: null,
						qcOverriddenAt: null,
					},
				}),
			},
			contentDerivation: { findFirst: vi.fn(async () => null) },
		},
	} as unknown as ServerContext;
});
async function page(offset = 0) {
	const response = await GET(
		new Request(
			`http://localhost/api/library/edits?contentId=${contentId}&offset=${offset}`,
		),
	);
	expect(response.status).toBe(200);
	return response.json();
}
it("lists separate alternatives with the latest failure and retained successful EXPORT, without draft/storage bytes", async () => {
	const row = required(projects[0]);
	latest = [exported(row.id, "FAILED")];
	successful = [exported(row.id, "SUCCEEDED", randomUUID())];
	const result = await page();
	expect(result.total).toBe(1);
	expect(result.items[0]).toMatchObject({
		id: row.id,
		contentId,
		draftRevision: 2,
		currentRevisionId: revisionId,
		currentRevisionMatchesDraft: true,
		durationFrames: 180,
		fps: { num: 30, den: 1 },
		archived: false,
		latestExport: {
			state: "FAILED",
			generation: 4,
			matchesCurrentDraft: true,
			artifact: null,
		},
		latestSuccessfulExport: {
			state: "SUCCEEDED",
			generation: 3,
			matchesCurrentDraft: false,
			artifact: { id: required(successful[0]).artifactId },
		},
	});
	expect(result.items[0].latestSuccessfulExport.artifact.downloadUrl).toContain(
		"/download?",
	);
	expect(
		new URL(
			result.items[0].latestSuccessfulExport.artifact.url,
			"http://localhost",
		).searchParams.get("expectedOrganizationId"),
	).toBe(org);
	expect(result.items[0]).not.toHaveProperty("draft");
	expect(JSON.stringify(result)).not.toContain("storage");
	expect(result.items[0].thumbnail).toMatchObject({
		draftRevision: 2,
		width: 1080,
		height: 1920,
	});
	const thumbnailUrl = new URL(
		result.items[0].thumbnail.url,
		"http://localhost",
	);
	expect(thumbnailUrl.pathname).toBe(
		`/api/library/edits/${row.id}/thumbnail-frame`,
	);
	expect(thumbnailUrl.searchParams.get("expectedOrganizationId")).toBe(org);
	expect(thumbnailUrl.searchParams.get("draftRevision")).toBe("2");
	expect(thumbnailUrl.searchParams.get("cacheKey")).toBe(
		result.items[0].thumbnail.cacheKey,
	);
	expect(result.items[0].thumbnail.url).not.toContain("artifacts");
});
it("does not claim that an older confirmed export represents an edited draft", async () => {
	required(projects[0]).draftRevision = 3;
	required(projects[0]).draft = {
		...draft,
		clips: [
			{
				...draft.clips[0],
				durationFrames: 60,
				framing: [{ ...required(draft.clips[0]).framing[0], toFrame: 60 }],
			},
		],
	};
	expect(
		anyEditingDocumentSchema.safeParse(required(projects[0]).draft).success,
	).toBe(true);
	latest = [exported(required(projects[0]).id, "SUCCEEDED")];
	successful = latest;
	const result = await page();
	expect(result.items[0]).toMatchObject({
		currentRevisionMatchesDraft: false,
		latestSuccessfulExport: { matchesCurrentDraft: false },
	});
});
it("uses the actual composition end for a timeline containing a gap", async () => {
	const composition = toCompositionDocument(draft);
	composition.clips.push({
		...required(composition.clips[0]),
		id: randomUUID(),
		timelineStartFrame: 300,
	});
	expect(anyEditingDocumentSchema.safeParse(composition).success).toBe(true);
	projects = [project(0, composition)];
	const result = await page();
	expect(result.items[0].durationFrames).toBe(480);
});
it("keeps all alternatives paginated deterministically, including archived alternatives", async () => {
	projects = Array.from({ length: 28 }, (_, i) => project(i));
	required(projects[27]).archived = true;
	const first = await page(),
		second = await page(25);
	expect(first.total).toBe(28);
	expect(first.items).toHaveLength(25);
	expect(first.items[0]).toMatchObject({
		id: required(projects[27]).id,
		archived: true,
	});
	expect(second.items.map((x: { id: string }) => x.id)).toEqual([
		required(projects[2]).id,
		required(projects[1]).id,
		required(projects[0]).id,
	]);
});
it("keeps invalid historical drafts visible without inventing a duration or revision match", async () => {
	projects = [project(0, { invalid: "private draft marker" }), project(1)];
	const result = await page();
	expect(result.items).toHaveLength(2);
	expect(
		result.items.find((x: { id: string }) => x.id === required(projects[0]).id),
	).toMatchObject({
		durationFrames: null,
		fps: null,
		currentRevisionMatchesDraft: false,
	});
	expect(JSON.stringify(result)).not.toContain("private draft marker");
});
it("returns the durable project parent even after derived content metadata/source was revised", async () => {
	const parent = {
		contentId: randomUUID(),
		title: "元作品",
		projectId: randomUUID(),
	};
	vi.mocked(
		holder.context.prisma.contentDerivation.findFirst,
	).mockResolvedValue({
		project: {
			id: parent.projectId,
			contentId: parent.contentId,
			content: { id: parent.contentId, title: parent.title },
		},
	} as never);
	const response = await readContent(contentId);
	expect(await response.json()).toMatchObject({
		id: contentId,
		title: "派生動画を改名",
		parent,
	});
});
it("keeps an original detail readable with an explicit absent parent", async () => {
	const response = await readContent(contentId);
	expect(await response.json()).toMatchObject({ parent: null });
});
