import type { LiveChannelPlan } from "@bitovp/core";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { FeederPanel } from "./feeder-panel";

/**
 *  — the feeder panel's TARGET PREFILL, pinned at the product path.
 *
 * The defect: a `live-redundant-rtmp` channel provisioned, reached RUNNING,
 * accepted a feeder session and wrote ZERO objects. Root cause measured
 * 2026-08-15: a redundant input's points declare their own application name
 * and stream key (`liveA`/`primaryFeed`), and the panel prefilled the
 * simple-RTMP convention `rtmp://<ip>/live` with the channel-level key. The
 * encoder listens at `liveA`; nothing arrives; no segments are written.
 *
 * The fix already existed in `defaultFeederTarget`, docstring and measured
 * evidence and all — but `feederTargetFields`, the ONLY function the panel
 * calls, had no such parameter, so the correct call would not have compiled.
 * `feeder-shared.test.ts` exercised the inner helper directly and stayed
 * green over a broken product. That is why this file renders the PANEL: the
 * helper was never the population under test.
 */

const CHANNEL_ID = "00000000-0000-4000-8000-000000000046";
const ENCODER_IP = "203.0.113.46";

function planWith(liveInput: unknown): LiveChannelPlan {
	return {
		planVersion: 1,
		name: "redundant",
		bitmovin: { accountId: "00000000-0000-4000-8000-0000000000a4" },
		liveInput,
		outputs: [],
		ingest: [],
		renditions: [],
		muxings: [],
		liveManifests: [],
		start: { streamKey: "channelLevelKey" },
	} as unknown as LiveChannelPlan;
}

function render(plan: LiveChannelPlan) {
	return renderWithQuery(
		<FeederPanel
			channelId={CHANNEL_ID}
			channelStatus="RUNNING"
			plan={plan}
			streamKey="channelLevelKey"
			encoderIp={ENCODER_IP}
		/>,
	);
}

/** Open the create form — the target fields only exist once it is shown. */
async function openForm() {
	const [toggle] = screen.getAllByRole("button", {
		name: /feed|file input|new session/i,
	});
	if (!toggle) throw new Error("feeder panel rendered no create-form toggle");
	await userEvent.click(toggle);
}

beforeEach(() => {
	vi.clearAllMocks();
	// Two queries with two DIFFERENT wire shapes: the session list is paged
	// (`.items`, probed by the poll-interval option on every options pass) and
	// the credential list is a bare array (`.filter`). One blanket mock value
	// crashes whichever query it does not match — and the crash unmounts the
	// panel, so the failure reads as "field not found", not as a throw.
	apiFetch.mockImplementation((path: unknown) =>
		Promise.resolve(
			String(path).includes("/api/credentials") ? [] : { items: [] },
		),
	);
});

