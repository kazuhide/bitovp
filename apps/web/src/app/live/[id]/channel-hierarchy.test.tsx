import type { ManifestPlaybackLink } from "@bitovp/core";
import { liveChannelPlanSchema } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "@/app/live/new/build-live-plan";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import { renderWithQuery as wrap } from "@/test/render";

/**
 * Rows #248 and #249 — the live channel detail's INFORMATION HIERARCHY.
 *
 * This file REPLACES the structural pin that used to live in
 * `channel-playback.test.tsx` ("almost every section expanded, exactly two
 * folds"). That pin described the #126 layout, and measured
 * that layout as having swung past the fix: 15 always-expanded panels over 5.7
 * viewports, with the schedule ARM FORM and the content-registration UI ahead
 * of open alerts, playback, the active feeder and the ingest coordinates.
 *
 * A fold COUNT cannot express the property the audit actually asks for, which
 * is about ORDER and about WHICH sections a given situation opens. So the pin
 * below is a table — phase × expected open set, phase × expected order — and
 * the expectations are written out LITERALLY here rather than imported from
 * `section-layout.ts`. That is deliberate: the page renders FROM that module,
 * so importing it would make this test a restatement of the code. Reverting the
 * table must turn these arms red, and it does (mutation-verified).
 */

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

const CHANNEL = "00000000-0000-4000-8000-0000000000d7";
/** A fixed wall clock, so every countdown below is arithmetic, not luck. */
const NOW = Date.parse("2026-08-29T12:00:00.000Z");

function link(over: Partial<ManifestPlaybackLink> = {}): ManifestPlaybackLink {
	return {
		key: "hls",
		kind: "HLS",
		label: "Live HLS Manifest",
		url: "https://cdn.example.com/output/live/stream.m3u8",
		path: "output/live/stream.m3u8",
		via: "publicBaseUrls",
		...over,
	};
}

type Over = Record<string, unknown>;

/**
 * The wizard's own default plan, not a hand-typed shape: the feeder, DVR and
 * ladder panels all parse `row.plan` and fall back to an explanation when it
 * does not, and a fixture that silently took the fallback would make the
 * hierarchy pins assert over a page missing three of its sections' contents.
 */
const PLAN = liveChannelPlanSchema.parse(
	buildLiveChannelPlan({
		...DEFAULT_LIVE_WIZARD_STATE,
		name: "hierarchy",
		redundantRtmp: {
			...DEFAULT_LIVE_WIZARD_STATE.redundantRtmp,
			ingestPoints: [{ applicationName: "liveA", streamKey: "hkey" }],
		},
		output: {
			...DEFAULT_LIVE_WIZARD_STATE.output,
			credentialId: "11111111-1111-4111-8111-111111111111",
			bucket: "hierarchy-bucket",
		},
		start: { ...DEFAULT_LIVE_WIZARD_STATE.start, streamKey: "hkey" },
	}),
);

function mockChannel(over: Over = {}, extra: Over = {}) {
	apiFetch.mockImplementation(async (input: string) => {
		if (input === "/api/auth/session") {
			return {
				mode: "password",
				configured: true,
				authenticated: true,
				loginKind: "password-form",
			};
		}
		if (input.endsWith("/schedules")) {
			return (extra.schedules as unknown[]) ?? [];
		}
		if (input.endsWith("/alerts")) {
			return (
				(extra.alerts as unknown) ?? {
					open: [],
					history: [],
				}
			);
		}
		if (input.includes("/runs/") && input.endsWith("/health")) {
			return {
				points: [],
				lanes: { ingest: [], encoder: [], output: [] },
				run: {
					id: "run-1",
					seq: 1,
					status: "RUNNING",
					createdAt: "2026-08-29T10:00:00.000Z",
				},
				truncated: false,
				outputObservable: true,
				timeline: { window: { startMs: NOW - 7_200_000 }, events: [] },
			};
		}
		if (input.startsWith(`/api/live-channels/${CHANNEL}`)) {
			return {
				id: CHANNEL,
				name: "Hierarchy channel",
				status: "RUNNING",
				labels: [],
				region: "ap-northeast-1",
				protocol: "RTMP",
				bitmovinEncodingId: "enc-1",
				bitmovinAccountId: "00000000-0000-4000-8000-0000000000a7",
				createdAt: "2026-08-29T09:00:00.000Z",
				updatedAt: "2026-08-29T09:00:00.000Z",
				plan: PLAN,
				stepLog: [],
				streamKey: null,
				encoderIp: null,
				programStartAt: null,
				programEndAt: null,
				lastHeartbeat: null,
				liveToVod: null,
				maxRunMinutes: null,
				...over,
			};
		}
		return { items: [] };
	});
}

