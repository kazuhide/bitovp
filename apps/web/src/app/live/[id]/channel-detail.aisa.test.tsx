import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery as renderWithQueryBase } from "@/test/render";
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

function renderWithQuery(node: ReactNode, cachedSession?: unknown) {
	const rendered = renderWithQueryBase(<div />);
	// Production's 15s freshness prevents newly mounted RoleAccess readers
	// from repeatedly refetching and remounting fresh-session-gated sections.
	// ChannelDetail still forces a fresh session request on every mount.
	rendered.client.setDefaultOptions({
		queries: { retry: false, staleTime: 15_000 },
	});
	if (cachedSession)
		rendered.client.setQueryData(["auth", "session"], cachedSession);
	rendered.rerender(node);
	return rendered;
}

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
		stepLog: [] as unknown[],
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
		stepLog: [] as unknown[],
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
	window.history.replaceState(null, "", "/");
	apiFetch.mockReset();
	seen.bindings = [];
	seen.snapshots.mockClear();
	replaceRoute.mockClear();
});
function respond(
	row: ReturnType<typeof fixture>,
	role: "OPERATOR" | "VIEWER" = "OPERATOR",
) {
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
				role,
				effectiveUserId: "operator",
				organizationId: "org",
				isImpersonating: false,
			};
		if (/\/runs\/[^/]+\/health$/.test(url))
			return {
				points: [],
				lanes: {},
				run: row.currentRun,
				truncated: false,
				outputObservable: true,
			};
		if (url.includes("/alerts")) return { open: [], history: [] };
		if (url.includes("/feeder")) return { items: [] };
		if (url.includes("/heartbeats")) return { items: [], truncated: false };
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
	expect(screen.getByText(/Its settings cannot be changed/)).toBeVisible();
	expect(screen.getByTestId("aisa-analysis")).toHaveTextContent(
		`${analysisId}:${encodingId}`,
	);
	expect(
		screen.queryByRole("button", { name: /Start a new broadcast/ }),
	).toBeNull();
	expect(screen.queryByRole("button", { name: /Copy settings/ })).toBeNull();
	expect(
		screen.getByRole("heading", { name: "DVR / timeshift" }),
	).toBeVisible();
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

it("keeps managed lifecycle controls and read-only operational sections", async () => {
	respond(fixture(false));
	renderWithQuery(<ChannelDetail id={ID} />);
	await screen.findByRole("heading", { name: "Court 1" });
	expect(
		await screen.findByRole("button", { name: "Stop channel" }),
	).toBeVisible();
	expect(screen.queryByRole("button", { name: /Restart/ })).toBeNull();
	expect(
		screen.getByRole("button", { name: "Actions — more information" }),
	).toBeVisible();
	expect(screen.getByRole("button", { name: /Copy settings/ })).toBeVisible();
	expect(screen.getByTestId("aisa-analysis")).toHaveTextContent(
		`${analysisId}:${encodingId}`,
	);
	expect(
		screen.getByRole("heading", { name: "DVR / timeshift" }),
	).toBeVisible();
	expect(screen.getByRole("heading", { name: "Live-to-VOD" })).toBeVisible();
	expect(
		screen.getByRole("heading", { name: "Slate reservations" }),
	).toBeVisible();
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
			"The requested run is unavailable in this channel.",
		),
	).toBeVisible();
	expect(screen.queryByTestId("aisa-analysis")).toBeNull();
	expect(seen.bindings).toEqual([]);
});

