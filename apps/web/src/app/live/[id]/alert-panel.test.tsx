import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { renderWithQuery } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { AlertPanel, type ChannelAlertEvent } from "./alert-panel";

/**
 *  PR2 — the banner colors by severity, history shows the
 * open→resolve span, the channel-rule form posts WITH the channel id and
 * shows the threshold field only for numeric metrics, and ja renders
 * through the catalogue.
 */

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000c6";

function event(over: Partial<ChannelAlertEvent> = {}): ChannelAlertEvent {
	return {
		id: "e-1",
		openedAt: "2026-08-13T10:00:00.000Z",
		resolvedAt: null,
		context: {},
		rule: {
			metric: "INPUT_DISCONNECTED",
			severity: "CRIT",
			threshold: null,
			windowPolls: 2,
		},
		...over,
	};
}

/**
 *  split this panel in two by `mode`: `open` is the Operations
 * readout (firing events + resolve), `manage` is the Diagnostics editor
 * (rule form + resolved history). The default here stays `open`, matching
 * the component's own default, and the tests that exercise the editor say
 * which half they mean — a test that forgot would silently assert against
 * the half the operator never configures from.
 */
function renderPanel(over: {
	open?: ChannelAlertEvent[];
	history?: ChannelAlertEvent[];
	locale?: "en" | "ja";
	fetchError?: string | null;
	mode?: "open" | "manage";
	onChanged?: () => void;
}) {
	return renderWithQuery(
		<AlertPanel
			channelId={CHANNEL_ID}
			open={over.open ?? []}
			history={over.history ?? []}
			fetchError={over.fetchError ?? null}
			mode={over.mode ?? "open"}
			onChanged={over.onChanged ?? (() => {})}
		/>,
		over.locale ?? "en",
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	apiFetch.mockResolvedValue({ id: "r-new" });
});

