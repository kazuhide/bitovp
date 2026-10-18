import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));

import { FeederDetail } from "./feeder-detail";

const SESSION_ID = "00000000-0000-4000-8000-0000000000f1";

function stub(role: "OPERATOR" | "ADMIN") {
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/auth/session") {
			return {
				mode: "users",
				configured: true,
				authenticated: true,
				loginKind: "password-form",
				role,
			};
		}
		if (url === `/api/feeder-sessions/${SESSION_ID}?diagnostics=1`) {
			return {
				pid: 4242,
				ownerHost: "support-host-a",
				processGoneAt: null,
				error: "worker lost ffmpeg PID 4242 while publishing",
				logTail: ["publisher process started with sanitized arguments"],
				loopBoundaryCount: 1,
				recentLoopBoundaries: [
					{
						loopIndex: 1,
						wallClock: "2026-08-31T00:00:00.000Z",
						streamTimeSec: 30,
					},
				],
			};
		}
		if (url === `/api/feeder-sessions/${SESSION_ID}`) {
			return {
				id: SESSION_ID,
				liveChannelId: "00000000-0000-4000-8000-0000000000c1",
				status: "PUSHING",
				protocol: "RTMP",
				sourceBucket: "media",
				sourceKey: "clip.mp4",
				target: { url: "rtmp://example/live", streamKey: "***" },
				stoppable: true,
				internalFailure: false,
				startedAt: "2026-08-31T00:00:00.000Z",
				stoppedAt: null,
				error: null,
				createdAt: "2026-08-31T00:00:00.000Z",
				updatedAt: "2026-08-31T00:00:00.000Z",
			};
		}
		return {};
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("FeederDetail diagnostics audience (UX-02b)", () => {
	it("keeps diagnostics out of OPERATOR DOM and never requests its payload", async () => {
		stub("OPERATOR");
		renderWithQuery(<FeederDetail id={SESSION_ID} />);
		expect(await screen.findByText(/File input session/i)).toBeVisible();
		expect(screen.queryByRole("button", { name: "Diagnostics" })).toBeNull();
		expect(
			apiFetch.mock.calls.some(
				([url]) =>
					String(url) === `/api/feeder-sessions/${SESSION_ID}?diagnostics=1`,
			),
		).toBe(false);
		expect(document.body.textContent).not.toContain("4242");
		expect(document.body.textContent).not.toContain("support-host-a");
	});

	it("fetches and renders process diagnostics only after ADMIN opens it", async () => {
		stub("ADMIN");
		renderWithQuery(<FeederDetail id={SESSION_ID} />);
		const disclosure = await screen.findByRole("button", {
			name: "Diagnostics",
		});
		expect(
			apiFetch.mock.calls.some(
				([url]) =>
					String(url) === `/api/feeder-sessions/${SESSION_ID}?diagnostics=1`,
			),
		).toBe(false);

		await userEvent.click(disclosure);
		expect(await screen.findByText(/Process ID 4242/)).toBeVisible();
		expect(screen.getByText("support-host-a")).toBeVisible();
		expect(
			screen.getByText("publisher process started with sanitized arguments"),
		).toBeVisible();
		expect(
			screen.getByText("worker lost ffmpeg PID 4242 while publishing"),
		).toBeVisible();
		await waitFor(() =>
			expect(
				apiFetch.mock.calls.filter(
					([url]) =>
						String(url) === `/api/feeder-sessions/${SESSION_ID}?diagnostics=1`,
				),
			).toHaveLength(1),
		);
	});
});
