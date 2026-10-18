import { feederError } from "@bitovp/core";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

vi.mock("@/components/storage-picker", () => ({
	StoragePicker: ({
		open,
		onSelect,
	}: {
		open: boolean;
		onSelect: (selection: {
			credentialId: string;
			bucket: string;
			path: string;
		}) => void;
	}) =>
		open ? (
			<button
				type="button"
				onClick={() =>
					onSelect({
						credentialId: "credential-1",
						bucket: "media",
						path: "clip.mp4",
					})
				}
			>
				Choose test MP4
			</button>
		) : null,
}));

import { ChannelsClient } from "../channels-client";
import type { FeederSessionListItem } from "./feeder-shared";
import { FeedersClient } from "./feeders-client";

function session(
	over: Partial<FeederSessionListItem> = {},
): FeederSessionListItem {
	return {
		id: "00000000-0000-4000-8000-0000000000f1",
		liveChannelId: "00000000-0000-4000-8000-0000000000c1",
		status: "STOPPED",
		protocol: "RTMP",
		sourceBucket: "bucket",
		sourceKey: "clip.mp4",
		pid: null,
		processGoneAt: null,
		startedAt: "2026-06-18T00:00:00.000Z",
		stoppedAt: "2026-06-18T00:05:00.000Z",
		error: null,
		createdAt: "2026-06-18T00:00:00.000Z",
		updatedAt: "2026-06-18T00:05:00.000Z",
		...over,
	};
}

function mockList(items: FeederSessionListItem[]) {
	apiFetch.mockImplementation(async (input: string, init?: RequestInit) => {
		if (init?.method === "DELETE") {
			return { deleted: true };
		}
		// FeederPanel's credentials query (enabled once the form opens) expects an
		// ARRAY; handing it the list envelope made `.filter` throw in a render that
		// landed after the test ended — an unhandled error attributed to whichever
		// file ran next (merge #347, 2026-08-29).
		if (String(input) === "/api/credentials") {
			return [];
		}
		return { items };
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("Feeder channel picker — shared navigation cache and pagination", () => {
	const channel = {
		id: "channel-1",
		name: "Navigation channel",
		status: "STOPPED",
		error: null,
		bitmovinEncodingId: null,
		bitmovinAccountId: null,
		createdAt: "2026-09-07T00:00:00Z",
		updatedAt: "2026-09-07T00:00:00Z",
		health: {
			heartbeat: null,
			openAlerts: 0,
			activeFeeders: 0,
			erroredFeeders: 0,
			origin: null,
			runningSince: null,
			endedAt: null,
			maxRunMinutes: null,
		},
	};
	function mockChannels(paged = false) {
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/bitmovin-accounts") return [];
			if (url === "/api/credentials") return [];
			if (url === "/api/live-channels")
				return {
					items: [channel],
					...(paged ? { nextCursor: "older-cursor" } : {}),
				};
			if (url === "/api/live-channels?cursor=older-cursor")
				return { items: [{ ...channel, id: "older", name: "Older channel" }] };
			if (url === "/api/live-channels/older")
				return {
					...channel,
					id: "older",
					plan: { liveInput: { kind: "RTMP" } },
					streamKey: null,
					encoderIp: null,
				};
			return { items: [] };
		});
	}
	async function openPicker() {
		fireEvent.click(
			await screen.findByRole("button", {
				name: /new feeder session|start file input/i,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: /browse storage/i }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Choose test MP4" }),
		);
	}
	it("shows selected-channel read failures and retries without losing the source", async () => {
		let failed = true;
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/credentials") return [];
			if (url === "/api/live-channels") return { items: [channel] };
			if (url === `/api/live-channels/${channel.id}`) {
				if (failed) throw new Error("offline");
				return {
					...channel,
					plan: { liveInput: { kind: "RTMP" } },
					streamKey: null,
					encoderIp: null,
				};
			}
			return { items: [] };
		});
		wrap(<FeedersClient />);
		await openPicker();
		await screen.findByRole("option", { name: "Navigation channel" });
		fireEvent.change(screen.getByLabelText("Channel"), {
			target: { value: channel.id },
		});
		await screen.findByRole("alert", {}, { timeout: 1000 });
		failed = false;
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() =>
			expect(screen.queryByText("Failed to load the live channel.")).toBeNull(),
		);
		expect(screen.getByDisplayValue("media/clip.mp4")).toBeInTheDocument();
		expect(screen.getByLabelText("Channel")).toHaveValue(channel.id);
	});

	it("keeps channel options available after visiting Live, and can return to Live", async () => {
		mockChannels();
		const view = wrap(<ChannelsClient />);
		view.client.setQueryDefaults(["live-channels"], { staleTime: 15_000 });
		await screen.findByRole("link", { name: "Navigation channel" });
		view.rerender(<FeedersClient />);
		await openPicker();
		expect(
			await screen.findByRole("option", { name: "Navigation channel" }),
		).toBeInTheDocument();
		view.rerender(<ChannelsClient />);
		expect(
			await screen.findByRole("link", { name: "Navigation channel" }),
		).toBeInTheDocument();
	});
	it("opens the Live list after the picker populated the same QueryClient", async () => {
		mockChannels();
		const view = wrap(<FeedersClient />);
		view.client.setQueryDefaults(["live-channels"], { staleTime: 15_000 });
		await openPicker();
		await screen.findByRole("option", { name: "Navigation channel" });
		view.rerender(<ChannelsClient />);
		expect(
			await screen.findByRole("link", { name: "Navigation channel" }),
		).toBeInTheDocument();
	});
	it("loads an older channel page and selects its actual channel id", async () => {
		mockChannels(true);
		wrap(<FeedersClient />);
		await openPicker();
		await screen.findByRole("option", { name: "Navigation channel" });
		fireEvent.click(screen.getByRole("button", { name: /load more/i }));
		await screen.findByRole("option", { name: "Older channel" });
		fireEvent.change(screen.getByLabelText("Channel"), {
			target: { value: "older" },
		});
		await waitFor(() =>
			expect(apiFetch).toHaveBeenCalledWith("/api/live-channels/older"),
		);
	});
	it("retries a failed channel picker load without discarding the source", async () => {
		let fail = true;
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/credentials") return [];
			if (url === "/api/live-channels") {
				if (fail) throw new Error("unavailable");
				return { items: [channel] };
			}
			return { items: [] };
		});
		wrap(<FeedersClient />);
		await openPicker();
		await screen.findByRole("alert");
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: /retry/i }));
		expect(
			await screen.findByRole("option", { name: "Navigation channel" }),
		).toBeInTheDocument();
	});
});

