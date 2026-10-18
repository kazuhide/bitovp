import type { ManifestPlaybackLink } from "@bitovp/core";
import { compileLiveChannel, liveChannelPlanSchema } from "@bitovp/core";
import { focusManager } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "@/app/live/new/build-live-plan";
import { renderLocalized, renderWithQuery as wrap } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

/**
 * The long page's NAVIGATION and FOCUS HANDOFF.
 *
 * Three gaps were visible on a body 5.72 viewports tall: a
 * source comment describing a right-margin section rail that does not exist in
 * the render tree, a next-action pointer that scrolls to an anchor whose
 * `FlatSection` is not focusable, and a StatusStrip whose material changes are
 * announced to nobody.
 *
 * What each `describe` below pins, and why it is the arm that would go red:
 *
 * - the rail and the "Jump to" menu are ONE list rendered from
 * `section-layout.ts` — delete a layer from that table and the navigation
 * loses it in the same edit as the page;
 * - the "you are here" highlight follows the IntersectionObserver, not a
 * hand-maintained scroll table;
 * - a deep link, a rail link, the next-action CTA and the FIRST auto-reveal of
 * an escalated section each leave the caret on the target's HEADING, and a
 * poll or a second reveal leaves it exactly where the operator put it;
 * - the live region speaks on a CHANGE and is silent on a poll that measured
 * the same thing again.
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
import { DeepLinkFocus, RevealFocus } from "./focus-handoff";
import {
	ANNOUNCE_MIN_INTERVAL_MS,
	LiveAnnouncer,
	StatusAnnouncer,
	useAnnounce,
} from "./live-announcer";
import { LIVE_LAYERS } from "./section-layout";
import { LiveSectionNav } from "./section-nav";
import {
	type LiveStatusSignal,
	liveStatusAnnouncements,
} from "./status-announce";

const CHANNEL = "00000000-0000-4000-8000-0000000000e1";
const NOW = Date.parse("2026-08-29T12:00:00.000Z");

const PLAN = liveChannelPlanSchema.parse(
	buildLiveChannelPlan({
		...DEFAULT_LIVE_WIZARD_STATE,
		name: "navigation",
		redundantRtmp: {
			...DEFAULT_LIVE_WIZARD_STATE.redundantRtmp,
			ingestPoints: [{ applicationName: "liveA", streamKey: "nkey" }],
		},
		output: {
			...DEFAULT_LIVE_WIZARD_STATE.output,
			credentialId: "11111111-1111-4111-8111-111111111111",
			bucket: "navigation-bucket",
		},
		start: { ...DEFAULT_LIVE_WIZARD_STATE.start, streamKey: "nkey" },
	}),
);

const link = (
	over: Partial<ManifestPlaybackLink> = {},
): ManifestPlaybackLink => ({
	key: "hls",
	kind: "HLS",
	label: "Live HLS Manifest",
	url: "https://cdn.example.com/output/live/stream.m3u8",
	path: "output/live/stream.m3u8",
	via: "publicBaseUrls",
	...over,
});

const heartbeatAt = (ms: number, ingest = "CONNECTED") => ({
	at: new Date(ms).toISOString(),
	raw: { ingest: { status: ingest, healthy: ingest === "CONNECTED" } },
	deltas: {},
});

type AlertEvent = {
	id: string;
	openedAt: string;
	rule: { severity: string; metric: string };
};

/**
 * A mutable world the 15s poll re-reads. Every arm below that needs a CHANGE
 * mutates this and advances the timers, because that is the only way to
 * exercise what the page does on a poll rather than on a re-render.
 */
type World = {
	plan?: typeof PLAN;
	streamKey?: string | null;
	providerStatus?: "FINISHED";
	status: string;
	runId: string;
	/**
	 * The RUN's status, which is what the page actually derives from
	 * (`deriveLiveChannelStatus(run.status)`,  PR2b). It was
	 * hard-coded RUNNING while `status` moved, so an arm that set the channel
	 * row to STOPPING changed nothing the page reads — the S2 arm caught its own
	 * fixture doing that before it could pass for the wrong reason.
	 */
	runStatus: string;
	lastHeartbeat: ReturnType<typeof heartbeatAt> | null;
	openAlerts: AlertEvent[];
	stepLog: unknown[];
};

let world: World;
let liveToVodDetail: Record<string, unknown> | null;
let technicalDetailsAllowed: boolean;
let sessionReadFails: boolean;

