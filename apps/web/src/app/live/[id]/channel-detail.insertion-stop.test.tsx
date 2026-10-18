import { liveChannelPlanSchema } from "@bitovp/core";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "@/app/live/new/build-live-plan";
import { renderWithQuery as wrap } from "@/test/render";

/* Slate reservations and emergency stopping occupy distinct sections on a running channel, including when the current run is unavailable. */

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => {
	class ApiError extends Error {
		constructor(
			readonly status: number,
			message: string,
		) {
			super(message);
			this.name = "ApiError";
		}
	}
	return { apiFetch: (...args: unknown[]) => apiFetch(...args), ApiError };
});
vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("hls.js", () => {
	class Hls {
		static Events = { ERROR: "hlsError" };
		static isSupported() {
			return true;
		}
		on() {}
		loadSource() {}
		attachMedia() {}
		startLoad() {}
		destroy() {}
	}
	return { default: Hls };
});
vi.mock("shaka-player", () => ({
	default: {
		polyfill: { installAll() {} },
		Player: class {
			static isBrowserSupported() {
				return true;
			}
			addEventListener() {}
			removeEventListener() {}
			async attach() {}
			configure() {}
			async load() {}
			async destroy() {}
		},
	},
}));

import { ChannelDetail } from "./channel-detail";

const CHANNEL = "00000000-0000-4000-8000-000000000277";
const ACCOUNT = "00000000-0000-4000-8000-0000000000a7";
const STOP_URL = `/api/live-channels/${CHANNEL}/insertable-content/stop`;

const PLAN = liveChannelPlanSchema.parse(
	buildLiveChannelPlan({
		...DEFAULT_LIVE_WIZARD_STATE,
		name: "slate-reservations",
		redundantRtmp: {
			...DEFAULT_LIVE_WIZARD_STATE.redundantRtmp,
			ingestPoints: [{ applicationName: "liveA", streamKey: "skey" }],
		},
		output: {
			...DEFAULT_LIVE_WIZARD_STATE.output,
			credentialId: "11111111-1111-4111-8111-111111111111",
			bucket: "slate-bucket",
		},
		start: { ...DEFAULT_LIVE_WIZARD_STATE.start, streamKey: "skey" },
	}),
);

/** A reservation booked for the FUTURE — the row the audit named. */
const FUTURE_RESERVATION = {
	id: "22223333-4444-4555-8666-777788889999",
	contentId: "aaaabbbb-cccc-4ddd-8eee-ffff00001111",
	runAt: "2099-01-01T00:00:00Z",
	durationInSeconds: 15,
	status: "SCHEDULED",
};

