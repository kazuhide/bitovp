import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	available: false,
	player: vi.fn(async () => ({ provider: "native" })),
}));
vi.mock("@/lib/server/library-editing-feature", () => ({
	isClipEditingAvailable: async () => state.available,
}));
vi.mock("@/lib/server/player-config", () => ({
	readPlayerClientConfig: state.player,
}));
vi.mock("@/lib/i18n/metadata", () => ({
	localizedTitle: () => vi.fn(),
}));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("CLIP_EDITING_NOT_FOUND");
	},
}));
vi.mock("./library-client", () => ({ LibraryClient: () => null }));
vi.mock("./[id]/content-detail", () => ({ ContentDetailClient: () => null }));
vi.mock("./[id]/edits/editing-library", () => ({
	EditingLibraryClient: () => null,
}));
vi.mock("./edits/[id]/editor-router", () => ({ EditorRouter: () => null }));
vi.mock("./edits/[id]/editor-client", () => ({ EditorClient: () => null }));
vi.mock("./generations/[id]/generation-progress", () => ({
	GenerationProgress: () => null,
}));
vi.mock("./edits/[id]/result/portrait-result", () => ({
	PortraitResult: () => null,
}));

import EditingLibraryPage from "./[id]/edits/page";
import ContentDetailPage from "./[id]/page";
import { EditorClient } from "./edits/[id]/editor-client";
import { EditorRouter } from "./edits/[id]/editor-router";
import EditingPage from "./edits/[id]/page";
import PortraitResultPage from "./edits/[id]/result/page";
import GenerationPage from "./generations/[id]/page";
import LibraryPage from "./page";

beforeEach(() => {
	state.available = false;
	state.player.mockClear();
});

it("passes only request-time availability to original browse and detail pages", async () => {
	for (const available of [false, true, false]) {
		state.available = available;
		const browse = await LibraryPage({ searchParams: Promise.resolve({}) });
		expect(browse.props.clipEditingAvailable).toBe(available);
		const detail = await ContentDetailPage({
			params: Promise.resolve({ id: "source" }),
			searchParams: Promise.resolve({}),
		});
		expect(detail.props).toMatchObject({
			id: "source",
			player: { provider: "native" },
			clipEditingAvailable: available,
		});
	}
	expect(state.player).toHaveBeenCalledTimes(3);
});

it("keeps the editor URL as read-only history when GPU availability is lost", async () => {
	for (const available of [false, true, false]) {
		state.available = available;
		const view = await EditingPage({
			params: Promise.resolve({ id: "project" }),
		});
		expect(view.props.id).toBe("project");
		if (available) expect(view.type).toBe(EditorRouter);
		else {
			expect(view.type).toBe(EditorClient);
			expect(view.props.historyOnly).toBe(true);
		}
	}
});

it.each([
	["existing projects", EditingLibraryPage],
	["generation progress and cancellation", GenerationPage],
	["existing editing result", PortraitResultPage],
] as const)("keeps %s visible while disabling new GPU work", async (_name, page) => {
	const view = await page({ params: Promise.resolve({ id: "project" }) });
	expect(view.props.id ?? view.props.contentId).toBe("project");
	expect(view.props.clipEditingAvailable).toBe(false);
});
