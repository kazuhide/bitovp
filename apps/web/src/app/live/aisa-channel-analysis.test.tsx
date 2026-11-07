import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

const { apiFetch, access, preview } = vi.hoisted(() => ({
	apiFetch: vi.fn(),
	access: { allowed: true },
	preview: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => access.allowed,
}));
vi.mock("./aisa-live-player", () => ({
	AisaMomentPreview: (props: unknown) => {
		preview(props);
		return <div data-testid="moment-preview" />;
	},
}));

import { AisaChannelAnalysisPanel } from "./aisa-channel-analysis";

const accountId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const analysisId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const encodingId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const original = "A player scores a goal.";
const japanese = "選手がゴールを決めた。";
const snapshot = {
	analysisId,
	encodingId,
	sequence: 1,
	producedAt: "2026-11-07T00:00:00Z",
	mediaTimeOriginUnixMs: 1794009600000,
	isFinal: true,
	analyzedStartTimeSeconds: 0,
	analyzedEndTimeSeconds: 20,
	metadata: { version: "synthetic", disclaimer: "Synthetic fixture" },
	sourceGaps: [],
	observations: [
		{ id: "obs-one", text: original, startTimeSeconds: 0, endTimeSeconds: 10 },
	],
	keyMoments: [
		{
			id: "moment-one",
			lastUpdatedSequence: 1,
			importanceLevel: 1,
			startInSeconds: 2,
			endInSeconds: 8,
			anchorInSeconds: 4,
			observations: ["obs-one"],
			categories: ["soccer"],
		},
	],
};
const translated = {
	observationId: "obs-one",
	sourceText: original,
	sourceTextHash: "a".repeat(64),
	text: japanese,
	targetLanguage: "ja",
	sourceSequence: 1,
	createdAt: "2026-11-07T00:00:00Z",
	origin: "LOCAL_MODEL",
	provider: "LOCAL_OPENAI_COMPATIBLE",
	model: "installed-local-model",
	promptVersion: "aisa-observation-ja-v1",
};
const response = (entries: unknown[] = [translated]) => ({
	analysisId,
	encodingId,
	targetLanguage: "ja",
	automatic: {
		available: true,
		provider: "LOCAL_OPENAI_COMPATIBLE",
		model: "installed-local-model",
	},
	translations: entries,
});
function respond(entries: unknown[] = [translated]) {
	apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
		if (url.includes("/translations"))
			return response(init?.method === "POST" ? [translated] : entries);
		if (url.includes("/results?"))
			return { availability: "available", snapshot };
		return { analysisId, encodingId, status: "FINISHED" };
	});
}
beforeEach(() => {
	apiFetch.mockReset();
	preview.mockClear();
	access.allowed = true;
	respond();
});

describe("AISA results in a normal channel", () => {
	it("switches a source-matched local translation and passes the actual moment range to playback", async () => {
		const user = userEvent.setup();
		renderWithQuery(
			<AisaChannelAnalysisPanel
				accountId={accountId}
				analysisId={analysisId}
				encodingId={encodingId}
			/>,
		);
		await screen.findByText(original);
		await user.click(screen.getByRole("button", { name: "Japanese" }));
		expect(await screen.findByText(japanese)).toHaveAttribute("lang", "ja");
		expect(
			screen.getByText("Local model: installed-local-model"),
		).toBeInTheDocument();
		expect(preview).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId,
				analysisId,
				encodingId,
				mediaTimeOriginUnixMs: snapshot.mediaTimeOriginUnixMs,
				moment: expect.objectContaining({
					startInSeconds: 2,
					endInSeconds: 8,
					anchorInSeconds: 4,
				}),
			}),
		);
		await user.click(
			screen.getByRole("button", { name: "Original (English)" }),
		);
		expect(screen.getByText(original)).toHaveAttribute("lang", "en");
		expect(
			apiFetch.mock.calls.filter(([, init]) => init?.method === "POST"),
		).toHaveLength(0);
	});
	it("keeps stale translations out and never runs inference for a viewer", async () => {
		access.allowed = false;
		respond([{ ...translated, sourceText: "An earlier observation." }]);
		renderWithQuery(
			<AisaChannelAnalysisPanel
				accountId={accountId}
				analysisId={analysisId}
				encodingId={encodingId}
			/>,
			"ja",
		);
		expect(await screen.findByText(original)).toBeInTheDocument();
		await screen.findByText("未翻訳のため原文を表示しています。");
		expect(screen.queryByText(japanese)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "未翻訳の説明を翻訳" }),
		).not.toBeInTheDocument();
		expect(
			apiFetch.mock.calls.filter(([, init]) => init?.method === "POST"),
		).toHaveLength(0);
	});
	it("automatically translates missing moment observations once for an operator", async () => {
		respond([]);
		renderWithQuery(
			<AisaChannelAnalysisPanel
				accountId={accountId}
				analysisId={analysisId}
				encodingId={encodingId}
			/>,
			"ja",
		);
		await screen.findByText(japanese);
		await waitFor(() =>
			expect(
				apiFetch.mock.calls.filter(([, init]) => init?.method === "POST"),
			).toHaveLength(1),
		);
		const [url, init] =
			apiFetch.mock.calls.find(([, init]) => init?.method === "POST") ?? [];
		expect(url).toBe(`/api/live/analyses/${analysisId}/translations`);
		expect(JSON.parse(init.body)).toEqual({
			bitmovinAccountId: accountId,
			encodingId,
			action: "translate",
			observationIds: ["obs-one"],
		});
	});
});
