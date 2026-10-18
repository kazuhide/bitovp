import { liveChannelPlanSchema } from "@bitovp/core";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "@/app/live/new/build-live-plan";
import { renderWithQuery as wrap } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/app/vod/jobs/[id]/player-preview", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	PlayerPreview: () => <div data-testid="player-preview" />,
}));
vi.mock("./live-announcer", () => ({
	LiveAnnouncer: ({ children }: { children: ReactNode }) => <>{children}</>,
	useAnnounce: () => () => {},
	StatusAnnouncer: ({
		signal,
	}: {
		signal: {
			onAir: boolean;
			ingestConnected: boolean;
			heartbeatFresh: boolean;
		};
	}) => (
		<output
			data-testid="announcement"
			data-air={signal.onAir}
			data-input={signal.ingestConnected}
			data-fresh={signal.heartbeatFresh}
		/>
	),
}));
vi.mock("./schedule-panel", () => ({
	SchedulePanel: ({ ingestConnected }: { ingestConnected: boolean }) => (
		<output data-testid="schedule-guard">{String(ingestConnected)}</output>
	),
}));
vi.mock("./feeder-panel", () => ({
	FeederPanel: ({ ingestConnected }: { ingestConnected: boolean | null }) => (
		<output data-testid="feeder-guard">{String(ingestConnected)}</output>
	),
}));
vi.mock("./content-insertion-panel", () => ({
	ContentInsertionPanel: ({
		runId,
		outputObservation,
		onPreview,
	}: {
		runId: string | null;
		outputObservation?: unknown;
		onPreview?: () => void;
	}) => (
		<div>
			<output data-testid="slate-observation" data-run={runId}>
				{JSON.stringify(outputObservation ?? null)}
			</output>
			<button type="button" disabled={!onPreview} onClick={onPreview}>
				Test slate preview
			</button>
		</div>
	),
}));

import { ChannelDetail } from "./channel-detail";

const ID = "00000000-0000-4000-8000-0000000000f3";
const PLAN = liveChannelPlanSchema.parse(
	buildLiveChannelPlan({
		...DEFAULT_LIVE_WIZARD_STATE,
		name: "Push wiring",
		redundantRtmp: {
			...DEFAULT_LIVE_WIZARD_STATE.redundantRtmp,
			ingestPoints: [{ applicationName: "liveA", streamKey: "key" }],
		},
		output: {
			...DEFAULT_LIVE_WIZARD_STATE.output,
			credentialId: "11111111-1111-4111-8111-111111111111",
			bucket: "fixture",
		},
		start: { ...DEFAULT_LIVE_WIZARD_STATE.start, streamKey: "key" },
	}),
);
function fixture() {
	const now = new Date().toISOString();
	const raw = (status: string) => ({
		timestamp: now,
		ingest: { status, healthy: status === "CONNECTED", streams: [] },
		output: {
			manifests: {
				hls: [{ manifestUpdates: [{ manifestUpdateWallClockTime: now }] }],
			},
		},
	});
	return {
		id: ID,
		name: "Push wiring",
		status: "RUNNING",
		labels: [],
		region: "ap-northeast-1",
		protocol: "RTMP",
		bitmovinEncodingId: "encoding",
		bitmovinAccountId: null,
		createdAt: now,
		updatedAt: now,
		plan: PLAN,
		stepLog: [],
		streamKey: "key",
		encoderIp: "203.0.113.9",
		programStartAt: null,
		programEndAt: null,
		maxRunMinutes: null,
		error: null,
		lastHeartbeat: { at: now, raw: raw("CONNECTED"), deltas: {} },
		liveToVod: null,
		serverNow: now,
		playbackLinks: [
			{
				key: "hls",
				kind: "HLS",
				label: "HLS",
				url: "https://cdn.example.com/test/stream.m3u8",
				path: "test/stream.m3u8",
				via: "publicBaseUrls",
			},
		],
		heartbeatReception: {
			state: "available",
			runId: "run-current",
			configuredIntervalS: 20,
			latest: { receivedAt: now, sampledAt: now, raw: raw("CONNECTED") },
			previousReceivedAt: null,
		},
		currentRun: {
			id: "run-current",
			seq: 2,
			status: "RUNNING",
			bitmovinEncodingId: "encoding",
			encoderIp: "203.0.113.9",
			streamKey: "key",
			outputPrefix: "test/",
			runningSince: now,
			endedAt: null,
			programStartAt: null,
			programEndAt: null,
			error: null,
			lastHeartbeat: {
				at: now,
				raw: raw("DISCONNECTED"),
				deltas: {},
			} as unknown,
			lastHeartbeatAt: now,
			stepLog: [],
			liveToVod: null,
			originObservation: null,
			createdAt: now,
			providerStatus: "RUNNING",
			providerStatusObservedAt: now as string | null,
			providerUnknownSince: null as string | null,
			providerTerminalAt: null,
		},
	};
}
function setup(row: ReturnType<typeof fixture>) {
	apiFetch.mockImplementation(async (url: string) => {
		if (url.endsWith("/schedules")) return [];
		if (url.endsWith("/alerts")) return { open: [], history: [] };
		if (url.endsWith("/health"))
			return {
				points: [],
				lanes: { ingest: [], encoder: [], output: [] },
				run: {
					id: row.currentRun.id,
					seq: 2,
					status: "RUNNING",
					createdAt: row.createdAt,
				},
				truncated: false,
				outputObservable: true,
			};
		if (url.endsWith("/runs")) return { runs: [] };
		if (url === `/api/live-channels/${ID}`) return row;
		return { items: [] };
	});
	return wrap(<ChannelDetail id={ID} />);
}
const nextAction = () =>
	document
		.querySelector("[data-next-action]")
		?.getAttribute("data-next-action");
