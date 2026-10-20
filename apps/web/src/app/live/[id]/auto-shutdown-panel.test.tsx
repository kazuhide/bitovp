import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => api.fetch(...args),
}));

import { ApiError } from "@/lib/api";
import { AutoShutdownPanel } from "./auto-shutdown-panel";

const ID = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
let record: Record<string, unknown>;
let role: "OPERATOR" | "VIEWER";
beforeEach(() => {
	vi.clearAllMocks();
	role = "OPERATOR";
	record = {
		runId: RUN,
		configuration: {
			bytesReadTimeoutSeconds: 30,
			streamTimeoutMinutes: 120,
			waitingForFirstConnectTimeoutMinutes: 5,
		},
		revision: null,
		receipt: null,
		request: null,
	};
	api.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
		if (url === "/api/auth/session")
			return {
				mode: "users",
				configured: true,
				authenticated: true,
				role,
				loginKind: "password-form",
			};
		if (init?.method === "POST") {
			const body = JSON.parse(init.body as string) as { requestId: string };
			record.request = {
				key: `manual:auto-shutdown:${ID}:${body.requestId}`,
				state: "QUEUED",
			};
			return { handoffStatus: "QUEUED" };
		}
		return record;
	});
});
const posts = () =>
	api.fetch.mock.calls.filter(
		(call) => (call[1] as RequestInit | undefined)?.method === "POST",
	);
async function open(locale: "en" | "ja" = "en") {
	const user = userEvent.setup();
	renderWithQuery(
		<AutoShutdownPanel channelId={ID} runId={RUN} status="RUNNING" />,
		locale,
	);
	await user.click(
		await screen.findByText(
			locale === "en" ? "Encoder automatic stop" : "エンコーダーの自動停止",
		),
	);
	await screen.findByRole("spinbutton", {
		name:
			locale === "en"
				? "Stop after update (minutes)"
				: "更新後に停止するまで（分）",
	});
	return user;
}

describe("running Live automatic stop editor", () => {
	it("keeps untouched timers and sends only after reviewing the full replacement", async () => {
		const user = await open();
		const runtime = screen.getByRole("spinbutton", {
			name: "Stop after update (minutes)",
		});
		await user.clear(runtime);
		await user.type(runtime, "150");
		await user.click(screen.getByRole("button", { name: "Review settings" }));
		expect(posts()).toHaveLength(0);
		const dialog = screen.getByRole("dialog", {
			name: "Replace automatic stop settings",
		});
		expect(within(dialog).getByText("150")).toBeVisible();
		expect(within(dialog).getByText("30")).toBeVisible();
		await user.click(
			within(dialog).getByRole("button", { name: "Apply to this broadcast" }),
		);
		await waitFor(() => expect(posts()).toHaveLength(1));
		expect(
			JSON.parse((posts()[0]?.[1] as RequestInit).body as string),
		).toMatchObject({
			runId: RUN,
			expectedRevision: null,
			configuration: {
				bytesReadTimeoutSeconds: 30,
				streamTimeoutMinutes: 150,
				waitingForFirstConnectTimeoutMinutes: 5,
			},
		});
		expect(
			screen.queryByText("The encoder accepted this update."),
		).not.toBeInTheDocument();
	});
	it("requires a separate explicit confirmation to disable all three timers", async () => {
		const user = await open();
		for (const input of screen.getAllByRole("spinbutton"))
			await user.clear(input);
		await user.click(screen.getByRole("button", { name: "Review settings" }));
		expect(posts()).toHaveLength(0);
		await user.click(
			screen.getByRole("button", { name: "Disable all three timers" }),
		);
		await waitFor(() => expect(posts()).toHaveLength(1));
		expect(
			JSON.parse((posts()[0]?.[1] as RequestInit).body as string).configuration,
		).toEqual({});
	});
	it("rejects invalid integers before opening the confirmation or posting", async () => {
		const user = await open();
		const runtime = screen.getByRole("spinbutton", {
			name: "Stop after update (minutes)",
		});
		await user.clear(runtime);
		await user.type(runtime, "4");
		await user.click(screen.getByRole("button", { name: "Review settings" }));
		expect(screen.getByRole("alert")).toHaveTextContent("at least 5 minutes");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(posts()).toHaveLength(0);
	});
	it("a definite route refusal unlocks the form instead of inventing a queued operation", async () => {
		const user = await open();
		api.fetch.mockImplementationOnce(async () => {
			throw new ApiError(409, "settings changed", {
				code: "LIVE_ACTION_REQUEST_CONFLICT",
			});
		});
		await user.click(screen.getByRole("button", { name: "Review settings" }));
		await user.click(
			screen.getByRole("button", { name: "Apply to this broadcast" }),
		);
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Review settings" }),
			).toBeEnabled(),
		);
		expect(screen.queryByText(/Update queued/)).not.toBeInTheDocument();
	});
	it("renders Japanese explanations and labels", async () => {
		await open("ja");
		expect(screen.getByText(/3項目すべてを置き換えます/)).toBeVisible();
		expect(
			screen.getByRole("button", { name: "変更内容を確認" }),
		).toBeVisible();
	});
	it("never offers a viewer the operation or reads its local settings", async () => {
		role = "VIEWER";
		renderWithQuery(
			<AutoShutdownPanel channelId={ID} runId={RUN} status="RUNNING" />,
		);
		await waitFor(() =>
			expect(api.fetch).toHaveBeenCalledWith("/api/auth/session", {
				cache: "no-store",
			}),
		);
		expect(
			screen.queryByText("Encoder automatic stop"),
		).not.toBeInTheDocument();
		expect(
			api.fetch.mock.calls.some((call) =>
				String(call[0]).includes("/auto-shutdown"),
			),
		).toBe(false);
	});
});
