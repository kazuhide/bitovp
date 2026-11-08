import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import { initialEditingDocument } from "./library-editing-common";
import { readEditingProject } from "./library-editing-projects";

const holder = vi.hoisted(() => ({
	context: null as unknown as ServerContext,
}));
vi.mock("./context", () => ({ getServerContext: async () => holder.context }));

const id = randomUUID();
const mediaId = randomUUID();
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
function run(kind: "EXPORT" | "PREVIEW", state = "QUEUED", generation = 0) {
	return {
		id: randomUUID(),
		projectId: id,
		revisionId: id,
		requestKey: randomUUID(),
		generation,
		state,
		profile: { kind },
		error: null,
		revision: { document: draft },
		artifact:
			state === "SUCCEEDED"
				? { id: randomUUID(), activeDerivations: [] }
				: null,
	};
}
const latest = vi.fn();
let recent = Array.from({ length: 25 }, () => run("PREVIEW"));
beforeEach(() => {
	recent = Array.from({ length: 25 }, () => run("PREVIEW"));
	latest.mockReset();
	holder.context = {
		tenant: { organizationId: id },
		prisma: {
			editProject: {
				findUnique: async () => ({
					id,
					contentId: id,
					title: "Portrait",
					variant: "PORTRAIT",
					draftRevision: 1,
					draft,
					currentRevisionId: id,
					currentRevision: { document: draft },
					renderRuns: recent,
					mediaVersion: {
						id: mediaId,
						sourceId: id,
						state: "READY",
						error: null,
						durationUs: 6_000_000n,
						width: 640,
						height: 360,
						timeMap: map,
					},
				}),
			},
			renderRun: { findFirst: latest },
		},
	} as unknown as ServerContext;
});
describe("latest export outside bounded mixed history", () => {
	it.each([
		"QUEUED",
		"RENDERING",
		"SUCCEEDED",
	])("keeps the highest %s export after 25 newer previews", async (state) => {
		const authoritative = run("EXPORT", state, 8);
		latest.mockResolvedValue(authoritative);
		const project = await readEditingProject(id);
		expect(
			project.renders.find((entry) => entry.id === authoritative.id),
		).toMatchObject({ kind: "EXPORT", generation: 8, state });
		expect(
			project.renders.filter((entry) => entry.kind === "PREVIEW"),
		).toHaveLength(25);
		expect(project.renders).toHaveLength(26);
		if (state === "SUCCEEDED")
			expect(
				project.renders.find((entry) => entry.id === authoritative.id)?.artifact
					?.downloadUrl,
			).toContain("/download?");
	});
	it("does not duplicate the export if it is already in recent history", async () => {
		recent[0] = run("EXPORT", "SUCCEEDED", 8);
		latest.mockResolvedValue(recent[0]);
		const project = await readEditingProject(id);
		expect(project.renders).toHaveLength(25);
	});
});
