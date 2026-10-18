import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import { LifecycleStrip, lifecycleStage } from "./lifecycle-strip";

/**
 *  — the stage mapping is the teaching surface: an operator at
 * ③ expecting ④ behaviour was the #95 incident. Table-driven on the pure
 * mapper, plus one render pinning the active-stage highlight + hint.
 */

describe("lifecycleStage", () => {
	it.each([
		["CREATED", false, 1],
		["ERROR", false, 1],
		["PROVISIONING", false, 2],
		["RUNNING", false, 3],
		["RUNNING", true, 4],
		["STOPPING", true, 7],
		["STOPPED", false, 7],
	] as const)("%s + connected=%s ⇒ stage %i", (status, connected, stage) => {
		expect(lifecycleStage(status, connected)).toBe(stage);
	});
});

describe("LifecycleStrip", () => {
	it("highlights the ACTIVE stage and speaks its hint — RUNNING without input is ③, not broadcasting", () => {
		const { container } = renderWithQuery(
			<LifecycleStrip
				status="RUNNING"
				ingestConnected={false}
				hasEncoding={true}
			/>,
		);
		const active = container.querySelector('[data-state="active"]');
		expect(active?.getAttribute("data-stage")).toBe("3");
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByText(/nothing is broadcast yet/i)).toBeInTheDocument();
	});

	it("ERROR with an encoding still up does NOT claim 'not running' — a Stop button sits beside this text (review-228 I3)", () => {
		renderWithQuery(
			<LifecycleStrip
				status="ERROR"
				ingestConnected={false}
				hasEncoding={true}
			/>,
		);
		expect(screen.getByText(/may still be up on Bitmovin/)).toBeInTheDocument();
		expect(screen.queryByText(/Encoder not running/)).toBeNull();
	});

	it("STOPPED whose stop never CONFIRMED gets the same warning — the evidence there is positive (ledger #130 C-fold)", () => {
		renderWithQuery(
			<LifecycleStrip
				status="STOPPED"
				ingestConnected={false}
				hasEncoding={true}
				hasError={true}
			/>,
		);
		// The reset blocks on exactly these rows; the channel's own page is
		// where the operator goes, and it showed the raw error string with
		// neither the framing nor the action. ERROR is ambiguous — this is not.
		expect(screen.getByText(/may still be up on Bitmovin/)).toBeInTheDocument();
	});

	/**
	 *  (audit 5c3d97ca BLOCKER-1): the provider's view outranks the
	 * stage hint — UNKNOWN is amber with the last confirmed reading and the
	 * window's start; a provider-TERMINAL error run must not say "may still
	 * be up on Bitmovin" when Bitmovin has said the encoding ended.
	 */
	it("provider UNKNOWN on a RUNNING channel paints the active stage AMBER and says the status cannot be confirmed — never the sky-blue on-air chip", () => {
		const { container } = renderWithQuery(
			<LifecycleStrip
				status="RUNNING"
				ingestConnected={true}
				hasEncoding={true}
				provider={{
					unknown: true,
					terminal: false,
					observedAt: "2026-08-30T11:58:00.000Z",
					unknownSince: "2026-08-30T11:59:00.000Z",
					status: "RUNNING",
				}}
			/>,
		);
		const figure = container.querySelector("figure");
		expect(figure?.getAttribute("data-provider")).toBe("unknown");
		const active = container.querySelector('[data-state="active"] span + span');
		expect(active?.className).toContain("amber");
		expect(active?.className).not.toContain("sky");
		expect(
			screen.getByText("RUNNING · Bitmovin status unconfirmed"),
		).toBeVisible();
		fireEvent.click(screen.getByRole("button"));
		expect(
			screen.getByText(/Provider status cannot be confirmed/),
		).toBeInTheDocument();
		// The stage hint it replaces is gone: no reassuring "encoding & delivering".
		expect(screen.queryByText(/delivering normally/i)).toBeNull();
	});

	it("provider UNKNOWN with no confirmed reading ever says so instead of inventing a time", () => {
		renderWithQuery(
			<LifecycleStrip
				status="RUNNING"
				ingestConnected={false}
				hasEncoding={true}
				provider={{
					unknown: true,
					terminal: false,
					observedAt: null,
					unknownSince: null,
					status: null,
				}}
			/>,
		);
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByText(/last confirmed never/)).toBeInTheDocument();
	});

	it("an ERROR channel whose encoding the provider ENDED gets the terminal hint, not 'may still be up on Bitmovin'", () => {
		renderWithQuery(
			<LifecycleStrip
				status="ERROR"
				ingestConnected={false}
				hasEncoding={true}
				provider={{
					unknown: false,
					terminal: true,
					observedAt: "2026-08-30T12:00:00.000Z",
					unknownSince: null,
					status: "FINISHED",
				}}
			/>,
		);
		fireEvent.click(screen.getByRole("button"));
		expect(
			screen.getByText(/reported this run's encoding FINISHED/),
		).toBeInTheDocument();
		expect(screen.getByText(/fresh run/)).toBeInTheDocument();
		expect(screen.queryByText(/may still be up on Bitmovin/)).toBeNull();
	});

	it("a confirmed provider view renders exactly as the pre-#280 strip did", () => {
		const { container } = renderWithQuery(
			<LifecycleStrip
				status="RUNNING"
				ingestConnected={true}
				hasEncoding={true}
				provider={{
					unknown: false,
					terminal: false,
					observedAt: "2026-08-30T12:00:00.000Z",
					unknownSince: null,
					status: "RUNNING",
				}}
			/>,
		);
		expect(
			container.querySelector("figure")?.hasAttribute("data-provider"),
		).toBe(false);
		const active = container.querySelector('[data-state="active"] span + span');
		expect(active?.className).toContain("sky");
		expect(screen.queryByText(/cannot be confirmed/)).toBeNull();
	});

	it("a CLEANLY stopped channel does not — a confirmed stop is not a warning", () => {
		renderWithQuery(
			<LifecycleStrip
				status="STOPPED"
				ingestConnected={false}
				hasEncoding={true}
				hasError={false}
			/>,
		);
		// Every past airing keeps its pointer, so without the error term this
		// hint would fire on all of them and mean nothing.
		expect(screen.queryByText(/may still be up on Bitmovin/)).toBeNull();
	});

	it("flips to ④ the moment the input is CONNECTED — 蓋被せ works from here", () => {
		const { container } = renderWithQuery(
			<LifecycleStrip
				status="RUNNING"
				ingestConnected={true}
				hasEncoding={true}
			/>,
		);
		expect(
			container
				.querySelector('[data-state="active"]')
				?.getAttribute("data-stage"),
		).toBe("4");
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByText(/蓋被せ.*from here on/i)).toBeInTheDocument();
	});
});
