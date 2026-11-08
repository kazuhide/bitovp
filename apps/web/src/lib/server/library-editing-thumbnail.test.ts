import { randomUUID } from "node:crypto";
import {
	type AnyEditDocument,
	hashEditingEvidence,
	toCompositionDocument,
} from "@bitovp/core";
import { beforeEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/library/edits/[id]/thumbnail-frame/route";
import { passiveRequestPath } from "@/lib/passive-request";
import { enableClipEditingForTests } from "@/test/clip-editing-env";
import type { ServerContext } from "./context";
import { initialEditingDocument } from "./library-editing-common";
import {
	editingThumbnailReference,
	readEditingThumbnailFrame,
} from "./library-editing-thumbnail";

enableClipEditingForTests();

const holder = vi.hoisted(() => ({
	context: null as unknown as ServerContext,
}));
vi.mock("./context", () => ({ getServerContext: async () => holder.context }));

const org = randomUUID(),
	projectId = randomUUID(),
	mediaId = randomUUID();
const map = {
	id: randomUUID(),
	mediaVersionId: mediaId,
	kind: "CFR" as const,
	sourceStartUs: 20_000_000,
	sourceEndUs: 30_000_000,
	editingStartFrame: 0,
	editingEndFrame: 300,
	fps: { num: 30 as const, den: 1 as const },
};
const media = {
	id: mediaId,
	sourceId: randomUUID(),
	state: "READY",
	sha256: "a".repeat(64),
	width: 1920,
	height: 1080,
	timeMap: map,
	probe: { streams: [{ codec_type: "video" }] },
};
function required<T>(value: T | null | undefined): T {
	if (value === null || value === undefined)
		throw new Error("Missing fixture value");
	return value;
}
function fixture(): {
	id: string;
	draftRevision: number;
	draft: AnyEditDocument;
	mediaVersion: typeof media;
} {
	const draft = initialEditingDocument(
		{ id: mediaId, timeMap: map },
		"PORTRAIT",
	);
	const clip = required(draft.clips[0]);
	clip.sourceInUs = 22_000_000;
	clip.durationFrames = 60;
	clip.framing = [
		{
			fromFrame: 0,
			toFrame: 60,
			mode: "CROP",
			origin: "MANUAL",
			rect: { x: 0.25, y: 0, w: 0.5, h: 1 },
		},
	];
	return { id: projectId, draftRevision: 4, draft, mediaVersion: media };
}
let row: ReturnType<typeof fixture>;
let lookup: ReturnType<typeof vi.fn>;
beforeEach(() => {
	row = fixture();
	lookup = vi.fn(async () => row);
	const prisma = {
		editProject: { findUnique: lookup },
		libraryMediaVersion: { findMany: vi.fn(async () => []) },
		libraryImageAsset: { findMany: vi.fn(async () => []) },
		sceneAnalysisRevision: { findFirst: vi.fn(async () => null) },
	};
	holder.context = {
		tenant: { organizationId: org },
		prisma: {
			...prisma,
			$transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
		},
	} as unknown as ServerContext;
});
function request() {
	const reference = editingThumbnailReference(
		holder.context,
		row.id,
		row.draftRevision,
		row.draft,
	);
	return new Request(`http://localhost${reference.url}`);
}
it("rejects a still captured before Japanese line-break handling even when the draft itself is unchanged", async () => {
	const old = new URL(request().url);
	old.searchParams.set(
		"cacheKey",
		hashEditingEvidence({
			version: "editing-thumbnail-v3-shared-caption-rows",
			id: row.id,
			draftRevision: row.draftRevision,
			draft: row.draft,
		}),
	);
	await expect(
		readEditingThumbnailFrame(new Request(old), projectId),
	).rejects.toMatchObject({ status: 409, message: "EDIT_THUMBNAIL_CHANGED" });
});
it("uses the edited first clip, one-second representative point and normalized media clock for legacy drafts", async () => {
	const result = await readEditingThumbnailFrame(request(), projectId);
	expect(result.draftRevision).toBe(4);
	expect(result.frame?.frame).toBe(29);
	expect(result.frame?.layers).toHaveLength(1);
	expect(result.frame?.layers[0]?.sourceSeconds).toBeCloseTo(2 + 29 / 30);
	expect(result.frame?.layers[0]?.mode).toBe("CROP");
	expect(result.frame?.layers[0]?.sourceRect.x).toBe(480);
	expect(result.video?.url).toBe(
		`/api/library/media-versions/${mediaId}/media?expectedOrganizationId=${org}`,
	);
	expect(
		passiveRequestPath(
			new URL(required(result.video).url, "http://localhost").pathname,
			"GET",
		),
	).toBe(true);
	expect(result.frame?.audio).toEqual([]);
	expect(
		Math.max(
			required(result.frame).canvas.width,
			required(result.frame).canvas.height,
		),
	).toBe(192);
	expect(JSON.stringify(result)).not.toMatch(
		/storage|quotes|analysisDocument|sourceStartUs/,
	);
});
it("binds the descriptor to the requested draft bytes and refuses a newer draft", async () => {
	const before = request();
	row.draftRevision++;
	await expect(
		readEditingThumbnailFrame(before, projectId),
	).rejects.toMatchObject({
		status: 409,
		code: "EDIT_THUMBNAIL_CHANGED",
	});
});
it.each([
	{ width: 1920, height: 1080 },
	{ width: 1080, height: 1920 },
	{ width: 1080, height: 1080 },
	{ width: 1080, height: 1350 },
])("keeps exact canvas aspect and a bounded still for $width × $height", async (canvas) => {
	const draft = toCompositionDocument(row.draft);
	draft.canvas = canvas;
	row.draft = draft;
	const result = await readEditingThumbnailFrame(request(), projectId);
	const output = required(result.frame).canvas;
	expect(output.width * canvas.height).toBe(output.height * canvas.width);
	expect(Math.max(output.width, output.height)).toBeLessThanOrEqual(192);
	expect(Math.min(output.width, output.height)).toBeGreaterThanOrEqual(2);
	if (canvas.height === 1350)
		expect(output).toEqual({ width: 152, height: 190 });
});
it("keeps FIT blur and the visible translated caption, without leaking its source text or receipt", async () => {
	const draft = toCompositionDocument(row.draft);
	draft.presentation = {
		version: "portrait-layout-v1",
		videoFit: "AUTO",
		captionPlacement: "OVERLAY",
		fallbackFraming: "PRESERVE_SOURCE_V1",
	};
	draft.captionDisplayLanguage = "ja";
	draft.captions = [
		{
			id: randomUUID(),
			fromFrame: 0,
			toFrame: 60,
			text: "Original private caption",
			translation: {
				targetLanguage: "ja",
				text: "表示する字幕",
				sourceText: "Original private caption",
				sourceTextHash: "a".repeat(64),
				origin: "LOCAL_LLM",
				evidenceHash: "b".repeat(64),
			},
		},
	];
	row.draft = draft;
	const result = await readEditingThumbnailFrame(request(), projectId);
	expect(result.frame?.layers[0]?.mode).toBe("FIT");
	expect(result.frame?.layers[0]?.backdrop?.kind).toBe("BLUR");
	expect(result.frame?.captions[0]?.text).toBe("表示する字幕");
	expect(JSON.stringify(result)).not.toMatch(
		/Original private caption|sourceText|evidenceHash|translation|translated|staleTranslation/,
	);
});
it("does not accept changed draft bytes under the same revision or another organization", async () => {
	const before = request();
	row.draft.canvas = { width: 1920, height: 1080 };
	await expect(
		readEditingThumbnailFrame(before, projectId),
	).rejects.toMatchObject({ status: 409 });
	const url = new URL(request().url);
	url.searchParams.set("expectedOrganizationId", randomUUID());
	lookup.mockClear();
	await expect(
		readEditingThumbnailFrame(new Request(url), projectId),
	).rejects.toMatchObject({
		status: 409,
		code: "MEDIA_ORGANIZATION_CHANGED",
	});
	expect(lookup).not.toHaveBeenCalled();
});
it("returns a quiet unavailable descriptor for a multi-video composition instead of one wrong layer", async () => {
	const draft = toCompositionDocument(row.draft);
	draft.clips.push({ ...required(draft.clips[0]), id: randomUUID() });
	// Two overlapping clips on separate video tracks are a supported complex composition.
	draft.videoTracks = [
		{ id: "v0", name: "Main", order: 0 },
		{ id: "v1", name: "Other", order: 1 },
	];
	required(draft.clips[0]).trackId = "v0";
	required(draft.clips[1]).trackId = "v1";
	row.draft = draft;
	const result = await readEditingThumbnailFrame(request(), projectId);
	expect(result.frame).toBeNull();
	expect(result.video).toBeNull();
	expect(result.images).toEqual([]);
});
it("rejects unknown query fields, malformed revision and foreign project rows without a descriptor", async () => {
	const invalid = new URL(request().url);
	invalid.searchParams.set("time", "100");
	await expect(
		readEditingThumbnailFrame(new Request(invalid), projectId),
	).rejects.toMatchObject({ status: 400 });
	invalid.searchParams.delete("time");
	invalid.searchParams.set("draftRevision", "-1");
	await expect(
		readEditingThumbnailFrame(new Request(invalid), projectId),
	).rejects.toMatchObject({ status: 400 });
	lookup.mockResolvedValueOnce(null);
	await expect(
		readEditingThumbnailFrame(request(), projectId),
	).rejects.toMatchObject({ status: 404 });
});
it("serves only private non-cacheable read-only descriptors and rejects an invalid resource ID", async () => {
	const response = await GET(request(), {
		params: Promise.resolve({ id: projectId }),
	});
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("private, no-store");
	expect((await response.json()).frame.layers).toHaveLength(1);
	lookup.mockClear();
	const invalid = await GET(request(), {
		params: Promise.resolve({ id: "not-an-id" }),
	});
	expect(invalid.status).toBe(400);
	expect(lookup).not.toHaveBeenCalled();
});
