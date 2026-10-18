import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { DeliveryStatusPanel } from "./delivery-status-panel";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
const now = Date.parse("2026-09-07T00:00:00Z");
const sample = {
	at: new Date(now - 10_000).toISOString(),
	raw: { ingest: { status: "CONNECTED" } },
};
const freshOutput = {
	manifests: {
		hls: [{ manifestUpdates: [{ manifestUpdateWallClockTime: sample.at }] }],
	},
};
const lowRateInput = {
	ingest: {
		status: "CONNECTED",
		streams: [
			{
				mediaType: "VIDEO",
				incomingBitrate: 750000,
				rate: 30,
				samplesReadPerSecondAvg: 15,
			},
		],
	},
};
function push(
	raw: unknown = lowRateInput,
	sampledAt = sample.at,
): NonNullable<
	ComponentProps<typeof DeliveryStatusPanel>["heartbeatReception"]
> {
	return {
		state: "available",
		runId: "run-1",
		configuredIntervalS: 20,
		previousReceivedAt: null,
		latest: { receivedAt: sample.at, sampledAt, raw },
	};
}
function props(): ComponentProps<typeof DeliveryStatusPanel> {
	return {
		channelId: "ch-1",
		run: {
			id: "run-1",
			originObservation: {
				lastFetchAtMs: now - 5_000,
				lastVerdicts: {
					one: { stale: false, endlist: false, edgeDelaySeconds: 3 },
				},
			},
		},
		mode: "live",
		phase: "onair",
		lastHeartbeat: sample,
		openAlerts: [
			"INPUT_DISCONNECTED",
			"PROVIDER_WARNING",
			"ORIGIN_MANIFEST_STALE",
		].map((metric) => ({
			id: metric,
			openedAt: sample.at,
			resolvedAt: null,
			context: null,
			rule: { metric, severity: "WARN", threshold: null, windowPolls: 1 },
		})),
		alertHistory: [],
		playableCount: 1,
		manifestCount: 2,
		region: "AKAMAI_JP_OSA",
		encoderIp: "192.0.2.1",
		channelStatus: "RUNNING",
		providerStatus: "RUNNING",
		providerObservedAt: sample.at,
		nowMs: now,
		detailsOpen: () => false,
		detailsHelp: () => undefined,
	};
}
let health: Record<string, unknown>;
it.each([
	"ja",
	"en",
] as const)("shows a safe read-limit warning outside collapsed details despite healthy Push, then clears it in %s", async (locale) => {
	const p = {
		...props(),
		heartbeatReception: push({
			ingest: { status: "CONNECTED" },
			output: freshOutput,
		}),
		openAlerts: [],
	};
	p.run = {
		id: "run-1",
		originObservation: {
			lastFetchAtMs: now,
			playlistReadLimitReached: true,
			unavailableReason: "private-bucket/secret-key",
			lastVerdicts: {},
		},
	};
	const view = renderWithQuery(<DeliveryStatusPanel {...p} />, locale);
	const warning = await screen.findByText(/256 KiB/);
	const user = userEvent.setup();
	const explanation =
		locale === "ja"
			? /マニフェストのサイズと DVR 設定/
			: /Check manifest size and DVR settings/;
	expect(screen.queryByText(explanation)).toBeNull();
	const help = within(warning).getByRole("button");
	await user.click(help);
	expect(screen.getByRole("note")).toHaveTextContent(explanation);
	await user.keyboard("{Escape}");
	expect(screen.queryByRole("note")).toBeNull();
	expect(help).toHaveFocus();
	await user.keyboard("{Enter}");
	expect(screen.getByRole("note")).toHaveTextContent(explanation);
	await user.keyboard("{Escape}");
	expect(help).toHaveFocus();
	expect(warning).toHaveAttribute("role", "status");
	expect(warning).toHaveTextContent("256 KiB");
	expect(warning).toHaveClass("text-amber-300");
	expect(warning.closest("details")).toBeNull();
	expect(view.container).not.toHaveTextContent("private-bucket/secret-key");
	expect(
		view.container.querySelector('[data-lane="output"] [data-lane-lamp]'),
	).toHaveAttribute("data-lane-lamp", "on");
	view.rerender(<DeliveryStatusPanel {...p} run={props().run} />);
	expect(screen.queryByText(/256 KiB/)).toBeNull();
});