describe("FeederPanel target prefill (ledger #46)", () => {
	it("warns when a feeder is PUSHING and the encoder never bound — and stays quiet once bound (ledger #95)", async () => {
		apiFetch.mockImplementation((path: unknown) =>
			Promise.resolve(
				String(path).includes("/api/credentials")
					? []
					: {
							items: [
								{
									id: "fs-1",
									status: "PUSHING",
									protocol: "RTMP",
									sourceBucket: "in",
									sourceKey: "loop.mp4",
									startedAt: "2026-08-15T00:54:00.000Z",
									stoppedAt: null,
									error: null,
									loopBoundaries: [],
									logTail: [],
									createdAt: "2026-08-15T00:53:00.000Z",
								},
							],
						},
			),
		);
		renderWithQuery(
			<FeederPanel
				channelId={CHANNEL_ID}
				channelStatus="RUNNING"
				plan={planWith({ key: "main", kind: "RTMP", name: "RTMP Input" })}
				streamKey="channelLevelKey"
				encoderIp={ENCODER_IP}
				ingestConnected={false}
			/>,
		);
		expect(
			await screen.findByText(/encoder has not bound any input/),
		).toBeInTheDocument();

		cleanup();
		renderWithQuery(
			<FeederPanel
				channelId={CHANNEL_ID}
				channelStatus="RUNNING"
				plan={planWith({ key: "main", kind: "RTMP", name: "RTMP Input" })}
				streamKey="channelLevelKey"
				encoderIp={ENCODER_IP}
				ingestConnected={true}
			/>,
		);
		await screen.findByText(/PUSHING/);
		expect(screen.queryByText(/encoder has not bound any input/)).toBeNull();
	});

	/**
	 *  — the immediate switch. The option exists only while a feeder
	 * is active (there is nothing to switch from otherwise), and choosing it
	 * relabels the submit: this create stages first and swaps after.
	 */
	it("offers the two-phase switch only while a feeder is active, and relabels the submit when chosen", async () => {
		const listWith = (items: Record<string, unknown>[]) =>
			apiFetch.mockImplementation((path: unknown) =>
				Promise.resolve(
					String(path).includes("/api/credentials") ? [] : { items },
				),
			);
		listWith([
			{
				id: "fs-1",
				status: "PUSHING",
				protocol: "RTMP",
				sourceBucket: "in",
				sourceKey: "slate.mp4",
				pid: 4242,
				processGoneAt: null,
				startedAt: "2026-08-29T00:54:00.000Z",
				stoppedAt: null,
				error: null,
				createdAt: "2026-08-29T00:53:00.000Z",
			},
		]);
		render(planWith({ key: "main", kind: "RTMP", name: "RTMP Input" }));
		await screen.findByText("PUSHING");
		await openForm();
		const option = await screen.findByLabelText(
			/Switch from the active feeder/,
		);
		expect(
			screen.getByRole("button", { name: "Start file input" }),
		).toBeInTheDocument();
		await userEvent.click(option);
		expect(
			screen.getByRole("button", { name: "Stage and switch" }),
		).toBeInTheDocument();
		expect(
			screen.getByText(/dead air is preferred over two pushes/),
		).toBeInTheDocument();

		cleanup();
		listWith([]);
		render(planWith({ key: "main", kind: "RTMP", name: "RTMP Input" }));
		await openForm();
		expect(screen.queryByLabelText(/Switch from the active feeder/)).toBeNull();
	});

	it("a staged session shows its phase beside the DOWNLOADING badge (row #240)", async () => {
		apiFetch.mockImplementation((path: unknown) =>
			Promise.resolve(
				String(path).includes("/api/credentials")
					? []
					: {
							items: [
								{
									id: "fs-2",
									status: "DOWNLOADING",
									protocol: "RTMP",
									sourceBucket: "in",
									sourceKey: "program.mp4",
									pid: null,
									processGoneAt: null,
									commitAt: "2026-08-29T01:00:00.000Z",
									readyAt: "2026-08-29T00:57:00.000Z",
									committedAt: null,
									startedAt: null,
									stoppedAt: null,
									error: null,
									createdAt: "2026-08-29T00:53:00.000Z",
								},
							],
						},
			),
		);
		render(planWith({ key: "main", kind: "RTMP", name: "RTMP Input" }));
		expect(
			await screen.findByText("ready — holding for the switch"),
		).toBeInTheDocument();
	});

	/**
	 * Audit 2026-08-29 CRITICAL-2 — the channel's own panel is where an
	 * operator watching a live channel sees its feeders, so it is where the
	 * stop for a dead-job ERROR row (pid kept, ffmpeg still pushing) has to be
	 * offered. Gating that button on the status alone hid the only control
	 * that reaches the worker's kill ladder.
	 */
	it("still offers stop for an ERROR feeder that records an unreclaimed pid, and drops it once proven gone", async () => {
		const row = (over: Record<string, unknown>) => ({
			id: "fs-err",
			status: "ERROR",
			protocol: "RTMP",
			sourceBucket: "in",
			sourceKey: "loop.mp4",
			startedAt: "2026-08-29T00:54:00.000Z",
			stoppedAt: "2026-08-29T00:58:00.000Z",
			error: "Worker lost the session — a pushing ffmpeg may be orphaned",
			loopBoundaries: [],
			logTail: [],
			createdAt: "2026-08-29T00:53:00.000Z",
			...over,
		});
		const mount = (session: Record<string, unknown>) => {
			apiFetch.mockImplementation((path: unknown) =>
				Promise.resolve(
					String(path).includes("/api/credentials") ? [] : { items: [session] },
				),
			);
			renderWithQuery(
				<FeederPanel
					channelId={CHANNEL_ID}
					channelStatus="RUNNING"
					plan={planWith({ key: "main", kind: "RTMP", name: "RTMP Input" })}
					streamKey="channelLevelKey"
					encoderIp={ENCODER_IP}
					ingestConnected={true}
				/>,
			);
		};

		mount(row({ pid: 4242, processGoneAt: null }));
		await screen.findByText(/ERROR/);
		expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

		cleanup();
		mount(row({ pid: 4242, processGoneAt: "2026-08-29T01:00:00.000Z" }));
		await screen.findByText(/ERROR/);
		expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
	});

	it("a PUSHING feeder with NO heartbeat information reads as unconfirmed, not healthy (ledger #213)", async () => {
		// Paid audit 893eb66 MODERATE-15: the bound-input banner fires only on an
		// explicit `false`; a missing or stale heartbeat left the PUSHING badge
		// standing alone, and absence of information read as a healthy push.
		apiFetch.mockImplementation((path: unknown) =>
			Promise.resolve(
				String(path).includes("/api/credentials")
					? []
					: {
							items: [
								{
									id: "fs-1",
									status: "PUSHING",
									protocol: "RTMP",
									sourceBucket: "in",
									sourceKey: "loop.mp4",
									startedAt: "2026-08-15T00:54:00.000Z",
									stoppedAt: null,
									error: null,
									loopBoundaries: [],
									logTail: [],
									createdAt: "2026-08-15T00:53:00.000Z",
								},
							],
						},
			),
		);
		renderWithQuery(
			<FeederPanel
				channelId={CHANNEL_ID}
				channelStatus="RUNNING"
				plan={planWith({ key: "main", kind: "RTMP", name: "RTMP Input" })}
				streamKey="channelLevelKey"
				encoderIp={ENCODER_IP}
			/>,
		);
		expect(
			await screen.findByText(/no recent heartbeat to confirm/),
		).toBeInTheDocument();
		// And not the bound-input banner — that one needs an explicit false.
		expect(screen.queryByText(/encoder has not bound any input/)).toBeNull();

		cleanup();
		renderWithQuery(
			<FeederPanel
				channelId={CHANNEL_ID}
				channelStatus="RUNNING"
				plan={planWith({ key: "main", kind: "RTMP", name: "RTMP Input" })}
				streamKey="channelLevelKey"
				encoderIp={ENCODER_IP}
				ingestConnected={true}
			/>,
		);
		await screen.findByText(/PUSHING/);
		expect(screen.queryByText(/no recent heartbeat to confirm/)).toBeNull();
	});

	it("a REDUNDANT_RTMP channel prefills its FIRST point's application and key", async () => {
		render(
			planWith({
				key: "main",
				kind: "REDUNDANT_RTMP",
				name: "Redundant RTMP Input",
				delayThreshold: 12,
				ingestPoints: [
					{ applicationName: "liveA", streamKey: "primaryFeed" },
					{ applicationName: "liveB", streamKey: "backupFeed" },
				],
			}),
		);
		await openForm();

		const url = screen.getByLabelText(/rtmp url/i) as HTMLInputElement;
		const key = screen.getByLabelText(/stream key/i) as HTMLInputElement;

		expect(url.value).toBe(`rtmp://${ENCODER_IP}/liveA`);
		expect(key.value).toBe("primaryFeed");

		// The two shapes of the original defect, asserted as such: the
		// simple-RTMP application and the channel-level key are what the
		// encoder is NOT listening for.
		expect(url.value).not.toBe(`rtmp://${ENCODER_IP}/live`);
		expect(key.value).not.toBe("channelLevelKey");
	});

	it("a STATIC redundant point prefills the fixed FQDN, with no encoder IP", async () => {
		renderWithQuery(
			<FeederPanel
				channelId={CHANNEL_ID}
				channelStatus="RUNNING"
				plan={planWith({
					key: "main",
					kind: "REDUNDANT_RTMP",
					name: "Redundant RTMP Input",
					staticIngestPoints: [{ name: "primary" }, { name: "backup" }],
				})}
				streamKey="channelLevelKey"
				// A static point does not ride the encoder IP: the target is
				// complete before the channel ever reports one.
				encoderIp={null}
			/>,
		);
		await openForm();

		expect((screen.getByLabelText(/rtmp url/i) as HTMLInputElement).value).toBe(
			"rtmps://live-input.bitmovin.com/live",
		);
		/*
		 * The key is BLANK, and this assertion used to say the opposite —
		 * "a static point carries no key of its own — the channel's is correct
		 * here". It is not correct: the channel's key is the plan's
		 * `start.streamKey`, and the static ingest refuses it ("not ingestible
		 * or doesn't exist"). Measured 2026-08-21 with a real push; only the
		 * revealed `StreamKey.value` connects. .
		 *
		 * Worth keeping as a note about tests rather than about feeders: this
		 * defect was PINNED, so it read as deliberate for as long as nobody
		 * pushed a byte through it.
		 */
		expect(
			(screen.getByLabelText(/stream key/i) as HTMLInputElement).value,
		).toBe("");
	});

	it("a simple RTMP channel is unchanged: /live plus the channel key", async () => {
		render(planWith({ key: "main", kind: "RTMP", name: "RTMP Input" }));
		await openForm();

		expect((screen.getByLabelText(/rtmp url/i) as HTMLInputElement).value).toBe(
			`rtmp://${ENCODER_IP}/live`,
		);
		expect(
			(screen.getByLabelText(/stream key/i) as HTMLInputElement).value,
		).toBe("channelLevelKey");
	});
});