function mockOnAirChannel() {
	const now = Date.now();
	const connected = {
		at: new Date(now - 10_000).toISOString(),
		raw: { ingest: { status: "CONNECTED", healthy: true } },
		deltas: {},
	};
	const run = {
		id: "run-1",
		seq: 3,
		status: "RUNNING",
		bitmovinEncodingId: "enc-1",
		encoderIp: null,
		streamKey: null,
		outputPrefix: "out/",
		runningSince: new Date(now - 90 * 60_000).toISOString(),
		endedAt: null,
		programStartAt: null,
		programEndAt: null,
		error: null,
		lastHeartbeat: connected,
		lastHeartbeatAt: connected.at,
		stepLog: [],
		liveToVod: null,
		originObservation: null,
		createdAt: new Date(now - 100 * 60_000).toISOString(),
	};
	apiFetch.mockImplementation(
		async (input: string, init?: { method?: string }) => {
			if (input === STOP_URL && init?.method === "POST") {
				return { encodingId: "enc-1", stopped: true };
			}
			if (input.includes("/insertable-content/scheduled?")) {
				return { totalCount: 1, items: [FUTURE_RESERVATION] };
			}
			if (input.includes("/insertable-content?")) {
				return { totalCount: 0, items: [] };
			}
			if (input.startsWith("/api/live/inputs")) {
				return { totalCount: 0, items: [] };
			}
			if (input.endsWith("/schedules")) {
				return [];
			}
			if (input.endsWith("/alerts")) {
				return { open: [], history: [] };
			}
			if (input.includes("/runs/") && input.endsWith("/health")) {
				return {
					points: [],
					lanes: { ingest: [], encoder: [], output: [] },
					run: {
						id: "run-1",
						seq: 3,
						status: "RUNNING",
						createdAt: run.createdAt,
					},
					truncated: false,
					outputObservable: true,
					timeline: { window: { startMs: now - 7_200_000 }, events: [] },
				};
			}
			if (input.startsWith(`/api/live-channels/${CHANNEL}`)) {
				return {
					id: CHANNEL,
					name: "Slate channel",
					status: "RUNNING",
					labels: [],
					region: "ap-northeast-1",
					protocol: "RTMP",
					bitmovinEncodingId: "enc-1",
					bitmovinAccountId: ACCOUNT,
					createdAt: run.createdAt,
					updatedAt: run.createdAt,
					plan: PLAN,
					stepLog: [],
					streamKey: null,
					encoderIp: null,
					programStartAt: null,
					programEndAt: null,
					lastHeartbeat: connected,
					liveToVod: null,
					maxRunMinutes: null,
					playbackLinks: [],
					currentRun: run,
				};
			}
			return { items: [] };
		},
	);
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("row #277 — reservations and emergency stop retain separate sections and confirmations", () => {
	it.each([
		{
			locale: "en" as const,
			heading: "Slate reservations",
			forbiddenHeading: /on.?air|now|current/i,
			reserved: "Reserved",
			forbiddenControl: /stop|return|live/i,
			stopTitle: "Emergency stop: inserted content",
			action: "Stop the playing inserted content and return to the live input",
			confirmTitle: "Stop the inserted content that is playing?",
			confirm: "Stop and return to the live input",
		},
		{
			locale: "ja" as const,
			heading: "スレートの予約",
			forbiddenHeading: /本番中|現在|いま/,
			reserved: "予約済み",
			forbiddenControl: /停止|戻す|ライブ/,
			stopTitle: "差し込みコンテンツの緊急停止",
			action: "再生中の差し込みコンテンツを停止してライブ入力へ戻す",
			confirmTitle: "再生中の差し込みコンテンツを停止しますか?",
			confirm: "停止してライブ入力へ戻す",
		},
	])("$locale: the list says reservations and holds no stop; the stop is its own confirm-gated section", async ({
		locale,
		heading,
		forbiddenHeading,
		reserved,
		forbiddenControl,
		stopTitle,
		action,
		confirmTitle,
		confirm,
	}) => {
		mockOnAirChannel();
		const user = userEvent.setup();
		wrap(<ChannelDetail id={CHANNEL} />, locale);
		await screen.findByRole("region", { name: /next action|次にやること/i });

		const operations = document.getElementById(
			"layer-operations",
		) as HTMLElement;
		const reservations = document.getElementById(
			"sec-slate",
		) as HTMLDetailsElement;
		const emergency = document.getElementById(
			"sec-insertion-stop",
		) as HTMLDetailsElement;
		expect(operations).not.toBeNull();
		expect(operations).not.toHaveTextContent(/emergency stop|緊急停止/i);
		expect(reservations).not.toBeNull();
		expect(emergency).not.toBeNull();
		// Emergency stop belongs beside content operations, not channel state.
		expect(operations.contains(reservations)).toBe(true);
		expect(operations.contains(emergency)).toBe(false);
		expect(
			document.getElementById("layer-programme")?.contains(emergency),
		).toBe(true);
		expect(reservations.contains(emergency)).toBe(false);

		// The list's heading names reservations, and no on-air word.
		const listHeading = within(reservations).getByRole("heading", {
			level: 3,
		});
		expect(listHeading).toHaveTextContent(heading);
		expect(listHeading.textContent ?? "").not.toMatch(forbiddenHeading);
		expect(
			within(emergency).getByRole("heading", { level: 3 }),
		).toHaveTextContent(stopTitle);

		// The future reservation is listed — and NO stop / return-to-live
		// control sits with it.
		reservations.open = true;
		await within(reservations).findByText(reserved);
		expect(
			within(reservations).queryByRole("button", {
				name: forbiddenControl,
			}),
		).toBeNull();

		// The emergency stop: a button, a confirm, then ONE post.
		emergency.open = true;
		await user.click(within(emergency).getByRole("button", { name: action }));
		expect(apiFetch.mock.calls.some((c) => c[0] === STOP_URL)).toBe(false);
		const dialog = await screen.findByRole("dialog", { name: confirmTitle });
		await user.click(within(dialog).getByRole("button", { name: confirm }));
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith(
				STOP_URL,
				expect.objectContaining({ method: "POST" }),
			);
		});
		expect(apiFetch.mock.calls.filter((c) => c[0] === STOP_URL)).toHaveLength(
			1,
		);
		// The stop did not cancel the reservation: no DELETE went out.
		expect(
			apiFetch.mock.calls.some(
				(c) =>
					String(c[0]).includes("/schedule/") &&
					(c[1] as { method?: string } | undefined)?.method === "DELETE",
			),
		).toBe(false);
	});
});