function mockWorld() {
	apiFetch.mockImplementation(async (input: string) => {
		if (input === "/api/auth/session") {
			if (sessionReadFails) {
				throw new Error("session refresh failed");
			}
			return {
				mode: "users",
				configured: true,
				authenticated: true,
				loginKind: "password-form",
				role: "ADMIN",
			};
		}
		if (input.endsWith("/alerts")) {
			return { open: world.openAlerts, history: [] };
		}
		if (input.endsWith("/schedules")) {
			return [];
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
				name: "Navigation channel",
				status: world.status,
				labels: [],
				region: "ap-northeast-1",
				protocol: "RTMP",
				bitmovinEncodingId: "enc-1",
				bitmovinAccountId: "00000000-0000-4000-8000-0000000000a7",
				createdAt: "2026-08-29T09:00:00.000Z",
				updatedAt: "2026-08-29T09:00:00.000Z",
				plan: world.plan ?? PLAN,
				stepLog: [],
				streamKey: null,
				encoderIp: null,
				programStartAt: null,
				programEndAt: null,
				lastHeartbeat: world.lastHeartbeat,
				liveToVod: liveToVodDetail,
				technicalDetailsAllowed,
				maxRunMinutes: null,
				playbackLinks: [link()],
				serverNow: new Date(Date.now()).toISOString(),
				currentRun: {
					id: world.runId,
					seq: 3,
					status: world.runStatus,
					bitmovinEncodingId: "enc-1",
					encoderIp: null,
					streamKey: world.streamKey ?? null,
					outputPrefix: "out/",
					runningSince: new Date(NOW - 90 * 60_000).toISOString(),
					endedAt: null,
					programStartAt: null,
					programEndAt: null,
					error: null,
					lastHeartbeat: world.lastHeartbeat,
					lastHeartbeatAt: world.lastHeartbeat?.at ?? null,
					stepLog: world.stepLog,
					liveToVod: liveToVodDetail,
					originObservation: null,
					createdAt: "2026-08-29T10:00:00.000Z",
					providerStatus: world.providerStatus ?? "RUNNING",
					providerStatusObservedAt: new Date(Date.now()).toISOString(),
					providerUnknownSince: null,
					providerTerminalAt: world.providerStatus
						? new Date(NOW).toISOString()
						: null,
				},
			};
		}
		return { items: [] };
	});
}

/** One 15s poll of every query on the page. */
async function poll() {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(15_000);
	});
}

/**
 * Click an anchor and report whether the page's handler CANCELLED the default
 * action — the half of `jumpToLiveSection` that only matters in a real browser
 * (review-366 I1), and the half `userEvent.click` gives no way to read.
 *
 * A hand-dispatched `MouseEvent`, because its own `defaultPrevented` is the
 * only place the answer is observable: React's synthetic `preventDefault` calls
 * through to the native event.
 *
 * Words rather than a boolean: `toBe(true)` reads identically whichever way the
 * rule is stated, and this rule has two directions that must not be swapped.
 */
function clickAndReadDefault(
	anchor: Element,
	modifiers: Partial<
		Pick<MouseEventInit, "metaKey" | "ctrlKey" | "shiftKey" | "altKey">
	> = {},
): "prevented" | "navigated" {
	const event = new MouseEvent("click", {
		bubbles: true,
		cancelable: true,
		button: 0,
		...modifiers,
	});
	act(() => {
		anchor.dispatchEvent(event);
	});
	return event.defaultPrevented ? "prevented" : "navigated";
}

/** The nav's link list, by DOM query: `display:none` is a class here, not state. */
function navLinks(): string[] {
	return Array.from(
		document.querySelectorAll<HTMLAnchorElement>(
			"[data-live-section-list] a[href^='#']",
		),
	).map((a) => a.getAttribute("href") ?? "");
}

/** The `IntersectionObserver` jsdom does not have, with its callback captured. */
type FakeEntry = { target: Element; isIntersecting: boolean };
let observerCallbacks: ((entries: FakeEntry[]) => void)[] = [];
let disconnects = 0;

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.setSystemTime(NOW);
	observerCallbacks = [];
	disconnects = 0;
	world = {
		status: "RUNNING",
		runId: "run-1",
		runStatus: "RUNNING",
		lastHeartbeat: heartbeatAt(NOW - 10_000),
		openAlerts: [],
		stepLog: [],
	};
	liveToVodDetail = null;
	technicalDetailsAllowed = false;
	sessionReadFails = false;
	mockWorld();
	class FakeObserver {
		constructor(callback: (entries: FakeEntry[]) => void) {
			observerCallbacks.push(callback);
		}
		observe() {}
		unobserve() {}
		disconnect() {
			disconnects += 1;
		}
		takeRecords() {
			return [];
		}
	}
	Object.defineProperty(globalThis, "IntersectionObserver", {
		configurable: true,
		writable: true,
		value: FakeObserver,
	});
});

afterEach(() => {
	focusManager.setFocused(undefined);
	vi.useRealTimers();
	Reflect.deleteProperty(globalThis, "IntersectionObserver");
	window.history.replaceState(null, "", window.location.pathname);
});

/** Render the page and wait for the body (not the skeleton) to be on screen. */
async function renderPage(locale: "en" | "ja" = "en") {
	const result = wrap(<ChannelDetail id={CHANNEL} />, locale);
	await screen.findByRole("region", { name: /next action|次にやること/i });
	return result;
}