/**
 *  — the forward path #151's blank left open: a static ingest
 * point's REAL key is the StreamKey resource assigned to this encoding, and
 * only its per-key reveal GET carries the value. The panel's button walks
 * exactly that pair and fills the field; nothing here persists the value.
 */
describe("reveal & fill (ledger #153)", () => {
	it.each([
		null,
		ENCODER_IP,
	])("explains the fixed static URL independently of encoder IP %s", async (encoderIp) => {
		renderWithQuery(
			<FeederPanel
				channelId={CHANNEL_ID}
				channelStatus="RUNNING"
				plan={staticPlan()}
				streamKey="genericKey"
				encoderIp={encoderIp}
			/>,
		);
		await openForm();
		expect(
			screen.getByText(
				"Fixed-FQDN ingress; the stream key comes from the StreamKey resource",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/encoder IP.*unknown|prefilled from.*encoder IP/i),
		).not.toBeInTheDocument();
	});
	const ACCOUNT = "00000000-0000-4000-8000-0000000000a4";
	const ENCODING = "00000000-0000-4000-8000-00000000e153";
	const KEY_ID = "00000000-0000-4000-8000-00000000k153";

	function staticPlan(): LiveChannelPlan {
		return planWith({
			key: "main",
			kind: "REDUNDANT_RTMP",
			name: "Static Redundant",
			staticIngestPoints: [
				{ name: "primary", streamKeyConfiguration: { type: "GENERATE" } },
			],
		});
	}

	function renderStatic() {
		return renderWithQuery(
			<FeederPanel
				channelId={CHANNEL_ID}
				channelStatus="RUNNING"
				plan={staticPlan()}
				streamKey="channelLevelKey"
				encoderIp={ENCODER_IP}
				bitmovinAccountId={ACCOUNT}
				bitmovinEncodingId={ENCODING}
			/>,
		);
	}

	it("walks LIST(assignedEncodingId) → per-key reveal and fills the field", async () => {
		apiFetch.mockImplementation((path: unknown) => {
			const url = String(path);
			if (url.includes("/api/credentials")) {
				return Promise.resolve([]);
			}
			if (url.includes("/api/feeder-sessions")) {
				return Promise.resolve({ items: [] });
			}
			if (url.includes(`/api/live/stream-keys/${KEY_ID}`)) {
				return Promise.resolve({ id: KEY_ID, value: "reveal22charvalue" });
			}
			if (url.includes("/api/live/stream-keys?")) {
				// The scan must be scoped to THIS encoding — an unscoped list
				// would fill the field with some other channel's credential.
				expect(url).toContain(`assignedEncodingId=${ENCODING}`);
				expect(url).toContain(`bitmovinAccountId=${ACCOUNT}`);
				// review-uibatch #3(b): the GENERATE arm must never surface
				// account-level RESERVED keys — TEMPORARY only.
				expect(url).toContain("type=TEMPORARY");
				return Promise.resolve({ items: [{ id: KEY_ID }] });
			}
			throw new Error(`unexpected ${url}`);
		});
		renderStatic();
		await openForm();
		expect(
			(screen.getByLabelText(/stream key/i) as HTMLInputElement).value,
		).toBe("");
		await userEvent.click(
			screen.getByRole("button", { name: /reveal key & fill/i }),
		);
		const field = screen.getByLabelText(/stream key/i) as HTMLInputElement;
		expect(field.value).toBe("reveal22charvalue");
		// LF-03: reveal fills the credential but does not make it shoulder-visible.
		// The operator must take a second, explicit action to show it.
		expect(field.type).toBe("password");
		await userEvent.click(screen.getByRole("button", { name: /show key/i }));
		expect(field.type).toBe("text");
	});

	it("clears a revealed key when the mounted global form switches channels", async () => {
		apiFetch.mockImplementation((path: unknown) => {
			const url = String(path);
			if (url.includes("/api/credentials")) return Promise.resolve([]);
			if (url.includes("/api/feeder-sessions")) {
				return Promise.resolve({ items: [] });
			}
			if (url.includes(`/api/live/stream-keys/${KEY_ID}`)) {
				return Promise.resolve({ value: "reveal22charvalue" });
			}
			if (url.includes("/api/live/stream-keys?")) {
				return Promise.resolve({ items: [{ id: KEY_ID }] });
			}
			throw new Error(`unexpected ${url}`);
		});
		const view = renderStatic();
		await openForm();
		await userEvent.click(
			screen.getByRole("button", { name: /reveal key & fill/i }),
		);
		const field = screen.getByLabelText(/stream key/i) as HTMLInputElement;
		expect(field.value).toBe("reveal22charvalue");

		view.rerender(
			<FeederPanel
				channelId="00000000-0000-4000-8000-000000000047"
				channelStatus="RUNNING"
				plan={staticPlan()}
				streamKey="channelLevelKey"
				encoderIp={ENCODER_IP}
				bitmovinAccountId={ACCOUNT}
				bitmovinEncodingId="00000000-0000-4000-8000-00000000e154"
			/>,
		);
		await waitFor(() => expect(field.value).toBe(""));
		expect(field.type).toBe("password");
	});

	it("fails closed while the current run has no encoding id", async () => {
		const calls: string[] = [];
		apiFetch.mockImplementation((path: unknown) => {
			const url = String(path);
			calls.push(url);
			return Promise.resolve(
				url.includes("/api/credentials") ? [] : { items: [] },
			);
		});
		renderWithQuery(
			<FeederPanel
				channelId={CHANNEL_ID}
				channelStatus="PROVISIONING"
				plan={staticPlan()}
				streamKey={null}
				encoderIp={null}
				bitmovinAccountId={ACCOUNT}
				bitmovinEncodingId={null}
				bitmovinEncodingPending
			/>,
		);
		await openForm();
		expect(
			await screen.findByText(/input destination is being prepared/i),
		).toBeVisible();
		expect(
			screen.getByRole("button", { name: /reveal key & fill/i }),
		).toBeDisabled();
		expect(
			calls.filter((url) => url.includes("/api/live/stream-keys")),
		).toHaveLength(0);
	});

	it("says so when no key is assigned yet — never fills a guess", async () => {
		apiFetch.mockImplementation((path: unknown) => {
			const url = String(path);
			if (url.includes("/api/credentials")) {
				return Promise.resolve([]);
			}
			if (url.includes("/api/live/stream-keys?")) {
				return Promise.resolve({ items: [] });
			}
			return Promise.resolve({ items: [] });
		});
		renderStatic();
		await openForm();
		await userEvent.click(
			screen.getByRole("button", { name: /reveal key & fill/i }),
		);
		expect(
			await screen.findByText(/No stream key is assigned/i),
		).toBeInTheDocument();
		expect(
			(screen.getByLabelText(/stream key/i) as HTMLInputElement).value,
		).toBe("");
	});

	it("a non-static channel gets no reveal button", async () => {
		render(planWith({ key: "main", kind: "RTMP", name: "RTMP Input" }));
		await openForm();
		expect(
			screen.queryByRole("button", { name: /reveal key & fill/i }),
		).not.toBeInTheDocument();
	});

	it("an SRT input gets no stream-key reveal control", async () => {
		render(
			planWith({
				key: "main",
				kind: "SRT",
				name: "SRT Input",
				mode: "LISTENER",
				port: 2088,
			}),
		);
		await openForm();
		expect(
			screen.queryByRole("button", { name: /reveal key & fill/i }),
		).not.toBeInTheDocument();
	});
});