/** A heartbeat that vouches for a CONNECTED ingest at the fixed clock. */
const connected = {
	at: new Date(NOW - 10_000).toISOString(),
	raw: { ingest: { status: "CONNECTED", healthy: true } },
	deltas: {},
};

/** A run that came up 90 minutes before the fixed clock. */
const run = (over: Over = {}) => ({
	id: "run-1",
	seq: 3,
	status: "RUNNING",
	bitmovinEncodingId: "enc-1",
	encoderIp: null,
	streamKey: null,
	outputPrefix: "out/",
	runningSince: new Date(NOW - 90 * 60_000).toISOString(),
	endedAt: null,
	programStartAt: null,
	programEndAt: null,
	error: null,
	lastHeartbeat: connected,
	lastHeartbeatAt: connected.at,
	stepLog: [],
	liveToVod: null,
	originObservation: null,
	createdAt: "2026-08-29T10:00:00.000Z",
	...over,
});

/**
 * A section is "open" when its content is on screen: an always-visible
 * `FlatSection` always is; a `SectionCard` is a native `<details>`.
 */
function isOpen(id: string): boolean | "absent" {
	const el = document.getElementById(id);
	if (!el) {
		return "absent";
	}
	return el.tagName === "DETAILS" ? (el as HTMLDetailsElement).open : true;
}

/**
 * Every addressable BLOCK, in document order. Scoped to the two element types a
 * section can be — `FlatSection`'s `<section>` and `SectionCard`'s `<details>`
 * — because `FlatSection` also stamps a `${id}-h` id on its visible heading,
 * and a bare `[id^='sec-']` swept those up as phantom sections.
 */
function renderedOrder(): string[] {
	return (
		Array.from(
			document.querySelectorAll("section[id^='sec-'], details[id^='sec-']"),
		)
			.map((el) => el.id)
			// The panel contains addressable details, but is not itself a fold.
			.filter((id) => id !== "sec-delivery-status")
	);
}

