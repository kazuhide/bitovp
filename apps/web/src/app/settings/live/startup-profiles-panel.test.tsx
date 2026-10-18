import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { StartupProfilesPanel } from "./startup-profiles-panel";

/**
 *  PR1 — the profiles table renders core's honesty contract:
 * named percentiles at n ≥ 20, em-dash + the small-n note below.
 */

function mockProfiles(rows: unknown[], designation: unknown = null) {
	apiFetch.mockImplementation(async (input: unknown) => {
		const url = String(input);
		if (url.startsWith("/api/settings/startup-profiles")) {
			return { windowDays: 30, rows };
		}
		if (url.startsWith("/api/settings/startup-probes/run")) {
			return { requestId: "req-1" };
		}
		if (url.startsWith("/api/settings/startup-probes")) {
			return { designation };
		}
		if (url.startsWith("/api/credentials")) {
			return [];
		}
		// review-287 m2: the new account query must be mocked, or the select
		// renders empty in every panel test and the save-gate goes uncovered.
		if (url.startsWith("/api/bitmovin-accounts")) {
			return [{ id: "acct-1", label: "main" }];
		}
		if (url.startsWith("/api/live-channels")) {
			return { items: [] };
		}
		throw new Error(`unexpected ${url}`);
	});
}

describe("StartupProfilesPanel", () => {
	it("renders a big-n row with named percentiles and a small-n row with the honesty note", async () => {
		mockProfiles([
			{
				region: "AWS_AP_NORTHEAST_1",
				source: "CHANNEL",
				profile: {
					n: 40,
					failures: 2,
					censored: 1,
					maxSeconds: 840,
					p50Seconds: 170,
					p90Seconds: 300,
					rawSeconds: [],
				},
			},
			{
				region: "AKAMAI_JP_OSA",
				source: "CHANNEL",
				profile: {
					n: 3,
					failures: 0,
					censored: 0,
					maxSeconds: 95,
					p50Seconds: null,
					p90Seconds: null,
					rawSeconds: [80, 90, 95],
				},
			},
		]);
		wrap(<StartupProfilesPanel />);
		// findByText(region) would now match the probe form's OPTION instantly
		// — await the P50 CELL so the profiles query has actually resolved.
		expect(await screen.findByText("2m50s")).toBeInTheDocument();
		expect(screen.getByText("5m")).toBeInTheDocument();
		// The small-n row refuses percentile labels…
		expect(screen.getByText("AKAMAI_JP_OSA")).toBeInTheDocument();
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
		// …and the note says why.
		expect(
			screen.getByText(/too few samples for percentiles/),
		).toBeInTheDocument();
	});

	it("says so when there are no samples yet", async () => {
		mockProfiles([]);
		wrap(<StartupProfilesPanel />);
		expect(await screen.findByText(/No samples yet/)).toBeInTheDocument();
	});

	it("probe launcher is gated on BOTH a designation and the worst-case acknowledgement (ledger #160 PR4)", async () => {
		mockProfiles([]);
		wrap(<StartupProfilesPanel />);
		expect(
			await screen.findByText(/No probe destination designated yet/),
		).toBeInTheDocument();
		const launch = screen.getByRole("button", { name: /Launch probes/i });
		// No designation + no acknowledgement → disabled.
		expect(launch).toBeDisabled();
		// The worst-case line quotes the batch arithmetic, not the happy path.
		expect(screen.getByText(/Worst case: 3 probes/)).toBeInTheDocument();
	});

	it("a COMPLETE designation names the account and enables launch (review-287 M1)", async () => {
		mockProfiles([], {
			credentialId: "00000000-0000-4000-8000-0000000000c1",
			bitmovinAccountId: "acct-1",
			bucket: "probe-bucket",
			prefix: "probes/startup/",
			abandonDeadlineMinutes: 8,
		});
		wrap(<StartupProfilesPanel />);
		// The account label (joined against the accounts query) renders.
		expect(await screen.findByText(/runs under main/)).toBeInTheDocument();
		// n4: the title claims "enables launch" — prove it, don't assert it in
		// the name only. With the account present, the ONLY remaining gate is
		// the worst-case acknowledgement, so ticking it must flip the button
		// from disabled to enabled. This is also the sole test of that
		// transition, so it doubles as coverage of the enable path.
		const launch = screen.getByRole("button", { name: /Launch probes/i });
		expect(launch).toBeDisabled();
		await userEvent.click(screen.getByRole("checkbox"));
		expect(launch).toBeEnabled();
	});

	it("a LEGACY designation (no account) RENDERS without crashing and shows the re-save note (review-287 B2)", async () => {
		// The exact state this fold exists to handle. The first cut passed
		// des.bitmovinAccountId (undefined) to t, which THROWS on an
		// undefined placeholder — crashing the panel that fixes the
		// designation. The summary must render, naming the missing account.
		mockProfiles([], {
			credentialId: "00000000-0000-4000-8000-0000000000c1",
			bucket: "probe-bucket",
			prefix: "probes/startup/",
			abandonDeadlineMinutes: 8,
			// bitmovinAccountId deliberately absent (legacy shape).
		});
		wrap(<StartupProfilesPanel />);
		// The bucket/prefix summary is there (proving the des branch rendered
		// rather than throwing), and the account line is the re-save note.
		expect(
			await screen.findByText(/re-save this destination/),
		).toBeInTheDocument();
		// The launch button is disabled on the legacy path (no account).
		const launch = await screen.findByRole("button", {
			name: /Launch probes/i,
		});
		expect(launch).toBeDisabled();
	});
});
