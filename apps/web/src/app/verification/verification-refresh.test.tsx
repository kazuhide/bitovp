import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/messages/en";
import { renderLocalized, renderWithQuery } from "@/test/render";
import {
	RunDetailClient,
	VERIFICATION_DETAIL_POLL_MS,
	verificationDetailRefetchInterval,
} from "./[id]/run-detail";
import type { VerificationRunDetail, VerificationRunSummary } from "./types";
import {
	RefreshStaleNotice,
	VERIFICATION_LIST_POLL_MS,
	VerificationRunsClient,
	verificationListRefetchInterval,
} from "./verification-client";

/**
 * The auto-refresh + stale-safety half of the release-evidence screens
 * A long run must reach its terminal state here
 * without a manual reload, the polling must STOP once it is terminal, and a
 * refresh failure must never keep showing the last state as if it were current.
 *
 * The list/detail containers do the fetching, so they are driven with a mocked
 * `apiFetch` and the query's OWN refetch — the transition resolves on the
 * observed DOM, never on a wall-clock timer. The STOP decision is a pure
 * function, tested directly.
 */

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const RUNNING_SUMMARY: VerificationRunSummary = {
	id: "run-1-id",
	runId: "2026-08-30T10-00-00-000-aaaaaa",
	kind: "VOD",
	status: "RUNNING",
	startedAt: "2026-08-30T10:00:00.000Z",
	finishedAt: null,
	commit: "abcdef0123456789",
	drift: false,
	counts: null,
	sealed: false,
	bitmovinAccountId: null,
};

const SEALED_SUMMARY: VerificationRunSummary = {
	...RUNNING_SUMMARY,
	status: "SEALED",
	finishedAt: "2026-08-30T10:30:00.000Z",
	counts: { PASS: 1 },
	sealed: true,
};

const RUNNING_DETAIL: VerificationRunDetail = {
	...RUNNING_SUMMARY,
	checkoutLatestMigration: "20260830_x",
	dbLatestMigration: "20260830_x",
	baseUrlOrigin: null,
	actor: null,
	sourceObject: null,
	sourceIdentity: null,
	resumedFromId: null,
	resumedFrom: null,
	resumeDecision: null,
	outcomes: null,
	providerReadback: null,
	cleanup: null,
	reportPath: "verify-runs/run/report.json",
	reportSha256: null,
	seal: null,
	sealAlgorithm: null,
	sealKeyId: null,
	evidenceVersion: null,
	evidenceManifest: null,
	retentionUntil: null,
	sealedAt: null,
	error: null,
};

const SEALED_DETAIL: VerificationRunDetail = {
	...RUNNING_DETAIL,
	status: "SEALED",
	finishedAt: "2026-08-30T10:30:00.000Z",
	counts: { PASS: 1 },
	sealed: true,
	reportSha256: "deadbeefcafe",
	seal: "sha256:cafe",
	sealAlgorithm: "SHA256",
	evidenceVersion: 1,
	evidenceManifest: { version: 1, scenarios: [] },
	retentionUntil: "2026-11-28T10:30:01.000Z",
	sealedAt: "2026-08-30T10:30:01.000Z",
};

beforeEach(() => {
	apiFetch.mockReset();
});

describe("verificationListRefetchInterval", () => {
	it("polls while ANY run is RUNNING and stops once every run is terminal", () => {
		// Any RUNNING row keeps the poll alive…
		expect(verificationListRefetchInterval({ items: [RUNNING_SUMMARY] })).toBe(
			VERIFICATION_LIST_POLL_MS,
		);
		expect(
			verificationListRefetchInterval({
				items: [SEALED_SUMMARY, RUNNING_SUMMARY],
			}),
		).toBe(VERIFICATION_LIST_POLL_MS);
		// …and a corpus that is all-terminal is not polled forever.
		expect(
			verificationListRefetchInterval({
				items: [SEALED_SUMMARY, { ...RUNNING_SUMMARY, status: "INCOMPLETE" }],
			}),
		).toBe(false);
		expect(verificationListRefetchInterval({ items: [] })).toBe(false);
		// Before the first load there is nothing to poll ON.
		expect(verificationListRefetchInterval(undefined)).toBe(false);
	});
});

