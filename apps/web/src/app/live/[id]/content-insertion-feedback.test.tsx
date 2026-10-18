import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { ContentInsertionPanel } from "./content-insertion-panel";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));
const apiFetch = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const channelId = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const accountId = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const contentId = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";
const reservationId = "22223333-4444-4555-8666-777788889999";
const props = {
	channelId,
	bitmovinAccountId: accountId,
	status: "RUNNING" as const,
	runId: "run-1",
};

function mockApi(
	response: unknown = { id: reservationId, contentId, status: "SCHEDULED" },
) {
	apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
		if (path.endsWith("/schedule") && init?.method === "POST")
			return Promise.resolve(response);
		return Promise.resolve({
			items: [{ id: contentId, name: "Test slate", status: "READY" }],
			totalCount: 1,
		});
	});
}

async function submit() {
	const user = userEvent.setup();
	await user.click(await screen.findByRole("button", { name: "Schedule" }));
	await user.click(screen.getByRole("button", { name: "Confirm" }));
}

afterEach(() => vi.resetAllMocks());

describe("content insertion feedback", () => {
	it("keeps acceptance and reservation status without claiming reflected content, even when Push output advances", async () => {
		mockApi();
		const onPreview = vi.fn();
		renderWithQuery(
			<ContentInsertionPanel
				{...props}
				outputObservation={{ runId: "run-1", source: "push", advancing: true }}
				onPreview={onPreview}
			/>,
		);
		await submit();
		const feedback = await screen.findByRole("status", {
			name: "Reservation request accepted",
		});
		expect(
			within(feedback).getByText(/Content appearance is unconfirmed/),
		).toBeInTheDocument();
		expect(
			within(feedback).getByText(/Reservation response status: Reserved/),
		).toBeInTheDocument();
		expect(
			within(feedback).getByText(
				/Push: output updates observed; inserted content is not verified/,
			),
		).toBeInTheDocument();
		expect(
			within(feedback).getByText(new RegExp(reservationId)),
		).toBeInTheDocument();
		expect(feedback.className).not.toMatch(/emerald|green/);
		await userEvent.click(
			within(feedback).getByRole("button", { name: "Check in preview" }),
		);
		expect(onPreview).toHaveBeenCalledOnce();
	});

	it.each([
		"run",
		"channel",
		"account",
	])("discards previous acceptance when %s changes", async (scope) => {
		mockApi();
		const view = renderWithQuery(<ContentInsertionPanel {...props} />);
		await submit();
		await screen.findByRole("status", { name: "Reservation request accepted" });
		view.rerender(
			<ContentInsertionPanel
				{...props}
				{...(scope === "run"
					? { runId: "run-2" }
					: scope === "channel"
						? { channelId: "another-channel" }
						: { bitmovinAccountId: "another-account" })}
			/>,
		);
		expect(
			screen.queryByRole("status", { name: "Reservation request accepted" }),
		).not.toBeInTheDocument();
	});

	it("does not attach an old in-flight response to a new airing", async () => {
		let resolve!: (value: unknown) => void;
		mockApi(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const view = renderWithQuery(<ContentInsertionPanel {...props} />);
		await submit();
		await waitFor(() =>
			expect(
				apiFetch.mock.calls.some(
					([path, init]) =>
						String(path).endsWith("/schedule") && init?.method === "POST",
				),
			).toBe(true),
		);
		view.rerender(<ContentInsertionPanel {...props} runId="run-2" />);
		await act(async () => resolve({ id: reservationId, status: "SCHEDULED" }));
		expect(
			screen.queryByRole("status", { name: "Reservation request accepted" }),
		).not.toBeInTheDocument();
	});

	it("withholds output progression from another run and keeps unknown provider response unknown", async () => {
		mockApi({ id: reservationId, status: "FUTURE_STATUS" });
		renderWithQuery(
			<ContentInsertionPanel
				{...props}
				outputObservation={{
					runId: "run-old",
					source: "push",
					advancing: true,
				}}
			/>,
		);
		await submit();
		const feedback = await screen.findByRole("status", {
			name: "Reservation request accepted",
		});
		expect(
			within(feedback).getByText(/Reservation status unknown/),
		).toBeInTheDocument();
		expect(
			within(feedback).getByText("Current output updates are unconfirmed."),
		).toBeInTheDocument();
		expect(
			within(feedback).queryByRole("button", { name: "Check in preview" }),
		).not.toBeInTheDocument();
		expect(
			within(feedback).queryByText(/FUTURE_STATUS|output updates observed/),
		).not.toBeInTheDocument();
	});

	it("renders a Poll observation as limited output information, never insertion failure", async () => {
		mockApi({ acknowledged: true, idempotentReplay: true });
		renderWithQuery(
			<ContentInsertionPanel
				{...props}
				outputObservation={{ runId: "run-1", source: "poll", advancing: false }}
			/>,
		);
		await submit();
		const feedback = await screen.findByRole("status", {
			name: "Reservation request accepted",
		});
		expect(
			within(feedback).getByText(
				/Poll: output updates unconfirmed; this does not establish insertion failure/,
			),
		).toBeInTheDocument();
		expect(
			within(feedback).getByText(/Content appearance is unconfirmed/),
		).toBeInTheDocument();
		expect(
			within(feedback).getByText(/Reservation status unknown/),
		).toBeInTheDocument();
	});

	it("does not persist feedback without a known run identity", async () => {
		mockApi();
		renderWithQuery(<ContentInsertionPanel {...props} runId={null} />);
		await submit();
		await waitFor(() =>
			expect(
				screen.queryByRole("button", { name: "Confirm" }),
			).not.toBeInTheDocument(),
		);
		expect(
			screen.queryByRole("status", { name: "Reservation request accepted" }),
		).not.toBeInTheDocument();
	});

	it("keeps rejected requests out of accepted feedback", async () => {
		mockApi();
		apiFetch.mockImplementation((path: string) =>
			path.endsWith("/schedule")
				? Promise.reject(new Error("Request failed"))
				: Promise.resolve({
						items: [{ id: contentId, name: "Test slate", status: "READY" }],
					}),
		);
		renderWithQuery(<ContentInsertionPanel {...props} />);
		await submit();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Request failed",
		);
		expect(
			screen.queryByRole("status", { name: "Reservation request accepted" }),
		).not.toBeInTheDocument();
	});

	it("labels acceptance and unconfirmed content in Japanese", async () => {
		mockApi();
		renderWithQuery(<ContentInsertionPanel {...props} />, "ja");
		await userEvent.click(
			await screen.findByRole("button", { name: "スケジュール" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "確認" }));
		const feedback = await screen.findByRole("status", {
			name: "予約要求を受け付けました",
		});
		expect(
			within(feedback).getByText("映像への反映は未確認です。"),
		).toBeInTheDocument();
		expect(
			within(feedback).getByText("現在の出力更新は未確認です。"),
		).toBeInTheDocument();
	});
});