describe("reusable channel observes an external restart without a reload", () => {
	it.each([
		"en",
		"ja",
	] as const)("ERROR after provider FINISHED and all DONE steps does not claim startup failed in %s", async (locale) => {
		world.status = "ERROR";
		world.runStatus = "ERROR";
		world.providerStatus = "FINISHED";
		world.stepLog = compileLiveChannel(PLAN).map((operation) => ({
			...operation,
			status: "DONE",
		}));
		await renderPage(locale);
		const panel = document.querySelector(
			'[data-next-action="RECOVER_FROM_ERROR"]',
		);
		expect(panel).not.toBeNull();
		const next = within(panel as HTMLElement);
		expect(
			next.getByText(
				locale === "ja"
					? "前回の配信の状態を確認してください"
					: "Review the previous run's status",
			),
		).toBeInTheDocument();
		expect(
			next.getByText(
				locale === "ja"
					? "診断と終了理由、エンコーダの状態を確認してから次の操作を選んでください。"
					: "Review diagnostics, the end reason and the encoder state before choosing the next action.",
			),
		).toBeInTheDocument();
		expect(
			next.queryByText(/The last start failed|前回の起動が失敗/),
		).not.toBeInTheDocument();
		expect(next.getByRole("link")).toHaveAttribute("href", "#sec-actions");
		expect(document.querySelector('[data-provider="terminal"]')).not.toBeNull();
	});

	it.each([
		"en",
		"ja",
	] as const)("static input never renders a generic-key copy action in %s", async (locale) => {
		world.status = "PROVISIONING";
		world.runStatus = "PROVISIONING";
		world.plan = {
			...PLAN,
			liveInput: {
				key: "main",
				kind: "REDUNDANT_RTMP",
				name: "Static input",
				staticIngestPoints: [
					{ name: "primary", streamKeyConfiguration: { type: "GENERATE" } },
				],
			},
			start: { ...PLAN.start, streamKey: "autoprimary" },
		};
		await renderPage(locale);
		const ingest = within(document.getElementById("sec-ingest") as HTMLElement);
		const assertSafe = () => {
			expect(ingest.queryByText("autoprimary")).not.toBeInTheDocument();
			expect(
				ingest.queryByText("genericLiveDetailsKey"),
			).not.toBeInTheDocument();
			expect(
				ingest.queryByRole("button", {
					name: /copy stream key|ストリームキー.*コピー/i,
				}),
			).not.toBeInTheDocument();
			expect(
				ingest.getByRole("link", {
					name: locale === "ja" ? "ストリームキー" : "Stream keys",
				}),
			).toHaveAttribute("href", "/settings/live");
		};
		assertSafe();
		world.streamKey = "genericLiveDetailsKey";
		world.status = "RUNNING";
		world.runStatus = "RUNNING";
		await poll();
		assertSafe();
	});

	it.each([
		"ERROR",
		"STOPPED",
	])("refreshes %s at 30s, then provisioning at 5s and running at 15s", async (status) => {
		focusManager.setFocused(true);
		world.status = status;
		world.runStatus = status;
		const page = await renderPage();
		const channelReads = () =>
			apiFetch.mock.calls.filter(
				([path]) => path === `/api/live-channels/${CHANNEL}`,
			).length;
		const initialReads = channelReads();
		world.status = "PROVISIONING";
		world.runStatus = "PROVISIONING";
		world.runId = "external-run-2";
		await poll();
		expect(channelReads()).toBe(initialReads);
		await poll();
		expect(channelReads()).toBe(initialReads + 1);
		expect(
			document.querySelector('[data-phase-lead="starting"]'),
		).toBeInTheDocument();
		expect(
			page.client.getQueryData<{ currentRun: { id: string } }>([
				"live-channel",
				CHANNEL,
			])?.currentRun.id,
		).toBe("external-run-2");
		world.status = "RUNNING";
		world.runStatus = "RUNNING";
		world.lastHeartbeat = heartbeatAt(Date.now());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(channelReads()).toBe(initialReads + 2);
		expect(
			document.querySelector('[data-next-action="ON_AIR"]'),
		).toBeInTheDocument();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(channelReads()).toBe(initialReads + 2);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});
		expect(channelReads()).toBe(initialReads + 3);
		focusManager.setFocused(false);
		await poll();
		expect(channelReads()).toBe(initialReads + 3);
		page.unmount();
		page.client.clear();
	});
});

describe("live-to-VOD technical-detail role cache", () => {
	it("hides cached ADMIN detail when the fresh session query errors", async () => {
		technicalDetailsAllowed = true;
		liveToVodDetail = {
			status: "ERROR",
			errorCode: "L2V_PROVIDER_STATUS_FAILED",
			technicalDetail: "bounded administrator diagnostic",
			families: [],
			manifests: [],
		};
		const page = await renderPage();
		expect(
			await screen.findByText("Technical details (administrators)"),
		).toBeInTheDocument();

		// Keep the successful ADMIN data in TanStack's cache, then make its fresh
		// resolution fail. The UI must gate on query status, not cached role data.
		sessionReadFails = true;
		await act(async () => {
			await page.client.invalidateQueries({ queryKey: ["auth", "session"] });
		});
		await waitFor(() => {
			expect(
				screen.queryByText("Technical details (administrators)"),
			).not.toBeInTheDocument();
		});
	});
});

