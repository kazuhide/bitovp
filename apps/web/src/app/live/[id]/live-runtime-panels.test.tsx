import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	SCHEDULED_CONTENT_STATUSES,
	type ScheduledContentStatus,
} from "@/lib/live-runtime/schemas";
import { renderWithQuery as wrap } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { ApiError } from "@/lib/api";
import { ChannelDnsMappingsPanel } from "./channel-dns-mappings-panel";
import { ContentInsertionPanel } from "./content-insertion-panel";
import { EsamPanel } from "./esam-panel";
import { LiveToVodPanel } from "./live-to-vod-panel";
import { SlateReservationsPanel } from "./slate-reservations-panel";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const CHANNEL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const CONTENT_ID = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";
const SCHEDULED_ID = "22223333-4444-4555-8666-777788889999";
const INPUT_ID = "44445555-6666-4777-8888-99990000aaaa";
const RTMP_INPUT_ID = "55556666-7777-4888-8999-0000aaaabbbb";
const OTHER_ORG_INPUT_ID = "66667777-8888-4999-8aaa-bbbbccccdddd";
const BINARY = "/DAgAAAAAAAAAP/wDwAA";

afterEach(() => {
	vi.clearAllMocks();
});

describe("EsamPanel", () => {
	it("explains the start-time prerequisite and posts a valid media point", async () => {
		apiFetch.mockResolvedValue({ insertedAt: "2026-08-06T12:34:56.000Z" });
		const user = userEvent.setup();
		wrap(
			<EsamPanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
		);

		// The start-time prerequisite remains available in the section help.
		await user.click(
			screen.getByRole("button", { name: /ESAM.*more information/ }),
		);
		expect(screen.getByRole("note")).toHaveTextContent(
			/adInsertionSettings\.enableEsamMediaPointInsertion/,
		);
		await user.keyboard("{Escape}");

		await user.type(
			screen.getByLabelText(/SCTE-35 binary/),
			BINARY.replace(/[{[]/g, ""),
		);
		await user.click(
			screen.getByRole("button", { name: "Insert media point" }),
		);

		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith(
				`/api/live-channels/${CHANNEL_ID}/esam-media-point`,
				expect.objectContaining({ method: "POST" }),
			);
		});
		const body = JSON.parse(
			(apiFetch.mock.calls[0]?.[1] as { body: string }).body,
		) as { bitmovinAccountId: string; mediaPoint: { signals: unknown[] } };
		expect(body.bitmovinAccountId).toBe(ACCOUNT_ID);
		expect(body.mediaPoint.signals).toHaveLength(1);

		expect(
			await screen.findByText(/Last media point inserted at/),
		).toBeInTheDocument();
	});

	it("rejects a non-base64 binary client-side without calling the API", async () => {
		const user = userEvent.setup();
		wrap(
			<EsamPanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
		);
		await user.type(screen.getByLabelText(/SCTE-35 binary/), "not base64!!");
		await user.click(
			screen.getByRole("button", { name: "Insert media point" }),
		);
		expect(
			await screen.findByText(/base64-encoded SCTE-35 data/),
		).toBeInTheDocument();
		expect(apiFetch).not.toHaveBeenCalled();
	});

	it("adds and removes signal rows (the first row is never removable)", async () => {
		const user = userEvent.setup();
		wrap(
			<EsamPanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
		);
		expect(
			screen.getByRole("button", { name: "Remove signal 1" }),
		).toBeDisabled();
		await user.click(screen.getByRole("button", { name: /Add signal/ }));
		expect(screen.getAllByLabelText(/SCTE-35 binary/)).toHaveLength(2);
		await user.click(screen.getByRole("button", { name: "Remove signal 2" }));
		expect(screen.getAllByLabelText(/SCTE-35 binary/)).toHaveLength(1);
	});

	it("is gated to RUNNING channels", () => {
		wrap(
			<EsamPanel
				channelId={CHANNEL_ID}
				status="STOPPED"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
		);
		expect(
			screen.getByText(/only be inserted into a RUNNING/),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Insert media point" }),
		).not.toBeInTheDocument();
	});

	it("maps a coded runtime refusal to Japanese without exposing API prose", async () => {
		apiFetch.mockRejectedValue(
			new ApiError(409, "ESAM media points need a RUNNING channel", {
				code: "LIVE_RUNTIME_REQUIRES_RUNNING",
				status: "STOPPED",
			}),
		);
		const user = userEvent.setup();
		wrap(
			<EsamPanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
			"ja",
		);
		await user.type(screen.getByLabelText(/SCTE-35 バイナリ/), BINARY);
		await user.click(
			screen.getByRole("button", { name: "media point を挿入" }),
		);
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"この操作はチャンネルが RUNNING の間だけ利用できます。現在の状態は STOPPED です。",
		);
		expect(alert).not.toHaveTextContent(/ESAM media points need/);
	});
});

