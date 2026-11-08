import {
	compileComposition,
	compositionDocumentSchema,
	confirmCompositionFraming,
	resolveCompositionGeometry,
	suggestFixedCrop,
	toCompositionDocument,
} from "@bitovp/core";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { editingIds, editingProjectFixture } from "../editing-fixtures";
import { CompositionWorkbench } from "./composition-workbench";
import { stableManualCrop } from "./manual-crop";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: mocks.api,
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => true,
}));
vi.mock("@/lib/auth/use-session", () => ({
	useSession: () => ({
		status: "success",
		data: {
			configured: true,
			authenticated: true,
			mode: "none",
			organizationId: "00000000-0000-4000-8000-000000000001",
		},
	}),
}));
vi.mock("./composition-preview", () => ({ CompositionPreview: () => null }));
function fixture() {
	const original = editingProjectFixture(),
		draft = toCompositionDocument(original.draft),
		map = original.media.timeMap;
	if (!map) throw new Error("Missing fixture map");
	draft.presentation = {
		version: "portrait-layout-v1",
		videoFit: "FILL",
		captionPlacement: "BANDS",
	};
	return {
		...original,
		media: { ...original.media, width: 1600, height: 714 },
		draft,
		currentRevisionId: editingIds.revision,
		currentRevisionMatchesDraft: true,
		compositionSources: [
			{
				mediaVersionId: original.media.id,
				timeMap: map,
				width: 1600,
				height: 714,
				hasAudio: true,
			},
		],
	};
}
const writes = () => mocks.api.mock.calls.filter(([, init]) => init?.method);
function server(
	project: ReturnType<typeof fixture>,
	unexpectedCropChange = false,
) {
	let stored = project;
	mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
		if (!init?.method) return { media: [] };
		const input = JSON.parse(String(init.body));
		if (init.method === "PUT") {
			const document = compositionDocumentSchema.parse(input.document);
			for (const clip of document.clips)
				for (const part of clip.framing) {
					if (part.origin === "AUTO_POLICY") part.origin = "MANUAL";
					if (part.mode === "CROP") {
						// Recorded Prisma numeric-transport counterexample; ordinary JS JSON keeps the input.
						if (part.rect.w === 0.20917968750000002) part.rect.w = 0.2091796875;
						if (unexpectedCropChange) part.rect.w += 0.000000000001;
					}
				}
			stored = {
				...stored,
				draft: document,
				draftRevision: 2,
				currentRevisionMatchesDraft: false,
			};
			return stored;
		}
		if (url.endsWith("/revisions")) {
			stored = {
				...stored,
				draft: confirmCompositionFraming(stored.draft),
				draftRevision: 3,
				currentRevisionId: "88888888-8888-4888-8888-888888888888",
				currentRevisionMatchesDraft: true,
			};
			return stored;
		}
		compileComposition(stored.draft, stored.compositionSources);
		return {
			id: "99999999-9999-4999-8999-999999999999",
			revisionId: stored.currentRevisionId,
			kind: "EXPORT",
			state: "QUEUED",
			generation: 1,
			error: null,
			artifact: null,
		};
	});
	return () => stored;
}
function edit() {
	fireEvent.change(screen.getByRole("slider", { name: "Crop zoom" }), {
		target: { value: "1.2" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Captions & titles" }));
	const placement = screen.getByLabelText("Caption placement");
	fireEvent.change(placement, { target: { value: "OVERLAY" } });
	fireEvent.change(placement, { target: { value: "BANDS" } });
}
beforeEach(() => mocks.api.mockReset());
it("saves an Inspector-produced 1600x714 manual crop through the recorded numeric roundtrip and exports that exact revision", async () => {
	const project = fixture(),
		stored = server(project);
	renderWithQuery(<CompositionWorkbench project={project} />);
	edit();
	fireEvent.click(screen.getByRole("button", { name: "Generate MP4" }));
	await waitFor(() => expect(writes().length).toBeGreaterThan(0));
	const sent = JSON.parse(String(writes()[0]?.[1].body)).document;
	expect(sent.clips[0].framing[0].rect.w).toBe(0.2091796875);
	await waitFor(() =>
		expect(writes().map(([url]) => String(url).split("/").at(-1))).toEqual([
			"draft",
			"revisions",
			"renders",
		]),
	);
	expect(stored().draft.clips).toEqual(sent.clips);
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("still rejects a saved crop differing by one decimal tick before creating or exporting a revision", async () => {
	const project = fixture();
	server(project, true);
	renderWithQuery(<CompositionWorkbench project={project} />);
	edit();
	fireEvent.click(screen.getByRole("button", { name: "Generate MP4" }));
	await screen.findByRole("alert");
	expect(writes().map(([url]) => String(url).split("/").at(-1))).toEqual([
		"draft",
	]);
});

it("stores the recorded TOS crop as stable decimals while retaining its half-pixel bottom edge", () => {
	const source = { width: 1600, height: 714 };
	const original = suggestFixedCrop({
		sourceWidth: source.width,
		sourceHeight: source.height,
		targetWidth: 1080,
		targetHeight: 1920,
		centerX: 0.5,
		centerY: 0.5,
		zoom: 1.2,
	});
	const before = structuredClone(original),
		saved = stableManualCrop(original, source);
	expect(original.w).toBe(0.20917968750000002);
	expect(saved).toEqual({
		x: 0.39541015625,
		y: 0.083333333333,
		w: 0.2091796875,
		h: 0.833333333334,
	});
	const pixels = (rect: typeof original) =>
		resolveCompositionGeometry({
			sourceWidth: source.width,
			sourceHeight: source.height,
			width: 1080,
			height: 1920,
			frame: 0,
			framing: { mode: "CROP", rect },
		}).sourceRect;
	expect(pixels(original)).toEqual({ x: 633, y: 59, w: 334, h: 596 });
	expect(pixels(saved)).toEqual(pixels(original));
	expect(stableManualCrop(saved, source)).toEqual(saved);
	expect(original).toEqual(before);
});
it("preserves source pixel bounds for 1000 new manual crops including image edges and one-pixel sources", () => {
	let checked = 0;
	for (const [width, height] of [
		[1600, 714],
		[1920, 1080],
		[1080, 1920],
		[2, 1080],
		[8192, 4096],
	] as const) {
		const source = { width, height };
		for (const centerX of [0, 0.05, 0.1, 0.35, 0.5, 0.625, 0.9, 1])
			for (const centerY of [0, 0.1, 0.5, 0.9, 1])
				for (const zoom of [1, 1.2, 1.5, 2, 3]) {
					const original = suggestFixedCrop({
						sourceWidth: width,
						sourceHeight: height,
						targetWidth: 1080,
						targetHeight: 1920,
						centerX,
						centerY,
						zoom,
					});
					const saved = stableManualCrop(original, source);
					const pixels = (rect: typeof original) =>
						resolveCompositionGeometry({
							sourceWidth: width,
							sourceHeight: height,
							width: 1080,
							height: 1920,
							frame: 0,
							framing: { mode: "CROP", rect },
						}).sourceRect;
					expect(pixels(saved)).toEqual(pixels(original));
					for (const value of Object.values(saved))
						expect(Number(value.toFixed(12))).toBe(value);
					expect(stableManualCrop(saved, source)).toEqual(saved);
					checked++;
				}
	}
	expect(checked).toBe(1000);
});