const ingestLamp = () =>
	document
		.querySelector('[data-lane="ingest"] [data-lane-lamp]')
		?.getAttribute("data-lane-lamp");
const observation = () =>
	JSON.parse(screen.getByTestId("slate-observation").textContent ?? "null");
beforeEach(() => {
	vi.clearAllMocks();
	window.history.replaceState(null, "", "/");
});

describe("ChannelDetail Push display wiring stays separate from lifecycle/action guards", () => {
	it("fresh Push wins a disagreeing Poll in header/delivery, but schedule/feeder guards retain Poll", async () => {
		setup(fixture());
		await waitFor(() => expect(nextAction()).toBe("ON_AIR"));
		expect(ingestLamp()).toBe("on");
		expect(document.querySelector('[data-stage="4"]')).toHaveAttribute(
			"data-state",
			"active",
		);
		expect(screen.getByTestId("announcement")).toHaveAttribute(
			"data-input",
			"true",
		);
		expect(screen.getByTestId("schedule-guard")).toHaveTextContent("false");
		expect(screen.getByTestId("feeder-guard")).toHaveTextContent("false");
		expect(observation()).toEqual({
			runId: "run-current",
			source: "push",
			advancing: true,
		});
	});
	it("a re-air with no current Poll never borrows the previous channel mirror or previous Push", async () => {
		const row = fixture();
		row.currentRun.lastHeartbeat = null;
		row.heartbeatReception.runId = "old-run";
		setup(row);
		await waitFor(() => expect(ingestLamp()).toBe("unknown"));
		expect(nextAction()).not.toBe("ON_AIR");
		expect(document.querySelector('[data-stage="3"]')).toHaveAttribute(
			"data-state",
			"active",
		);
		expect(screen.getByTestId("announcement")).toHaveAttribute(
			"data-input",
			"false",
		);
		expect(observation()).toBeNull();
	});
	it("fresh Push cannot turn an unconfirmed provider lifecycle into ON_AIR", async () => {
		const row = fixture();
		row.currentRun.providerStatusObservedAt = null;
		setup(row);
		await waitFor(() => expect(nextAction()).toBe("PROVIDER_UNKNOWN"));
		expect(ingestLamp()).toBe("on");
		expect(screen.getByTestId("announcement")).toHaveAttribute(
			"data-air",
			"false",
		);
		expect(
			document.querySelector('[data-lane="encoder"] [data-lane-lamp]'),
		).toHaveAttribute("data-lane-lamp", "unknown");
	});
	it("slate observation expires when both same-run Push and Poll lose freshness", async () => {
		const row = fixture();
		const { client } = setup(row);
		await waitFor(() => expect(observation()?.source).toBe("push"));
		const stale = new Date(Date.parse(row.serverNow) - 120_000).toISOString();
		await act(async () =>
			client.setQueryData(["live-channel", ID], {
				...row,
				currentRun: { ...row.currentRun, lastHeartbeat: null },
				heartbeatReception: {
					...row.heartbeatReception,
					latest: {
						...row.heartbeatReception.latest,
						receivedAt: stale,
						sampledAt: stale,
					},
				},
			}),
		);
		await waitFor(() => expect(observation()).toBeNull());
		expect(ingestLamp()).toBe("unknown");
	});
	it.each([
		true,
		false,
	])("slate preview eligibility=%s preserves player access, opens target and moves focus", async (playable) => {
		const row = fixture();
		if (!playable) row.playbackLinks = [];
		setup(row);
		await screen.findByRole("heading", { name: "Push wiring", level: 1 });
		const target = document.getElementById(
			"sec-manifests",
		) as HTMLDetailsElement;
		expect(target).not.toBeNull();
		const button = screen.getByRole("button", {
			name: "Test slate preview",
			hidden: true,
		});
		if (!playable) {
			expect(button).toBeDisabled();
			return;
		}
		target.open = false;
		fireEvent.click(button);
		expect(target.open).toBe(true);
		expect(window.location.hash).toBe("#sec-manifests");
		expect(document.activeElement).toBe(
			document.getElementById("sec-manifests-h"),
		);
	});
});