/**
 * review-uibatch Q1: a redundant input may run primary + backup static
 * points — TWO keys on one encoding, same FQDN, the KEY selects the point.
 * Filling items[0] silently could aim the feed at the backup; ambiguity must
 * refuse and point at the per-point reveal screen.
 */
describe("reveal & fill — ASSIGN points (review-uibatch #2)", () => {
	it("an ASSIGN point reveals its NAMED key directly — no list, no guess", async () => {
		const NAMED = "00000000-0000-4000-8000-00000000a51e";
		const calls: string[] = [];
		apiFetch.mockImplementation((path: unknown) => {
			const url = String(path);
			calls.push(url);
			if (url.includes("/api/credentials")) {
				return Promise.resolve([]);
			}
			if (url.includes(`/api/live/stream-keys/${NAMED}`)) {
				return Promise.resolve({ id: NAMED, value: "assignedvalue22ch" });
			}
			return Promise.resolve({ items: [] });
		});
		renderWithQuery(
			<FeederPanel
				channelId={CHANNEL_ID}
				channelStatus="RUNNING"
				plan={planWith({
					key: "main",
					kind: "REDUNDANT_RTMP",
					name: "Static Assign",
					staticIngestPoints: [
						{
							name: "primary",
							streamKeyConfiguration: {
								type: "ASSIGN",
								streamKeyId: NAMED,
							},
						},
					],
				})}
				streamKey="channelLevelKey"
				encoderIp={ENCODER_IP}
				bitmovinAccountId="00000000-0000-4000-8000-0000000000a4"
				bitmovinEncodingId="00000000-0000-4000-8000-00000000e153"
			/>,
		);
		await openForm();
		await userEvent.click(
			screen.getByRole("button", { name: /reveal key & fill/i }),
		);
		const field = screen.getByLabelText(/stream key/i, {
			selector: "input",
		}) as HTMLInputElement;
		expect(field.value).toBe("assignedvalue22ch");
		// No LIST call happened — the plan already names the key.
		expect(calls.some((u) => u.includes("/api/live/stream-keys?"))).toBe(false);
	});
});