function mockContentApis(overrides: Record<string, unknown> = {}) {
	apiFetch.mockImplementation(async (input: unknown, init?: unknown) => {
		const url = String(input);
		const method = (init as { method?: string } | undefined)?.method ?? "GET";
		if (url.startsWith("/api/live/inputs?")) {
			if (overrides.inputsFail) {
				throw new ApiError(502, "Bitmovin API error (502)");
			}
			return (
				overrides.inputs ?? {
					totalCount: 2,
					items: [
						{ id: INPUT_ID, name: "slate-bucket", type: "S3" },
						{ id: RTMP_INPUT_ID, name: "studio-a-ingest", type: "RTMP" },
					],
				}
			);
		}
		if (url.includes("/scheduled?")) {
			return (
				overrides.scheduled ?? {
					totalCount: 1,
					items: [
						{
							id: SCHEDULED_ID,
							contentId: CONTENT_ID,
							runAt: "2026-08-06T20:00:00Z",
							durationInSeconds: 15,
							status: "SCHEDULED",
						},
					],
				}
			);
		}
		if (url.includes("/insertable-content?")) {
			return (
				overrides.content ?? {
					totalCount: 2,
					items: [
						{
							id: CONTENT_ID,
							name: "brb-slate",
							status: "READY",
							inputs: [{ inputId: INPUT_ID, inputPath: "/slates/brb.png" }],
						},
						{
							id: "44445555-6666-4777-8888-99990000bbbb",
							name: "downloading-clip",
							status: "DOWNLOADING",
							inputs: [{ inputId: INPUT_ID, inputPath: "/clips/promo.mp4" }],
						},
					],
				}
			);
		}
		if (url.includes("/stop")) {
			return { stopped: true };
		}
		if (url.endsWith("/insertable-content/preflight")) {
			// C36: the compatibility check the register button waits for. The
			// healthiest answer — a verdict of OK — unless an arm says otherwise.
			return (
				overrides.preflight ?? {
					status: "DONE",
					verdict: "OK",
					inputPath: {
						path: "slates/brb.png",
						original: "/slates/brb.png",
						stripped: true,
					},
					kind: "image",
					container: "png_pipe",
					differences: [],
				}
			);
		}
		if (url.includes("/schedule/")) {
			return { id: SCHEDULED_ID };
		}
		if (url.includes("/schedule")) {
			return { id: SCHEDULED_ID, status: "SCHEDULED" };
		}
		if (method === "POST") {
			if (overrides.postError) {
				throw overrides.postError;
			}
			return { id: "new-content", status: "CREATED" };
		}
		throw new Error(`unexpected apiFetch: ${method} ${url}`);
	});
}