it.each([
	false,
	true,
])("keeps ordinary monitoring with supplementary key moments (imported=%s)", async (imported) => {
	respond(fixture(imported, imported ? "STOPPED" : "RUNNING"));
	renderWithQuery(<ChannelDetail id={ID} />);
	await screen.findByRole("heading", { name: "Court 1" });
	expect(
		screen.getByRole("figure", { name: "Encoder lifecycle" }),
	).toBeVisible();
	expect(
		screen.getByRole("heading", { name: "Channel state", level: 2 }),
	).toBeVisible();
	expect(
		screen.getByRole("heading", { name: "Key moments", level: 3 }),
	).toBeVisible();
	expect(document.querySelectorAll("#sec-analysis")).toHaveLength(1);
	expect(screen.queryByText("AISA Live Preview")).toBeNull();
	expect(screen.getByRole("region", { name: "Channel status" })).toBeVisible();
	expect(screen.getByRole("region", { name: "Next action" })).toBeVisible();
	expect(
		screen.getByRole("heading", { name: "Delivery status" }),
	).toBeVisible();
	for (const section of [
		"sec-alerts",
		"sec-manifests",
		"sec-heartbeat",
		"sec-origin",
		"sec-heartbeat-log",
		"sec-alert-rules",
		"sec-schedule",
		"sec-feeders",
		"sec-ladder",
		"sec-runtime-cap",
	]) {
		expect(document.getElementById(section), section).toBeInTheDocument();
	}
	expect(
		screen.getByText("Alerts, manifests and slate reservations"),
	).toBeVisible();
	expect(
		screen.getByText(
			"Raw telemetry, past runs, and the settings you change once.",
		),
	).toBeVisible();
	if (!imported) expect(screen.queryByText("③ Waiting for input")).toBeNull();
	expect(screen.getByTestId("aisa-analysis")).not.toBeVisible();
	await waitFor(() => {
		for (const url of [
			`/api/live-channels/${ID}/alerts`,
			`/api/live-channels/${ID}/schedules`,
			`/api/feeder-sessions?liveChannelId=${ID}`,
		])
			expect(apiFetch.mock.calls.some(([requested]) => requested === url)).toBe(
				true,
			);
	});
	expect(
		apiFetch.mock.calls.some(
			([, init]) => init?.method && init.method !== "GET",
		),
	).toBe(false);
});

it("keeps current-run monitoring when a historical analysis is selected", async () => {
	respond(fixture(false));
	renderWithQuery(<ChannelDetail id={ID} initialAisaRun={selectedRun} />);
	await screen.findByTestId("aisa-analysis");
	await waitFor(() =>
		expect(
			apiFetch.mock.calls.some(
				([url]) => url === `/api/live-channels/${ID}/runs/current/health`,
			),
		).toBe(true),
	);
	expect(
		apiFetch.mock.calls.some(
			([url]) => url === `/api/live-channels/${ID}/runs/older/health`,
		),
	).toBe(false);
	expect(screen.getByTestId("aisa-analysis")).toHaveTextContent(
		`${oldAnalysis}:${oldEncoding}`,
	);
});

it("reports failed monitoring reads as unavailable rather than healthy zero", async () => {
	respond(fixture(false));
	const normalResponse = apiFetch.getMockImplementation();
	apiFetch.mockImplementation(async (url: string) => {
		if (
			url.endsWith("/alerts") ||
			url.endsWith("/schedules") ||
			url.includes("/feeder-sessions?")
		)
			throw new Error("Synthetic monitoring failure");
		return normalResponse?.(url);
	});
	renderWithQuery(<ChannelDetail id={ID} />);
	await screen.findByRole("region", { name: "Channel status" });
	expect(
		document.querySelector('[data-status-cell="alerts"]'),
	).toHaveTextContent("unknown");
	expect(
		document.querySelector('[data-status-cell="feeders"]'),
	).toHaveTextContent("unknown");
	expect(
		document.querySelector('[data-status-cell="next-event"]'),
	).toHaveTextContent("could not be read");
});

it("withholds cached operator telemetry and raw logs while a fresh session is pending, then permits safe viewer monitoring", async () => {
	const row = fixture(false);
	const privateHeartbeat = {
		at: now,
		raw: {
			ingest: {
				status: "CONNECTED",
				streams: [
					{ streamId: "video", mediaType: "VIDEO", codec: "private-codec" },
				],
			},
			events: [
				{
					details: { eventType: "WARNING", message: "private-heartbeat-event" },
				},
			],
		},
	};
	Object.assign(row, {
		encoderIp: "private-encoder",
		lastHeartbeat: privateHeartbeat,
	});
	Object.assign(row.currentRun, {
		encoderIp: "private-encoder",
		lastHeartbeat: privateHeartbeat,
	});
	respond(row);
	const normalResponse = apiFetch.getMockImplementation();
	let resolveSession: (value: unknown) => void = () => {};
	const session = new Promise((resolve) => {
		resolveSession = resolve;
	});
	apiFetch.mockImplementation((url: string) =>
		url === "/api/auth/session" ? session : normalResponse?.(url),
	);
	const cachedOperator = {
		mode: "users",
		configured: true,
		authenticated: true,
		role: "OPERATOR",
		organizationId: "org",
		effectiveUserId: "operator",
		isImpersonating: false,
	};
	const rendered = renderWithQuery(<ChannelDetail id={ID} />, cachedOperator);
	await screen.findByRole("heading", { name: "Court 1" });
	for (const value of [
		"private-codec",
		"private-heartbeat-event",
		"private-encoder",
		"TennisMatch",
	])
		expect(document.body).not.toHaveTextContent(value);
	expect(
		apiFetch.mock.calls.some(([url]) =>
			/\/runs\/[^/]+\/heartbeats(?:\?|$)/.test(url),
		),
	).toBe(false);
	expect(document.getElementById("sec-heartbeat-log")).toHaveTextContent(
		/operator/i,
	);

	await act(async () => resolveSession({ ...cachedOperator, role: "VIEWER" }));
	await waitFor(() =>
		expect(rendered.client.getQueryData(["auth", "session"])).toMatchObject({
			role: "VIEWER",
		}),
	);
	const publicRow = {
		...row,
		monitoringSafeForViewer: true,
		lastHeartbeat: null,
		currentRun: {
			...row.currentRun,
			lastHeartbeat: {
				at: new Date().toISOString(),
				raw: { ingest: { status: "CONNECTED", healthy: true, streams: [] } },
			},
		},
	};
	act(() => rendered.client.setQueryData(["live-channel", ID], publicRow));
	await waitFor(() =>
		expect(document.getElementById("sec-heartbeat")).toHaveTextContent(
			"CONNECTED",
		),
	);
	for (const value of [
		"private-codec",
		"private-heartbeat-event",
		"private-encoder",
		"TennisMatch",
	])
		expect(document.body).not.toHaveTextContent(value);
	expect(
		apiFetch.mock.calls.some(([url]) =>
			/\/runs\/[^/]+\/heartbeats(?:\?|$)/.test(url),
		),
	).toBe(false);
});

