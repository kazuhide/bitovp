import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

const { apiFetch, navigate, access } = vi.hoisted(() => ({
	apiFetch: vi.fn(),
	navigate: vi.fn(),
	access: { allowed: true },
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: navigate }) }));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => access.allowed,
	RoleAccess: ({ children }: { children: React.ReactNode }) =>
		access.allowed ? children : null,
}));

import { AisaLiveCreate } from "./aisa-live-create";
import { AisaLiveDetail } from "./aisa-live-detail";
import { AisaLiveList } from "./aisa-live-list";

const accountId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const analysisId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const encodingId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const outputId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const resource = {
	analysisId,
	encodingId,
	name: "Court one",
	status: "CREATED",
};
const snapshot = {
	analysisId,
	encodingId,
	sequence: 1,
	producedAt: "2026-11-07T00:00:00Z",
	mediaTimeOriginUnixMs: 1794009600000,
	isFinal: false,
	analyzedStartTimeSeconds: 0,
	analyzedEndTimeSeconds: 20,
	metadata: { version: "synthetic", disclaimer: "Synthetic fixture" },
	sourceGaps: [],
	observations: [
		{
			id: "obs-one",
			text: "A player wins the point.",
			startTimeSeconds: 0,
			endTimeSeconds: 10,
		},
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
			categories: ["future/new-sport"],
		},
	],
};

function respond() {
	apiFetch.mockImplementation(async (input: string, init?: RequestInit) => {
		if (input === "/api/bitmovin-accounts")
			return [{ id: accountId, label: "Preview account" }];
		if (input.endsWith("/actions")) return { ...resource, status: "QUEUED" };
		if (input.includes("/ingest?")) return {};
		if (input.includes("/results?")) return { availability: "pending" };
		if (input === "/api/live/analyses" && init?.method === "POST")
			return resource;
		if (input.includes("/api/live/analyses?"))
			return { items: [resource], totalCount: 1 };
		if (input.includes(`/api/live/analyses/${analysisId}?`)) return resource;
		throw new Error(`Unexpected request: ${input}`);
	});
}