describe("FeedersClient — delete", () => {
	it("enables delete on a terminal session and disables it on an active one", async () => {
		mockList([
			session({
				id: "11111111-1111-4111-8111-111111111111",
				status: "STOPPED",
			}),
			session({
				id: "22222222-2222-4222-8222-222222222222",
				status: "PUSHING",
			}),
		]);
		wrap(<FeedersClient />);
		await screen.findByRole("button", { name: /Delete session 11111111/ });

		expect(
			screen.getByRole("button", { name: "Delete session 11111111" }),
		).not.toBeDisabled();
		expect(
			screen.getByRole("button", {
				name: /Delete session 22222222 \(disabled\)/,
			}),
		).toBeDisabled();
	});

	/**
	 * Audit 2026-08-29 CRITICAL-2 — an ERROR row left by a dead START job
	 * keeps its pid because the `-stream_loop -1` ffmpeg outlived the worker.
	 * Deleting it erased the last reference to a live push, so the button that
	 * did it must be shut for exactly as long as the API refuses.
	 */
	it("disables delete on a terminal session that still records an unreclaimed pid", async () => {
		mockList([
			session({
				id: "33333333-3333-4333-8333-333333333333",
				status: "ERROR",
				pid: 4242,
				processGoneAt: null,
			}),
			session({
				id: "44444444-4444-4444-8444-444444444444",
				status: "ERROR",
				pid: 4243,
				// Reclaimed: the kill ladder proved this one gone.
				processGoneAt: "2026-08-29T00:00:00.000Z",
			}),
		]);
		wrap(<FeedersClient />);
		await screen.findByRole("button", { name: /Delete session 44444444/ });

		expect(
			screen.getByRole("button", {
				name: /Delete session 33333333 \(disabled\)/,
			}),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Delete session 44444444" }),
		).not.toBeDisabled();
	});

	it("confirms then DELETEs the session and refetches the list", async () => {
		const id = "00000000-0000-4000-8000-0000000000f1";
		mockList([session({ id, status: "STOPPED" })]);
		wrap(<FeedersClient />);
		await screen.findByRole("button", { name: /Delete session 00000000/ });

		const user = userEvent.setup();
		await user.click(
			screen.getByRole("button", { name: "Delete session 00000000" }),
		);
		await user.click(screen.getByRole("button", { name: "Delete" }));

		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				(c) =>
					String(c[0]) === `/api/feeder-sessions/${id}` &&
					(c[1] as RequestInit)?.method === "DELETE",
			);
			expect(call).toBeTruthy();
		});
		await waitFor(() => {
			const getCalls = apiFetch.mock.calls.filter(
				(c) => (c[1] as RequestInit)?.method !== "DELETE",
			);
			expect(getCalls.length).toBeGreaterThan(1);
		});
	});
});