function openSections(): string[] {
	return (
		renderedOrder()
			// `sec-actions` is the header's lifecycle control, not a section that
			// opens or closes — it is the anchor `liveNextAction` points at, and
			// it is visible in every phase by construction.
			.filter((id) => id !== "sec-actions")
			.filter((id) => isOpen(id) === true)
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

/**
 * The body order, layer by layer, with the VMAF capture entry absent (the
 * deployment flag is off by default — one arm below turns it on and pins where
 * it lands). Written out once because all four phases share it; what differs
 * per phase is only the LEAD and whether the ingest card is hoisted out of it.
 */
const BODY_WITHOUT_INGEST = [
	// Operations — what the broadcast is doing right now.
	"sec-alerts",
	"sec-manifests",
	"sec-slate",
	// Programme — register, schedule the insert, stop if needed .
	"sec-insertion",
	"sec-schedule",
	"sec-insertion-stop",
	"sec-cue",
	"sec-esam",
	// Input / pseudo-live — minus the ingest card, spliced in per phase.
	"sec-feeders",
	// Delivery & QC.
	"sec-dvr",
	"sec-dns",
	"sec-live-to-vod",
	// Diagnostics & history.
	// The per-run heartbeat log (2026-09-02), under Diagnostics for now.
	"sec-heartbeat-log",
	"sec-alert-rules",
	"sec-runs",
	"sec-steps",
	"sec-ladder",
	"sec-runtime-cap",
	"sec-advanced",
	// Danger zone.
	"sec-danger",
];
const withIngestInInputLayer = () => {
	const out = [...BODY_WITHOUT_INGEST];
	out.splice(out.indexOf("sec-feeders"), 0, "sec-ingest");
	return out;
};

/**
 * The §5.7 table, as data. `order` is the whole page top to bottom; `open` is
 * exactly the set an operator finds expanded on arrival. Every fixture below is
 * chosen so the derived next action points at `sec-actions` (the header
 * control) or at a section the phase already opens — otherwise this table would
 * be pinning the next-action rule as well, and two rules in one assertion is
 * how a green test stops meaning anything.
 */
const PHASES = [
	{
		name: "prepare — paste the ingest URL, see what is scheduled, check the feeder",
		row: { status: "CREATED", bitmovinEncodingId: null },
		order: ["sec-actions", "sec-ingest", ...BODY_WITHOUT_INGEST],
		open: ["sec-ingest", "sec-schedule", "sec-feeders"],
	},
	{
		name: "starting — watch it come up, catch a stuck step",
		row: { status: "PROVISIONING" },
		order: [
			"sec-actions",
			"sec-ingest",
			"sec-heartbeat",
			"sec-origin",
			...BODY_WITHOUT_INGEST,
		],
		open: ["sec-ingest", "sec-steps"],
	},
	{
		name: "on air — input, alerts, output, feeder, what fires next",
		row: {
			status: "RUNNING",
			lastHeartbeat: connected,
			playbackLinks: [link()],
			currentRun: run(),
		},
		order: [
			"sec-actions",
			"sec-heartbeat",
			"sec-origin",
			...withIngestInInputLayer(),
		],
		open: [
			"sec-ingest",
			"sec-alerts",
			"sec-manifests",
			"sec-feeders",
			"sec-schedule",
		],
	},
	{
		name: "finished — what happened, what is unresolved, and the VOD",
		row: {
			status: "STOPPED",
			currentRun: run({
				status: "STOPPED",
				endedAt: new Date(NOW).toISOString(),
			}),
		},
		order: [
			"sec-actions",
			"sec-last-run",
			"sec-heartbeat",
			"sec-origin",
			...withIngestInInputLayer(),
		],
		open: ["sec-last-run", "sec-alerts", "sec-alert-rules", "sec-live-to-vod"],
	},
] as const;

describe("live channel detail — the §5.7 hierarchy (rows #248/#249)", () => {
	for (const phase of PHASES) {
		it(`${phase.name}: renders the layers in order`, async () => {
			mockChannel(phase.row as Over);
			const view = wrap(<ChannelDetail id={CHANNEL} />);
			await screen.findByRole("region", { name: /next action/i });
			expect(renderedOrder()).toEqual(phase.order);
			const panels = document.querySelectorAll("#sec-delivery-status");
			expect(panels).toHaveLength(phase.row.status === "CREATED" ? 0 : 1);
			if (panels[0]) {
				expect(
					panels[0].querySelectorAll("h4#sec-heartbeat-h, h4#sec-origin-h"),
				).toHaveLength(2);
				expect(
					document.getElementById("sec-heartbeat")?.closest("section")?.id,
				).toBe("sec-delivery-status");
				expect(
					document.getElementById("sec-origin")?.closest("section")?.id,
				).toBe("sec-delivery-status");
			}
			view.unmount();
		});

		it(`${phase.name}: opens exactly the sections the phase is about`, async () => {
			mockChannel(phase.row as Over);
			const view = wrap(<ChannelDetail id={CHANNEL} />);
			await screen.findByRole("region", { name: /next action/i });
			// Set equality in BOTH directions: an extra open section is as much
			// a defect as a missing one — "collapse nothing" is the layout this
			// replaced, and "collapse everything" is the one before that.
			expect([...openSections()].sort()).toEqual([...phase.open].sort());
			view.unmount();
		});
	}

	it("the VMAF capture entry lands in Delivery & QC when the deployment has the flag on (ledger #131)", async () => {
		mockChannel({ status: "RUNNING", lastHeartbeat: connected });
		const view = wrap(
			<FeatureFlagsProvider flags={{ qcVmaf: true }}>
				<ChannelDetail id={CHANNEL} />
			</FeatureFlagsProvider>,
		);
		await screen.findByRole("region", { name: /next action/i });
		const ids = renderedOrder();
		expect(ids).toContain("sec-vmaf");
		// Last of the delivery four, before the diagnostics layer opens.
		expect(ids.indexOf("sec-vmaf")).toBe(ids.indexOf("sec-live-to-vod") + 1);
		expect(ids.indexOf("sec-vmaf")).toBeLessThan(
			ids.indexOf("sec-heartbeat-log"),
		);
		expect(document.getElementById("sec-vmaf")?.closest("section")?.id).toBe(
			"layer-delivery",
		);
		view.unmount();
	});
});

describe("the operational header carries the two TIME answers (row #248)", () => {
	it("shows the next event with its countdown and slate duration, and links to Programme", async () => {
		mockChannel(
			{ status: "RUNNING", lastHeartbeat: connected, currentRun: run() },
			{
				schedules: [
					{
						id: "s-slate",
						action: "SLATE_IN",
						fireAt: new Date(NOW + 4 * 60_000).toISOString(),
						status: "ARMED",
						insertableContentId: "c-1",
						slateDurationSeconds: 30,
						firedAt: null,
						note: null,
						error: null,
						createdAt: "2026-08-29T09:00:00.000Z",
					},
					{
						// Later than the slate: the header must show the SOONEST.
						id: "s-stop",
						action: "STOP",
						fireAt: new Date(NOW + 40 * 60_000).toISOString(),
						status: "ARMED",
						insertableContentId: null,
						slateDurationSeconds: null,
						firedAt: null,
						note: null,
						error: null,
						createdAt: "2026-08-29T09:00:00.000Z",
					},
				],
			},
		);
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		const cell = document.querySelector('[data-status-cell="next-event"]');
		expect(cell?.textContent).toBe("Insert slate (SLATE_IN) in 4m · slate 30s");
		// The header links to the layer that owns the detail — §5.7's rule is a
		// compact summary plus a link, never a second copy of the control.
		expect(cell?.getAttribute("href")).toBe("#layer-programme");
		expect(document.getElementById("layer-programme")).not.toBeNull();
	});

	it("shows elapsed and what the runtime cap leaves", async () => {
		mockChannel({
			status: "RUNNING",
			lastHeartbeat: connected,
			maxRunMinutes: 120,
			currentRun: run(),
		});
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		// The run came up 90 minutes ago under a 120-minute cap.
		expect(
			document.querySelector('[data-status-cell="runtime"]')?.textContent,
		).toBe("1h 30m elapsed · 30m left");
	});

	it("a FINISHED run shows the frozen figure it MEASURED, not a delta that keeps growing", async () => {
		/**
		 * Review of #360, the real bug. The cell computed `now − runningSince`
		 * with no `active` gate — the gate every other clock-reading cell in
		 * `status-strip.tsx` has, and whose absence its own docstring already
		 * names as the owner's "36406s ago" defect. A channel that ran ten
		 * minutes under a two-hour cap and stopped three days ago therefore
		 * read `72h 10m elapsed · cap reached`, in amber, growing on every
		 * view — and the amber implied a cap had bitten a broadcast that had
		 * simply finished.
		 *
		 * The clock here is THREE DAYS after the stop, so a surviving live
		 * delta cannot hide inside a rounding margin.
		 */
		const ended = NOW - 3 * 24 * 60 * 60_000;
		mockChannel({
			status: "STOPPED",
			maxRunMinutes: 120,
			currentRun: run({
				status: "STOPPED",
				runningSince: new Date(ended - 10 * 60_000).toISOString(),
				endedAt: new Date(ended).toISOString(),
			}),
		});
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		const cell = document.querySelector('[data-status-cell="runtime"]');
		// `endedAt − runningSince`: two worker stamps, no viewer clock, so it
		// reads the same three days later as it did at the stop.
		expect(cell?.textContent).toBe("ran for 10m");
		// The pre-fix rendering, named so a regression is recognisable rather
		// than merely red.
		expect(cell?.textContent).not.toBe("72h 10m elapsed · cap reached");
		expect(cell?.textContent).not.toMatch(/elapsed|cap reached/);
		// And a finished run can no longer wear the cap's amber.
		expect(cell?.className).not.toContain("amber");
	});

	it("a finished run with NO end stamp says None rather than inventing one from the clock", async () => {
		// The counterfactual for the arm above: the frozen figure needs a
		// MEASUREMENT. A legacy row without `endedAt` has none, and the answer
		// to that is silence, not `now − runningSince` wearing a past tense.
		mockChannel({
			status: "STOPPED",
			maxRunMinutes: 120,
			currentRun: run({ status: "STOPPED", endedAt: null }),
		});
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		expect(
			document.querySelector('[data-status-cell="runtime"]')?.textContent,
		).toBe("None");
	});

	it("an armed row past its fire time reads as OVERDUE, not as 0s away", async () => {
		// The sweep reaps a due row within one 30s tick, so a row still ARMED
		// past fireAt is evidence the worker is down — the reading the page
		// already applies one level up (`overdueArmedCount`).
		mockChannel(
			{ status: "RUNNING", lastHeartbeat: connected, currentRun: run() },
			{
				schedules: [
					{
						id: "s-late",
						action: "STOP",
						fireAt: new Date(NOW - 5 * 60_000).toISOString(),
						status: "ARMED",
						insertableContentId: null,
						slateDurationSeconds: null,
						firedAt: null,
						note: null,
						error: null,
						createdAt: "2026-08-29T09:00:00.000Z",
					},
				],
			},
		);
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		const cell = document.querySelector('[data-status-cell="next-event"]');
		expect(cell?.textContent).toBe("Stop channel (STOP) overdue by 5m");
		expect(cell?.className).toContain("amber");
	});

	it("a FAILED schedules read is unknown in the header, never 'none armed'", async () => {
		apiFetch.mockImplementation(async (input: string) => {
			if (input.endsWith("/schedules")) {
				throw new Error("503 from the schedules route");
			}
			if (input.endsWith("/alerts")) {
				return { open: [], history: [] };
			}
			if (input.startsWith(`/api/live-channels/${CHANNEL}`)) {
				return {
					id: CHANNEL,
					name: "Hierarchy channel",
					status: "STOPPED",
					labels: [],
					region: "ap-northeast-1",
					protocol: "RTMP",
					bitmovinEncodingId: "enc-1",
					bitmovinAccountId: null,
					createdAt: "2026-08-29T09:00:00.000Z",
					updatedAt: "2026-08-29T09:00:00.000Z",
					plan: PLAN,
					stepLog: [],
					streamKey: null,
					encoderIp: null,
					programStartAt: null,
					programEndAt: null,
					lastHeartbeat: null,
					liveToVod: null,
				};
			}
			return { items: [] };
		});
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		const cell = document.querySelector('[data-status-cell="next-event"]');
		expect(cell?.textContent).toBe("could not be read");
		expect(cell?.textContent).not.toBe("none armed");
	});
});

describe("read, configure and destroy no longer share a row (row #249)", () => {
	it("Delete lives in the Danger zone, and NOT beside Stop in the header", async () => {
		mockChannel({ status: "STOPPED", currentRun: run({ status: "STOPPED" }) });
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });

		const danger = document.getElementById("sec-danger") as HTMLDetailsElement;
		expect(danger).not.toBeNull();
		// The zone is closed on arrival in EVERY phase: deleting a channel is
		// not what any situation is "about".
		expect(danger.open).toBe(false);
		danger.open = true;
		expect(
			within(danger).getByRole("button", { name: /Delete channel/i }),
		).toBeInTheDocument();

		// …and the header's lifecycle row carries Start only.
		const actions = document.getElementById("sec-actions") as HTMLElement;
		expect(
			within(actions).queryByRole("button", { name: /Delete channel/i }),
		).toBeNull();
		expect(
			within(actions).queryByRole("button", {
				name: /設定をコピーして編集|Copy settings and edit/i,
			}),
		).toBeNull();
		expect(
			within(actions).getByRole("button", { name: "Start a new run" }),
		).toBeInTheDocument();
	});

	it("copy settings is in the header while Save as template remains in Advanced", async () => {
		mockChannel({ status: "STOPPED", currentRun: run({ status: "STOPPED" }) });
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		const advanced = document.getElementById(
			"sec-advanced",
		) as HTMLDetailsElement;
		advanced.open = true;
		expect(
			screen.getByRole("button", { name: "Copy settings and edit" }),
		).toBeInTheDocument();
		expect(
			screen
				.getByRole("button", { name: "Copy settings and edit" })
				.closest("header"),
		).not.toBeNull();
		expect(
			within(advanced).queryByRole("button", {
				name: "Copy settings and edit",
			}),
		).toBeNull();
		expect(advanced.closest("section")?.id).toBe("layer-diagnostics");
	});
});