beforeEach(() => {
	access.allowed = true;
	respond();
});
afterEach(() => {
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("AISA Live Preview UI", () => {
	it("creates once, keeps start separate, and explains the supported sports", async () => {
		const user = userEvent.setup();
		renderWithQuery(<AisaLiveCreate />);
		expect(
			screen.getByText(/soccer.*tennis.*American football/i),
		).toBeInTheDocument();
		await screen.findByRole("option", { name: "Preview account" });
		await user.type(screen.getByLabelText("Analysis name"), "Court one");
		await user.type(screen.getByLabelText("Encoding Output ID"), outputId);
		await user.type(screen.getByLabelText("Stream key"), "synthetickey");
		await user.click(screen.getByRole("button", { name: "Create analysis" }));
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith(
				`/live/analyses/${analysisId}?bitmovinAccountId=${accountId}`,
			),
		);
		const writes = apiFetch.mock.calls.filter(
			([, init]) => init?.method === "POST",
		);
		expect(writes).toHaveLength(1);
		const body = JSON.parse(String(writes[0]?.[1]?.body));
		expect(body.analysis.input).toEqual({
			type: "RTMP",
			streamKey: "synthetickey",
		});
		expect(body.analysis).not.toHaveProperty("encoderVersion");
		expect(body.analysis.recording.outputs[0].outputId).toBe(outputId);
	});

	it("does not offer create or ingest to a viewer", async () => {
		access.allowed = false;
		renderWithQuery(
			<AisaLiveDetail accountId={accountId} analysisId={analysisId} />,
		);
		await screen.findByText("Court one");
		expect(
			screen.queryByRole("button", { name: "Start analysis" }),
		).not.toBeInTheDocument();
		expect(
			apiFetch.mock.calls.some(([input]) => input.includes("/ingest?")),
		).toBe(false);
	});

	it("shows pending results without implying that key moments have been detected", async () => {
		renderWithQuery(
			<AisaLiveDetail accountId={accountId} analysisId={analysisId} />,
		);
		expect(
			await screen.findByText("Waiting for analysis results."),
		).toBeInTheDocument();
		expect(
			screen.getByText(/soccer.*tennis.*American football/i),
		).toBeInTheDocument();
	});

	it("keeps the last valid snapshot when a later result changes identity", async () => {
		let result = snapshot;
		const base = apiFetch.getMockImplementation();
		apiFetch.mockImplementation(async (input: string, init?: RequestInit) =>
			input.includes("/results?")
				? { availability: "available", snapshot: result }
				: base?.(input, init),
		);
		const user = userEvent.setup();
		renderWithQuery(
			<AisaLiveDetail accountId={accountId} analysisId={analysisId} />,
		);
		expect(
			await screen.findByText("A player wins the point."),
		).toBeInTheDocument();
		expect(screen.getByText("future/new-sport")).toBeInTheDocument();
		result = { ...snapshot, sequence: 2, encodingId: outputId };
		await user.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByText(/last valid result/i)).toBeInTheDocument();
		expect(screen.getByText("A player wins the point.")).toBeInTheDocument();
	});

	it("separates a terminal lifecycle state from a missing final snapshot", async () => {
		const base = apiFetch.getMockImplementation();
		apiFetch.mockImplementation(async (input: string, init?: RequestInit) => {
			if (input.includes("/results?"))
				return { availability: "available", snapshot };
			if (input.includes(`/api/live/analyses/${analysisId}?`))
				return { ...resource, status: "FINISHED" };
			return base?.(input, init);
		});
		renderWithQuery(
			<AisaLiveDetail accountId={accountId} analysisId={analysisId} />,
		);
		expect(
			await screen.findByText("Waiting for the final result."),
		).toBeInTheDocument();
	});

	it("lists analyses in the selected saved account", async () => {
		renderWithQuery(<AisaLiveList />);
		const link = await screen.findByRole("link", { name: "Court one" });
		expect(link).toHaveAttribute(
			"href",
			`/live/analyses/${analysisId}?bitmovinAccountId=${accountId}`,
		);
	});

	it("keeps polling after rejecting a forged final snapshot", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		let result = snapshot;
		const base = apiFetch.getMockImplementation();
		apiFetch.mockImplementation(async (input: string, init?: RequestInit) =>
			input.includes("/results?")
				? { availability: "available", snapshot: result }
				: base?.(input, init),
		);
		const user = userEvent.setup();
		renderWithQuery(
			<AisaLiveDetail accountId={accountId} analysisId={analysisId} />,
		);
		await screen.findByText("A player wins the point.");
		result = { ...snapshot, sequence: 2, encodingId: outputId, isFinal: true };
		await user.click(screen.getByRole("button", { name: "Refresh" }));
		await screen.findByText(/last valid result/i);
		result = { ...snapshot, sequence: 3 };
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(await screen.findByText("Snapshot 3")).toBeInTheDocument();
		expect(screen.queryByText(/last valid result/i)).not.toBeInTheDocument();
	});

	it("explains zero moments and does not treat an empty snapshot as a fetch failure", async () => {
		const base = apiFetch.getMockImplementation();
		apiFetch.mockImplementation(async (input: string, init?: RequestInit) =>
			input.includes("/results?")
				? {
						availability: "available",
						snapshot: { ...snapshot, observations: [], keyMoments: [] },
					}
				: base?.(input, init),
		);
		renderWithQuery(
			<AisaLiveDetail accountId={accountId} analysisId={analysisId} />,
		);
		expect(
			await screen.findByText(/No key moments in this snapshot/),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/Results could not be refreshed/),
		).not.toBeInTheDocument();
	});

	it("starts only after an explicit operator action and omits empty overrides", async () => {
		const user = userEvent.setup();
		renderWithQuery(
			<AisaLiveDetail accountId={accountId} analysisId={analysisId} />,
		);
		const start = await screen.findByRole("button", { name: "Start analysis" });
		expect(
			apiFetch.mock.calls.filter(([, init]) => init?.method === "POST"),
		).toHaveLength(0);
		await user.dblClick(start);
		await waitFor(() =>
			expect(
				apiFetch.mock.calls.filter(([, init]) => init?.method === "POST"),
			).toHaveLength(1),
		);
		const write = apiFetch.mock.calls.find(
			([, init]) => init?.method === "POST",
		);
		expect(JSON.parse(String(write?.[1]?.body))).toEqual({
			bitmovinAccountId: accountId,
			action: "start",
		});
	});

	it("clears results when navigating to a different analysis identity", async () => {
		const base = apiFetch.getMockImplementation();
		apiFetch.mockImplementation(async (input: string, init?: RequestInit) =>
			input.includes("/results?")
				? { availability: "available", snapshot }
				: base?.(input, init),
		);
		const rendered = renderWithQuery(
			<AisaLiveDetail accountId={accountId} analysisId={analysisId} />,
		);
		await screen.findByText("A player wins the point.");
		rendered.rerender(
			<AisaLiveDetail accountId={accountId} analysisId={outputId} />,
		);
		expect(
			screen.queryByText("A player wins the point."),
		).not.toBeInTheDocument();
		await screen.findByText("The request could not be completed.");
	});

	it("retains the original encoding identity when the detail response changes it", async () => {
		let current = resource;
		const base = apiFetch.getMockImplementation();
		apiFetch.mockImplementation(async (input: string, init?: RequestInit) => {
			if (input.includes("/results?"))
				return { availability: "available", snapshot };
			if (input.includes(`/api/live/analyses/${analysisId}?`)) return current;
			return base?.(input, init);
		});
		const user = userEvent.setup();
		renderWithQuery(
			<AisaLiveDetail accountId={accountId} analysisId={analysisId} />,
		);
		await screen.findByText("A player wins the point.");
		current = { ...resource, encodingId: outputId };
		await user.click(screen.getByRole("button", { name: "Refresh" }));
		await screen.findByText("The request could not be completed.");
		expect(screen.getByText("A player wins the point.")).toBeInTheDocument();
		expect(screen.getByText(encodingId)).toBeInTheDocument();
		expect(screen.queryByText(outputId)).not.toBeInTheDocument();
	});

	it("does not mount the billable create form for a viewer", () => {
		access.allowed = false;
		renderWithQuery(<AisaLiveCreate />);
		expect(screen.getByText(/Viewing only/)).toBeInTheDocument();
		expect(screen.queryByLabelText("Analysis name")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Create analysis" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "Standard Live Encoding" }),
		).not.toBeInTheDocument();
	});
});