describe("the rail and the Jump-to menu are ONE list, from section-layout.ts", () => {
	it("lists every rendered layer and every section inside it, in table order", async () => {
		await renderPage();
		// The six layers, then their sections — exactly the order
		// `liveBodyLayers` gives the page itself. `sec-vmaf` is absent because
		// the deployment flag is off, which is the point: the navigation is
		// derived from what this channel RENDERS, never from the full union.
		expect(navLinks()).toEqual([
			"#layer-operations",
			"#sec-alerts",
			"#sec-manifests",
			"#sec-slate",
			"#layer-programme",
			// #548: register → schedule → stop, in the order an operator works.
			"#sec-insertion",
			"#sec-schedule",
			"#sec-insertion-stop",
			"#sec-cue",
			"#sec-esam",
			"#layer-input",
			"#sec-ingest",
			"#sec-feeders",
			"#layer-delivery",
			"#sec-dvr",
			"#sec-dns",
			"#sec-live-to-vod",
			"#layer-diagnostics",
			"#sec-heartbeat-log",
			"#sec-alert-rules",
			"#sec-runs",
			"#sec-steps",
			"#sec-ladder",
			"#sec-runtime-cap",
			"#sec-advanced",
			"#layer-danger",
			"#sec-danger",
		]);
		// Every link points at something that EXISTS: a rail whose entries
		// dangle is worse than no rail, and `sec-*` ids are a contract the
		// next-action codes share.
		for (const href of navLinks()) {
			expect(
				document.getElementById(href.slice(1)),
				`${href} must resolve`,
			).not.toBeNull();
		}
	});

	it("the narrow-screen trigger controls THAT list — there is no second one", async () => {
		await renderPage();
		const nav = screen.getByRole("navigation", { name: "Sections" });
		const trigger = within(nav).getByRole("button", { name: "Jump to" });
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		const listId = trigger.getAttribute("aria-controls");
		const list = document.getElementById(listId as string);
		// The one `<ul>` the rail IS, and the one the button discloses.
		expect(list).toBe(document.querySelector("[data-live-section-list]"));
		expect(list?.classList.contains("hidden")).toBe(true);
		expect(document.querySelectorAll("[data-live-section-list]")).toHaveLength(
			1,
		);

		await userEvent.click(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(list?.classList.contains("hidden")).toBe(false);
		expect(list?.classList.contains("block")).toBe(true);
	});

	/**
	 * review-366 C1, and the reason the assertions above read a CLASS.
	 *
	 * The first cut closed the list with the `hidden` ATTRIBUTE and relied on
	 * `xl:block` to re-show it as the rail. Tailwind 4's preflight declares
	 * `[hidden]:where(:not([hidden='until-found'])) { display: none !important }`
	 * in `@layer base`, which no utility can outrank — so the rail was
	 * `display:none` at every width, measured in Chrome at 1512 px. Nothing in
	 * jsdom sees that (no stylesheet is loaded), so the property has to be
	 * asserted structurally: the attribute must never appear, in either state.
	 */
	it("never closes the list with the `hidden` ATTRIBUTE — a breakpoint cannot outrank it", async () => {
		await renderPage();
		const list = document.querySelector("[data-live-section-list]");
		expect(list?.hasAttribute("hidden")).toBe(false);
		expect(list?.className).toContain("xl:block");

		const trigger = screen.getByRole("button", { name: "Jump to" });
		await userEvent.click(trigger);
		expect(list?.hasAttribute("hidden")).toBe(false);
		await userEvent.click(trigger);
		expect(list?.hasAttribute("hidden")).toBe(false);
	});

	it("disconnects its observer when the nav unmounts (review-366 I3/E3)", () => {
		// An IntersectionObserver holds a strong reference to every element it
		// observes; a nav that leaves without disconnecting keeps the whole
		// section tree alive on a page an operator navigates away from and back
		// to all day. Making `disconnect` a no-op changed no test.
		const view = renderLocalized(<LiveSectionNav layers={LIVE_LAYERS} />);
		expect(observerCallbacks).toHaveLength(1);
		expect(disconnects).toBe(0);
		view.unmount();
		expect(disconnects).toBe(1);
	});

	it("the current section follows the observer, and holds when nothing intersects", async () => {
		await renderPage();
		const current = () =>
			document
				.querySelector("[data-live-section-list] a[aria-current='location']")
				?.getAttribute("href");
		expect(current()).toBeUndefined();

		const fire = (entries: FakeEntry[]) => {
			act(() => {
				for (const callback of observerCallbacks) {
					callback(entries);
				}
			});
		};
		const element = (id: string) => document.getElementById(id) as Element;

		fire([{ target: element("sec-schedule"), isIntersecting: true }]);
		expect(current()).toBe("#sec-schedule");

		// Two on screen at once ⇒ the FIRST in table order wins, not the last
		// callback to arrive.
		fire([{ target: element("sec-alerts"), isIntersecting: true }]);
		expect(current()).toBe("#sec-alerts");

		// Scrolled past everything: the last answer STANDS rather than blanking.
		fire([
			{ target: element("sec-alerts"), isIntersecting: false },
			{ target: element("sec-schedule"), isIntersecting: false },
		]);
		expect(current()).toBe("#sec-alerts");
	});
});

describe("every jump lands the caret on the target's heading (audit §5.6)", () => {
	it.each([
		"sec-heartbeat",
		"sec-origin",
	])("a deep link to %s focuses its nested delivery-panel heading", async (id) => {
		window.history.replaceState(null, "", `#${id}`);
		await renderPage();
		const heading = document.getElementById(`${id}-h`);
		expect(document.activeElement).toBe(heading);
		expect(heading?.tagName).toBe("H4");
		expect(heading?.closest("#sec-delivery-status")).not.toBeNull();
	});

	/**
	 * Both arms below click the SAME pointer twice, and the SECOND click is the
	 * assertion, for two reasons that arrived a review apart.
	 *
	 * With only a first click, reverting the click handler left the suite green:
	 * a fragment navigation fires `hashchange` and `DeepLinkFocus` picked the
	 * jump up, so the arm pinned an outcome the handler had not produced.
	 *
	 * And in a real browser the first click is not where the handler decides
	 * anything at all (review-366 I1): Blink runs the anchor's default action
	 * after the handler and CLEARS the focus it set, and only the `hashchange`
	 * listener puts it back. On a same-fragment click there is no navigation and
	 * no `hashchange`, so the handler must cancel the default itself — which is
	 * what these arms assert, `preventDefault` included.
	 */
	it("the next-action CTA focuses its target — the header region, which has no heading", async () => {
		// A RUNNING channel with connected ingest and a playable output settles
		// on ON_AIR, whose pointer is `sec-actions`: the one target with no
		// heading of its own, and so the one the fallback exists for.
		await renderPage();
		const panel = screen.getByRole("region", { name: /next action/i });
		const cta = within(panel).getByRole("link");
		await userEvent.click(cta);
		expect(document.activeElement).toBe(document.getElementById("sec-actions"));

		const parked = document.getElementById("sec-runs-h") as HTMLElement;
		parked.focus();
		// The URL already carries this fragment, so there is nothing to navigate
		// to and no `hashchange` to restore the focus afterwards. The handler
		// must cancel the default action itself.
		expect(window.location.hash).toBe("#sec-actions");
		expect(clickAndReadDefault(cta)).toBe("prevented");
		expect(document.activeElement).toBe(document.getElementById("sec-actions"));
	});

	it("a rail link focuses the section's heading and closes the narrow menu", async () => {
		await renderPage();
		const nav = screen.getByRole("navigation", { name: "Sections" });
		const trigger = within(nav).getByRole("button", { name: "Jump to" });
		await userEvent.click(trigger);
		const ladder = within(nav).getByRole("link", { name: "Ladder" });
		await userEvent.click(ladder);
		expect(document.activeElement).toBe(
			document.getElementById("sec-ladder-h"),
		);
		expect(trigger.getAttribute("aria-expanded")).toBe("false");

		const parked = document.getElementById("sec-runs-h") as HTMLElement;
		parked.focus();
		await userEvent.click(trigger);
		expect(window.location.hash).toBe("#sec-ladder");
		expect(
			clickAndReadDefault(within(nav).getByRole("link", { name: "Ladder" })),
		).toBe("prevented");
		expect(document.activeElement).toBe(
			document.getElementById("sec-ladder-h"),
		);
	});

	it("the header's Programme cell hands focus over too (review-366 I2)", async () => {
		// Three docblocks claimed this cell handed focus over while it was a
		// bare `href` with no handler at all — prose describing a mechanism
		// nobody had written, which is the same failure §5.6 opened with.
		await renderPage();
		const cell = document.querySelector(
			"[data-status-cell='next-event']",
		) as HTMLAnchorElement;
		expect(cell.getAttribute("href")).toBe("#layer-programme");
		await userEvent.click(cell);
		expect(document.activeElement).toBe(
			document.getElementById("layer-programme-h"),
		);

		const parked = document.getElementById("sec-runs-h") as HTMLElement;
		parked.focus();
		expect(clickAndReadDefault(cell)).toBe("prevented");
		expect(document.activeElement).toBe(
			document.getElementById("layer-programme-h"),
		);
	});

	it.each([
		["meta", { metaKey: true }],
		["ctrl", { ctrlKey: true }],
		["shift", { shiftKey: true }],
		["alt", { altKey: true }],
	] as const)("a %s-click on an already-current fragment is left to the browser", async (_name, modifiers) => {
		// review-366 S-A: a modifier click asks for a NEW tab or window. The
		// same-fragment branch is the one that cancels, so "open in new tab"
		// on a rail entry the page was already at came back as nothing at
		// all — and silently, because the entry an operator is most likely
		// to open beside the page is the one they are looking at.
		await renderPage();
		const nav = screen.getByRole("navigation", { name: "Sections" });
		await userEvent.click(within(nav).getByRole("button", { name: "Jump to" }));
		await userEvent.click(within(nav).getByRole("link", { name: "Ladder" }));
		expect(window.location.hash).toBe("#sec-ladder");

		// Re-open the menu BEFORE parking the caret: clicking the trigger
		// focuses the trigger, so parking first measured that instead — this arm
		// caught its own setup doing it.
		await userEvent.click(within(nav).getByRole("button", { name: "Jump to" }));
		const parked = document.getElementById("sec-runs-h") as HTMLElement;
		parked.focus();
		expect(
			clickAndReadDefault(
				within(nav).getByRole("link", { name: "Ladder" }),
				modifiers,
			),
		).toBe("navigated");
		// And no focus moves: the page is about to be left open behind a new
		// one, so the caret stays where the operator put it.
		expect(document.activeElement).toBe(parked);
	});

	it("a jump to a DIFFERENT section leaves the navigation alone", async () => {
		// The other half of the rule. Cancelling here would drop the hash from
		// the URL, and the hash is what makes a jump shareable and survivable
		// across a Back — so the browser navigates and `hashchange` (pinned in
		// its own arm below) is what delivers the focus.
		await renderPage();
		const nav = screen.getByRole("navigation", { name: "Sections" });
		await userEvent.click(within(nav).getByRole("button", { name: "Jump to" }));
		expect(window.location.hash).toBe("");
		expect(
			clickAndReadDefault(within(nav).getByRole("link", { name: "Ladder" })),
		).toBe("navigated");
	});

	it("the `hashchange` listener is what delivers focus once the browser HAS navigated", () => {
		// Not a decoration on the click handlers: in Chrome it is the only thing
		// that focuses the heading for every jump that changes the fragment,
		// because the anchor's default action clears what the handler set
		// (review-366 I3/E2 — removing this listener changed no test).
		render(
			<div>
				<h3 id="sec-ladder-h" tabIndex={-1}>
					Ladder
				</h3>
				<DeepLinkFocus />
			</div>,
		);
		expect(document.activeElement).toBe(document.body);
		act(() => {
			window.history.replaceState(null, "", "#sec-ladder");
			window.dispatchEvent(new HashChangeEvent("hashchange"));
		});
		expect(document.activeElement).toBe(
			document.getElementById("sec-ladder-h"),
		);
	});

	it("a poll that changes nothing does not move the caret", async () => {
		await renderPage();
		const parked = document.getElementById("sec-runs-h") as HTMLElement;
		parked.focus();
		expect(document.activeElement).toBe(parked);
		await poll();
		await poll();
		expect(document.activeElement).toBe(parked);
	});
});

describe("an escalation reveals a section and hands it the caret ONCE", () => {
	it("a CRITICAL alert already open on arrival does not steal focus", async () => {
		world.openAlerts = [
			{
				id: "a1",
				openedAt: "2026-08-29T11:59:00.000Z",
				rule: { severity: "CRIT", metric: "INPUT_DISCONNECTED" },
			},
		];
		await renderPage();
		// The section IS open — that is 's escalation — but nothing was
		// revealed, so the caret stays where the operator's navigation left it.
		expect(
			(document.getElementById("sec-alerts") as HTMLDetailsElement).open,
		).toBe(true);
		expect(document.activeElement).toBe(document.body);
	});

	it("a CRITICAL alert arriving on a poll moves focus to the alerts heading", async () => {
		await renderPage();
		expect(document.activeElement).toBe(document.body);
		world.openAlerts = [
			{
				id: "a1",
				openedAt: "2026-08-29T12:00:30.000Z",
				rule: { severity: "CRIT", metric: "INPUT_DISCONNECTED" },
			},
		];
		await poll();
		expect(document.activeElement).toBe(
			document.getElementById("sec-alerts-h"),
		);
	});

	it("the SECOND reveal of the same section does not (one-way, like the open)", () => {
		// Driven directly, because the flap needs three states and the poll only
		// gives one per 15s: reveal → clear → reveal again.
		const view = render(
			<div>
				<h3 id="sec-alerts-h" tabIndex={-1}>
					Alerts
				</h3>
				<button type="button" id="elsewhere">
					elsewhere
				</button>
				<RevealFocus revealed={[]} />
			</div>,
		);
		const heading = document.getElementById("sec-alerts-h");
		expect(document.activeElement).toBe(document.body);

		view.rerender(
			<div>
				<h3 id="sec-alerts-h" tabIndex={-1}>
					Alerts
				</h3>
				<button type="button" id="elsewhere">
					elsewhere
				</button>
				<RevealFocus revealed={["sec-alerts"]} />
			</div>,
		);
		expect(document.activeElement).toBe(heading);

		const elsewhere = document.getElementById("elsewhere") as HTMLElement;
		elsewhere.focus();
		view.rerender(
			<div>
				<h3 id="sec-alerts-h" tabIndex={-1}>
					Alerts
				</h3>
				<button type="button" id="elsewhere">
					elsewhere
				</button>
				<RevealFocus revealed={[]} />
			</div>,
		);
		view.rerender(
			<div>
				<h3 id="sec-alerts-h" tabIndex={-1}>
					Alerts
				</h3>
				<button type="button" id="elsewhere">
					elsewhere
				</button>
				<RevealFocus revealed={["sec-alerts"]} />
			</div>,
		);
		expect(document.activeElement).toBe(elsewhere);
	});
});

const region = () =>
	document.querySelector("[data-live-announcer]")?.textContent ?? "";

describe("the polite live region speaks on a change and not on a poll", () => {
	it("says nothing on arrival, nor on polls that measure the same thing", async () => {
		await renderPage();
		expect(region()).toBe("");
		await poll();
		await poll();
		expect(region()).toBe("");
	});

	it("announces the ingest going away, and the alert that opened", async () => {
		await renderPage();
		// A FRESH sample that reports the ingest gone — one signal moving, so
		// one sentence. Dropping the heartbeat entirely moves two (the ingest
		// AND the freshness), and with per-signal slots both now speak; the
		// region then holds whichever landed last, which says nothing about
		// either rule.
		world.lastHeartbeat = heartbeatAt(NOW - 10_000, "DISCONNECTED");
		await poll();
		expect(region()).toBe("Ingest disconnected.");

		// Past the coalescing window, so the next crossing speaks immediately
		// rather than being held (that behaviour has its own arm below).
		await act(async () => {
			await vi.advanceTimersByTimeAsync(ANNOUNCE_MIN_INTERVAL_MS);
		});
		world.openAlerts = [
			{
				id: "a1",
				openedAt: "2026-08-29T12:01:00.000Z",
				rule: { severity: "WARN", metric: "INPUT_DISCONNECTED" },
			},
		];
		await poll();
		expect(region()).toBe("An alert opened — 1 open.");
	});

	it("a Stop is silent — the ingest it drops is not news (review-366 S2)", async () => {
		// The page-level half of S2, with a REAL wire status. The signal used to
		// carry `isActiveChannelStatus`, which holds for STOPPING, so both
		// samples stayed "active" across RUNNING → STOPPING and the disconnect a
		// Stop causes was read aloud — the exact pair the rule exists to skip.
		await renderPage();
		expect(region()).toBe("");
		world.status = "STOPPING";
		world.runStatus = "STOPPING";
		world.lastHeartbeat = heartbeatAt(NOW - 10_000, "DISCONNECTED");
		await poll();
		expect(region()).toBe("");
	});

	it("announces an accepted lifecycle action, which nothing announced before", async () => {
		await renderPage();
		// The trigger and the dialog's confirm share an accessible name
		// ("Stop channel"), so the second click is scoped to the dialog.
		await userEvent.click(screen.getByRole("button", { name: "Stop channel" }));
		const dialog = await screen.findByRole("dialog");
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Stop channel" }),
		);
		// TWO nodes carry the sentence: the visible notice and the region. That
		// is the design — one is seen, one is spoken — and the notice is NOT
		// itself a live region, or it would be read twice. The sentence is the
		// NOUN frame.
		const carrying = await screen.findAllByText("Channel stop accepted.");
		expect(carrying).toHaveLength(2);
		expect(region()).toBe("Channel stop accepted.");
		const notice = carrying.find(
			(el) => !el.hasAttribute("data-live-announcer"),
		);
		expect(notice?.getAttribute("aria-live")).toBeNull();
		expect(notice?.getAttribute("role")).toBeNull();
	});
});