describe("reveal & fill — multi-key ambiguity (review-uibatch)", () => {
	it("two assigned keys refuse the fill and say where to disambiguate", async () => {
		apiFetch.mockImplementation((path: unknown) => {
			const url = String(path);
			if (url.includes("/api/credentials")) {
				return Promise.resolve([]);
			}
			if (url.includes("/api/live/stream-keys?")) {
				return Promise.resolve({ items: [{ id: "k1" }, { id: "k2" }] });
			}
			return Promise.resolve({ items: [] });
		});
		renderWithQuery(
			<FeederPanel
				channelId={CHANNEL_ID}
				channelStatus="RUNNING"
				plan={planWith({
					key: "main",
					kind: "REDUNDANT_RTMP",
					name: "Static Redundant",
					staticIngestPoints: [
						{ name: "primary", streamKeyConfiguration: { type: "GENERATE" } },
						{ name: "backup", streamKeyConfiguration: { type: "GENERATE" } },
					],
				})}
				streamKey="channelLevelKey"
				encoderIp={ENCODER_IP}
				bitmovinAccountId="00000000-0000-4000-8000-0000000000a4"
				bitmovinEncodingId="00000000-0000-4000-8000-00000000e153"
			/>,
		);
		await openForm();
		await userEvent.click(
			screen.getByRole("button", { name: /reveal key & fill/i }),
		);
		expect(
			await screen.findByText(/Multiple keys are assigned/i),
		).toBeInTheDocument();
		const field = screen.getByLabelText(/stream key/i, {
			selector: "input",
		}) as HTMLInputElement;
		expect(field.value).toBe("");
	});
});
