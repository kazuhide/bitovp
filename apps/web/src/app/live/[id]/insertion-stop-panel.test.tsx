import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

import { ApiError } from "@/lib/api";
import { InsertedContentStopPanel } from "./insertion-stop-panel";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const CHANNEL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const STOP_URL = `/api/live-channels/${CHANNEL_ID}/insertable-content/stop`;

const ACTION = "Stop the playing inserted content and return to the live input";
const CONFIRM_TITLE = "Stop the inserted content that is playing?";
const CONFIRM = "Stop and return to the live input";

afterEach(() => {
	vi.clearAllMocks();
});

function renderPanel(locale: "en" | "ja" = "en") {
	return wrap(
		<InsertedContentStopPanel
			channelId={CHANNEL_ID}
			status="RUNNING"
			bitmovinAccountId={ACCOUNT_ID}
		/>,
		locale,
	);
}

/**
 * the global
 * `POST …/insertable-content/stop` is an EMERGENCY operation on whatever is
 * playing — not a reservation action, and not a claim that anything was
 * playing. So: confirm-gated, one POST, copy that says the stop was ACCEPTED
 * and that reservations are untouched, and the provider's own 409 verbatim
 * when there was nothing to stop.
 */
describe("InsertedContentStopPanel (row #277)", () => {
	it("is confirm-gated: the button opens a dialog and nothing is posted until confirmed; cancelling posts nothing", async () => {
		apiFetch.mockResolvedValue({ encodingId: "enc-1", stopped: true });
		const user = userEvent.setup();
		renderPanel();

		// The lead states both halves: what it does, and what it leaves alone.
		expect(
			screen.getByText(/Future reservations are not cancelled/),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: ACTION }));
		const dialog = await screen.findByRole("dialog", { name: CONFIRM_TITLE });
		expect(dialog).toHaveTextContent(/This sends a request to stop/);
		expect(dialog).toHaveTextContent(/Future reservations stay as they are/);
		expect(dialog.textContent).not.toMatch(/immediately|cuts back/i);
		expect(apiFetch).not.toHaveBeenCalled();

		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});
		expect(apiFetch).not.toHaveBeenCalled();
	});

	it.each([
		{
			locale: "en" as const,
			action: ACTION,
			confirm: CONFIRM,
			pending: "Sending stop request…",
		},
		{
			locale: "ja" as const,
			action: "再生中の差し込みコンテンツを停止してライブ入力へ戻す",
			confirm: "停止してライブ入力へ戻す",
			pending: "停止リクエストを送信しています…",
		},
	])("$locale: exposes request-only pending state on the visible confirm button", async ({
		locale,
		action,
		confirm,
		pending,
	}) => {
		let resolveStop!: (value: { encodingId: string; stopped: boolean }) => void;
		apiFetch.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveStop = resolve;
				}),
		);
		const user = userEvent.setup();
		renderPanel(locale);
		await user.click(screen.getByRole("button", { name: action }));
		const dialog = await screen.findByRole("dialog");
		const pendingStatus = within(dialog).getByRole("status");
		expect(pendingStatus).toBeEmptyDOMElement();
		await user.click(within(dialog).getByRole("button", { name: confirm }));

		const pendingButton = await within(dialog).findByRole("button", {
			name: pending,
		});
		expect(pendingButton).toBeDisabled();
		expect(pendingButton).toHaveAttribute("aria-busy", "true");
		expect(pendingButton).toHaveTextContent(pending);
		expect(pendingStatus).toHaveTextContent(pending);
		expect(pendingStatus.closest("button")).toBeNull();
		expect(within(dialog).getAllByRole("status")).toHaveLength(1);
		expect(pendingButton.textContent).not.toMatch(/return|back|戻|復帰/i);

		resolveStop({ encodingId: "enc-1", stopped: true });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("confirming POSTs the global stop exactly once, with the account id, re-reads the reservations, and says 'accepted' — not 'on air'", async () => {
		apiFetch.mockResolvedValue({ encodingId: "enc-1", stopped: true });
		const user = userEvent.setup();
		const { client } = renderPanel();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		await user.click(screen.getByRole("button", { name: ACTION }));
		await user.click(
			within(await screen.findByRole("dialog")).getByRole("button", {
				name: CONFIRM,
			}),
		);

		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith(
				STOP_URL,
				expect.objectContaining({ method: "POST" }),
			);
		});
		expect(apiFetch).toHaveBeenCalledTimes(1);
		expect(
			JSON.parse((apiFetch.mock.calls[0]?.[1] as { body: string }).body),
		).toEqual({ bitmovinAccountId: ACCOUNT_ID });

		const accepted = await screen.findByText("Stop request accepted.");
		expect(accepted.textContent).not.toMatch(
			/return(?:ed|ing)?|back|live input|live feed|on.?air|playing|restored|switched/i,
		);
		// The reservation list is refreshed, never edited: the stop touched
		// what was playing, and only the provider knows whether that moved a
		// row's status.
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: ["live-scheduled-content", CHANNEL_ID],
		});
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});
	});

	it("explains a coded 409 without exposing the provider's English prose", async () => {
		apiFetch.mockRejectedValue(
			new ApiError(409, "SHOULD_NOT_LEAK provider detail", {
				code: "CONTENT_INSERT_NOT_ACTIVE",
			}),
		);
		const user = userEvent.setup();
		renderPanel();
		await user.click(screen.getByRole("button", { name: ACTION }));
		await user.click(
			within(await screen.findByRole("dialog")).getByRole("button", {
				name: CONFIRM,
			}),
		);
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"No inserted content is currently playing, so no stop is needed. Refresh the scheduled insertions to confirm their current state.",
		);
		expect(alert).not.toHaveTextContent("SHOULD_NOT_LEAK");
		expect(screen.queryByText(/Stop accepted/)).toBeNull();
	});

	it("ja: the same gate, in the operator's words", async () => {
		apiFetch.mockResolvedValue({ encodingId: "enc-1", stopped: true });
		const user = userEvent.setup();
		renderPanel("ja");
		expect(screen.getByText(/今後の予約は解除されません/)).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", {
				name: "再生中の差し込みコンテンツを停止してライブ入力へ戻す",
			}),
		);
		const dialog = await screen.findByRole("dialog", {
			name: "再生中の差し込みコンテンツを停止しますか?",
		});
		expect(dialog).toHaveTextContent(/リクエストを送信します/);
		expect(dialog).toHaveTextContent(/今後の予約はそのまま残ります/);
		expect(dialog.textContent).not.toMatch(/直ちに|戻ります/);
		expect(apiFetch).not.toHaveBeenCalled();
		await user.click(
			within(dialog).getByRole("button", { name: "停止してライブ入力へ戻す" }),
		);
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledTimes(1);
		});
		const accepted = await screen.findByText(
			"差し込みコンテンツの停止リクエストを受け付けました。",
		);
		expect(accepted.textContent).not.toMatch(
			/戻|復帰|ライブ入力|映像|配信中|再生中|切り替/,
		);
	});

	it("is gated to RUNNING channels, with no button at all otherwise", () => {
		wrap(
			<InsertedContentStopPanel
				channelId={CHANNEL_ID}
				status="STOPPED"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
		);
		expect(
			screen.getByText(/only while the channel is running/),
		).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
		expect(apiFetch).not.toHaveBeenCalled();
	});
});