/**
 * The two rules that keep the region usable, driven directly.
 *
 * The page arm above proves the WIRING; these prove the rules, because a poll
 * gives one state change per 15s and a flap needs four inside one window.
 */
describe("change detection and the coalescing window", () => {
	const signal = (over: Partial<LiveStatusSignal> = {}): LiveStatusSignal => ({
		onAir: true,
		ingestConnected: true,
		heartbeatFresh: true,
		openAlerts: 0,
		...over,
	});
	const tree = (s: LiveStatusSignal) => (
		<LiveAnnouncer>
			<StatusAnnouncer signal={s} />
		</LiveAnnouncer>
	);

	it("a re-render carrying the same values announces nothing", () => {
		const view = renderLocalized(tree(signal()));
		expect(region()).toBe("");
		// A NEW object with identical values — what every poll hands it. The
		// effect RUNS; `liveStatusAnnouncements` is what keeps it quiet.
		view.rerender(tree(signal()));
		view.rerender(tree(signal()));
		expect(region()).toBe("");
	});

	it("a lifecycle transition is not a material change", () => {
		const view = renderLocalized(tree(signal()));
		// Stopping a channel disconnects its ingest and stales its heartbeat by
		// definition; the operator who pressed Stop does not need telling.
		view.rerender(
			tree(
				signal({
					onAir: false,
					ingestConnected: false,
					heartbeatFresh: false,
				}),
			),
		);
		expect(region()).toBe("");
	});

	it("a flapping value announces once per window, and says where it ENDED UP", () => {
		const view = renderLocalized(tree(signal()));
		view.rerender(tree(signal({ ingestConnected: false })));
		expect(region()).toBe("Ingest disconnected.");

		// Three more crossings inside the window: held, not spoken.
		view.rerender(tree(signal({ ingestConnected: true })));
		view.rerender(tree(signal({ ingestConnected: false })));
		view.rerender(tree(signal({ ingestConnected: true })));
		expect(region()).toBe("Ingest disconnected.");

		act(() => {
			vi.advanceTimersByTime(ANNOUNCE_MIN_INTERVAL_MS);
		});
		expect(region()).toBe("Ingest connected.");
	});

	/**
	 * review-366 I3/E1: the docblock said a FAILED alert read stays silent, and
	 * deleting the two `typeof … === "number"` guards changed no test. A rule
	 * nothing asserts is a comment.
	 */
	it.each([
		["a failed read", "unknown" as const, 2],
		["a recovered read", 2, "unknown" as const],
	])("%s of the alert count is not an alert opening or resolving", (_name, before, after) => {
		expect(
			liveStatusAnnouncements(
				signal({ openAlerts: before }),
				signal({ openAlerts: after }),
			),
		).toEqual([]);
	});

	/**
	 * review-366 S1: one window and one hold slot for the whole page meant a
	 * held message was replaced by the next message of ANY kind, and was then
	 * never spoken. The slot is per SIGNAL now.
	 */
	it("a held message is not evicted by a different signal", () => {
		const view = renderLocalized(tree(signal()));
		// Open this signal's window, then put a second ingest crossing in it.
		view.rerender(tree(signal({ ingestConnected: false })));
		expect(region()).toBe("Ingest disconnected.");
		view.rerender(tree(signal({ ingestConnected: true })));

		// A DIFFERENT signal, inside that same window: its own slot is free, so
		// it speaks at once and takes nothing from the ingest hold.
		view.rerender(
			tree(signal({ ingestConnected: true, heartbeatFresh: false })),
		);
		expect(region()).toBe("Heartbeat has gone stale.");

		act(() => {
			vi.advanceTimersByTime(ANNOUNCE_MIN_INTERVAL_MS);
		});
		expect(region()).toBe("Ingest connected.");
	});

	it("an operator's own confirmation is never held behind a window", () => {
		renderLocalized(
			<LiveAnnouncer>
				<StatusAnnouncer signal={signal()} />
				<AnnounceHarness />
			</LiveAnnouncer>,
		);
		const say = () =>
			act(() => {
				screen.getByRole("button", { name: "announce" }).click();
			});
		say();
		expect(region()).toBe("Action 1 accepted.");
		// Immediately again, well inside `ANNOUNCE_MIN_INTERVAL_MS`. A windowed
		// path would hold these for 8s — long enough for an operator to press
		// the button again believing nothing happened.
		say();
		expect(region()).toBe("Action 2 accepted.");
		say();
		expect(region()).toBe("Action 3 accepted.");
	});
});