it("opens the supplementary results for an explicit deep link", async () => {
	window.history.replaceState(null, "", `#sec-analysis`);
	respond(fixture(false));
	renderWithQuery(<ChannelDetail id={ID} />);
	await waitFor(() =>
		expect(screen.getByTestId("aisa-analysis")).toBeVisible(),
	);
	window.history.replaceState(null, "", "/");
});

it.each([
	true,
	false,
])("protects cached technical diagnostics when the fresh ADMIN session is impersonating (%s)", async (isImpersonating) => {
	const row = fixture(false);
	Object.assign(row, { technicalDetailsAllowed: true });
	respond(row);
	const normalResponse = apiFetch.getMockImplementation();
	let resolveSession: (value: unknown) => void = () => {};
	const session = new Promise((resolve) => {
		resolveSession = resolve;
	});
	apiFetch.mockImplementation((url: string) => {
		if (url === "/api/auth/session") return session;
		if (url.endsWith("/normalizations")) return new Promise(() => {});
		return normalResponse?.(url);
	});
	const cachedAdmin = {
		mode: "users",
		configured: true,
		authenticated: true,
		role: "ADMIN",
		organizationId: "org",
		effectiveUserId: "admin",
		isImpersonating: false,
	};
	const rendered = renderWithQuery(<ChannelDetail id={ID} />, cachedAdmin);
	await screen.findByRole("heading", { name: "Court 1" });
	act(() =>
		rendered.client.setQueryData(["live-slate-normalizations", ID], {
			items: [
				{
					id: "failed",
					name: "Cached failed clip",
					bucket: "fixture",
					sourceKey: "clip.ts",
					status: "ERROR",
					error: "private-normalization-error",
				},
				{
					id: "pending",
					name: "Cached pending clip",
					bucket: "fixture",
					sourceKey: "clip.ts",
					status: "QUEUED",
					note: "private-normalization-note",
				},
			],
		}),
	);
	await screen.findByText("Cached failed clip");
	expect(document.body).not.toHaveTextContent("private-normalization-error");
	await act(async () => resolveSession({ ...cachedAdmin, isImpersonating }));
	await waitFor(() =>
		expect(rendered.client.getQueryData(["auth", "session"])).toMatchObject({
			role: "ADMIN",
			isImpersonating,
		}),
	);
	await waitFor(() => {
		for (const text of [
			"private-normalization-error",
			"private-normalization-note",
		]) {
			if (isImpersonating) expect(document.body).not.toHaveTextContent(text);
			else expect(document.body).toHaveTextContent(text);
		}
	});
	expect(document.body).toHaveTextContent("Cached failed clip");
});

it("shows unresolved AISA playback availability without a zero manifest count", async () => {
	const row = fixture(false);
	Object.assign(row, { playbackLinksAvailability: "unavailable" });
	respond(row);
	renderWithQuery(<ChannelDetail id={ID} />);
	await screen.findByRole("region", { name: "Channel status" });
	expect(
		document.querySelector('[data-status-cell="playable"]'),
	).toHaveTextContent("unknown");
	expect(document.getElementById("sec-manifests")).toHaveTextContent(
		"could not be read",
	);
});

