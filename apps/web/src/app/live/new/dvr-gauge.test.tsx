import {
	LIVE_MANIFEST_ELEMENT_BUDGET,
	RECOMMENDED_MAX_TIMESHIFT_SEC,
} from "@bitovp/core";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderLocalized as renderL } from "@/test/render";

import {
	DVR_LEVEL_BAR_CLASS,
	DVR_LEVEL_TEXT_CLASS,
	DvrGauge,
	dvrGaugeModel,
	formatSeconds,
} from "./dvr-gauge";

const legs = (count: number, segmentLengthSec = 6) =>
	Array.from({ length: count }, () => ({ segmentLengthSec }));

describe("dvrGaugeModel (C8 — surface, never clamp)", () => {
	it("is off without a timeshift, without legs, or with broken segment lengths", () => {
		expect(dvrGaugeModel(undefined, legs(4))).toEqual({ state: "off" });
		expect(dvrGaugeModel(0, legs(4))).toEqual({ state: "off" });
		expect(dvrGaugeModel(7200, [])).toEqual({ state: "off" });
		expect(dvrGaugeModel(7200, legs(2, 0))).toEqual({ state: "off" });
		expect(dvrGaugeModel(Number.NaN, legs(2))).toEqual({ state: "off" });
	});

	it("computes ok level with the validator's per-leg math", () => {
		const model = dvrGaugeModel(7200, legs(4));
		if (model.state !== "on") {
			throw new Error("expected on");
		}
		// ceil(7200/6) = 1200 per leg × 4 legs.
		expect(model.totalElements).toBe(4800);
		expect(model.budget).toBe(LIVE_MANIFEST_ELEMENT_BUDGET);
		expect(model.level).toBe("ok");
		expect(model.utilization).toBeCloseTo(4800 / 54000, 6);
		// The math line is a key + values now, so the numbers are asserted directly
		// rather than through a formatted English sentence.
		expect(model.mathLine).toEqual({
			key: "uiX.dvrMathUniform",
			values: {
				timeshift: 7200,
				segment: 6,
				segments: 1200,
				renditions: 4,
				total: 4800,
				budget: 54000,
			},
		});
	});

	it("turns warning above 80% utilization", () => {
		// 1 leg, 1s segments, 45000s timeshift → 45000 elements = 83.3%.
		const model = dvrGaugeModel(45_000, legs(1, 1));
		if (model.state !== "on") {
			throw new Error("expected on");
		}
		expect(model.level).toBe("warning");
		expect(model.fillPct).toBeCloseTo(83.3, 0);
		expect(model.overflowPct).toBe(0);
	});

	it("turns over above 100% — numbers stay unclamped, only the bar FILL caps", () => {
		const model = dvrGaugeModel(60_000, legs(1, 1));
		if (model.state !== "on") {
			throw new Error("expected on");
		}
		expect(model.level).toBe("over");
		expect(model.totalElements).toBe(60_000);
		expect(model.utilization).toBeGreaterThan(1);
		expect(model.pct).toBeCloseTo(111.1, 1);
		expect(model.fillPct).toBe(100);
		// The visual clamp keeps the overflow magnitude explicit.
		expect(model.overflowPct).toBeCloseTo(11.1, 1);
	});

	it("derives the in-budget timeshift recommendation for uniform ladders", () => {
		const model = dvrGaugeModel(7200, legs(4, 6));
		if (model.state !== "on") {
			throw new Error("expected on");
		}
		// floor(54000 / 4) × 6s.
		expect(model.recommendedSec).toBe(81_000);
	});

	it("falls back to the Σ form (no recommendation) for mixed segment lengths", () => {
		const model = dvrGaugeModel(600, [
			{ segmentLengthSec: 6 },
			{ segmentLengthSec: 4 },
		]);
		if (model.state !== "on") {
			throw new Error("expected on");
		}
		expect(model.totalElements).toBe(100 + 150);
		expect(model.mathLine.key).toBe("uiX.dvrMathMixed");
		expect(model.mathLine.values.timeshift).toBe(600);
		expect(model.recommendedSec).toBeNull();
	});

	it("maps every level to bar/text colors", () => {
		expect(DVR_LEVEL_BAR_CLASS.ok).toContain("emerald");
		expect(DVR_LEVEL_BAR_CLASS.warning).toContain("amber");
		expect(DVR_LEVEL_BAR_CLASS.over).toContain("red");
		expect(DVR_LEVEL_TEXT_CLASS.ok).toContain("emerald");
		expect(DVR_LEVEL_TEXT_CLASS.warning).toContain("amber");
		expect(DVR_LEVEL_TEXT_CLASS.over).toContain("red");
	});

	it("formats the 3h Bitmovin recommendation readably", () => {
		expect(formatSeconds(RECOMMENDED_MAX_TIMESHIFT_SEC)).toBe("3h");
		expect(formatSeconds(81_000)).toBe("22h 30m");
		expect(formatSeconds(0)).toBe("0s");
	});
});