it.each([
	"ja",
	"en",
] as const)("supports historical reason codes without exposing the raw reason in %s", async (locale) => {
	const p = props();
	p.run = {
		id: "run-1",
		originObservation: {
			unavailableReason: "private/key: PLAYLIST_TRUNCATED_AT_256KIB",
			lastFetchAtMs: now,
		},
	};
	renderWithQuery(<DeliveryStatusPanel {...p} />, locale);
	expect(await screen.findByText(/256 KiB/)).toHaveAttribute("role", "status");
	expect(screen.queryByText(/private\/key/)).toBeNull();
});

it.each([
	"ja",
	"en",
] as const)("keeps source explanation available on demand in %s", async (locale) => {
	const user = userEvent.setup();
	renderWithQuery(<DeliveryStatusPanel {...props()} />, locale);
	const copy = locale === "ja" ? /新しい Push を優先し/ : /Fresh Push/;
	expect(screen.queryByText(copy)).toBeNull();
	const label =
		locale === "ja" ? /配信状態.*説明/ : /Delivery status.*more information/;
	await user.click(screen.getByRole("button", { name: label }));
	expect(screen.getByRole("note")).toHaveTextContent(/Push/);
	expect(screen.getByRole("note")).toHaveTextContent(/Poll/);
	await user.keyboard("{Escape}");
	expect(screen.queryByRole("note")).toBeNull();
});
beforeEach(() => {
	apiFetch.mockReset();
	health = {
		latest: { atMs: now, ingest: true, encoder: true, output: false },
		points: [],
		lanes: { ingest: [], encoder: [], output: [] },
		outputObservable: true,
		run: { id: "run-1", seq: 1, status: "RUNNING", createdAt: sample.at },
		truncated: false,
	};
	apiFetch.mockImplementation((url: string) =>
		url.endsWith("/health")
			? Promise.resolve(health)
			: Promise.resolve({ samples: [] }),
	);
});
function cell(name: string) {
	return document.querySelector(`[data-lane-cell="${name}"]`);
}
function inputMbps() {
	return within(screen.getByRole("article", { name: "Input" })).getByText(
		"In Mbps",
	).nextElementSibling;
}

