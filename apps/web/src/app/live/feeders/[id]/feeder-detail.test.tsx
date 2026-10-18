import { feederError } from "@bitovp/core";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: routerPush }),
}));

import type { FeederSessionDetail } from "../feeder-shared";
import { FeederDetail } from "./feeder-detail";

const SESSION_ID = "00000000-0000-4000-8000-0000000000f1";

function detail(over: Partial<FeederSessionDetail> = {}): FeederSessionDetail {
	return {
		id: SESSION_ID,
		liveChannelId: "00000000-0000-4000-8000-0000000000c1",
		status: "STOPPED",
		protocol: "RTMP",
		sourceBucket: "bucket",
		sourceKey: "clip.mp4",
		target: { url: "rtmp://h/live", streamKey: "***" },
		stoppable: false,
		internalFailure: false,
		startedAt: "2026-06-18T00:00:00.000Z",
		stoppedAt: "2026-06-18T00:05:00.000Z",
		error: null,
		createdAt: "2026-06-18T00:00:00.000Z",
		updatedAt: "2026-06-18T00:05:00.000Z",
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("FeederDetail — delete", () => {
	it("keeps polling an ERROR cleanup after stop acknowledgement until process-free proof arrives", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		let cleaned = false;
		let reads = 0;
		apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
			if (init?.method === "POST") return { status: "ERROR", action: "stop" };
			reads += 1;
			return detail({ status: "ERROR", stoppable: !cleaned });
		});
		const view = wrap(<FeederDetail id={SESSION_ID} />);
		try {
			fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
			fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
			await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
			expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
			cleaned = true;
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3_100);
			});
			await waitFor(() =>
				expect(screen.queryByRole("button", { name: "Stop" })).toBeNull(),
			);
			expect(
				screen.getByRole("button", { name: "Delete file-input session" }),
			).toBeEnabled();
			const settledReads = reads;
			await act(async () => {
				await vi.advanceTimersByTimeAsync(6_000);
			});
			expect(reads).toBe(settledReads);
		} finally {
			view.unmount();
			view.client.clear();
			vi.useRealTimers();
		}
	});

	it("disables delete while the session is PUSHING", async () => {
		apiFetch.mockResolvedValue(detail({ status: "PUSHING", stoppable: true }));
		wrap(<FeederDetail id={SESSION_ID} />);
		await screen.findByText(/File input session/i);
		expect(
			screen.getByRole("button", {
				name: /Delete file-input session \(disabled\)/,
			}),
		).toBeDisabled();
	});

	/**
	 * Audit 2026-08-29 CRITICAL-2. An ERROR session whose START job died
	 * outside the worker keeps its pid, and its ffmpeg keeps pushing. Stop is
	 * the ONLY path to the worker's kill ladder, so it has to stay on screen
	 * for that row — and delete has to stay shut until the pid is proven gone.
	 */
	it("offers stop (and refuses delete) when the server says an ERROR session is still stoppable", async () => {
		apiFetch.mockResolvedValue(detail({ status: "ERROR", stoppable: true }));
		wrap(<FeederDetail id={SESSION_ID} />);
		await screen.findByText(/File input session/i);
		expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
		expect(
			screen.getByRole("button", {
				name: /Delete file-input session \(disabled\)/,
			}),
		).toBeDisabled();
	});

	it("drops the stop button once the server proves the session is no longer stoppable", async () => {
		apiFetch.mockResolvedValue(
			detail({
				status: "ERROR",
				stoppable: false,
			}),
		);
		wrap(<FeederDetail id={SESSION_ID} />);
		await screen.findByText(/File input session/i);
		expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
		expect(
			screen.getByRole("button", { name: "Delete file-input session" }),
		).not.toBeDisabled();
	});

	it("confirms then DELETEs a STOPPED session and redirects to the list", async () => {
		apiFetch.mockImplementation(async (_input: string, init?: RequestInit) => {
			if (init?.method === "DELETE") {
				return { deleted: true };
			}
			return detail({ status: "STOPPED" });
		});
		wrap(<FeederDetail id={SESSION_ID} />);
		await screen.findByText(/File input session/i);

		const user = userEvent.setup();
		await user.click(
			screen.getByRole("button", { name: "Delete file-input session" }),
		);
		await user.click(screen.getByRole("button", { name: "Delete" }));

		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				(c) =>
					String(c[0]) === `/api/feeder-sessions/${SESSION_ID}` &&
					(c[1] as RequestInit)?.method === "DELETE",
			);
			expect(call).toBeTruthy();
		});
		await waitFor(() =>
			expect(routerPush).toHaveBeenCalledWith("/live/feeders"),
		);
	});
});

describe("FeederDetail — the compatibility diff, as written (ledger #239)", () => {
	const MULTILINE_ERROR = [
		"Source does not match what this channel is ingesting (the source this run started on):",
		"resolution 1920×1080 → 1920×1012",
		"frame rate 30000/1001 → 24/1",
		"H.264 profile Main → High",
	].join("\n");

	it("withholds legacy multiline provider prose from the customer panel", async () => {
		apiFetch.mockResolvedValue(
			detail({ status: "ERROR", error: MULTILINE_ERROR }),
		);
		wrap(<FeederDetail id={SESSION_ID} />);
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"The file input could not continue. Ask an administrator to review Diagnostics.",
		);
		for (const line of MULTILINE_ERROR.split("\n")) {
			expect(alert.textContent).not.toContain(line);
		}
	});

	// : the same refusal, stored STRUCTURED, must render the LOCALIZED
	// sentence in the panel — this pins the wiring (`feederErrorMessage(t, …)`).
	// Reverting the render to `{row.error}` would show raw JSON here → red.
	it("localizes a structured sourceMismatch refusal in JA, diff and all", async () => {
		const differences = [
			"frame rate 30000/1001 → 24/1",
			"H.264 profile Main → High",
		].join("\n");
		apiFetch.mockResolvedValue(
			detail({
				status: "ERROR",
				error: feederError("sourceMismatch", {
					originKind: "runSource",
					differences,
				}),
			}),
		);
		wrap(<FeederDetail id={SESSION_ID} />, "ja");
		const alert = await screen.findByRole("alert");
		// The Japanese safety sentence and the localized reference phrase.
		expect(alert.textContent).toContain(
			"ソースがこのチャンネルの取り込み内容と一致しません",
		);
		expect(alert.textContent).toContain("この run が開始したソース");
		expect(alert.textContent).toContain("静止した映像のまま進み続けます");
		// The per-attribute diff still rides along verbatim, newlines honoured.
		expect(alert).toHaveClass("whitespace-pre-line");
		for (const line of differences.split("\n")) {
			expect(alert.textContent).toContain(line);
		}
		// The raw JSON must NOT leak onto the screen.
		expect(alert.textContent).not.toContain("sourceMismatch");
		expect(alert.textContent).not.toContain("originKind");
	});
});

it("retries a failed feeder detail read", async () => {
	apiFetch.mockRejectedValue(new Error("offline"));
	wrap(<FeederDetail id={SESSION_ID} />);
	await screen.findByRole("alert");
	apiFetch.mockResolvedValue(detail());
	await userEvent.click(screen.getByRole("button", { name: "Retry" }));
	expect(await screen.findByText(/File input session/i)).toBeInTheDocument();
});
