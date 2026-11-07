import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "../new/build-live-plan";
import { ChannelDetail } from "./channel-detail";

const apiFetch = vi.fn();
const replaceRoute = vi.fn();
const seen = vi.hoisted(() => ({
	bindings: [] as string[],
	snapshots: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("../aisa-channel-analysis", () => ({
	AisaChannelAnalysisPanel: ({
		analysisId,
		encodingId,
		initialSnapshot,
	}: {
		analysisId: string;
		encodingId: string;
		initialSnapshot?: unknown;
	}) => {
		seen.bindings.push(`${analysisId}:${encodingId}`);
		seen.snapshots(initialSnapshot);
		return (
			<div data-testid="aisa-analysis">
				{analysisId}:{encodingId}
			</div>
		);
	},
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: replaceRoute }),
}));
const ID = "00000000-0000-4000-8000-000000000021";
const accountId = "00000000-0000-4000-8000-000000000022";
const encodingId = "00000000-0000-4000-8000-000000000023";
const analysisId = "00000000-0000-4000-8000-000000000024";
const oldEncoding = "00000000-0000-4000-8000-000000000025";
const oldAnalysis = "00000000-0000-4000-8000-000000000026";
const now = "2026-11-07T00:00:00.000Z";

function fixture(imported: boolean, status = "RUNNING") {
	const plan = buildLiveChannelPlan({
		...structuredClone(DEFAULT_LIVE_WIZARD_STATE),
		name: "Court 1",
		accountId,
		inputKind: "RTMP",
		start: {
			...structuredClone(DEFAULT_LIVE_WIZARD_STATE.start),
			streamKey: "TennisMatch",
		},
		aisaLive: {
			enabled: true,
			useManagedGraph: true,
			outputId: ID,
			recordingPath: "recording",
			analysisPath: "analysis",
			esVersion: "",
			aicaVersion: "",
		},
	});
	const currentRun = {
		id: "current",
		seq: 2,
		status,
		bitmovinEncodingId: encodingId,
		aisaAnalysisId: analysisId,
		aisaStatus: status,
		encoderIp: null,
		streamKey: "TennisMatch",
		outputPrefix: "",
		runningSince: now,
		endedAt: null,
		programStartAt: null,
		programEndAt: null,
		error: null,
		lastHeartbeat: null,
		lastHeartbeatAt: null,
		stepLog: [],
		liveToVod: null,
		originObservation: null,
		createdAt: now,
	};
	return {
		id: ID,
		origin: imported ? "AISA_IMPORTED" : "MANAGED",
		name: "Court 1",
		status,
		error: null,
		plan: imported ? { kind: "AISA_IMPORTED" } : plan,
		bitmovinEncodingId: encodingId,
		bitmovinAccountId: accountId,
		stepLog: [],
		streamKey: "TennisMatch",
		encoderIp: null,
		programStartAt: null,
		programEndAt: null,
		lastHeartbeat: null,
		liveToVod: null,
		currentRun,
		createdAt: now,
		updatedAt: now,
	};
}

beforeEach(() => {
	apiFetch.mockReset();
	seen.bindings = [];
	seen.snapshots.mockClear();
	replaceRoute.mockClear();
});
function respond(row: ReturnType<typeof fixture>) {
	apiFetch.mockImplementation(async (url: string) => {
		if (url === `/api/live-channels/${ID}`) return row;
		if (url === `/api/live-channels/${ID}/runs`)
			return {
				runs: [
					row.currentRun,
					{
						...row.currentRun,
						id: "older",
						seq: 1,
						status: "STOPPED",
						bitmovinEncodingId: oldEncoding,
						aisaAnalysisId: oldAnalysis,
						aisaStatus: "FINISHED",
					},
				],
			};
		if (url === "/api/auth/session")
			return {
				mode: "users",
				configured: true,
				authenticated: true,
				role: "OPERATOR",
				effectiveUserId: "operator",
				organizationId: "org",
				isImpersonating: false,
			};
		if (url.includes("/alerts")) return { open: [], history: [] };
		if (url.includes("/feeder")) return { items: [] };
		return [];
	});
}

it("shows an imported completed run in the normal detail route with read-only history and bound analysis", async () => {
	respond(fixture(true, "STOPPED"));
	renderWithQuery(<ChannelDetail id={ID} />);
	expect(await screen.findByRole("heading", { name: "Court 1" })).toBeVisible();
	expect(screen.getByRole("link", { name: "Live Channels" })).toHaveAttribute(
		"href",
		"/live",
	);
	expect(screen.getByText(/Provider settings are read-only/)).toBeVisible();
	expect(screen.getByTestId("aisa-analysis")).toHaveTextContent(
		`${analysisId}:${encodingId}`,
	);
	expect(
		screen.queryByRole("button", { name: /Start a new broadcast/ }),
	).toBeNull();
	expect(screen.queryByRole("link", { name: /Copy settings/ })).toBeNull();
	expect(screen.queryByRole("heading", { name: "Timeshift" })).toBeNull();
	expect(
		await screen.findByRole("button", { name: "View results for run #1" }),
	).toBeVisible();
	fireEvent.click(
		screen.getByRole("button", { name: "View results for run #1" }),
	);
	await waitFor(() =>
		expect(screen.getByTestId("aisa-analysis")).toHaveTextContent(
			`${oldAnalysis}:${oldEncoding}`,
		),
	);
});

it("offers managed lifecycle controls without standard graph-only mutation panels", async () => {
	respond(fixture(false));
	renderWithQuery(<ChannelDetail id={ID} />);
	await screen.findByRole("heading", { name: "Court 1" });
	expect(
		await screen.findByRole("button", { name: "Stop channel" }),
	).toBeVisible();
	expect(screen.queryByRole("button", { name: /Restart/ })).toBeNull();
	expect(
		screen.getByText(
			/supports starting a new run, stopping, and cancelling startup/,
		),
	).toBeVisible();
	expect(screen.getByTestId("aisa-analysis")).toHaveTextContent(
		`${analysisId}:${encodingId}`,
	);
	expect(screen.queryByRole("heading", { name: "Timeshift" })).toBeNull();
	expect(screen.queryByRole("heading", { name: "Live to VOD" })).toBeNull();
	expect(
		screen.queryByRole("heading", { name: "Slate reservations" }),
	).toBeNull();
});

const selectedRun = {
	id: "older",
	liveChannelId: ID,
	seq: 1,
	aisaAnalysisId: oldAnalysis,
	bitmovinEncodingId: oldEncoding,
	aisaStatus: "FINISHED",
	aisaSnapshot: { sequence: 5, isFinal: true },
};

it("starts an existing deep link on its exact historical Analysis without showing the latest run first", async () => {
	respond(fixture(false));
	renderWithQuery(<ChannelDetail id={ID} initialAisaRun={selectedRun} />);
	expect(await screen.findByTestId("aisa-analysis")).toHaveTextContent(
		`${oldAnalysis}:${oldEncoding}`,
	);
	expect(
		seen.bindings.every(
			(binding) => binding === `${oldAnalysis}:${oldEncoding}`,
		),
	).toBe(true);
	expect(seen.snapshots).toHaveBeenCalledWith(selectedRun.aisaSnapshot);
	const history = await screen.findByRole("button", {
		name: "View results for run #2",
	});
	fireEvent.click(history);
	expect(replaceRoute).toHaveBeenCalledWith(
		`/live/${ID}?runId=current#sec-analysis`,
		{ scroll: false },
	);
	await waitFor(() =>
		expect(screen.getByTestId("aisa-analysis")).toHaveTextContent(
			`${analysisId}:${encodingId}`,
		),
	);
});

it("keeps a historical selection when the same channel starts a newer airing", async () => {
	const row = fixture(false);
	respond(row);
	const rendered = renderWithQuery(
		<ChannelDetail id={ID} initialAisaRun={selectedRun} />,
	);
	await screen.findByTestId("aisa-analysis");
	const newer = {
		...row,
		currentRun: {
			...row.currentRun,
			id: "newer",
			seq: 3,
			bitmovinEncodingId: "00000000-0000-4000-8000-000000000031",
			aisaAnalysisId: "00000000-0000-4000-8000-000000000032",
		},
	};
	act(() => rendered.client.setQueryData(["live-channel", ID], newer));
	await waitFor(() =>
		expect(screen.getByTestId("aisa-analysis")).toHaveTextContent(
			`${oldAnalysis}:${oldEncoding}`,
		),
	);
	expect(
		seen.bindings.every(
			(binding) => binding === `${oldAnalysis}:${oldEncoding}`,
		),
	).toBe(true);
});

it("refuses a selected run belonging to another channel without falling back to its current Analysis", async () => {
	respond(fixture(false));
	renderWithQuery(
		<ChannelDetail
			id={ID}
			initialAisaRun={{ ...selectedRun, liveChannelId: accountId }}
		/>,
	);
	expect(
		await screen.findByText(
			"The requested AISA run is unavailable in this channel.",
		),
	).toBeVisible();
	expect(screen.queryByTestId("aisa-analysis")).toBeNull();
	expect(seen.bindings).toEqual([]);
});