describe("ContentInsertionPanel", () => {
	/**
	 *  split this panel: registration and scheduling stayed here, the
	 * scheduled queue and the global stop moved to the Operations layer — and
	 *  split those two again, into `SlateReservationsPanel` (the queue,
	 * as reservations) and `InsertedContentStopPanel` (the emergency stop; its
	 * own test file). The arms below follow the control, so each still asserts
	 * on the component that owns it — the whole point of the split was that no
	 * control exists twice.
	 */
	it("lists content with status chips — the registration half", async () => {
		mockContentApis();
		wrap(
			<ContentInsertionPanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
		);
		expect(await screen.findByText("brb-slate")).toBeInTheDocument();
		expect(screen.getByText("READY")).toBeInTheDocument();
		expect(screen.getByText("DOWNLOADING")).toBeInTheDocument();
		// The scheduled queue is the SlateReservationsPanel's, not this panel's.
		expect(screen.queryByText("SCHEDULED")).toBeNull();
		await userEvent.click(
			screen.getByRole("button", {
				name: "Registered content — more information",
			}),
		);
		expect(screen.getByRole("note")).toHaveTextContent(
			/match the live stream's codec, resolution and framerate/,
		);
		await userEvent.keyboard("{Escape}");
	});

	it("offers Schedule only for READY content and sends durationInSeconds", async () => {
		mockContentApis();
		const user = userEvent.setup();
		wrap(
			<ContentInsertionPanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
		);
		await screen.findByText("brb-slate");
		// Exactly one Schedule button: the DOWNLOADING row has none.
		const scheduleButtons = screen.getAllByRole("button", {
			name: "Schedule",
		});
		expect(scheduleButtons).toHaveLength(1);

		await user.click(scheduleButtons[0] as HTMLElement);
		await user.click(
			screen.getByRole("button", {
				name: "Duration (s) — more information",
			}),
		);
		expect(screen.getByRole("note")).toHaveTextContent(
			/Required for image content/,
		);
		await user.keyboard("{Escape}");
		await user.type(
			screen.getByLabelText(/Duration \(s\)/, { selector: "input" }),
			"15",
		);
		await user.click(screen.getByRole("button", { name: "Confirm" }));

		await waitFor(() => {
			const scheduleCall = apiFetch.mock.calls.find(
				(call) =>
					String(call[0]).endsWith("/schedule") &&
					(call[1] as { method?: string } | undefined)?.method === "POST",
			);
			expect(scheduleCall).toBeDefined();
			const body = JSON.parse((scheduleCall?.[1] as { body: string }).body) as {
				schedule: { contentId: string; durationInSeconds: number };
			};
			expect(body.schedule).toEqual({
				contentId: CONTENT_ID,
				durationInSeconds: 15,
			});
		});
	});

	/**
	 * C36 (WP-A1): the raw inputId/inputPath form moved under an ADVANCED
	 * disclosure and the register button waits for the compatibility check.
	 * These four arms used to register straight from the top-level form — the
	 * exact path that registered the 2026-09-02 clip READY and failed at air —
	 * so they were rewritten to walk the disclosure and the check; the
	 * assertions about validation, the input picker, the listing failure and
	 * the Japanese remediation are unchanged.
	 */
	async function openAdvanced(user: ReturnType<typeof userEvent.setup>) {
		await user.click(
			screen.getByRole("button", {
				name: "Advanced: register by Bitmovin input id",
			}),
		);
	}

	async function checkCompatibility(user: ReturnType<typeof userEvent.setup>) {
		await user.click(
			screen.getByRole("button", { name: "Check compatibility" }),
		);
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Register content" }),
			).toBeEnabled(),
		);
	}

	it("registers new content only with a UUID input id", async () => {
		mockContentApis();
		const user = userEvent.setup();
		wrap(
			<ContentInsertionPanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
		);
		await screen.findByText("brb-slate");
		await openAdvanced(user);
		await user.type(screen.getByLabelText("Input id"), "not-a-uuid");
		await user.type(screen.getByLabelText("Input path"), "/slates/brb.png");
		await checkCompatibility(user);
		await user.click(screen.getByRole("button", { name: "Register content" }));
		expect(await screen.findByText(/must be a UUID/)).toBeInTheDocument();
	});

	it("the register button is disabled until the compatibility check has run", async () => {
		mockContentApis();
		const user = userEvent.setup();
		wrap(
			<ContentInsertionPanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
		);
		await screen.findByText("brb-slate");
		// READY is explained as REGISTERED, not playable.
		expect(
			screen.getByText(/READY means Bitmovin has registered the file/),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Register content" }),
		).toBeDisabled();
		await openAdvanced(user);
		await user.type(screen.getByLabelText("Input id"), INPUT_ID);
		await user.type(screen.getByLabelText("Input path"), "/slates/brb.png");
		expect(
			screen.getByRole("button", { name: "Register content" }),
		).toBeDisabled();
		expect(
			screen.getByText("Run the compatibility check first."),
		).toBeInTheDocument();
		await checkCompatibility(user);
		const preflight = apiFetch.mock.calls.find((c) =>
			String(c[0]).endsWith("/insertable-content/preflight"),
		);
		expect(preflight).toBeDefined();
		// rev410 #2: the advanced path's preflight body is the route's strict
		// `input: { inputId, inputPath }` shape — `inputs: [...]` (the register
		// shape) answers 400 there and would leave Register dead.
		expect(JSON.parse((preflight?.[1] as { body: string }).body)).toEqual({
			bitmovinAccountId: ACCOUNT_ID,
			input: { inputId: INPUT_ID, inputPath: "/slates/brb.png" },
		});
		// rev410 #4: the stripped leading slash is said out loud.
		expect(
			screen.getByText(
				"The leading slash was removed: the file is registered as slates/brb.png.",
			),
		).toBeInTheDocument();
	});

	it("picks the input from the account's own list instead of pasting a UUID", async () => {
		mockContentApis();
		const user = userEvent.setup();
		wrap(
			<ContentInsertionPanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
		);
		await screen.findByText("brb-slate");
		await openAdvanced(user);
		// Candidates carry the NAME plus the type chip — the type is what tells an
		// operator a downloadable file input from a live ingest one.
		const inputRadio = await screen.findByRole("radio", {
			name: /slate-bucket/,
		});
		expect(
			screen.getByRole("radio", { name: /studio-a-ingest/ }),
		).toBeInTheDocument();
		expect(screen.getByText("RTMP")).toBeInTheDocument();
		expect(apiFetch).toHaveBeenCalledWith(
			`/api/live/inputs?bitmovinAccountId=${ACCOUNT_ID}`,
		);

		await user.click(inputRadio);
		expect(screen.getByLabelText("Input id")).toHaveValue(INPUT_ID);
		await user.type(screen.getByLabelText("Input path"), "/slates/brb.png");
		await checkCompatibility(user);
		await user.click(screen.getByRole("button", { name: "Register content" }));

		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				(c) =>
					String(c[0]).endsWith("/insertable-content") &&
					(c[1] as { method?: string } | undefined)?.method === "POST",
			);
			expect(call).toBeDefined();
			const body = JSON.parse((call?.[1] as { body: string }).body) as {
				content: { inputs: { inputId: string; inputPath: string }[] };
			};
			expect(body.content.inputs).toEqual([
				{ inputId: INPUT_ID, inputPath: "/slates/brb.png" },
			]);
		});
	});

	it("keeps the form usable when input listing fails without exposing provider prose", async () => {
		mockContentApis({ inputsFail: true });
		const user = userEvent.setup();
		wrap(
			<ContentInsertionPanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
		);
		await screen.findByText("brb-slate");
		await openAdvanced(user);
		expect(
			await screen.findByText(
				/Could not list this account's inputs Request failed\. Try again\. — paste an id below/,
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/Bitmovin API error/)).toBeNull();
		expect(screen.queryAllByRole("radio")).toHaveLength(0);

		// The form is still usable — an id from another org submits unchanged.
		await user.type(screen.getByLabelText("Input id"), OTHER_ORG_INPUT_ID);
		await user.type(screen.getByLabelText("Input path"), "/slates/brb.png");
		await checkCompatibility(user);
		await user.click(screen.getByRole("button", { name: "Register content" }));

		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				(c) =>
					String(c[0]).endsWith("/insertable-content") &&
					(c[1] as { method?: string } | undefined)?.method === "POST",
			);
			expect(call).toBeDefined();
			const body = JSON.parse((call?.[1] as { body: string }).body) as {
				content: { inputs: { inputId: string }[] };
			};
			expect(body.content.inputs[0]?.inputId).toBe(OTHER_ORG_INPUT_ID);
		});
	});

	it("collapses to an explanation on a non-RUNNING channel", () => {
		wrap(
			<ContentInsertionPanel
				channelId={CHANNEL_ID}
				status="CREATED"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
		);
		expect(screen.getByText(/needs a RUNNING channel/)).toBeInTheDocument();
		expect(apiFetch).not.toHaveBeenCalled();
	});

	it("shows an AWS-familiar CONNECTED remediation in Japanese instead of raw API English", async () => {
		mockContentApis({
			postError: new ApiError(
				409,
				"Scheduling insertable content need a CONNECTED ingest — raw English",
				{ code: "LIVE_RUNTIME_INGEST_NOT_CONNECTED" },
			),
		});
		const user = userEvent.setup();
		wrap(
			<ContentInsertionPanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
			"ja",
		);
		await screen.findByText("brb-slate");
		await user.click(
			screen.getByRole("button", { name: "詳細設定: Bitmovin 入力 ID で登録" }),
		);
		await user.type(screen.getByLabelText("入力 ID"), INPUT_ID);
		await user.type(screen.getByLabelText("入力パス"), "/slates/brb.png");
		await user.click(screen.getByRole("button", { name: "互換性を確認" }));
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "コンテンツを登録" }),
			).toBeEnabled(),
		);
		await user.click(screen.getByRole("button", { name: "コンテンツを登録" }));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"入力がまだ CONNECTED ではありません。入力の状態が CONNECTED になってから再実行してください。",
		);
		expect(alert).not.toHaveTextContent(/raw English|Scheduling insertable/);
	});
});