describe("DvrGauge component", () => {
	it("renders the utilization as text with the element math (bar is decorative)", () => {
		renderL(<DvrGauge label="HLS DVR" timeshiftSec={7200} legs={legs(4)} />);
		expect(screen.getByText(/8\.9% of budget/)).toBeInTheDocument();
		const bar = screen.getByTestId("dvr-gauge-bar");
		expect(bar).toHaveAttribute("data-level", "ok");
		expect(bar).not.toHaveAttribute("data-overflow");
		expect(screen.queryByText(/over budget/)).not.toBeInTheDocument();
		expect(screen.getByText(/4800 of ~54000/)).toBeInTheDocument();
		expect(screen.getByText(/Max in-budget timeshift/)).toBeInTheDocument();
	});

	it("shows the over-budget alert without clamping the percentage", () => {
		renderL(
			<DvrGauge label="HLS DVR" timeshiftSec={60_000} legs={legs(1, 1)} />,
		);
		expect(screen.getByText(/111\.1% of budget/)).toBeInTheDocument();
		// Overflow affordance: the bar carries the over treatment and the
		// marker spells out how far past the budget the (capped) fill sits.
		expect(screen.getByText("+11.1% over budget")).toBeInTheDocument();
		expect(screen.getByTestId("dvr-gauge-bar")).toHaveAttribute(
			"data-overflow",
			"true",
		);
		expect(screen.getByText(/validation blocks this plan/)).toBeInTheDocument();
	});

	it.each([
		"ja",
		"en",
	] as const)("explains an unset timeshift without claiming DVR is disabled (%s)", (locale) => {
		renderL(
			<DvrGauge label="HLS DVR" timeshiftSec={undefined} legs={legs(2)} />,
			locale,
		);
		expect(
			screen.getByText(
				locale === "ja"
					? /DVR 予算は未算定.*空欄は配信サービスの既定値/
					: /DVR budget is not estimated.*Empty timeshift uses the service default/,
			),
		).toBeVisible();
		expect(
			screen.queryByText(/DVR ウィンドウがありません|No DVR window/),
		).not.toBeInTheDocument();
		expect(screen.queryByTestId("dvr-gauge-bar")).not.toBeInTheDocument();
	});
});

describe("dvrGaugeModel — the English singular", () => {
	it("uses the singular key for a one-rendition ladder", () => {
		// main pluralised inline (`rendition${legs.length === 1 ? "" : "s"}`).
		// Collapsing that into one key made a one-rung ladder read "× 1 renditions",
		// and nothing caught it: the only mathLine equality assertion uses 4 legs.
		const one = dvrGaugeModel(600, legs(1, 6));
		expect(one.state).toBe("on");
		if (one.state !== "on") {
			return;
		}
		expect(one.mathLine.key).toBe("uiX.dvrMathUniformOne");
		expect(one.mathLine.values.renditions).toBe(1);
		const many = dvrGaugeModel(600, legs(2, 6));
		expect(many.state).toBe("on");
		if (many.state !== "on") {
			return;
		}
		expect(many.mathLine.key).toBe("uiX.dvrMathUniform");
	});
});

describe("DvrGauge — the per-leg popover is WIRED with insertion order", () => {
	it("keeps leg 2 before leg 10 in the opened panel", async () => {
		// The primitive's sort={false} behaviour is pinned in its own test; this
		// pins the WIRING — review-169's M3 deleted sort={false} at this call
		// site and every gate stayed green while legs scrambled to
		// 1, 10, 11, 2 on the exact ladder the popover exists for
		// ("a named slot is not a filled one", again).
		const legs = Array.from({ length: 11 }, (_, i) => ({
			segmentLengthSec: i % 2 === 0 ? 4 : 6,
		}));
		renderL(<DvrGauge label="DVR" timeshiftSec={10_800} legs={legs} />);
		await userEvent.click(screen.getByRole("button"));
		const keys = [...document.querySelectorAll('[role="dialog"] dt')].map(
			(dt) => dt.textContent,
		);
		expect(keys[1]).toBe("leg 2");
		expect(keys[9]).toBe("leg 10");
	});
});

describe("DvrGauge note variant (row #326 — reference information in the wizard)", () => {
	it("renders one line with the utilization and the math, and no bar or box", () => {
		renderL(
			<DvrGauge
				variant="note"
				label="HLS DVR"
				timeshiftSec={7200}
				legs={legs(4)}
			/>,
		);
		expect(screen.getByText(/8\.9% of budget/)).toBeInTheDocument();
		expect(screen.getByText(/4800 of ~54000/)).toBeInTheDocument();
		expect(screen.getByText(/Max in-budget timeshift/)).toBeInTheDocument();
		expect(screen.queryByTestId("dvr-gauge-bar")).not.toBeInTheDocument();
		expect(screen.getByTestId("dvr-note").tagName).toBe("P");
	});

	it("still says an over-budget window blocks the plan", () => {
		renderL(
			<DvrGauge
				variant="note"
				label="HLS DVR"
				timeshiftSec={60_000}
				legs={legs(1, 1)}
			/>,
		);
		expect(screen.getByRole("alert")).toHaveTextContent(
			/validation blocks this plan/,
		);
		expect(screen.getByText(/111\.1% of budget/)).toBeInTheDocument();
		expect(screen.queryByTestId("dvr-gauge-bar")).not.toBeInTheDocument();
	});

	it("explains an unset timeshift in the same line", () => {
		renderL(
			<DvrGauge
				variant="note"
				label="HLS DVR"
				timeshiftSec={undefined}
				legs={legs(2)}
			/>,
		);
		expect(screen.getByText(/DVR budget is not estimated/)).toBeInTheDocument();
		expect(screen.queryByTestId("dvr-gauge-bar")).not.toBeInTheDocument();
	});
});

describe("DvrGauge note variant keeps the per-leg popover (review-539 R2)", () => {
	it("opens the same leg → segments panel, in insertion order", async () => {
		const legs = Array.from({ length: 11 }, (_, i) => ({
			segmentLengthSec: i % 2 === 0 ? 4 : 6,
		}));
		renderL(
			<DvrGauge variant="note" label="DVR" timeshiftSec={10_800} legs={legs} />,
		);
		await userEvent.click(screen.getByRole("button"));
		const keys = [...document.querySelectorAll('[role="dialog"] dt')].map(
			(dt) => dt.textContent,
		);
		expect(keys[1]).toBe("leg 2");
		expect(keys[9]).toBe("leg 10");
	});
});