/**
 * : creation from the feeders screen itself — channel select →
 * detail fetch → the SAME FeederPanel the channel detail mounts (zero forked
 * form logic). Static ingest (#114) makes the target knowable up front.
 */
describe("FeedersClient — create session from this screen (ledger #121)", () => {
	const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000a1";
	const RUN_ENCODING_ID = "00000000-0000-4000-8000-0000000000e1";
	const CHANNEL_ENCODING_ID = "00000000-0000-4000-8000-0000000000e2";
	const STREAM_KEY_ID = "00000000-0000-4000-8000-0000000000e3";
	const STATIC_PLAN = {
		planVersion: 1,
		name: "static",
		liveInput: {
			key: "main",
			kind: "REDUNDANT_RTMP",
			staticIngestPoints: [
				{ name: "primary", streamKeyConfiguration: { type: "GENERATE" } },
			],
		},
		start: { streamKey: "stale-plan-key" },
	};

	async function openPickedFeederPanel() {
		fireEvent.click(
			await screen.findByRole("button", {
				name: /new feeder session|start file input/i,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: /browse storage/i }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Choose test MP4" }),
		);
		await screen.findByRole("option", { name: "My Channel" });
		fireEvent.change(screen.getByLabelText("Channel"), {
			target: { value: "ch-1" },
		});
		await screen.findByLabelText(/protocol/i, { selector: "select" });
	}

	function mockStaticChannel(
		currentRun: { bitmovinEncodingId: string | null } | null,
	) {
		const streamKeyUrls: string[] = [];
		apiFetch.mockImplementation(async (input: string) => {
			const url = String(input);
			if (url === "/api/credentials") return [];
			if (url === "/api/live-channels") {
				return {
					items: [{ id: "ch-1", name: "My Channel", status: "RUNNING" }],
				};
			}
			if (url === "/api/live-channels/ch-1") {
				return {
					id: "ch-1",
					status: "RUNNING",
					plan: STATIC_PLAN,
					bitmovinAccountId: ACCOUNT_ID,
					bitmovinEncodingId: CHANNEL_ENCODING_ID,
					streamKey: "stale-channel-key",
					encoderIp: null,
					currentRun: currentRun
						? {
								...currentRun,
								streamKey: null,
								encoderIp: null,
							}
						: null,
				};
			}
			if (url.startsWith("/api/live/stream-keys")) {
				streamKeyUrls.push(url);
				return url.includes(`/${STREAM_KEY_ID}`)
					? { id: STREAM_KEY_ID, value: "run-scoped-secret" }
					: { items: [{ id: STREAM_KEY_ID }] };
			}
			if (url.startsWith("/api/feeder-sessions")) return { items: [] };
			return { items: [] };
		});
		return streamKeyUrls;
	}

	it("reveals a static key against the current-run encoding, never the stale channel encoding (LF-03)", async () => {
		const streamKeyUrls = mockStaticChannel({
			bitmovinEncodingId: RUN_ENCODING_ID,
		});
		wrap(<FeedersClient />);
		await openPickedFeederPanel();
		await userEvent.click(
			screen.getByRole("button", { name: /reveal key & fill/i }),
		);
		await waitFor(() => expect(streamKeyUrls).toHaveLength(2));
		expect(streamKeyUrls[0]).toContain(`assignedEncodingId=${RUN_ENCODING_ID}`);
		expect(streamKeyUrls.join("\n")).not.toContain(CHANNEL_ENCODING_ID);
	});

	it("uses the channel encoding only when no current-run row exists (LF-03 legacy fallback)", async () => {
		const streamKeyUrls = mockStaticChannel(null);
		wrap(<FeedersClient />);
		await openPickedFeederPanel();
		await userEvent.click(
			screen.getByRole("button", { name: /reveal key & fill/i }),
		);
		await waitFor(() => expect(streamKeyUrls).toHaveLength(2));
		expect(streamKeyUrls[0]).toContain(
			`assignedEncodingId=${CHANNEL_ENCODING_ID}`,
		);
	});

	it("does not fall back to a stale channel encoding while the current run is unresolved", async () => {
		const streamKeyUrls = mockStaticChannel({ bitmovinEncodingId: null });
		wrap(<FeedersClient />);
		await openPickedFeederPanel();
		expect(
			await screen.findByText(/input destination is being prepared/i),
		).toBeVisible();
		expect(
			screen.getByRole("button", { name: /reveal key & fill/i }),
		).toBeDisabled();
		expect(streamKeyUrls).toHaveLength(0);
	});

	it("completes source → channel → create → CONNECTED confirmation → stop on the global page alone", async () => {
		let lifecycle: "empty" | "pushing" | "stopped" = "empty";
		const calls: Array<{ url: string; method: string }> = [];
		apiFetch.mockImplementation(async (input: string, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			calls.push({ url, method });
			if (url === "/api/credentials") return [];
			if (url === "/api/live-channels") {
				return {
					items: [{ id: "ch-1", name: "My Channel", status: "RUNNING" }],
				};
			}
			if (url === "/api/live-channels/ch-1") {
				const now = new Date().toISOString();
				return {
					id: "ch-1",
					status: "RUNNING",
					plan: {
						planVersion: 1,
						name: "dynamic",
						liveInput: { key: "main", kind: "RTMP" },
						start: { streamKey: "channel-key" },
					},
					bitmovinAccountId: ACCOUNT_ID,
					bitmovinEncodingId: CHANNEL_ENCODING_ID,
					streamKey: "channel-key",
					encoderIp: "198.51.100.44",
					serverNow: now,
					currentRun: {
						bitmovinEncodingId: RUN_ENCODING_ID,
						streamKey: "run-key",
						encoderIp: "198.51.100.45",
						lastHeartbeat: {
							at: now,
							raw: {
								ingest: { status: "CONNECTED", healthy: true, streams: [] },
								events: [],
							},
							deltas: {},
						},
					},
				};
			}
			if (url === "/api/feeder-sessions" && method === "POST") {
				lifecycle = "pushing";
				return { id: "fs-global" };
			}
			if (
				url === "/api/feeder-sessions/fs-global/actions" &&
				method === "POST"
			) {
				lifecycle = "stopped";
				return { id: "fs-global", status: "STOPPED" };
			}
			if (url.startsWith("/api/feeder-sessions")) {
				return {
					items:
						lifecycle === "empty"
							? []
							: [
									session({
										id: "fs-global",
										liveChannelId: "ch-1",
										status: lifecycle === "pushing" ? "PUSHING" : "STOPPED",
										pid: lifecycle === "pushing" ? 4242 : null,
										processGoneAt:
											lifecycle === "stopped"
												? "2026-08-31T00:00:00.000Z"
												: null,
										stoppedAt:
											lifecycle === "stopped"
												? "2026-08-31T00:00:00.000Z"
												: null,
									}),
								],
				};
			}
			return { items: [] };
		});

		const user = userEvent.setup();
		wrap(<FeedersClient />);
		await user.click(
			await screen.findByRole("button", { name: "Start file input" }),
		);
		await user.click(screen.getByRole("button", { name: /Browse storage/ }));
		await user.click(
			await screen.findByRole("button", { name: "Choose test MP4" }),
		);
		await user.selectOptions(await screen.findByLabelText("Channel"), "ch-1");
		const form = await waitFor(() => {
			const node = document.getElementById("feeder-new-session-form");
			expect(node).not.toBeNull();
			return node as HTMLElement;
		});
		await user.click(
			within(form).getByRole("button", { name: "Start file input" }),
		);
		expect(await screen.findByText(/Input confirmed/)).toBeVisible();
		expect(
			calls.some(
				(call) => call.url === "/api/feeder-sessions" && call.method === "POST",
			),
		).toBe(true);

		await user.click(screen.getByRole("button", { name: "Stop" }));
		await user.click(
			await screen.findByRole("button", { name: "Stop session" }),
		);
		await waitFor(() =>
			expect(
				calls.some(
					(call) =>
						call.url === "/api/feeder-sessions/fs-global/actions" &&
						call.method === "POST",
				),
			).toBe(true),
		);
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Stop" })).toBeNull(),
		);
	});

	it("prefills the feed target from the CURRENT RUN when it disagrees with the channel (ledger #108 PR2b)", async () => {
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/credentials") {
				return []; // the panel's credentials query expects an ARRAY (see mockList)
			}
			if (url === "/api/live-channels") {
				return {
					items: [{ id: "ch-1", name: "My Channel", status: "RUNNING" }],
				};
			}
			if (url === "/api/live-channels/ch-1") {
				return {
					id: "ch-1",
					status: "RUNNING",
					plan: {
						planVersion: 1,
						name: "ch",
						liveInput: { key: "main", kind: "RTMP" },
						start: { streamKey: "abcdef" },
					},
					// The STALE channel columns — the pre-restart encoder.
					streamKey: "old-key",
					encoderIp: "203.0.113.9",
					// The restart's run owns the coordinates (writer-coupled,
					// design R5: the two DISAGREE and the run must win — the
					// old IP is dead air after a restart).
					currentRun: {
						streamKey: "new-key",
						encoderIp: "198.51.100.7",
					},
				};
			}
			return { items: [] };
		});
		wrap(<FeedersClient />);
		fireEvent.click(await screen.findByText("Start file input"));
		fireEvent.click(screen.getByRole("button", { name: /browse storage/i }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Choose test MP4" }),
		);
		await screen.findByRole("option", { name: "My Channel" });
		fireEvent.change(screen.getByLabelText("Channel"), {
			target: { value: "ch-1" },
		});
		const urlInput = (await screen.findByLabelText(/rtmp url/i, {
			selector: "input",
		})) as HTMLInputElement;
		expect(urlInput.value).toBe("rtmp://198.51.100.7/live");
		expect(urlInput.value).not.toContain("203.0.113.9");
		const keyInput = screen.getByLabelText(/stream key/i, {
			selector: "input",
		}) as HTMLInputElement;
		expect(keyInput.value).toBe("new-key");
	});

	/**
	 *  (review-331): the picker rendered FeederPanel with NO ingest
	 * prop, so #213's first-cut notice ("unconfirmed until a heartbeat
	 * arrives") showed for EVERY picked channel — silence turned into a
	 * standing false alarm. The panel now derives the tri-state from the
	 * detail row it already fetches.
	 */
	function mockPicker(
		lastHeartbeat: unknown,
		serverNow?: string | (() => string),
	) {
		apiFetch.mockImplementation(async (input: string) => {
			const url = String(input);
			if (url === "/api/credentials") {
				return [];
			}
			if (url === "/api/live-channels") {
				return {
					items: [{ id: "ch-1", name: "My Channel", status: "RUNNING" }],
				};
			}
			if (url === "/api/live-channels/ch-1") {
				return {
					id: "ch-1",
					status: "RUNNING",
					plan: {
						planVersion: 1,
						name: "ch",
						liveInput: { key: "main", kind: "RTMP" },
						start: { streamKey: "abcdef" },
					},
					streamKey: "abcdef",
					encoderIp: "203.0.113.5",
					lastHeartbeat,
					currentRun: null,
					...(serverNow
						? {
								serverNow:
									typeof serverNow === "function" ? serverNow() : serverNow,
							}
						: {}),
				};
			}
			if (url.startsWith("/api/feeder-sessions")) {
				return {
					items: [
						session({
							liveChannelId: "ch-1",
							status: "PUSHING",
							stoppedAt: null,
						}),
					],
				};
			}
			return { items: [] };
		});
	}
	async function pickChannel() {
		wrap(<FeedersClient />);
		fireEvent.click(await screen.findByText("Start file input"));
		fireEvent.click(screen.getByRole("button", { name: /browse storage/i }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Choose test MP4" }),
		);
		await screen.findByRole("option", { name: "My Channel" });
		fireEvent.change(screen.getByLabelText("Channel"), {
			target: { value: "ch-1" },
		});
		await screen.findByLabelText(/protocol/i, { selector: "select" });
	}

	it("a picked channel with a fresh CONNECTED heartbeat shows NO ingest notice (ledger #213, review-331)", async () => {
		mockPicker({
			at: new Date().toISOString(),
			raw: {
				ingest: { status: "CONNECTED", healthy: true, streams: [] },
				events: [],
			},
			deltas: {},
		});
		await pickChannel();
		// The list row AND the panel badge both say PUSHING — any is enough.
		expect((await screen.findAllByText(/PUSHING/)).length).toBeGreaterThan(0);
		expect(screen.queryByText(/no recent heartbeat to confirm/)).toBeNull();
		expect(screen.queryByText(/encoder has not bound any input/)).toBeNull();
	});

	it("freshness is judged on the SERVER's clock — a viewer five minutes fast still sees no notice for a fresh heartbeat (ledger #127, review-331)", async () => {
		// The heartbeat is fresh as of the server's answer; the viewer's clock
		// runs five minutes ahead. Compared on the viewer's clock the sample
		// would look stale and the notice would fire — the #127 shape.
		const serverNow = "2026-08-28T12:00:00.000Z";
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.parse(serverNow) + 5 * 60_000);
		try {
			mockPicker(
				{
					at: "2026-08-28T11:59:50.000Z",
					raw: {
						ingest: { status: "CONNECTED", healthy: true, streams: [] },
						events: [],
					},
					deltas: {},
				},
				serverNow,
			);
			await pickChannel();
			// The list row AND the panel badge both say PUSHING — any is enough.
			expect((await screen.findAllByText(/PUSHING/)).length).toBeGreaterThan(0);
			expect(screen.queryByText(/no recent heartbeat to confirm/)).toBeNull();
			expect(screen.queryByText(/encoder has not bound any input/)).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps judging while the panel stays open: a heartbeat that goes stale after the pick raises the notice (review-334)", async () => {
		// The first response says fresh (serverNow 1 s after the sample); the
		// panel stays open; the next poll's serverNow is five minutes later with
		// the SAME sample — stale now. Without polling the verdict was frozen at
		// pick time: a false all-clear for as long as the panel stayed open.
		const at = "2026-08-28T12:00:00.000Z";
		let detailResponses = 0;
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.setSystemTime(Date.parse(at) + 1_000);
		try {
			mockPicker(
				{
					at,
					raw: {
						ingest: { status: "CONNECTED", healthy: true, streams: [] },
						events: [],
					},
					deltas: {},
				},
				() => {
					detailResponses += 1;
					return new Date(
						Date.parse(at) + (detailResponses === 1 ? 1_000 : 5 * 60_000),
					).toISOString();
				},
			);
			await pickChannel();
			// The list row AND the panel badge both say PUSHING — any is enough.
			expect((await screen.findAllByText(/PUSHING/)).length).toBeGreaterThan(0);
			expect(screen.queryByText(/no recent heartbeat to confirm/)).toBeNull();
			// The 15 s poll fires; the same sample is now stale on the server's clock.
			await vi.advanceTimersByTimeAsync(16_000);
			expect(
				await screen.findByText(/no recent heartbeat to confirm/),
			).toBeInTheDocument();
			expect(detailResponses).toBeGreaterThanOrEqual(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a picked channel with NO heartbeat reads as unconfirmed", async () => {
		mockPicker(null);
		await pickChannel();
		expect(
			await screen.findByText(/no recent heartbeat to confirm/),
		).toBeInTheDocument();
		expect(screen.queryByText(/encoder has not bound any input/)).toBeNull();
	});

	it("opens the section, lists channels, and mounts the feeder form for the picked one", async () => {
		apiFetch.mockImplementation(async (input: string) => {
			const url = String(input);
			if (url === "/api/credentials") {
				// The panel's SRT-passphrase pick filters this ARRAY — the
				// fallthrough object shape crashed the whole panel before the
				// protocol field could mount (surfaced when #129's help
				// triggers shifted render timing; the mock was always wrong).
				return [];
			}
			if (url === "/api/live-channels") {
				return {
					items: [{ id: "ch-1", name: "My Channel", status: "CREATED" }],
				};
			}
			if (url === "/api/live-channels/ch-1") {
				return {
					id: "ch-1",
					status: "CREATED",
					plan: {
						planVersion: 1,
						name: "ch",
						liveInput: { key: "main", kind: "RTMP" },
						start: { streamKey: "abcdef" },
					},
					streamKey: "abcdef",
					encoderIp: null,
				};
			}
			if (url.startsWith("/api/feeder-sessions")) {
				return { items: [] };
			}
			return { items: [] };
		});
		wrap(<FeedersClient />);
		fireEvent.click(await screen.findByText("Start file input"));
		fireEvent.click(screen.getByRole("button", { name: /browse storage/i }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Choose test MP4" }),
		);
		await screen.findByRole("option", { name: "My Channel" });
		fireEvent.change(screen.getByLabelText("Channel"), {
			target: { value: "ch-1" },
		});
		// The real shared FeederPanel mounts directly after source + channel.
		expect(
			await screen.findByLabelText(/protocol/i, { selector: "select" }),
		).toBeInTheDocument();
	});
});

/** A pre-structured row carrying the compatibility gate's old raw diagnostic. */
const MULTILINE_ERROR = [
	"Source does not match what this channel is ingesting (the source this run started on) — the encoder would warn on the attribute change and drop the input:",
	"resolution 1920×1080 → 1920×1012",
	"frame rate 30000/1001 → 24/1",
	"H.264 profile Main → High",
].join("\n");
const LEGACY_SAFE_ERROR =
	"The file input could not continue. Ask an administrator to review Diagnostics.";

describe("FeedersClient — concise, identifiable session rows", () => {
	it.each([
		"en",
		"ja",
	] as const)("shows channel names and accessible IDs (%s)", async (locale) => {
		const row = { ...session(), liveChannel: { name: "Morning programme" } };
		mockList([row]);
		wrap(<FeedersClient />, locale);
		const name = await screen.findByText("Morning programme");
		expect(name.closest("a")).toHaveAttribute(
			"href",
			`/live/${row.liveChannelId}`,
		);
		expect(name.closest("a")).toHaveAccessibleName(
			`Morning programme (${row.liveChannelId})`,
		);
		expect(
			screen.getByRole("link", { name: new RegExp(row.id) }),
		).toHaveAttribute("href", `/live/feeders/${row.id}`);
	});

	it.each([
		undefined,
		{ name: "" },
		{ name: "   " },
	])("falls back to the short ID for legacy or empty names: %j", async (liveChannel) => {
		const row = { ...session(), liveChannel };
		mockList([row]);
		wrap(<FeedersClient />);
		const link = await screen.findByRole("link", { name: row.liveChannelId });
		expect(link).toHaveTextContent(`${row.liveChannelId.slice(0, 8)}…`);
		expect(link).toHaveAttribute("href", `/live/${row.liveChannelId}`);
	});

	it.each([
		"en",
		"ja",
	] as const)("keeps failure details off the list and retains the detail link/status (%s)", async (locale) => {
		const row = session({ status: "ERROR", error: MULTILINE_ERROR });
		mockList([row]);
		wrap(<FeedersClient />, locale);
		expect(await screen.findByText("ERROR")).toBeInTheDocument();
		expect(screen.queryByText(LEGACY_SAFE_ERROR)).not.toBeInTheDocument();
		expect(
			screen.queryByText(/ファイル入力を継続できませんでした/),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText(/^Source does not match/),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: new RegExp(row.id) }),
		).toHaveAttribute("href", `/live/feeders/${row.id}`);
	});

	it("does not put a structured refusal on a stopped history row", async () => {
		mockList([
			session({
				status: "STOPPED",
				error: feederError("sourceMismatch", {
					originKind: "runSource",
					differences: "frame rate 30 → 24",
				}),
			}),
		]);
		wrap(<FeedersClient />, "ja");
		expect(await screen.findByText("STOPPED")).toBeInTheDocument();
		expect(
			screen.queryByText(/取り込み内容と一致しません/),
		).not.toBeInTheDocument();
	});
});

it("keeps loaded feeder sessions visible when a later page fails and retries that page", async () => {
	let failPage = true;
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/feeder-sessions")
			return { items: [session()], nextCursor: "older" };
		if (url.includes("cursor=older")) {
			if (failPage) throw new Error("offline");
			return {
				items: [session({ id: "older-session", sourceKey: "older.mp4" })],
			};
		}
		return [];
	});
	wrap(<FeedersClient />);
	await userEvent.click(
		await screen.findByRole("button", { name: "Load more" }),
	);
	await screen.findByRole("alert");
	expect(screen.getByText("bucket/clip.mp4")).toBeInTheDocument();
	failPage = false;
	await userEvent.click(screen.getByRole("button", { name: "Retry" }));
	expect(await screen.findByText("bucket/older.mp4")).toBeInTheDocument();
});
