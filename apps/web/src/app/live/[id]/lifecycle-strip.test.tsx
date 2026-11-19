import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatDateTime } from "@/lib/format";
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
		["RUNNING", null, 3],
		["STOPPING", true, 7],
		["STOPPED", false, 7],
	] as const)("%s + connected=%s ⇒ stage %i", (status, connected, stage) => {
		expect(lifecycleStage(status, connected)).toBe(stage);
	});
});

describe("LifecycleStrip", () => {
	it.each([
		false,
		true,
	])("keeps missing input evidence separate from provider evidence (confirmed=%s)", (confirmed) => {
		const { container } = renderWithQuery(
			<LifecycleStrip
				status="RUNNING"
				ingestConnected={null}
				hasEncoding={true}
				provider={
					confirmed
						? {
								unknown: false,
								terminal: false,
								observedAt: "2026-11-07T00:00:00Z",
								unknownSince: null,
								status: "RUNNING",
							}
						: undefined
				}
			/>,
		);
		const active = container.querySelector('[data-state="active"]');
		expect(active).toHaveAttribute("data-stage", "3");
		expect(active).toHaveTextContent("Waiting for input data");
		expect(active).not.toHaveTextContent(
			/^waiting for input$|input connected|encoding.*delivering/i,
		);
		expect(active?.querySelector("span + span")?.className).not.toContain(
			"sky",
		);
		expect(container.querySelector("figure")).not.toHaveAttribute(
			"data-provider",
		);
		expect(screen.queryByText(/Bitmovin status unconfirmed/)).toBeNull();
		fireEvent.click(screen.getByRole("button"));
		expect(
			screen.getByText(
				"Input connection status is not available for this run.",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/nothing is broadcast yet|delivering normally/i),
		).toBeNull();
	});
	it.each([
		"unknown",
		"unobserved",
		"terminal",
	])("retains provider %s hint precedence over absent input evidence", (state) => {
		const { container } = renderWithQuery(
			<LifecycleStrip
				status={state === "terminal" ? "ERROR" : "RUNNING"}
				ingestConnected={null}
				hasEncoding={true}
				provider={{
					unknown: state === "unknown",
					unobserved: state === "unobserved",
					terminal: state === "terminal",
					observedAt: "2026-11-07T00:00:00Z",
					unknownSince: null,
					status: state === "terminal" ? "FINISHED" : "RUNNING",
				}}
			/>,
		);
		expect(container.querySelector("figure")).toHaveAttribute(
			"data-provider",
			state,
		);
		fireEvent.click(screen.getByRole("button"));
		expect(
			screen.queryByText(
				"Input connection status is not available for this run.",
			),
		).toBeNull();
		if (state === "terminal") {
			expect(
				screen.getByText(/reported this run's encoding FINISHED/),
			).toBeInTheDocument();
			expect(screen.queryByText(/may still be up on Bitmovin/)).toBeNull();
		} else if (state === "unobserved")
			expect(
				screen.getByText("No Bitmovin status recorded"),
			).toBeInTheDocument();
		else
			expect(
				screen.getByText(/Last Bitmovin reading RUNNING/),
			).toBeInTheDocument();
	});
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
		expect(screen.queryByText(/may still be up on Bitmovin/)).toBeNull();
		fireEvent.click(screen.getByRole("button"));
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
		expect(screen.queryByText(/may still be up on Bitmovin/)).toBeNull();
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByText(/may still be up on Bitmovin/)).toBeInTheDocument();
	});

	/**
	 * the provider's view outranks the
	 * stage hint — UNKNOWN is amber with the last confirmed reading and the
	 * window's start; a provider-TERMINAL error run must not say "may still
	 * be up on Bitmovin" when Bitmovin has said the encoding ended.
	 */
	it("keeps provider acquisition detail behind help while the recorded stage stays visible", () => {
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
		expect(active?.className).not.toContain("sky");
		expect(screen.queryByText(/Last Bitmovin reading/)).toBeNull();
		fireEvent.click(screen.getByRole("button"));
		expect(
			screen.getByText(/Last Bitmovin reading RUNNING/),
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
		expect(screen.getByText("No Bitmovin status recorded")).toBeInTheDocument();
	});

	it.each([
		["ja", null],
		["ja", "2026-08-30T11:59:00.000Z"],
		["en", null],
		["en", "2026-08-30T11:59:00.000Z"],
	] as const)("distinguishes a stale status from a recorded loss of confirmation in %s (%s)", (locale, unknownSince) => {
		const observedAt = "2026-08-30T11:58:00.000Z";
		renderWithQuery(
			<LifecycleStrip
				status="RUNNING"
				ingestConnected={true}
				hasEncoding
				provider={{
					unknown: true,
					terminal: false,
					observedAt,
					unknownSince,
					status: "RUNNING",
				}}
			/>,
			locale,
		);
		fireEvent.click(screen.getByRole("button"));
		const help = screen.getByRole("note");
		expect(help).toHaveTextContent(
			locale === "ja" ? "最終取得 RUNNING" : "Last Bitmovin reading RUNNING",
		);
		expect(help).toHaveTextContent(formatDateTime(observedAt));
		expect(help).not.toHaveTextContent(/30 秒|30 seconds/);
		expect(help).not.toHaveTextContent(/取得エラー|取得失敗|read failure/i);
		const windowLabel = locale === "ja" ? "から更新なし" : "no update since";
		if (unknownSince) {
			expect(help).toHaveTextContent(windowLabel);
			expect(help).toHaveTextContent(formatDateTime(unknownSince));
		} else {
			expect(help).not.toHaveTextContent(windowLabel);
		}
	});

	it.each([
		"FINISHED",
		"ERROR",
	])("shows only the stopped stage for a local ERROR with provider status %s", (providerStatus) => {
		const { container } = renderWithQuery(
			<LifecycleStrip
				status="ERROR"
				ingestConnected={false}
				hasEncoding={true}
				provider={{
					unknown: false,
					terminal: true,
					observedAt: "2026-08-30T12:00:00.000Z",
					unknownSince: null,
					status: providerStatus,
				}}
			/>,
		);
		expect(container.querySelector('[data-state="active"]')).toHaveAttribute(
			"data-stage",
			"7",
		);
		expect(container.querySelector('[data-stage="1"]')).toBeNull();
		fireEvent.click(screen.getByRole("button"));
		expect(
			screen.getByText(
				new RegExp(`reported this run's encoding ${providerStatus}`),
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/fresh run/)).toBeNull();
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

	it("tracks reversible input changes with one current stage and no struck-through labels", () => {
		const { container, rerender } = renderWithQuery(
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
		expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
		expect(container.querySelector(".line-through")).toBeNull();
		rerender(
			<LifecycleStrip status="RUNNING" ingestConnected={false} hasEncoding />,
		);
		expect(container.querySelector('[aria-current="step"]')).toHaveTextContent(
			"Waiting for input",
		);
		rerender(
			<LifecycleStrip status="RUNNING" ingestConnected={null} hasEncoding />,
		);
		expect(container.querySelector('[aria-current="step"]')).toHaveTextContent(
			"Waiting for input data",
		);
	});
});
