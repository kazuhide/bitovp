import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

const { apiFetch, access, preview, readRecording } = vi.hoisted(() => ({
	apiFetch: vi.fn(),
	access: { allowed: true },
	preview: vi.fn(),
	readRecording: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => access.allowed,
}));
vi.mock("@/lib/auth/use-session", () => ({
	useSession: () => ({
		status: "success",
		data: {
			configured: true,
			authenticated: true,
			mode: "users",
			organizationId: "00000000-0000-4000-8000-000000000001",
		},
	}),
}));
vi.mock("@/lib/aisa-live/recording-timeline", () => ({
	readAisaRecordingTimeline: readRecording,
}));
vi.mock("./aisa-live-player-thumbnail", () => ({
	requestAisaThumbnail: vi.fn().mockResolvedValue(null),
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
function selectedMoment(id = "moment-one") {
	const region = document.querySelector<HTMLElement>(
		`[data-aisa-selected-moment="${id}"]`,
	);
	if (!region) throw new Error(`Selected moment ${id} is absent`);
	return within(region);
}
async function selectMoment(id = "moment-one") {
	const marker = await waitFor(() => {
		const node = document.querySelector<HTMLButtonElement>(
			`button[data-aisa-timeline-moment="${id}"]`,
		);
		if (!node) throw new Error(`Moment marker ${id} is absent`);
		expect(node).toHaveAttribute("data-playable", "true");
		return node;
	});
	await userEvent.setup().click(marker);
	expect(marker).toHaveAttribute("aria-pressed", "true");
	expect(screen.getAllByTestId("moment-preview")).toHaveLength(1);
	return selectedMoment(id);
}
beforeEach(() => {
	apiFetch.mockReset();
	preview.mockClear();
	readRecording.mockReset().mockResolvedValue({
		endList: true,
		fragments: [
			{
				start: 0,
				duration: 20,
				programDateTime: snapshot.mediaTimeOriginUnixMs,
			},
		],
	});
	access.allowed = true;
	respond();
});

describe("AISA results in a normal channel", () => {
	it("embeds under the channel heading with one collapsed analysis disclosure", async () => {
		const user = userEvent.setup();
		const rendered = renderWithQuery(
			<section id="sec-analysis">
				<h3>Key moments</h3>
				<AisaChannelAnalysisPanel
					accountId={accountId}
					analysisId={analysisId}
					encodingId={encodingId}
					embedded
				/>
			</section>,
		);
		await selectMoment();
		await selectedMoment().findByText(original);
		expect(rendered.container.querySelectorAll("#sec-analysis")).toHaveLength(
			1,
		);
		expect(
			screen.getAllByRole("heading", { name: "Key moments" }),
		).toHaveLength(1);
		expect(screen.queryByText("AISA Live Preview")).not.toBeInTheDocument();
		expect(
			screen.queryByText("Play detected moments from the recording."),
		).not.toBeInTheDocument();
		expect(screen.queryByText("Powered by AISA Live")).not.toBeInTheDocument();
		expect(screen.queryByText("Synthetic fixture")).not.toBeInTheDocument();
		expect(screen.getByText("Final result")).toBeVisible();
		const panel = rendered.container.querySelector("#sec-analysis > section");
		expect(panel).not.toHaveClass("border", "p-4", "sm:p-6");
		const disclosure = rendered.container.querySelector("details");
		expect(rendered.container.querySelectorAll("details")).toHaveLength(1);
		expect(disclosure).not.toHaveAttribute("open");
		expect(screen.getByText(analysisId).closest("details")).toBe(disclosure);
		expect(screen.getByText("Snapshot 1").closest("details")).toBe(disclosure);
		expect(screen.getByText("Analyzed: 0–20 s").closest("details")).toBe(
			disclosure,
		);
		await user.click(screen.getByRole("button", { name: "Japanese" }));
		await selectedMoment().findByText(japanese);
		expect(
			screen.getByText("Local model: installed-local-model").closest("details"),
		).toBe(disclosure);
		expect(
			screen.queryByText(/Japanese descriptions are local translations/),
		).not.toBeInTheDocument();
		await user.click(
			screen.getByText("Analysis details", { selector: "summary" }),
		);
		expect(disclosure).toHaveAttribute("open");
		expect(screen.getByText(analysisId)).toBeVisible();
	});

	it("switches a source-matched local translation and passes the actual moment range to playback", async () => {
		const user = userEvent.setup();
		renderWithQuery(
			<AisaChannelAnalysisPanel
				accountId={accountId}
				analysisId={analysisId}
				encodingId={encodingId}
			/>,
		);
		await selectMoment();
		await selectedMoment().findByText(original);
		expect(document.getElementById("sec-analysis")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Key moments" })).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Japanese" }));
		expect(await selectedMoment().findByText(japanese)).toHaveAttribute(
			"lang",
			"ja",
		);
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
		expect(selectedMoment().getByText(original)).toHaveAttribute("lang", "en");
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
		await selectMoment();
		expect(await selectedMoment().findByText(original)).toBeInTheDocument();
		await selectedMoment().findByText("未翻訳のため原文を表示しています。");
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
		await selectMoment();
		await selectedMoment().findByText(japanese);
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

const laterSnapshot = {
	...snapshot,
	sequence: 2,
	producedAt: "2026-11-07T00:00:01Z",
	observations: [
		...snapshot.observations,
		{
			id: "obs-two",
			text: "The final point ends the match.",
			startTimeSeconds: 10,
			endTimeSeconds: 12,
		},
	],
	keyMoments: [
		...snapshot.keyMoments,
		{
			...snapshot.keyMoments[0],
			id: "moment-two",
			lastUpdatedSequence: 2,
			startInSeconds: 10,
			endInSeconds: 12,
			anchorInSeconds: 11,
			observations: ["obs-two"],
		},
	],
};

function renderCachedPanel(initialSnapshot: unknown, cached: unknown) {
	const rendered = renderWithQuery(<div />);
	rendered.client.setDefaultOptions({
		queries: { retry: false, staleTime: 15_000, refetchOnWindowFocus: false },
	});
	rendered.client.setQueryData(
		["aisa-live-results", accountId, analysisId, encodingId],
		cached,
	);
	rendered.rerender(
		<AisaChannelAnalysisPanel
			accountId={accountId}
			analysisId={analysisId}
			encodingId={encodingId}
			initialSnapshot={initialSnapshot}
		/>,
	);
	return rendered;
}

it.each([
	"older",
	"pending",
] as const)("keeps the known DB final result ahead of fresh %s query cache on re-entry", async (kind) => {
	const cached =
		kind === "pending"
			? { availability: "pending" }
			: {
					availability: "available",
					snapshot: { ...snapshot, isFinal: false },
				};
	renderCachedPanel(laterSnapshot, cached);
	await selectMoment("moment-two");
	expect(
		await selectedMoment("moment-two").findByText(
			"The final point ends the match.",
		),
	).toBeInTheDocument();
	expect(screen.getByText("Final result")).toBeInTheDocument();
	expect(screen.getByText("Snapshot 2")).toBeInTheDocument();
	expect(apiFetch.mock.calls.some(([url]) => url.includes("/results?"))).toBe(
		false,
	);
});

it("adopts a newer valid DB snapshot prop while retaining the same mounted run", async () => {
	const rendered = renderCachedPanel(
		{ ...snapshot, isFinal: false },
		{ availability: "available", snapshot: { ...snapshot, isFinal: false } },
	);
	await selectMoment();
	await selectedMoment().findByText(original);
	rendered.rerender(
		<AisaChannelAnalysisPanel
			accountId={accountId}
			analysisId={analysisId}
			encodingId={encodingId}
			initialSnapshot={laterSnapshot}
		/>,
	);
	await selectMoment("moment-two");
	expect(
		await selectedMoment("moment-two").findByText(
			"The final point ends the match.",
		),
	).toBeInTheDocument();
	expect(screen.getByText("Final result")).toBeInTheDocument();
	expect(preview).toHaveBeenLastCalledWith(
		expect.objectContaining({
			moment: expect.objectContaining({
				id: "moment-two",
				startInSeconds: 10,
				endInSeconds: 12,
				anchorInSeconds: 11,
			}),
		}),
	);
});

it("retains the accepted source and warns when a cached same-sequence update changes it", async () => {
	const invalid = {
		...snapshot,
		observations: [
			{ ...snapshot.observations[0], text: "A mutated cached observation." },
		],
	};
	renderCachedPanel(snapshot, { availability: "available", snapshot: invalid });
	await selectMoment();
	expect(await selectedMoment().findByText(original)).toBeInTheDocument();
	expect(
		await screen.findByText(/last valid result is shown/),
	).toBeInTheDocument();
	expect(
		screen.queryByText("A mutated cached observation."),
	).not.toBeInTheDocument();
});

it("withdraws removed sources and refuses their reuse through the controlled channel view", async () => {
	const first = { ...snapshot, isFinal: false };
	const rendered = renderCachedPanel(first, {
		availability: "available",
		snapshot: first,
	});
	await selectMoment();
	await selectedMoment().findByText(original);
	act(() =>
		rendered.client.setQueryData(
			["aisa-live-results", accountId, analysisId, encodingId],
			{
				availability: "available",
				snapshot: { ...first, sequence: 2, observations: [], keyMoments: [] },
			},
		),
	);
	await screen.findByText(/No key moments in this result/);
	expect(screen.queryByText(original)).not.toBeInTheDocument();
	expect(document.querySelector("[data-aisa-selected-moment]")).toBeNull();
	expect(document.querySelector("[data-aisa-timeline-moment]")).toBeNull();
	expect(screen.queryByTestId("moment-preview")).not.toBeInTheDocument();
	act(() =>
		rendered.client.setQueryData(
			["aisa-live-results", accountId, analysisId, encodingId],
			{
				availability: "available",
				snapshot: {
					...first,
					sequence: 3,
					keyMoments: first.keyMoments.map((moment) => ({
						...moment,
						lastUpdatedSequence: 3,
					})),
				},
			},
		),
	);
	await screen.findByText(/last valid result is shown/);
	expect(screen.queryByText(original)).not.toBeInTheDocument();
	expect(document.querySelector("[data-aisa-selected-moment]")).toBeNull();
	expect(screen.queryByTestId("moment-preview")).not.toBeInTheDocument();
});

it("keeps English available and does not retry automatically after local inference fails", async () => {
	const user = userEvent.setup();
	apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
		if (url.includes("/translations")) {
			if (init?.method === "POST") throw new Error("local model unavailable");
			return response([]);
		}
		if (url.includes("/results?"))
			return { availability: "available", snapshot };
		return { analysisId, encodingId, status: "FINISHED" };
	});
	renderWithQuery(
		<AisaChannelAnalysisPanel
			accountId={accountId}
			analysisId={analysisId}
			encodingId={encodingId}
			embedded
		/>,
		"ja",
	);
	await selectMoment();
	await screen.findByText("翻訳を完了できませんでした。原文は確認できます。");
	expect(selectedMoment().getByText(original)).toHaveAttribute("lang", "en");
	expect(
		apiFetch.mock.calls.filter(([, init]) => init?.method === "POST"),
	).toHaveLength(1);
	const failure = screen.getByText(
		"翻訳を完了できませんでした。原文は確認できます。",
	);
	expect(failure).toBeVisible();
	expect(failure.closest("details")).toBeNull();
	const retry = screen.getByRole("button", { name: "未翻訳の説明を翻訳" });
	expect(retry).toBeVisible();
	expect(retry.closest("details")).toBeNull();
	await user.click(retry);
	await waitFor(() =>
		expect(
			apiFetch.mock.calls.filter(([, init]) => init?.method === "POST"),
		).toHaveLength(2),
	);
});