describe("verificationDetailRefetchInterval", () => {
	it.each([
		["RUNNING", VERIFICATION_DETAIL_POLL_MS],
		["SEALED", false],
		["INCOMPLETE", false],
	])("status %s → %s", (status, expected) => {
		expect(
			verificationDetailRefetchInterval({ ...RUNNING_DETAIL, status }),
		).toBe(expected);
	});

	it("does not poll before the first load", () => {
		expect(verificationDetailRefetchInterval(undefined)).toBe(false);
	});
});

describe("RefreshStaleNotice", () => {
	it("shows the refresh-failure marker and a machine-readable last-updated time", () => {
		renderLocalized(
			<RefreshStaleNotice
				dataUpdatedAt={Date.parse("2026-08-30T10:15:00.000Z")}
			/>,
		);
		expect(screen.getByText(en.verification.refreshFailed)).toBeInTheDocument();
		const time = document.querySelector("time");
		expect(time).toHaveAttribute("datetime", "2026-08-30T10:15:00.000Z");
	});

	it("omits the time when none was ever recorded", () => {
		renderLocalized(<RefreshStaleNotice dataUpdatedAt={0} />);
		expect(screen.getByText(en.verification.refreshFailed)).toBeInTheDocument();
		expect(document.querySelector("time")).toBeNull();
	});
});

describe("the verification list auto-refreshes", () => {
	it("moves a run from RUNNING to SEALED on the same screen, without a reload", async () => {
		apiFetch.mockResolvedValueOnce({ items: [RUNNING_SUMMARY] });
		apiFetch.mockResolvedValueOnce({ items: [SEALED_SUMMARY] });
		const { client } = renderWithQuery(<VerificationRunsClient />);
		expect(await screen.findByText("RUNNING")).toBeInTheDocument();
		await act(async () => {
			await client.refetchQueries({ queryKey: ["verification-runs"] });
		});
		expect(await screen.findByText("SEALED")).toBeInTheDocument();
		expect(screen.queryByText("RUNNING")).toBeNull();
		// The transition took the initial load plus exactly one refetch — no
		// spontaneous extra poll fired in-test. (The deterministic STOP proof is
		// the pure-function test above.)
		expect(apiFetch).toHaveBeenCalledTimes(2);
	});

	it("on a refresh failure keeps the last rows but marks them STALE — never a green as if current", async () => {
		apiFetch.mockResolvedValueOnce({ items: [RUNNING_SUMMARY] });
		apiFetch.mockRejectedValueOnce(new Error("network boom"));
		const { client } = renderWithQuery(<VerificationRunsClient />);
		expect(
			await screen.findByRole("link", { name: RUNNING_SUMMARY.runId }),
		).toBeInTheDocument();
		await act(async () => {
			await client
				.refetchQueries({ queryKey: ["verification-runs"] })
				.catch(() => {});
		});
		// The refresh-failure marker is shown…
		expect(
			await screen.findByText(en.verification.refreshFailed),
		).toBeInTheDocument();
		// …and the last good rows are STILL shown, not dropped and not silently
		// presented as current.
		expect(
			screen.getByRole("link", { name: RUNNING_SUMMARY.runId }),
		).toBeInTheDocument();
	});
});

describe("the verification detail auto-refreshes", () => {
	it("moves the run from RUNNING to SEALED without a reload", async () => {
		apiFetch.mockResolvedValueOnce(RUNNING_DETAIL);
		apiFetch.mockResolvedValueOnce(SEALED_DETAIL);
		const { client } = renderWithQuery(<RunDetailClient id="run-1-id" />);
		expect(await screen.findByText("RUNNING")).toBeInTheDocument();
		await act(async () => {
			await client.refetchQueries({
				queryKey: ["verification-run", "run-1-id"],
			});
		});
		expect(await screen.findByText("SEALED")).toBeInTheDocument();
	});

	it("on a refresh failure keeps the run but marks it STALE", async () => {
		apiFetch.mockResolvedValueOnce(RUNNING_DETAIL);
		apiFetch.mockRejectedValueOnce(new Error("boom"));
		const { client } = renderWithQuery(<RunDetailClient id="run-1-id" />);
		expect(await screen.findByText(RUNNING_DETAIL.runId)).toBeInTheDocument();
		await act(async () => {
			await client
				.refetchQueries({ queryKey: ["verification-run", "run-1-id"] })
				.catch(() => {});
		});
		expect(
			await screen.findByText(en.verification.refreshFailed),
		).toBeInTheDocument();
		expect(screen.getByText(RUNNING_DETAIL.runId)).toBeInTheDocument();
	});
});