describe("AlertPanel", () => {
	it("renders open alerts as a severity-colored banner with role=alert", () => {
		renderPanel({
			open: [
				event(),
				event({
					id: "e-2",
					rule: {
						metric: "BITRATE_BELOW",
						severity: "WARN",
						threshold: 1_000_000,
						windowPolls: 2,
					},
				}),
			],
		});
		// The metric labels ALSO exist as form <option>s — scope to the banner.
		const banner = screen.getByRole("alert");
		expect(banner).toHaveTextContent("Input disconnected");
		expect(banner).toHaveTextContent("Bitrate below");
		expect(banner).toHaveTextContent("CRIT");
	});

	it("quiet channel shows the quiet sentence, no alert role", () => {
		renderPanel({});
		expect(screen.getByText("No alerts firing.")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("history rows show the open→resolve span", () => {
		renderPanel({
			mode: "manage",
			history: [
				event({
					id: "e-3",
					resolvedAt: "2026-08-13T10:05:00.000Z",
				}),
			],
		});
		expect(screen.getByText(/→/)).toBeInTheDocument();
	});

	it("a PROVIDER_WARNING event renders the encoder's message verbatim — open banner and history alike", () => {
		const KEYFRAME =
			"At least one input video stream key-frame interval is larger than the threshold: 2167 ms >= 2000 ms!";
		const providerEvent = (id: string, resolvedAt: string | null) =>
			event({
				id,
				resolvedAt,
				context: { eventType: "WARNING", message: KEYFRAME },
				rule: {
					metric: "PROVIDER_WARNING",
					severity: "WARN",
					threshold: null,
					windowPolls: 2,
				},
			});
		const { unmount } = renderPanel({ open: [providerEvent("e-open", null)] });
		expect(screen.getByText("Encoder warning/error event")).toBeInTheDocument();
		expect(screen.getByText(KEYFRAME)).toBeInTheDocument();
		unmount();
		renderPanel({
			mode: "manage",
			history: [providerEvent("e-hist", "2026-08-13T10:05:00.000Z")],
			locale: "ja",
		});
		// The manage half also lists the metric in the rule form's <select>, so
		// the label appears twice; the history row is the one with the message.
		expect(
			screen.getAllByText("エンコーダの警告/エラーイベント").length,
		).toBeGreaterThanOrEqual(2);
		expect(screen.getByText(KEYFRAME)).toBeInTheDocument();
		expect(screen.getByText(/エンコーダのメッセージ/)).toBeInTheDocument();
	});

	it("an event whose context carries no message renders no message line", () => {
		renderPanel({ open: [event({ context: { status: "DISCONNECTED" } })] });
		expect(screen.queryByText(/Encoder message/)).not.toBeInTheDocument();
	});

	it("threshold field appears ONLY for numeric metrics", async () => {
		renderPanel({ mode: "manage" });
		expect(screen.queryByLabelText("Threshold")).toBeNull();
		await userEvent.selectOptions(
			screen.getByLabelText("Metric"),
			"BITRATE_BELOW",
		);
		expect(screen.getByLabelText("Threshold")).toBeInTheDocument();
	});

	it("adding a channel rule posts WITH the channel id", async () => {
		renderPanel({ mode: "manage" });
		await userEvent.selectOptions(screen.getByLabelText("Metric"), "FPS_BELOW");
		await userEvent.type(screen.getByLabelText("Threshold"), "24");
		await userEvent.selectOptions(screen.getByLabelText("Severity"), "CRIT");
		await userEvent.click(
			screen.getByRole("button", { name: "Add channel rule" }),
		);
		const call = apiFetch.mock.calls.find(
			([, init]) => (init as RequestInit | undefined)?.method === "POST",
		);
		expect(call?.[0]).toBe("/api/alert-rules");
		const body = JSON.parse((call?.[1] as RequestInit).body as string);
		expect(body).toMatchObject({
			liveChannelId: CHANNEL_ID,
			metric: "FPS_BELOW",
			threshold: 24,
			severity: "CRIT",
		});
	});

	it("a numeric rule without a threshold is refused CLIENT-side, translated", async () => {
		renderPanel({ mode: "manage", locale: "ja" });
		await userEvent.selectOptions(
			screen.getByLabelText("メトリクス"),
			"BITRATE_BELOW",
		);
		await userEvent.click(
			screen.getByRole("button", { name: "チャンネルルールを追加" }),
		);
		expect(
			await screen.findByText(/数値系のアラートルールにはしきい値が必要です/),
		).toBeInTheDocument();
		expect(
			apiFetch.mock.calls.find(
				([, init]) => (init as RequestInit | undefined)?.method === "POST",
			),
		).toBeUndefined();
	});

	it("renders Japanese throughout — BOTH halves of the row #249 split", () => {
		const readout = renderPanel({ open: [event()], locale: "ja" });
		expect(screen.getByRole("alert")).toHaveTextContent("入力切断");
		// The editor half is not in the readout — that IS the split.
		expect(screen.queryByText("解決済みの履歴")).toBeNull();
		readout.unmount();

		renderPanel({ mode: "manage", locale: "ja" });
		expect(screen.getByText("解決済みの履歴")).toBeInTheDocument();
		expect(
			screen.getByText("このチャンネル専用のルールを追加"),
		).toBeInTheDocument();
	});
});

describe("review-83b folds", () => {
	it("a FAILED fetch renders the failure, never the quiet sentence (I5)", () => {
		renderPanel({ fetchError: "boom 500" });
		expect(
			screen.getByText(/Alerts could not be loaded: boom 500/),
		).toBeInTheDocument();
		expect(screen.queryByText(/No alerts firing/)).toBeNull();
	});

	it("Resolve PATCHes the event route and refetches (C1's operator escape)", async () => {
		const onChanged = vi.fn();
		renderPanel({ open: [event()], onChanged });
		await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
		expect(apiFetch).toHaveBeenCalledWith(
			`/api/live-channels/${CHANNEL_ID}/alerts/e-1`,
			expect.objectContaining({
				method: "PATCH",
				body: JSON.stringify({ action: "resolve" }),
			}),
		);
		await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it("a LOST resolve race surfaces the 409 and still refetches the truth", async () => {
		const onChanged = vi.fn();
		apiFetch.mockRejectedValue(
			new ApiError(409, "Already resolved", {
				code: "ALERT_ALREADY_RESOLVED",
			}),
		);
		renderPanel({ open: [event()], onChanged });
		await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
		const alert = await screen.findByText(
			/Resolve failed: This alert has already been resolved/,
		);
		expect(alert).toHaveTextContent(
			"Resolve failed: This alert has already been resolved. Refresh the page to see its latest state.",
		);
		expect(alert).not.toHaveTextContent("Already resolved");
		await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it("switching AWAY from a numeric metric clears the stranded threshold (I8)", async () => {
		renderPanel({ mode: "manage" });
		const user = userEvent.setup();
		await user.selectOptions(screen.getByLabelText("Metric"), "BITRATE_BELOW");
		await user.type(screen.getByLabelText("Threshold"), "500000");
		await user.selectOptions(
			screen.getByLabelText("Metric"),
			"INPUT_DISCONNECTED",
		);
		// The field is gone AND its value no longer rides the submit — the
		// old code blocked the add with a message about an invisible field.
		expect(screen.queryByLabelText("Threshold")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Add channel rule" }));
		await vi.waitFor(() => {
			const post = apiFetch.mock.calls.find(
				([, init]) => (init as RequestInit | undefined)?.method === "POST",
			);
			expect(post).toBeDefined();
			const body = JSON.parse((post?.[1] as RequestInit).body as string);
			expect("threshold" in body).toBe(false);
		});
	});
});