it.each([
	"OPERATOR",
	"VIEWER",
] as const)("does not infer output waiting or no warnings from withheld AISA fields (%s)", async (role) => {
	const row = fixture(false);
	const at = new Date().toISOString();
	const heartbeat = {
		at,
		raw: {
			ingest: { status: "CONNECTED", healthy: true },
			output: {
				manifests: {
					hls: [{ manifestUpdates: [{ manifestUpdateWallClockTime: at }] }],
				},
			},
			...(role === "OPERATOR"
				? {
						events: [
							{
								time: at,
								details: {
									eventType: "WARNING",
									message: "operator-warning-evidence",
								},
							},
						],
					}
				: {}),
		},
	};
	Object.assign(row, {
		playbackLinksAvailability: "unavailable",
		monitoringSafeForViewer: role === "VIEWER",
		serverNow: at,
		lastHeartbeat: heartbeat,
	});
	Object.assign(row.currentRun, {
		lastHeartbeat: heartbeat,
		providerStatus: "RUNNING",
		providerStatusObservedAt: at,
	});
	respond(row, role);
	renderWithQuery(<ChannelDetail id={ID} />);
	await waitFor(() =>
		expect(
			document.querySelector('[data-next-action="OUTPUT_UNKNOWN"]'),
		).toBeInTheDocument(),
	);
	expect(
		document.querySelector('[data-next-action="OUTPUT_UNKNOWN"] a'),
	).toHaveAttribute("href", "#sec-origin");
	expect(
		document.querySelector('[data-next-action="WAIT_FOR_OUTPUT"]'),
	).toBeNull();
	const encoder = document.querySelector('[data-lane="encoder"]');
	if (role === "VIEWER") expect(encoder).not.toHaveTextContent("No warnings");
	else
		await waitFor(() =>
			expect(encoder).toHaveTextContent("operator-warning-evidence"),
		);
});

it.each([
	[analysisId, encodingId, "2 moments"],
	[oldAnalysis, encodingId, "Waiting for key moments."],
	[analysisId, oldEncoding, "Waiting for key moments."],
])("summarizes only a valid snapshot bound to this analysis and encoding (%s, %s)", async (snapshotAnalysis, snapshotEncoding, expected) => {
	const row = fixture(false);
	Object.assign(row.currentRun, {
		aisaSnapshot: {
			analysisId: snapshotAnalysis,
			encodingId: snapshotEncoding,
			sequence: 1,
			producedAt: now,
			mediaTimeOriginUnixMs: Date.parse(now),
			isFinal: true,
			analyzedStartTimeSeconds: 0,
			analyzedEndTimeSeconds: 20,
			metadata: { version: "synthetic", disclaimer: "Synthetic fixture" },
			observations: [
				{
					id: "obs-one",
					text: "A goal",
					startTimeSeconds: 0,
					endTimeSeconds: 10,
				},
			],
			keyMoments: ["one", "two"].map((id) => ({
				id,
				lastUpdatedSequence: 1,
				importanceLevel: 1,
				startInSeconds: 2,
				endInSeconds: 8,
				anchorInSeconds: 4,
				observations: ["obs-one"],
				categories: ["soccer"],
			})),
		},
	});
	respond(row);
	renderWithQuery(<ChannelDetail id={ID} />);
	await screen.findByRole("heading", { name: "Court 1" });
	expect(document.querySelector("#sec-analysis > summary")).toHaveTextContent(
		expected,
	);
	expect(screen.getByTestId("aisa-analysis")).not.toBeVisible();
});

it("keeps operator ingest and cached step payloads out of a viewer console", async () => {
	const row = fixture(false);
	row.currentRun.stepLog = [
		{
			step: "private-ingest-payload",
			kind: "CREATE_ENCODING",
			status: "DONE",
			payload: {},
			request: { streamKey: "private-stream-key" },
		},
	];
	respond(row, "VIEWER");
	const rendered = renderWithQuery(<ChannelDetail id={ID} />);
	await screen.findByTestId("aisa-analysis");
	await waitFor(() =>
		expect(rendered.client.getQueryData(["auth", "session"])).toMatchObject({
			role: "VIEWER",
		}),
	);
	expect(document.getElementById("sec-steps")).toBeNull();
	expect(screen.queryByRole("heading", { name: "Danger zone" })).toBeNull();
	expect(
		screen.queryByRole("link", { name: "Delete this channel" }),
	).toBeNull();
	expect(document.getElementById("sec-ingest")).toBeNull();
	expect(document.body).not.toHaveTextContent("private-ingest-payload");
	expect(document.body).not.toHaveTextContent("private-stream-key");
	expect(apiFetch.mock.calls.some(([url]) => url.includes("/ingest?"))).toBe(
		false,
	);
});
