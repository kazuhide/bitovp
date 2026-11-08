import type { EditDocument } from "@bitovp/core";
import * as core from "@bitovp/core";
import { beforeEach, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";

const holder = vi.hoisted(() => ({
	context: null as unknown as ServerContext,
}));
vi.mock("./context", () => ({ getServerContext: async () => holder.context }));

import {
	confirmEditingRevision,
	saveEditingDraft,
} from "./library-editing-projects";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const map = {
	id: id(2),
	mediaVersionId: id(2),
	kind: "CFR",
	sourceStartUs: 0,
	sourceEndUs: 6000000,
	editingStartFrame: 0,
	editingEndFrame: 180,
	fps: { num: 30, den: 1 },
};
function document(sourceInUs: number): EditDocument {
	return {
		schemaVersion: 1,
		mediaVersionId: id(2),
		analysisRevisionId: null,
		locale: "und",
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		timeMapId: id(2),
		canvas: { width: 1080, height: 1920 },
		fps: { num: 30, den: 1 },
		clips: [
			{
				id: id(4),
				sourceInUs,
				durationFrames: 60,
				timelineStartFrame: 0,
				framing: [{ fromFrame: 0, toFrame: 60, mode: "FIT", origin: "MANUAL" }],
				audio: { mode: "SOURCE" },
			},
		],
	};
}
function fixtureRow() {
	return {
		id: id(1),
		contentId: id(3),
		title: "Concurrent editors",
		variant: "PORTRAIT",
		draftRevision: 1,
		draft: document(0),
		currentRevisionId: null as string | null,
		currentRevision: null as { id: string; document: EditDocument } | null,
		mediaVersion: {
			id: id(2),
			sourceId: id(3),
			state: "READY",
			error: null,
			width: 640,
			height: 360,
			durationUs: 6000000n,
			timeMap: map,
		},
		renderRuns: [],
	};
}
let row: ReturnType<typeof fixtureRow>;
let injectExternalSave: boolean;
let immutableDocument: EditDocument | undefined;
beforeEach(() => {
	immutableDocument = undefined;
	injectExternalSave = true;
	row = fixtureRow();
	const editProject = {
		findUnique: vi.fn(async () => structuredClone(row)),
		updateMany: vi.fn(
			async ({
				where,
				data,
			}: {
				where: { draftRevision: number };
				data: { draft: EditDocument };
			}) => {
				if (row.draftRevision !== where.draftRevision) return { count: 0 };
				row.draft = structuredClone(data.draft);
				row.draftRevision++;
				return { count: 1 };
			},
		),
		update: vi.fn(async ({ data }: { data: Partial<typeof row> }) => {
			Object.assign(row, data);
			return structuredClone(row);
		}),
	};
	const editRevision = {
		create: vi.fn(async ({ data }: { data: { document: EditDocument } }) => {
			immutableDocument = structuredClone(data.document);
			row.currentRevision = { id: id(6), ...structuredClone(data) };
			return { id: id(6), ...data };
		}),
	};
	const delegates = {
		editProject,
		editRevision,
		renderRun: { findFirst: vi.fn(async () => null) },
	};
	const prisma = {
		...delegates,
		$transaction: async <T>(action: (tx: typeof delegates) => Promise<T>) => {
			const result = await action(delegates);
			// A second editor wins a later CAS as soon as this transaction releases
			// its row lock. The response must still describe this request's save.
			if (injectExternalSave) {
				injectExternalSave = false;
				row.draft = document(2000000);
				row.draftRevision++;
			}
			return result;
		},
	};
	holder.context = {
		prisma,
		tenant: { organizationId: id(5) },
	} as unknown as ServerContext;
});
it("returns the revision and document actually saved by this CAS", async () => {
	const saved = await saveEditingDraft(id(1), {
		expectedRevision: 1,
		document: document(1000000),
	});
	expect(row.draftRevision).toBe(3);
	expect(saved.draftRevision).toBe(2);
	expect(saved.draft).toEqual(document(1000000));
});
it("returns an explicit 422 without saving when protected framing adoption exceeds its bound", async () => {
	const normalize = vi
		.spyOn(core, "normalizeManualSubjectProtectionEdits")
		.mockImplementationOnce(() => {
			throw new core.SubjectProtectionAdoptionError();
		});
	try {
		await expect(
			saveEditingDraft(id(1), {
				expectedRevision: 1,
				document: document(1000000),
			}),
		).rejects.toMatchObject({
			status: 422,
			code: "SUBJECT_PROTECTION_ADOPTION_LIMIT",
		});
		expect(row.draftRevision).toBe(1);
		expect(row.draft).toEqual(document(0));
	} finally {
		normalize.mockRestore();
	}
});
it("cannot confirm another editor's later draft using the save response", async () => {
	const saved = await saveEditingDraft(id(1), {
		expectedRevision: 1,
		document: document(1000000),
	});
	await expect(
		confirmEditingRevision(
			id(1),
			{ expectedRevision: saved.draftRevision, confirmSuggestions: false },
			"fixture",
		),
	).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
	expect(immutableDocument).toBeUndefined();
});
it("returns the confirmed version even if another editor immediately saves again", async () => {
	const confirmed = await confirmEditingRevision(
		id(1),
		{ expectedRevision: 1, confirmSuggestions: false },
		"fixture",
	);
	expect(confirmed.draftRevision).toBe(2);
	expect(confirmed.draft).toEqual(document(0));
	expect(confirmed.currentRevisionMatchesDraft).toBe(true);
	expect(row.draftRevision).toBe(3);
	expect(immutableDocument).toEqual(document(0));
});
