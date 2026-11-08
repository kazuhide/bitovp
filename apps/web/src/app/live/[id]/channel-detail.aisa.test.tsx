import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery as renderWithQueryBase } from "@/test/render";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "../new/build-live-plan";
import { ChannelDetail as ChannelDetailBase } from "./channel-detail";

const ownerId = "00000000-0000-4000-8000-000000000099";
function ChannelDetail(props: Parameters<typeof ChannelDetailBase>[0]) {
	return <ChannelDetailBase aisaFeatureUserId={ownerId} {...props} />;
}

const apiFetch = vi.fn();
const replaceRoute = vi.fn();
const seen = vi.hoisted(() => ({
	bindings: [] as string[],
	snapshots: vi.fn(),
	privateProps: vi.fn(),
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
vi.mock("./feeder-panel", async (loadOriginal) => {
	const actual = await loadOriginal<typeof import("./feeder-panel")>();
	return {
		...actual,
		FeederPanel: (props: Parameters<typeof actual.FeederPanel>[0]) => {
			seen.privateProps("FeederPanel", props);
			return <actual.FeederPanel {...props} />;
		},
	};
});
vi.mock("./delivery-status-panel", async (loadOriginal) => {
	const actual = await loadOriginal<typeof import("./delivery-status-panel")>();
	return {
		...actual,
		DeliveryStatusPanel: (
			props: Parameters<typeof actual.DeliveryStatusPanel>[0],
		) => {
			seen.privateProps("DeliveryStatusPanel", props);
			return <actual.DeliveryStatusPanel {...props} />;
		},
	};
});
vi.mock("./archive-panel", async (loadOriginal) => {
	const actual = await loadOriginal<typeof import("./archive-panel")>();
	return {
		...actual,
		LiveArchivePanel: (
			props: Parameters<typeof actual.LiveArchivePanel>[0],
		) => {
			seen.privateProps("LiveArchivePanel", props);
			return <actual.LiveArchivePanel {...props} />;
		},
	};
});
vi.mock("./live-to-vod-panel", async (loadOriginal) => {
	const actual = await loadOriginal<typeof import("./live-to-vod-panel")>();
	return {
		...actual,
		LiveToVodPanel: (props: Parameters<typeof actual.LiveToVodPanel>[0]) => {
			seen.privateProps("LiveToVodPanel", props);
			return <actual.LiveToVodPanel {...props} />;
		},
	};
});
vi.mock("./ladder-panel", async (loadOriginal) => {
	const actual = await loadOriginal<typeof import("./ladder-panel")>();
	return {
		...actual,
		LadderPanel: (props: Parameters<typeof actual.LadderPanel>[0]) => {
			seen.privateProps("LadderPanel", props);
			return <actual.LadderPanel {...props} />;
		},
	};
});
vi.mock("@/components/step-timeline", async (loadOriginal) => {
	const actual =
		await loadOriginal<typeof import("@/components/step-timeline")>();
	return {
		...actual,
		StepTimeline: (props: Parameters<typeof actual.StepTimeline>[0]) => {
			seen.privateProps("StepTimeline", props);
			return <actual.StepTimeline {...props} />;
		},
	};
});
vi.mock("@/components/save-as-template", async (loadOriginal) => {
	const actual =
		await loadOriginal<typeof import("@/components/save-as-template")>();
	return {
		...actual,
		SaveAsTemplateButton: (
			props: Parameters<typeof actual.SaveAsTemplateButton>[0],
		) => {
			seen.privateProps("SaveAsTemplateButton", props);
			return <actual.SaveAsTemplateButton {...props} />;
		},
	};
});
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
		aisaFeatureAllowed: true,
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
	seen.privateProps.mockClear();
	replaceRoute.mockClear();
});
function respond(
	row: ReturnType<typeof fixture>,
	role: "ADMIN" | "OPERATOR" | "VIEWER" = "ADMIN",
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
				effectiveUserId: ownerId,
				actorUserId: ownerId,
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
		effectiveUserId: ownerId,
		actorUserId: ownerId,
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
	{ role: "ADMIN" as const, publicPayload: false },
	{ role: "VIEWER" as const, publicPayload: true },
	{ role: "OPERATOR" as const, publicPayload: true },
])("does not infer output waiting or no warnings from withheld AISA fields ($role, public=$publicPayload)", async ({
	role,
	publicPayload,
}) => {
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
			...(!publicPayload
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
		monitoringSafeForViewer: publicPayload,
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
	if (publicPayload) expect(encoder).not.toHaveTextContent("No warnings");
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
	await screen.findByRole("heading", { name: "Court 1" });
	await waitFor(() =>
		expect(rendered.client.getQueryData(["auth", "session"])).toMatchObject({
			role: "VIEWER",
		}),
	);
	expect(document.getElementById("sec-analysis")).toBeNull();
	expect(seen.bindings).toEqual([]);
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

it.each([
	{
		label: "denied server DTO",
		feature: false,
		binding: ownerId,
		role: "ADMIN",
		userId: ownerId,
		actorId: ownerId,
	},
	{
		label: "missing SSR binding with forged owner DTO",
		feature: true,
		binding: undefined,
		role: "ADMIN",
		userId: ownerId,
		actorId: ownerId,
	},
	{
		label: "other administrator",
		feature: true,
		binding: ownerId,
		role: "ADMIN",
		userId: "other-admin",
		actorId: "other-admin",
	},
	{
		label: "operator",
		feature: true,
		binding: ownerId,
		role: "OPERATOR",
		userId: ownerId,
		actorId: ownerId,
	},
	{
		label: "viewer",
		feature: true,
		binding: ownerId,
		role: "VIEWER",
		userId: ownerId,
		actorId: ownerId,
	},
	{
		label: "missing actor identity",
		feature: true,
		binding: ownerId,
		role: "ADMIN",
		userId: ownerId,
		actorId: undefined,
	},
])("hides all AISA entry points for $label while keeping ordinary Live monitoring", async ({
	feature,
	binding,
	role,
	userId,
	actorId,
}) => {
	const row = fixture(false);
	row.aisaFeatureAllowed = feature;
	respond(row);
	const respondNormally = apiFetch.getMockImplementation();
	apiFetch.mockImplementation((url: string) =>
		url === "/api/auth/session"
			? Promise.resolve({
					mode: "users",
					configured: true,
					authenticated: true,
					role,
					effectiveUserId: userId,
					actorUserId: actorId,
					organizationId: "org",
					isImpersonating: false,
				})
			: respondNormally?.(url),
	);
	const rendered = renderWithQuery(
		<ChannelDetail
			id={ID}
			aisaFeatureUserId={binding}
			initialAisaRun={selectedRun}
		/>,
	);
	await screen.findByRole("heading", { name: "Court 1" });
	await waitFor(() =>
		expect(rendered.client.getQueryData(["auth", "session"])).toMatchObject({
			role,
		}),
	);
	expect(document.getElementById("sec-analysis")).toBeNull();
	expect(document.querySelector('a[href="#sec-analysis"]')).toBeNull();
	expect(
		screen.queryByRole("button", { name: /View results for run/ }),
	).toBeNull();
	expect(screen.queryByRole("button", { name: "Stop channel" })).toBeNull();
	expect(screen.queryByRole("button", { name: /Copy settings/ })).toBeNull();
	expect(seen.bindings).toEqual([]);
	expect(seen.snapshots).not.toHaveBeenCalled();
	expect(
		apiFetch.mock.calls.some(([url]) => /\/api\/live\/analyses\//.test(url)),
	).toBe(false);
	expect(document.getElementById("sec-heartbeat")).not.toBeNull();
});

it("does not trust cached owner results after the fresh session request fails", async () => {
	respond(fixture(false));
	const normally = apiFetch.getMockImplementation();
	apiFetch.mockImplementation((url: string) =>
		url === "/api/auth/session"
			? Promise.reject(new Error("Session unavailable"))
			: normally?.(url),
	);
	const rendered = renderWithQuery(
		<ChannelDetail id={ID} initialAisaRun={selectedRun} />,
		{
			mode: "users",
			configured: true,
			authenticated: true,
			role: "ADMIN",
			actorUserId: ownerId,
			effectiveUserId: ownerId,
			organizationId: "org",
			isImpersonating: false,
		},
	);
	await screen.findByRole("heading", { name: "Court 1" });
	await waitFor(() =>
		expect(rendered.client.getQueryState(["auth", "session"])?.status).toBe(
			"error",
		),
	);
	expect(document.getElementById("sec-analysis")).toBeNull();
	expect(seen.bindings).toEqual([]);
	expect(seen.snapshots).not.toHaveBeenCalled();
	expect(
		apiFetch.mock.calls.some(([url]) => /\/api\/live\/analyses\//.test(url)),
	).toBe(false);
});

const privateOwnerMarkers = [
	"PrivateOwnerStream",
	"private-owner-encoder",
	"private-owner-plan",
	"private-owner-step",
	"private-owner-codec",
	"private-owner-heartbeat-event",
	"private-owner-vod-path",
	"private-owner-vod-detail",
	"private-owner-family-detail",
];
function cachedPrivateOwnerRow() {
	const row = fixture(false);
	const at = new Date().toISOString();
	const heartbeat = {
		at,
		raw: {
			ingest: {
				status: "CONNECTED",
				healthy: true,
				streams: [
					{
						streamId: "video",
						mediaType: "VIDEO",
						codec: "private-owner-codec",
					},
				],
			},
			events: [
				{
					details: {
						eventType: "WARNING",
						message: "private-owner-heartbeat-event",
					},
				},
			],
		},
	};
	const steps = [
		{
			step: "private-owner-step",
			kind: "CREATE_ENCODING",
			status: "DONE",
			payload: {},
			request: { streamKey: "PrivateOwnerStream" },
		},
	];
	const vod = {
		status: "ERROR",
		path: "private-owner-vod-path",
		technicalDetail: "private-owner-vod-detail",
		manifests: [],
	};
	Object.assign(row.plan, { name: "private-owner-plan" });
	if ("start" in row.plan) row.plan.start.streamKey = "PrivateOwnerStream";
	Object.assign(row, {
		serverNow: at,
		technicalDetailsAllowed: true,
		streamKey: "PrivateOwnerStream",
		encoderIp: "private-owner-encoder",
		stepLog: steps,
		lastHeartbeat: heartbeat,
		liveToVod: vod,
		liveToVodFamilies: {
			supported: [],
			unsupported: [
				{ family: "HLS", technicalDetail: "private-owner-family-detail" },
			],
		},
	});
	Object.assign(row.currentRun, {
		streamKey: "PrivateOwnerStream",
		encoderIp: "private-owner-encoder",
		stepLog: steps,
		lastHeartbeat: heartbeat,
		liveToVod: vod,
		providerStatus: "RUNNING",
		providerStatusObservedAt: at,
	});
	return row;
}
function latestPrivateProps(name: string) {
	const call = seen.privateProps.mock.calls
		.filter(([component]) => component === name)
		.at(-1);
	expect(call, `Expected real ${name} to render`).toBeDefined();
	return call?.[1] as Record<string, unknown>;
}
function expectPrivateOwnerDataWithheld() {
	const allProps = JSON.stringify(seen.privateProps.mock.calls);
	for (const marker of privateOwnerMarkers) {
		expect(allProps).not.toContain(marker);
		expect(document.body).not.toHaveTextContent(marker);
	}
	expect(latestPrivateProps("FeederPanel")).toMatchObject({
		plan: undefined,
		streamKey: null,
		encoderIp: null,
		readOnly: true,
	});
	expect(latestPrivateProps("DeliveryStatusPanel")).toMatchObject({
		lastHeartbeat: null,
		heartbeatReception: undefined,
		encoderIp: null,
		warningEvidenceAvailable: false,
	});
	expect(latestPrivateProps("LiveArchivePanel")).toMatchObject({
		plan: null,
		run: null,
	});
	expect(latestPrivateProps("LiveToVodPanel")).toMatchObject({
		record: null,
		families: null,
		technicalDetailsAllowed: false,
	});
	expect(document.getElementById("sec-analysis")).toBeNull();
	expect(document.getElementById("sec-steps")).toBeNull();
	expect(document.getElementById("sec-ingest")).toBeNull();
	expect(document.getElementById("sec-heartbeat")).not.toHaveTextContent(
		"CONNECTED",
	);
}

it.each([
	{ role: "ADMIN" as const, graph: "managed" },
	{ role: "OPERATOR" as const, graph: "managed" },
	{ role: "ADMIN" as const, graph: "unreadable" },
	{ role: "OPERATOR" as const, graph: "unreadable" },
])("withholds every private owner DTO prop while pending and after another fresh $role with $graph graph, then resumes safe monitoring", async ({
	role,
	graph,
}) => {
	const row = cachedPrivateOwnerRow();
	if (graph === "unreadable")
		Object.assign(row, { plan: { kind: "legacy-private-plan" } });
	respond(row);
	const normally = apiFetch.getMockImplementation();
	let resolveSession: (value: unknown) => void = () => {};
	const freshSession = new Promise((resolve) => {
		resolveSession = resolve;
	});
	apiFetch.mockImplementation((url: string) =>
		url === "/api/auth/session" ? freshSession : normally?.(url),
	);
	const cachedOwner = {
		mode: "users",
		configured: true,
		authenticated: true,
		role: "ADMIN",
		actorUserId: ownerId,
		effectiveUserId: ownerId,
		organizationId: "org",
		isImpersonating: false,
	};
	const rendered = renderWithQuery(<ChannelDetail id={ID} />, cachedOwner);
	await screen.findByRole("heading", { name: "Court 1" });
	expectPrivateOwnerDataWithheld();
	const otherId = "00000000-0000-4000-8000-000000000098";
	await act(async () =>
		resolveSession({
			...cachedOwner,
			role,
			actorUserId: otherId,
			effectiveUserId: otherId,
		}),
	);
	await waitFor(() =>
		expect(rendered.client.getQueryData(["auth", "session"])).toMatchObject({
			role,
			effectiveUserId: otherId,
		}),
	);
	expectPrivateOwnerDataWithheld();
	expect(
		apiFetch.mock.calls.some(([url]) =>
			/\/runs\/[^/]+\/heartbeats(?:\?|$)/.test(url),
		),
	).toBe(false);
	const safeHeartbeat = {
		at: new Date().toISOString(),
		raw: { ingest: { status: "CONNECTED", healthy: true, streams: [] } },
	};
	const safeRow = {
		...row,
		aisaFeatureAllowed: false,
		technicalDetailsAllowed: false,
		monitoringSafeForViewer: true,
		plan: {
			start: { aiSceneAnalysisLive: { preset: "AISA_PREVIEW_MANAGED" } },
		},
		streamKey: null,
		encoderIp: null,
		stepLog: [],
		lastHeartbeat: safeHeartbeat,
		liveToVod: null,
		liveToVodFamilies: null,
		currentRun: {
			...row.currentRun,
			aisaAnalysisId: null,
			aisaStatus: null,
			aisaSnapshot: null,
			streamKey: null,
			encoderIp: null,
			stepLog: [],
			lastHeartbeat: safeHeartbeat,
			liveToVod: null,
			originObservation: null,
		},
	};
	act(() => rendered.client.setQueryData(["live-channel", ID], safeRow));
	await waitFor(() =>
		expect(document.getElementById("sec-heartbeat")).toHaveTextContent(
			"CONNECTED",
		),
	);
	expect(latestPrivateProps("DeliveryStatusPanel").lastHeartbeat).toEqual(
		safeHeartbeat,
	);
	expect(latestPrivateProps("FeederPanel")).toMatchObject({
		plan: undefined,
		streamKey: null,
		encoderIp: null,
		readOnly: true,
	});
	for (const marker of privateOwnerMarkers)
		expect(JSON.stringify(seen.privateProps.mock.calls)).not.toContain(marker);
	expect(seen.bindings).toEqual([]);
});

it("retains the private operational DTO for the same freshly authenticated owner", async () => {
	respond(cachedPrivateOwnerRow());
	renderWithQuery(<ChannelDetail id={ID} />);
	await screen.findByTestId("aisa-analysis");
	await waitFor(() =>
		expect(latestPrivateProps("FeederPanel")).toMatchObject({
			streamKey: "PrivateOwnerStream",
			encoderIp: "private-owner-encoder",
			readOnly: false,
		}),
	);
	expect(latestPrivateProps("LiveArchivePanel").run).toMatchObject({
		streamKey: "PrivateOwnerStream",
	});
	expect(latestPrivateProps("LiveToVodPanel")).toMatchObject({
		record: {
			path: "private-owner-vod-path",
			technicalDetail: "private-owner-vod-detail",
		},
	});
});