/**
 * Calls `useAnnounce` with no signal — the operator-initiated path.
 *
 * Each click announces a DISTINCT sentence, and that is what makes the arm
 * below discriminating. With one fixed message the mutant survived: dropping
 * the immediate path sends an unsignalled call down the windowed one, where
 * `undefined` gets a slot of its own that has never been used, so the FIRST
 * call is immediate either way. Only a second click inside the window tells the
 * two apart — and only if its text differs, because an unchanged region says
 * nothing about which path ran.
 */
function AnnounceHarness() {
	const announce = useAnnounce();
	const clicks = useRef(0);
	return (
		<button
			type="button"
			onClick={() => {
				clicks.current += 1;
				announce(`Action ${clicks.current} accepted.`);
			}}
		>
			announce
		</button>
	);
}

describe("both catalogues carry the navigation and the announcements", () => {
	it.each([
		["en", "Sections", "Jump to"],
		["ja", "セクション", "セクションへ移動"],
	] as const)("%s renders the nav", async (locale, navName, jumpTo) => {
		await renderPage(locale);
		const nav = screen.getByRole("navigation", { name: navName });
		expect(within(nav).getByRole("button", { name: jumpTo })).toBeVisible();
	});

	it("ja announces the ingest change in Japanese", async () => {
		await renderPage("ja");
		world.lastHeartbeat = heartbeatAt(NOW - 10_000, "DISCONNECTED");
		await poll();
		expect(document.querySelector("[data-live-announcer]")?.textContent).toBe(
			"取り込みが切断されました。",
		);
	});
});