describe("Programme opens with what is scheduled, not with the form (row #248)", () => {
	const armed = {
		schedules: [
			{
				id: "s-1",
				action: "STOP",
				fireAt: new Date(NOW + 60 * 60_000).toISOString(),
				status: "ARMED",
				insertableContentId: null,
				slateDurationSeconds: null,
				firedAt: null,
				note: null,
				error: null,
				createdAt: "2026-08-29T09:00:00.000Z",
			},
		],
	};

	it("the upcoming list is FIRST inside the schedule section and the arm form is not rendered until disclosed", async () => {
		mockChannel(
			{ status: "RUNNING", lastHeartbeat: connected, currentRun: run() },
			armed,
		);
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		const section = document.getElementById("sec-schedule") as HTMLElement;

		// Closed: no Action select, no Run at, no Arm button anywhere.
		expect(within(section).queryByLabelText("Action")).toBeNull();
		expect(within(section).queryByLabelText("Run at")).toBeNull();
		expect(
			within(section).queryByRole("button", { name: "Arm schedule" }),
		).toBeNull();

		// And the upcoming heading precedes the disclosure that would open it.
		// h4 = the panel's own subheadings (the section's own title is the h3
		// in its <summary>), plus each disclosure's trigger.
		const texts = Array.from(
			section.querySelectorAll("h4, [data-disclosure] > button"),
		).map((el) => el.textContent);
		expect(texts[0]).toBe("Upcoming");
		expect(texts).toContain("Schedule an action");
		expect(texts.indexOf("Upcoming")).toBeLessThan(
			texts.indexOf("Schedule an action"),
		);

		// Disclosing it brings the form back, unchanged.
		await userEvent.click(
			within(section).getByRole("button", { name: "Schedule an action" }),
		);
		expect(within(section).getByLabelText("Action")).toBeInTheDocument();
	});

	it("every rare-authoring disclosure announces itself — aria-expanded and a REAL aria-controls target", async () => {
		mockChannel(
			{ status: "RUNNING", lastHeartbeat: connected, currentRun: run() },
			armed,
		);
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		const trigger = screen.getByRole("button", { name: "Schedule an action" });
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		const regionId = trigger.getAttribute("aria-controls");
		expect(regionId).toBeTruthy();
		// The controlled element EXISTS while closed — an aria-controls that
		// points at nothing is worse than none at all.
		const region = document.getElementById(regionId as string);
		expect(region).not.toBeNull();
		expect(region?.hasAttribute("hidden")).toBe(true);

		await userEvent.click(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(
			document.getElementById(regionId as string)?.hasAttribute("hidden"),
		).toBe(false);
	});

	it("the feeder panel's own form toggle gained the same pair (audit §5.6)", async () => {
		mockChannel({
			status: "RUNNING",
			lastHeartbeat: connected,
			currentRun: run(),
		});
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		const trigger = screen.getByRole("button", { name: "Start file input" });
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(trigger.getAttribute("aria-controls")).toBe(
			"feeder-new-session-form",
		);
		expect(document.getElementById("feeder-new-session-form")).not.toBeNull();
	});
});

describe("escalations outrank the phase default (row #249)", () => {
	it("a CRITICAL open alert opens the alerts section on a phase that would leave it closed", async () => {
		// PROVISIONING's default set is `progress + ingest` — alerts are NOT in
		// it, which is exactly why this is the phase to prove the escalation on.
		mockChannel(
			{ status: "PROVISIONING" },
			{
				alerts: {
					open: [
						{
							id: "a1",
							openedAt: "2026-08-29T11:59:00.000Z",
							rule: { severity: "CRIT", metric: "INPUT_DISCONNECTED" },
						},
					],
					history: [],
				},
			},
		);
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		expect(isOpen("sec-alerts")).toBe(true);
	});

	it("a WARN alert does not — the escalation is about severity, not about any alert", async () => {
		// The counterfactual. Without it "a critical alert opens it" would pass
		// for an implementation that opened the section for every alert, and for
		// one that opened it always.
		mockChannel(
			{ status: "PROVISIONING" },
			{
				alerts: {
					open: [
						{
							id: "a1",
							openedAt: "2026-08-29T11:59:00.000Z",
							rule: { severity: "WARN", metric: "BITRATE_BELOW" },
						},
					],
					history: [],
				},
			},
		);
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		expect(isOpen("sec-alerts")).toBe(false);
	});

	it("an escalation OPENS a section — it never closes another one", async () => {
		/**
		 * The invariant `SectionCard` has already failed twice ( →
		 * review-234), and until now nothing asserted it against the ESCALATION
		 * clauses: a reviewer's adversarial mutation — a CRITICAL alert forcing
		 * `sec-schedule` shut during on-air — survived all 202 tests.
		 *
		 * On air with a CRIT alert firing, the phase's whole default-open set
		 * must still be open. `sec-alerts` is in that set already, so what this
		 * arm really protects is everything AROUND it.
		 */
		mockChannel(
			{
				status: "RUNNING",
				lastHeartbeat: connected,
				playbackLinks: [link()],
				currentRun: run(),
			},
			{
				alerts: {
					open: [
						{
							id: "a1",
							openedAt: "2026-08-29T11:59:00.000Z",
							rule: { severity: "CRIT", metric: "INPUT_DISCONNECTED" },
						},
					],
					history: [],
				},
			},
		);
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		for (const id of [
			"sec-alerts",
			"sec-ingest",
			"sec-manifests",
			"sec-feeders",
			"sec-schedule",
		]) {
			expect(isOpen(id), `${id} must stay open under a CRITICAL alert`).toBe(
				true,
			);
		}
	});

	it("a FAILED provisioning step opens the step history", async () => {
		mockChannel({
			status: "RUNNING",
			lastHeartbeat: connected,
			playbackLinks: [link()],
			// On the RUN, not on the channel row: `effectiveStepLog` is
			// run-first , so a row-level log under a present
			// run is dead weight — and the entry must satisfy the STRICT
			// `stepLogEntrySchema`, or `stepEntries` is empty and this arm
			// proves nothing at all.
			currentRun: run({
				stepLog: [
					{
						step: "create-manifest-hls",
						kind: "CREATE_MANIFEST_HLS",
						payload: {},
						refs: {},
						status: "FAILED",
						error: "boom",
					},
				],
			}),
		});
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		expect(isOpen("sec-steps")).toBe(true);
	});
});

describe("the reorganised page renders in both catalogues", () => {
	// the layer names are the AWS operator's
	// concepts — "Channel state" and "Output & delivery", not "Operations".
	const EN = [
		"Channel state",
		"Programme",
		"Input & pseudo-live",
		"Output & delivery",
		"Diagnostics & history",
		"Danger zone",
		"Next event",
		"Runtime",
		// : the slate section is a reservation list, and the emergency
		// stop is its own section beside it.
		"Slate reservations",
		"Emergency stop: inserted content",
		"Alert rules & resolved history",
		"Duplicate & template",
		"Delete this channel",
		"Schedule an action",
		"Show past and cancelled rows",
		"Show every manifest URL",
		// the section titles an AWS operator
		// recognises, in place of Heartbeat / Ingest coordinates / Origin
		// observation / Pseudo-live feeders / Schedules.
		"Delivery status",
		"Input details",
		"Input endpoint",
		"Output monitoring",
		"File input (pseudo-live)",
		"Schedule actions",
	];
	const JA = [
		"チャンネルの状態",
		"番組・スケジュール",
		"入力・擬似ライブ",
		"出力・配信",
		"診断・履歴",
		"取り消せない操作",
		"次の予定",
		"稼働時間",
		"スレートの予約",
		"差し込みコンテンツの緊急停止",
		"アラートルールと解決済み履歴",
		"複製・テンプレート",
		"このチャンネルを削除",
		"予約を追加",
		"実行済み・取り消し済みを表示",
		"マニフェスト URL をすべて表示",
		"配信状態",
		"入力の詳細",
		"入力エンドポイント",
		"出力モニタリング",
		"ファイル入力（擬似ライブ）",
		"スケジュールアクション",
	];

	it.each([
		["en", EN],
		["ja", JA],
	] as const)("%s renders every new string", async (locale, strings) => {
		mockChannel({
			status: "RUNNING",
			lastHeartbeat: connected,
			playbackLinks: [link()],
			currentRun: run(),
		});
		wrap(<ChannelDetail id={CHANNEL} />, locale);
		await screen.findByRole("region", { name: /next action|次にやること/i });
		for (const text of strings) {
			expect(
				screen.getAllByText(text, { exact: false }).length,
				`${locale}: ${text}`,
			).toBeGreaterThan(0);
		}
		// the title-level help is ON THE PAGE, named for
		// its title in the locale's own frame, with the §8.5 body as the
		// trigger's accessible description (a short help) or behind it (a long
		// one, `role=note` on click). Output monitoring's help is long.
		const trigger = screen.getByRole("button", {
			name:
				locale === "ja"
					? "「出力モニタリング」の説明"
					: "Output monitoring — more information",
		});
		await userEvent.click(trigger);
		expect(screen.getByRole("note")).toHaveTextContent(
			locale === "ja"
				? "出力先の HLS メディアプレイリスト"
				: "HLS media playlists",
		);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(trigger).toHaveFocus();
	});
});