describe("DeliveryStatusPanel", () => {
	it("prioritizes signed Push input and quality while preserving independently stalled output", async () => {
		const input = props();
		input.lastHeartbeat = {
			...sample,
			raw: { ingest: { status: "DISCONNECTED" } },
		};
		input.heartbeatReception = {
			state: "available",
			runId: "run-1",
			configuredIntervalS: 20,
			previousReceivedAt: null,
			latest: {
				receivedAt: sample.at,
				sampledAt: sample.at,
				raw: {
					ingest: {
						status: "CONNECTED",
						streams: [
							{
								mediaType: "VIDEO",
								incomingBitrate: 750000,
								rate: 30,
								samplesReadPerSecondAvg: 15,
							},
						],
					},
				},
			},
		};
		input.run = {
			id: "run-1",
			originObservation: {
				lastFetchAtMs: now,
				lastVerdicts: {
					one: { stale: true, endlist: false, edgeDelaySeconds: 3 },
				},
			},
		};
		renderWithQuery(<DeliveryStatusPanel {...input} />);
		expect(cell("ingest-state")).toHaveTextContent("Connected");
		expect(inputMbps()).toHaveTextContent("6.00");
		expect(
			screen.getByText("Output updates have stalled. Check output details."),
		).toBeInTheDocument();
		expect(
			screen.getByText("Input quality: 1 observations"),
		).toBeInTheDocument();
		expect(screen.getByText("Evidence: Push")).toBeInTheDocument();
		expect(
			screen.getByText(/average 15 fps \/ declared 30 fps/),
		).not.toBeVisible();
		await userEvent.click(screen.getByText("Input quality: 1 observations"));
		expect(screen.getByText(/average 15 fps \/ declared 30 fps/)).toBeVisible();
		expect(screen.getByText(/Input heuristics only/)).toBeVisible();
	});
	it("does not interpret missing Push or Poll as input disconnection", () => {
		renderWithQuery(
			<DeliveryStatusPanel {...props()} lastHeartbeat={null} run={null} />,
		);
		expect(cell("ingest-state")).toHaveTextContent("unknown");
		expect(
			screen.getByText(/Current input health is unconfirmed/),
		).toBeInTheDocument();
	});
	it.each([
		["en", "Origin observation unavailable", "Healthy"],
		["ja", "配信先の直接確認不可", "正常"],
	] as const)("distinguishes unavailable origin observation from healthy encoder output (%s)", async (locale, copy, healthy) => {
		health.latest = { atMs: now, ingest: true, encoder: true, output: true };
		const input = props();
		input.lastHeartbeat = {
			...sample,
			raw: { ingest: { status: "CONNECTED" }, output: freshOutput },
		};
		input.run = {
			id: "run-1",
			originObservation: {
				lastFetchAtMs: now - 5_000,
				lastVerdicts: {},
				unavailableReason: "MSL is not an object-storage driver",
			},
		};
		renderWithQuery(<DeliveryStatusPanel {...input} />, locale);
		await waitFor(() =>
			expect(
				document.querySelector('[data-lane="output"] [data-lane-lamp]'),
			).toHaveTextContent(healthy),
		);
		expect(cell("output-state")).toHaveTextContent(copy);
	});
	it.each([
		[754_499.56, "6.04"],
		[571_298.7702733343, "4.57"], // run 7 pull sample
		[568_148.8767848341, "4.55"], // run 8 pull sample
		[0, "0.00"],
		[undefined, "—"],
		[Number.NaN, "—"],
		["754499.56", "—"],
	])("converts measured incoming bytes/sec to Mbps (%s), never nominal bitrate", (incomingBitrate, expected) => {
		const lastHeartbeat = {
			...sample,
			raw: {
				ingest: {
					streams: [
						{ mediaType: "AUDIO", incomingBitrate: 128_000 },
						{ mediaType: "VIDEO", bitrate: 6_144_000, incomingBitrate },
					],
				},
			},
		};
		renderWithQuery(
			<DeliveryStatusPanel {...props()} lastHeartbeat={lastHeartbeat} />,
		);
		expect(inputMbps()).toHaveTextContent(expected);
	});
	it("consolidates lane readings, alerts and detail anchors with one health request", async () => {
		renderWithQuery(<DeliveryStatusPanel {...props()} />);
		await waitFor(() =>
			expect(
				document.querySelector('[data-lane="ingest"] [data-lane-lamp]'),
			).toHaveTextContent("Healthy"),
		);
		expect(
			document.querySelector('[data-lane="output"] [data-lane-lamp]'),
		).toHaveTextContent("Healthy");
		expect(cell("ingest-state")).toHaveTextContent("Connected");
		expect(cell("ingest-last-seen")).toHaveTextContent("Last seen 10s ago");
		for (const lane of ["ingest", "encoder", "output"])
			expect(cell(`${lane}-alerts`)).toHaveTextContent("Open alerts: 1");
		expect(document.getElementById("sec-heartbeat-h")?.tagName).toBe("H4");
		expect(document.getElementById("sec-origin-h")?.tagName).toBe("H4");
		expect(
			screen.getByRole("link", { name: "Playback links" }),
		).toHaveAttribute("href", "#sec-manifests");
		expect(
			apiFetch.mock.calls.filter(([url]) => url.endsWith("/health")),
		).toHaveLength(1);
	});
	it.each([
		["en", "Ended", "None"],
		["ja", "終了", "なし"],
	] as const)("finished cards show localized ended and neutral no-input state (%s)", async (locale, ended, none) => {
		renderWithQuery(
			<DeliveryStatusPanel
				{...props()}
				mode="finished"
				phase="finished"
				channelStatus="STOPPED"
			/>,
			locale,
		);
		expect(screen.getAllByText(ended)).toHaveLength(3);
		expect(cell("ingest-state")).toHaveTextContent(none);
		if (locale === "ja")
			expect(cell("ingest-state")).not.toHaveTextContent("None");
		expect(cell("ingest-last-seen")).not.toHaveTextContent("ago");
		await waitFor(() =>
			expect(apiFetch).toHaveBeenCalledWith(
				expect.stringContaining("runId=run-1"),
			),
		);
	});
	it("DASH-only output is unobservable and unavailable alerts stay unknown", async () => {
		health.outputObservable = false;
		renderWithQuery(
			<DeliveryStatusPanel
				{...props()}
				run={{ id: "run-1", originObservation: null }}
				openAlerts="unknown"
			/>,
		);
		await waitFor(() =>
			expect(
				document.querySelector('[data-lane="output"] [data-lane-lamp]'),
			).toHaveTextContent("Not measurable (no HLS)"),
		);
		for (const lane of ["ingest", "encoder", "output"])
			expect(cell(`${lane}-alerts`)).toHaveTextContent("Unknown");
	});
	it("a failed history endpoint does not erase independent fresh Poll, provider and origin observations", async () => {
		const view = renderWithQuery(<DeliveryStatusPanel {...props()} />);
		await waitFor(() =>
			expect(
				document.querySelector('[data-lane="ingest"] [data-lane-lamp]'),
			).toHaveTextContent("Healthy"),
		);
		apiFetch.mockImplementation((url: string) =>
			url.endsWith("/health")
				? Promise.reject(new Error("offline"))
				: Promise.resolve({ samples: [] }),
		);
		await view.client.invalidateQueries({
			queryKey: ["run-health", "ch-1", "run-1"],
		});
		await screen.findByText("Could not load stream health.");
		for (const lane of ["ingest", "encoder", "output"])
			expect(
				document.querySelector(`[data-lane="${lane}"] [data-lane-lamp]`),
			).toHaveTextContent("Healthy");
	});
	it.each([
		[null, "never"],
		["invalid", "never"],
		[new Date(now + 1000).toISOString(), "clock skew"],
		[new Date(now + 6000).toISOString(), "never"],
	])("bounds malformed/future samples without calling clock skew a recent receipt (%s)", (at, expected) => {
		renderWithQuery(
			<DeliveryStatusPanel
				{...props()}
				run={null}
				lastHeartbeat={{ ...sample, at }}
			/>,
		);
		expect(cell("ingest-last-seen")?.textContent?.toLowerCase()).toContain(
			expected,
		);
		expect(apiFetch.mock.calls.some(([url]) => url.endsWith("/health"))).toBe(
			false,
		);
	});
	it("starting without a sample says Starting; unknown live input is not None", async () => {
		const view = renderWithQuery(
			<DeliveryStatusPanel
				{...props()}
				phase="starting"
				run={null}
				lastHeartbeat={null}
			/>,
		);
		expect(cell("ingest-state")).toHaveTextContent("Starting");
		view.rerender(
			<DeliveryStatusPanel {...props()} run={null} lastHeartbeat={null} />,
		);
		expect(cell("ingest-state")).toHaveTextContent("unknown");
		await waitFor(() => expect(apiFetch).toHaveBeenCalled());
	});

	it("does not revive stale readings from a healthy historical health endpoint", async () => {
		const old = new Date(now - 120_000).toISOString();
		renderWithQuery(
			<DeliveryStatusPanel
				{...props()}
				run={{ id: "run-1", originObservation: null }}
				lastHeartbeat={{ at: old, raw: lowRateInput }}
				providerObservedAt={old}
				heartbeatReception={push(lowRateInput, old)}
			/>,
		);
		await waitFor(() =>
			expect(apiFetch.mock.calls.some(([url]) => url.endsWith("/health"))).toBe(
				true,
			),
		);
		for (const lane of ["ingest", "encoder", "output"])
			expect(
				document.querySelector(`[data-lane="${lane}"] [data-lane-lamp]`),
			).toHaveTextContent("unknown");
		expect(screen.getByText("Evidence: —")).toBeInTheDocument();
		expect(inputMbps()).toHaveTextContent("—");
		expect(screen.queryByText(/Input quality:/)).not.toBeInTheDocument();
	});

	it("falls back from stale Push to fresh Poll for both input metrics and quality", async () => {
		renderWithQuery(
			<DeliveryStatusPanel
				{...props()}
				heartbeatReception={push(
					{ ingest: { status: "DISCONNECTED" } },
					new Date(now - 120_000).toISOString(),
				)}
				lastHeartbeat={{
					...sample,
					raw: { ...lowRateInput, timestamp: sample.at },
				}}
			/>,
		);
		expect(screen.getByText("Evidence: Poll")).toBeInTheDocument();
		expect(cell("ingest-state")).toHaveTextContent("Connected");
		expect(inputMbps()).toHaveTextContent("6.00");
		await userEvent.click(screen.getByText("Input quality: 1 observations"));
		expect(screen.getByText(/average 15 fps \/ declared 30 fps/)).toBeVisible();
	});

	it("keeps a finished Push sample as history without current quality warnings", () => {
		renderWithQuery(
			<DeliveryStatusPanel
				{...props()}
				mode="finished"
				phase="finished"
				channelStatus="STOPPED"
				heartbeatReception={push()}
				lastHeartbeat={null}
			/>,
		);
		expect(inputMbps()).toHaveTextContent("6.00");
		expect(cell("ingest-state")).toHaveTextContent("None");
		expect(screen.queryByText(/Input quality:/)).not.toBeInTheDocument();
		expect(screen.queryByText(/average 15 fps/)).not.toBeInTheDocument();
	});

	it("uses the provider sample clock, not the later Poll receipt, for packet-arrival age", () => {
		const providerAt = new Date(now - 20_000).toISOString();
		renderWithQuery(
			<DeliveryStatusPanel
				{...props()}
				lastHeartbeat={{
					at: new Date(now).toISOString(),
					raw: {
						timestamp: providerAt,
						ingest: {
							status: "CONNECTED",
							streams: [
								{
									mediaType: "VIDEO",
									lastArrivalTime: providerAt,
									rate: 30,
									samplesReadPerSecondAvg: 30,
								},
							],
						},
					},
				}}
			/>,
		);
		expect(cell("ingest-state")).toHaveTextContent("Connected");
		expect(screen.queryByText(/Input quality:/)).not.toBeInTheDocument();
	});

	it("missing HLS is unknown, not stalled, and an observed Push output overrides a no-HLS history flag", async () => {
		const view = renderWithQuery(
			<DeliveryStatusPanel
				{...props()}
				run={{ id: "run-1", originObservation: null }}
			/>,
		);
		expect(
			document.querySelector('[data-lane="output"] [data-lane-lamp]'),
		).toHaveTextContent("unknown");
		health.outputObservable = false;
		await view.client.invalidateQueries({
			queryKey: ["run-health", "ch-1", "run-1"],
		});
		view.rerender(
			<DeliveryStatusPanel
				{...props()}
				run={{ id: "run-1", originObservation: null }}
				heartbeatReception={push({
					ingest: { status: "CONNECTED" },
					output: freshOutput,
				})}
			/>,
		);
		expect(
			document.querySelector('[data-lane="output"] [data-lane-lamp]'),
		).toHaveTextContent("Healthy");
	});
});