/* A provider scheduled-content queue proves reservation, not current insertion; primary copy must preserve that distinction. */
describe("SlateReservationsPanel (row #277)", () => {
	/** One reservation whose runAt is in the FUTURE — the row the audit named. */
	const futureReservation = {
		id: SCHEDULED_ID,
		contentId: CONTENT_ID,
		runAt: "2099-01-01T00:00:00Z",
		durationInSeconds: 15,
		status: "SCHEDULED",
	};
	const queueOf = (...items: Record<string, unknown>[]) => ({
		scheduled: { totalCount: items.length, items },
	});
	const renderPanel = (locale: "en" | "ja" = "en") =>
		wrap(
			<SlateReservationsPanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
			locale,
		);
	const stopCalls = () =>
		apiFetch.mock.calls.filter((c) => String(c[0]).endsWith("/stop"));

	/**
	 * Provider status → the customer's word, JA and EN, plus the class the
	 * badge must carry and the one it must never carry. The population is
	 * `SCHEDULED_CONTENT_STATUSES` (the wire superset), and this table is
	 * typed over it, so a status added to the schema is a compile error here
	 * rather than a row that silently goes untested.
	 */
	const STATUS_TABLE = {
		CREATED: { en: "Registering", ja: "登録処理中", paint: /text-zinc-400/ },
		SCHEDULED: { en: "Reserved", ja: "予約済み", paint: /text-sky-300/ },
		TO_BE_DESCHEDULED: {
			en: "Cancelling",
			ja: "予約解除中",
			paint: /text-zinc-400/,
		},
		DESCHEDULED: {
			en: "Cancelled",
			ja: "予約解除済み",
			paint: /text-zinc-400/,
		},
		ERROR: { en: "Reservation error", ja: "予約エラー", paint: /text-red-300/ },
	} satisfies Record<
		ScheduledContentStatus,
		{ en: string; ja: string; paint: RegExp }
	>;

	it.each([
		{
			locale: "en" as const,
			label: "Reserved",
			forbidden: /current|on.?air|covering|playing|live now/i,
			control: /return to live|stop/i,
		},
		{
			locale: "ja" as const,
			label: "予約済み",
			forbidden: /現在|配信中|本番中|挿入中|覆って/,
			control: /ライブに戻す|停止/,
		},
	])("$locale: a future SCHEDULED reservation reads 予約済み — never a current/on-air word, never green, never a return-to-live control", async ({
		locale,
		label,
		forbidden,
		control,
	}) => {
		mockContentApis(queueOf(futureReservation));
		renderPanel(locale);
		const badge = await screen.findByText(label);
		const row = badge.closest("li");
		expect(row).not.toBeNull();
		expect(row?.textContent ?? "").not.toMatch(forbidden);
		// Not the Badge's `ok` tone: emerald is what made SCHEDULED read as
		// "it worked / it is on". Blue says "booked".
		expect(badge.className).not.toMatch(/emerald|green/);
		expect(badge.className).toMatch(/sky/);
		// No live-return CTA and no global stop anywhere in this panel …
		expect(screen.queryByRole("button", { name: control })).toBeNull();
		// … and nothing was posted to /stop.
		expect(stopCalls()).toHaveLength(0);
	});

	it.each(
		SCHEDULED_CONTENT_STATUSES,
	)("status %s maps to its customer label in both locales and is never painted green", async (status) => {
		const expected = STATUS_TABLE[status];
		mockContentApis(queueOf({ ...futureReservation, status }));
		const en = renderPanel("en");
		const enBadge = await screen.findByText(expected.en);
		expect(enBadge.className).toMatch(expected.paint);
		expect(enBadge.className).not.toMatch(/emerald|green/);
		// The raw enum is not in the row.
		expect(enBadge.closest("li")?.textContent).not.toContain(status);
		en.unmount();

		mockContentApis(queueOf({ ...futureReservation, status }));
		renderPanel("ja");
		const jaBadge = await screen.findByText(expected.ja);
		expect(jaBadge.className).toMatch(expected.paint);
		expect(jaBadge.className).not.toMatch(/emerald|green/);
		expect(jaBadge.closest("li")?.textContent).not.toContain(status);
	});

	it("keeps the raw provider status out of the row — it appears only inside the technical-details disclosure", async () => {
		mockContentApis(queueOf(futureReservation));
		const user = userEvent.setup();
		renderPanel();
		await screen.findByText("Reserved");
		expect(screen.queryByText(/SCHEDULED/)).toBeNull();
		expect(screen.queryByText(/2099-01-01T00:00:00Z/)).toBeNull();

		const trigger = screen.getByRole("button", {
			name: "Show technical details",
		});
		await user.click(trigger);
		const region = document.getElementById(
			trigger.getAttribute("aria-controls") ?? "",
		) as HTMLElement;
		expect(region).not.toBeNull();
		// The raw row, verbatim, with the provider's own field names.
		expect(within(region).getByText(/status=SCHEDULED/)).toBeInTheDocument();
		expect(
			within(region).getByText(/runAt=2099-01-01T00:00:00Z/),
		).toBeInTheDocument();
		expect(
			within(region).getByText(/it carries no playback state/),
		).toBeInTheDocument();
		// Opening the disclosure did not put the raw word into the row.
		expect(
			screen.getByText("Reserved").closest("li")?.textContent,
		).not.toContain("SCHEDULED");
	});

	it("renders a malformed provider runAt as unknown while preserving the raw timestamp in technical details", async () => {
		mockContentApis(
			queueOf({ ...futureReservation, runAt: "not-a-provider-timestamp" }),
		);
		const user = userEvent.setup();
		renderPanel();
		const badge = await screen.findByText("Reserved");
		const row = badge.closest("li") as HTMLElement;
		expect(row).toHaveTextContent("— · 15 s");
		expect(row).not.toHaveTextContent("Invalid Date");

		const trigger = screen.getByRole("button", {
			name: "Show technical details",
		});
		await user.click(trigger);
		const region = document.getElementById(
			trigger.getAttribute("aria-controls") ?? "",
		) as HTMLElement;
		expect(
			within(region).getByText(/runAt=not-a-provider-timestamp/),
		).toBeInTheDocument();
	});

	it("a reservation without runAt reads 即時実行 / Run immediately — not ASAP", async () => {
		const asap = {
			id: SCHEDULED_ID,
			contentId: CONTENT_ID,
			durationInSeconds: 15,
			status: "SCHEDULED",
		};
		mockContentApis(queueOf(asap));
		const ja = renderPanel("ja");
		expect(await screen.findByText(/即時実行/)).toBeInTheDocument();
		expect(screen.queryByText(/ASAP/)).toBeNull();
		expect(screen.getByText(/15 秒間/)).toBeInTheDocument();
		ja.unmount();

		mockContentApis(queueOf(asap));
		renderPanel("en");
		expect(await screen.findByText(/Run immediately/)).toBeInTheDocument();
		expect(screen.queryByText(/ASAP/)).toBeNull();
	});

	it("cancels ONE reservation by DELETE with the row's own contentId — and never posts the global stop", async () => {
		mockContentApis(queueOf(futureReservation));
		const user = userEvent.setup();
		renderPanel();
		const runAt = new Intl.DateTimeFormat("en", {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(new Date(futureReservation.runAt));
		await user.click(
			await screen.findByRole("button", {
				name: `Cancel reservation for ${CONTENT_ID}, scheduled for ${runAt} (reservation ID ${SCHEDULED_ID})`,
			}),
		);
		await waitFor(() => {
			const call = apiFetch.mock.calls.find((c) =>
				String(c[0]).includes(`/schedule/${SCHEDULED_ID}?`),
			);
			expect(call).toBeDefined();
			expect(String(call?.[0])).toContain(`contentId=${CONTENT_ID}`);
			expect((call?.[1] as { method: string }).method).toBe("DELETE");
		});
		expect(stopCalls()).toHaveLength(0);
	});

	it("offers Cancel reservation only on rows that can still be cancelled", async () => {
		mockContentApis(
			queueOf(
				...SCHEDULED_CONTENT_STATUSES.map((status, i) => ({
					...futureReservation,
					id: `0000000${i}-0000-4000-8000-000000000277`,
					status,
				})),
			),
		);
		renderPanel();
		await screen.findByText("Reserved");
		const rowOf = (label: string) =>
			screen.getByText(label).closest("li") as HTMLElement;
		const cancelIn = (label: string) =>
			within(rowOf(label)).queryByRole("button", {
				name: /Cancel reservation for/,
			});
		expect(cancelIn("Registering")).not.toBeNull();
		expect(cancelIn("Reserved")).not.toBeNull();
		expect(cancelIn("Cancelling")).toBeNull();
		expect(cancelIn("Cancelled")).toBeNull();
		expect(cancelIn("Reservation error")).toBeNull();
		expect(
			screen.getAllByRole("button", { name: /Cancel reservation for/ }),
		).toHaveLength(2);
	});

	it.each([
		{
			locale: "en" as const,
			cancelLabel: (name: string, runAt: string, scheduledId: string) =>
				`Cancel reservation for ${name}, scheduled for ${runAt} (reservation ID ${scheduledId})`,
		},
		{
			locale: "ja" as const,
			cancelLabel: (name: string, runAt: string, scheduledId: string) =>
				`${runAt} に実行する「${name}」の予約を解除 (予約 ID: ${scheduledId})`,
		},
	])("$locale: distinguishes same-name/content reservations by localized runAt + scheduledId and DELETEs the selected ids", async ({
		locale,
		cancelLabel,
	}) => {
		const secondScheduledId = "33334444-5555-4666-8777-888899990000";
		const secondRunAt = "2099-01-01T01:00:00Z";
		const sharedName = "Sponsor slate";
		mockContentApis(
			queueOf(
				{ ...futureReservation, name: sharedName },
				{
					...futureReservation,
					id: secondScheduledId,
					name: sharedName,
					runAt: secondRunAt,
				},
			),
		);
		const user = userEvent.setup();
		renderPanel(locale);

		expect(await screen.findAllByText(sharedName)).toHaveLength(2);
		const localizedRunAt = new Intl.DateTimeFormat(locale, {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(new Date(futureReservation.runAt));
		const localizedSecondRunAt = new Intl.DateTimeFormat(locale, {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(new Date(secondRunAt));
		const identity = `${sharedName} (${CONTENT_ID})`;
		const firstCancel = screen.getByRole("button", {
			name: cancelLabel(identity, localizedRunAt, SCHEDULED_ID),
		});
		const secondCancel = screen.getByRole("button", {
			name: cancelLabel(identity, localizedSecondRunAt, secondScheduledId),
		});
		expect(firstCancel).toBeInTheDocument();
		expect(secondCancel).toBeInTheDocument();
		expect(firstCancel.closest("li")).toHaveTextContent(localizedRunAt);
		expect(secondCancel.closest("li")).toHaveTextContent(localizedSecondRunAt);

		await user.click(secondCancel);
		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				(c) =>
					String(c[0]).includes(`/schedule/${secondScheduledId}?`) &&
					(c[1] as { method?: string } | undefined)?.method === "DELETE",
			);
			expect(call).toBeDefined();
			expect(String(call?.[0])).toContain(`contentId=${CONTENT_ID}`);
		});
		expect(stopCalls()).toHaveLength(0);
	});

	it("uses contentId when name is absent and binds DELETE to that row's distinct scheduledId + contentId", async () => {
		const secondScheduledId = "33334444-5555-4666-8777-888899990000";
		const secondContentId = "bbbbcccc-dddd-4eee-8fff-000011112222";
		mockContentApis(
			queueOf(
				{ ...futureReservation, name: "Sponsor slate" },
				{
					...futureReservation,
					id: secondScheduledId,
					contentId: secondContentId,
				},
			),
		);
		const user = userEvent.setup();
		renderPanel();

		expect(await screen.findByText("bbbbcccc…")).toBeInTheDocument();
		const localizedRunAt = new Intl.DateTimeFormat("en", {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(new Date(futureReservation.runAt));
		const fallbackCancel = screen.getByRole("button", {
			name: `Cancel reservation for ${secondContentId}, scheduled for ${localizedRunAt} (reservation ID ${secondScheduledId})`,
		});

		await user.click(fallbackCancel);
		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				(c) =>
					String(c[0]).includes(`/schedule/${secondScheduledId}?`) &&
					(c[1] as { method?: string } | undefined)?.method === "DELETE",
			);
			expect(call).toBeDefined();
			expect(String(call?.[0])).toContain(`contentId=${secondContentId}`);
		});
		expect(stopCalls()).toHaveLength(0);
	});

	it("uses scheduledId as the final accessible-name fallback when name, contentId, and runAt all collide", async () => {
		const secondScheduledId = "33334444-5555-4666-8777-888899990000";
		const sharedName = "Sponsor slate";
		mockContentApis(
			queueOf(
				{ ...futureReservation, name: sharedName },
				{ ...futureReservation, id: secondScheduledId, name: sharedName },
			),
		);
		renderPanel();

		const localizedRunAt = new Intl.DateTimeFormat("en", {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(new Date(futureReservation.runAt));
		const identity = `${sharedName} (${CONTENT_ID})`;
		const firstLabel = `Cancel reservation for ${identity}, scheduled for ${localizedRunAt} (reservation ID ${SCHEDULED_ID})`;
		const secondLabel = `Cancel reservation for ${identity}, scheduled for ${localizedRunAt} (reservation ID ${secondScheduledId})`;
		expect(
			await screen.findByRole("button", { name: firstLabel }),
		).toBeVisible();
		expect(screen.getByRole("button", { name: secondLabel })).toBeVisible();
		expect(firstLabel).not.toBe(secondLabel);
	});

	it("keeps past-due and exact-runAt-boundary SCHEDULED rows as reservations — never active/on-air", async () => {
		const boundary = new Date();
		mockContentApis(
			queueOf(
				{
					...futureReservation,
					id: "44445555-6666-4777-8888-999900001111",
					name: "Past reservation",
					runAt: new Date(boundary.getTime() - 60_000).toISOString(),
				},
				{
					...futureReservation,
					id: "55556666-7777-4888-8999-000011112222",
					contentId: "ccccdddd-eeee-4fff-8000-111122223333",
					name: "Boundary reservation",
					runAt: boundary.toISOString(),
				},
			),
		);
		renderPanel();

		const badges = await screen.findAllByText("Reserved");
		expect(badges).toHaveLength(2);
		for (const badge of badges) {
			const row = badge.closest("li") as HTMLElement;
			expect(row.textContent ?? "").not.toMatch(
				/current|on.?air|covering|playing|live now/i,
			);
			expect(badge.className).not.toMatch(/emerald|green/);
		}
		expect(stopCalls()).toHaveLength(0);
	});

	it.each([
		{
			caseName: "absent provider status in English",
			locale: "en" as const,
			providerStatus: null,
			label: "Reservation status unknown",
			rawStatus: "status=-",
		},
		{
			caseName: "absent provider status in Japanese",
			locale: "ja" as const,
			providerStatus: null,
			label: "予約状態を確認できません",
			rawStatus: "status=-",
		},
		{
			caseName: "unknown provider status in English",
			locale: "en" as const,
			providerStatus: "ACTIVE",
			label: "Reservation status unknown",
			rawStatus: "status=ACTIVE",
		},
		{
			caseName: "unknown provider status in Japanese",
			locale: "ja" as const,
			providerStatus: "ACTIVE",
			label: "予約状態を確認できません",
			rawStatus: "status=ACTIVE",
		},
	])("$caseName is neutral, offers no destructive action, and keeps its raw value in technical details", async ({
		locale,
		providerStatus,
		label,
		rawStatus,
	}) => {
		const reservation: Record<string, unknown> = { ...futureReservation };
		if (providerStatus === null) {
			delete reservation.status;
		} else {
			reservation.status = providerStatus;
		}
		mockContentApis(queueOf(reservation));
		const user = userEvent.setup();
		renderPanel(locale);

		const badge = await screen.findByText(label);
		expect(badge.className).toMatch(/text-zinc-400/);
		expect(badge.className).not.toMatch(/emerald|green|sky/);
		if (providerStatus !== null) {
			expect(badge.closest("li")?.textContent).not.toContain(providerStatus);
		}
		expect(
			within(badge.closest("li") as HTMLElement).queryByRole("button"),
		).toBeNull();
		expect(
			apiFetch.mock.calls.some(
				(call) =>
					String(call[0]).includes(`/schedule/${SCHEDULED_ID}?`) &&
					(call[1] as { method?: string } | undefined)?.method === "DELETE",
			),
		).toBe(false);

		const trigger = screen.getByRole("button", {
			name: locale === "ja" ? "技術情報を表示" : "Show technical details",
		});
		await user.click(trigger);
		const region = document.getElementById(
			trigger.getAttribute("aria-controls") ?? "",
		) as HTMLElement;
		expect(within(region).getByText(new RegExp(rawStatus))).toBeInTheDocument();
	});

	it("an empty queue reads 'No reservations' with no technical disclosure", async () => {
		mockContentApis(queueOf());
		renderPanel();
		expect(await screen.findByText("No reservations.")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Show technical details" }),
		).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
	});
});

describe("ChannelDnsMappingsPanel (channel detail, read-only)", () => {
	it("lists the encoding's hostnames with copy affordances", async () => {
		apiFetch.mockResolvedValue({
			totalCount: 1,
			items: [
				{
					id: "dns-1",
					subdomain: "studio-a",
					hostname: "studio-a.live.bitmovin.com",
					ip: "203.0.113.5",
				},
			],
		});
		wrap(
			<ChannelDnsMappingsPanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
		);
		// The hostname renders twice by design: as the row label and inside the
		// CopyableId affordance.
		expect(
			await screen.findAllByText("studio-a.live.bitmovin.com"),
		).toHaveLength(2);
		expect(screen.getByText("→ 203.0.113.5")).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: /Copy DNS hostname: studio-a\.live\.bitmovin\.com/,
			}),
		).toBeInTheDocument();
	});

	it("says where to create one when the encoding has none", async () => {
		apiFetch.mockResolvedValue({ totalCount: 0, items: [] });
		wrap(
			<ChannelDnsMappingsPanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
		);
		expect(
			await screen.findByText(/create a mapping in Settings → Live/),
		).toBeInTheDocument();
	});

	it("does not fetch on a non-RUNNING channel", () => {
		wrap(
			<ChannelDnsMappingsPanel
				channelId={CHANNEL_ID}
				status="STOPPED"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
		);
		expect(
			screen.getByText(/while the channel is RUNNING/),
		).toBeInTheDocument();
		expect(apiFetch).not.toHaveBeenCalled();
	});
});

describe("LiveToVodPanel", () => {
	it.each([
		"ja",
		"en",
	] as const)("keeps long manifest IDs copyable in wrapping result rows (%s)", async (locale) => {
		const user = userEvent.setup();
		const writeText = vi
			.spyOn(navigator.clipboard, "writeText")
			.mockResolvedValue();
		const manifests = (["HLS", "DASH"] as const).map((type, index) => ({
			type,
			manifestId: `00000000-0000-4000-8000-00000000000${index}`,
			url: `recordings/channel-with-long-output-prefix/run-3/${type}/master.${index ? "mpd" : "m3u8"}`,
		}));
		try {
			wrap(
				<LiveToVodPanel
					channelId={CHANNEL_ID}
					status="STOPPED"
					record={{
						status: "FINISHED",
						requestedAt: "2026-08-06T00:00:00.000Z",
						manifests,
					}}
					onStarted={() => {}}
				/>,
				locale,
			);
			for (const manifest of manifests) {
				const copy = screen.getByRole("button", {
					name: new RegExp(manifest.manifestId),
				});
				// Browser r3 showed the unshrinkable chip overflowing a 219px row.
				// Pin the local wrapping/shrinking rails; browser geometry is checked separately.
				expect(copy.closest("li")).toHaveClass("flex-wrap");
				expect(copy).toHaveClass("min-w-0");
				expect(screen.getByText(manifest.url)).toHaveAttribute(
					"title",
					manifest.url,
				);
				await user.click(copy);
				expect(writeText).toHaveBeenLastCalledWith(manifest.manifestId);
			}
		} finally {
			writeText.mockRestore();
		}
	});

	it("refuses to publish while the channel is not STOPPED", () => {
		wrap(
			<LiveToVodPanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				record={null}
				onStarted={() => {}}
			/>,
		);
		// The gate is the point: a still-recording channel yields a truncated
		// manifest, so there is no button to press at all.
		expect(screen.getByText(/Stop the channel first/)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Publish as VOD/ }),
		).not.toBeInTheDocument();
	});

	it("posts both checked families explicitly, and refetches", async () => {
		apiFetch.mockResolvedValue({ status: "RUNNING" });
		const onStarted = vi.fn();
		wrap(
			<LiveToVodPanel
				channelId={CHANNEL_ID}
				status="STOPPED"
				record={null}
				onStarted={onStarted}
			/>,
		);
		await userEvent.click(
			screen.getByRole("button", { name: /Publish as VOD/ }),
		);
		await waitFor(() => expect(onStarted).toHaveBeenCalled());
		const [, init] = apiFetch.mock.calls[0] as [string, { body: string }];
		expect(JSON.parse(init.body)).toEqual({ manifests: ["HLS", "DASH"] });
	});

	it("sends the chosen family and path when narrowed", async () => {
		apiFetch.mockResolvedValue({ status: "RUNNING" });
		wrap(
			<LiveToVodPanel
				channelId={CHANNEL_ID}
				status="STOPPED"
				record={null}
				onStarted={() => {}}
			/>,
		);
		await userEvent.click(screen.getByRole("checkbox", { name: "DASH" }));
		// An ANCESTOR of the recording — the only shape the API accepts since
		// C35 (a default manifest must sit above the muxings it lists). The
		// panel itself still just forwards what was typed.
		await userEvent.type(screen.getByLabelText("Manifest path"), "output/ch");
		await userEvent.click(
			screen.getByRole("button", { name: /Publish as VOD/ }),
		);
		await waitFor(() => expect(apiFetch).toHaveBeenCalled());
		const [, init] = apiFetch.mock.calls[0] as [string, { body: string }];
		expect(JSON.parse(init.body)).toEqual({
			manifests: ["HLS"],
			path: "output/ch",
		});
	});

	it("blocks submission with no family selected", async () => {
		wrap(
			<LiveToVodPanel
				channelId={CHANNEL_ID}
				status="STOPPED"
				record={null}
				onStarted={() => {}}
			/>,
		);
		await userEvent.click(screen.getByRole("checkbox", { name: "HLS" }));
		await userEvent.click(screen.getByRole("checkbox", { name: "DASH" }));
		expect(
			screen.getByRole("button", { name: /Publish as VOD/ }),
		).toBeDisabled();
		expect(apiFetch).not.toHaveBeenCalled();
	});

	it("preselects only the families the recording can carry and disables the rest (row #323)", async () => {
		apiFetch.mockResolvedValue({ status: "RUNNING" });
		wrap(
			<LiveToVodPanel
				channelId={CHANNEL_ID}
				status="STOPPED"
				record={null}
				families={{ supported: ["HLS"], unsupported: [{ family: "DASH" }] }}
				onStarted={() => {}}
			/>,
		);
		expect(screen.getByRole("checkbox", { name: "HLS" })).toBeChecked();
		const dash = screen.getByRole("checkbox", { name: "DASH" });
		expect(dash).not.toBeChecked();
		expect(dash).toBeDisabled();
		expect(
			screen.getByText(/does not support DASH manifest generation/),
		).toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: /Publish as VOD/ }),
		);
		await waitFor(() => expect(apiFetch).toHaveBeenCalled());
		const [, init] = apiFetch.mock.calls[0] as [string, { body: string }];
		expect(JSON.parse(init.body)).toEqual({ manifests: ["HLS"] });
	});

	it("says the recording cannot be published at all when no family is supported, instead of asking for a selection (row #323)", () => {
		wrap(
			<LiveToVodPanel
				channelId={CHANNEL_ID}
				status="STOPPED"
				record={null}
				families={{
					supported: [],
					unsupported: [{ family: "HLS" }, { family: "DASH" }],
				}}
				onStarted={() => {}}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /Publish as VOD/ }),
		).toBeDisabled();
		expect(
			screen.getByText(/No VOD manifest can be generated/),
		).toBeInTheDocument();
		expect(screen.queryByText(/Select at least one/)).not.toBeInTheDocument();
	});

	it("maps a stable start error code to localized copy without exposing route prose", async () => {
		apiFetch.mockRejectedValue(
			new ApiError(422, "DASH provider-specific raw English", {
				code: "L2V_UNSUPPORTED_FAMILY",
			}),
		);
		wrap(
			<LiveToVodPanel
				channelId={CHANNEL_ID}
				status="STOPPED"
				record={null}
				onStarted={() => {}}
			/>,
			"ja",
		);
		await userEvent.click(
			screen.getByRole("button", { name: "VOD として公開" }),
		);
		expect(
			await screen.findByText(
				"選択したマニフェストは、この録画形式では生成できません。選択内容を変更してください。",
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/provider-specific raw English/)).toBeNull();
	});

	it("shows a finished run's manifests and disables the button while one runs", () => {
		const { unmount } = wrap(
			<LiveToVodPanel
				channelId={CHANNEL_ID}
				status="STOPPED"
				record={{
					status: "FINISHED",
					requestedAt: "2026-08-06T00:00:00.000Z",
					finishedAt: "2026-08-06T00:02:00.000Z",
					manifests: [
						{
							type: "HLS",
							manifestId: "bm-vod-hls",
							url: "chan/vod.m3u8",
						},
					],
				}}
				onStarted={() => {}}
			/>,
		);
		expect(screen.getByText("chan/vod.m3u8")).toBeInTheDocument();
		unmount();

		wrap(
			<LiveToVodPanel
				channelId={CHANNEL_ID}
				status="STOPPED"
				record={{
					status: "RUNNING",
					requestedAt: "2026-08-06T00:00:00.000Z",
					manifests: [],
				}}
				onStarted={() => {}}
			/>,
		);
		expect(screen.getByRole("button", { name: /Generating/ })).toBeDisabled();
	});

	it("shows a PARTIAL roll family by family: the delivered manifest, the failed family's error, and the retry hint (ledger #283)", () => {
		const providerIdentity = {
			attemptId: "attempt-1",
			encodingId: "encoding-1",
			outputId: "output-1",
			outputPath: "chan",
			manifestName: "vod.m3u8",
		};
		wrap(
			<LiveToVodPanel
				channelId={CHANNEL_ID}
				status="STOPPED"
				record={{
					status: "PARTIAL",
					requestedAt: "2026-08-30T00:00:00.000Z",
					finishedAt: "2026-08-30T00:02:00.000Z",
					path: "chan",
					families: [
						{
							type: "HLS",
							status: "FINISHED",
							providerIdentity,
							manifestId: "bm-vod-hls",
							url: "chan/vod.m3u8",
						},
						{
							type: "DASH",
							status: "ERROR",
							errorCode: "L2V_PROVIDER_CREATE_FAILED",
							error: "code 2700: Muxing type not supported for DASH manifest",
						},
					],
					manifests: [
						{ type: "HLS", manifestId: "bm-vod-hls", url: "chan/vod.m3u8" },
					],
					error: "DASH: code 2700",
				}}
				onStarted={() => {}}
			/>,
		);
		// The delivered HLS is listed as a manifest — it was not erased by DASH.
		expect(screen.getByText("chan/vod.m3u8")).toBeInTheDocument();
		const families = screen.getByRole("list", { name: "Manifest families" });
		expect(screen.getByText("Partially complete")).toBeInTheDocument();
		expect(screen.queryByText("PARTIAL")).toBeNull();
		expect(families).toHaveTextContent(/HLS\s*Generated/);
		expect(families).toHaveTextContent(/DASH\s*Failed/);
		expect(families).not.toHaveTextContent(/FINISHED|ERROR/);
		expect(families).toHaveTextContent(
			/The manifest generation status could not be confirmed\. Please try again\./,
		);
		expect(families).not.toHaveTextContent(/Muxing type not supported/);
		expect(
			screen.getByText(/generates only the failed family/),
		).toBeInTheDocument();
		// A terminal record: publishing again is allowed.
		expect(
			screen.getByRole("button", { name: /Publish as VOD/ }),
		).toBeEnabled();
	});

	it("explains an unsupported family in natural Japanese without exposing the internal status or English reason", () => {
		const providerIdentity = {
			attemptId: "attempt-1",
			encodingId: "encoding-1",
			outputId: "output-1",
			outputPath: "chan",
			manifestName: "vod.m3u8",
		};
		wrap(
			<LiveToVodPanel
				channelId={CHANNEL_ID}
				status="STOPPED"
				record={{
					status: "FINISHED",
					families: [
						{
							type: "HLS",
							status: "FINISHED",
							providerIdentity,
							manifestId: "bm-vod-hls",
							url: "chan/vod.m3u8",
						},
						{
							type: "DASH",
							status: "SKIPPED_UNSUPPORTED",
							reasonCode: "L2V_UNSUPPORTED_FAMILY",
							reason: "this recording supports HLS only",
						},
					],
					manifests: [
						{ type: "HLS", manifestId: "bm-vod-hls", url: "chan/vod.m3u8" },
					],
				}}
				onStarted={() => {}}
			/>,
			"ja",
		);
		const families = screen.getByRole("list", {
			name: "マニフェストの種類",
		});
		expect(families).toHaveTextContent(/HLS\s*生成完了/);
		expect(families).toHaveTextContent(/DASH\s*対応していません/);
		expect(families).toHaveTextContent(
			"この録画形式では DASH マニフェストを生成できません。",
		);
		expect(families).not.toHaveTextContent(
			/SKIPPED_UNSUPPORTED|FINISHED|supports HLS only/,
		);
		expect(screen.queryByText(/generates only the failed family/)).toBeNull();
	});

	it("shows localized customer copy and withholds raw provider English on the normal Japanese view", () => {
		wrap(
			<LiveToVodPanel
				channelId={CHANNEL_ID}
				status="STOPPED"
				record={{
					status: "ERROR",
					families: [
						{
							type: "HLS",
							status: "ERROR",
							errorCode: "L2V_PROVIDER_STATUS_FAILED",
							error: "Manifest ended ERROR: internal vendor stack in English",
						},
					],
					manifests: [],
					errorCode: "L2V_PROVIDER_STATUS_FAILED",
					error: "HLS: Manifest ended ERROR: internal vendor stack in English",
				}}
				onStarted={() => {}}
			/>,
			"ja",
		);
		expect(
			screen.getAllByText(
				"マニフェストの生成状況を確認できませんでした。再実行してください。",
			),
		).toHaveLength(2);
		expect(
			screen.queryByText(/internal vendor stack|Manifest ended ERROR/),
		).toBeNull();
	});
});
