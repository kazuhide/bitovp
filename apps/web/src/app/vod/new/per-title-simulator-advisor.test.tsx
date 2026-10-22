import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import {
	applyPerTitleAdvice,
	perTitleAdvice,
} from "./per-title-simulator-advice";
import { PerTitleAdvisor } from "./per-title-simulator-advisor";
import { initializePerTitleSettings } from "./per-title-simulator-tuning";

const source = (): PerTitleGoal =>
	initializePerTitleSettings({
		strategy: "fixed-ranges",
		codec: "H264",
		minBitrate: 100_000,
		maxBitrate: 4_000_000,
		minBitrateStepSize: 1.25,
		maxBitrateStepSize: 4,
		countPolicy: { kind: "unrestricted" },
		autoRepresentations: false,
		rows: [
			{
				id: "a",
				height: 720,
				minBitrate: 1_000_000,
				maxBitrate: 1_600_000,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 1_250_000,
				highComplexityBoundaryForMaxBitrate: 4_000_000,
			},
		],
		automaticTemplates: [
			{ id: "base", height: 120 },
			{ id: "top", height: 1080 },
		],
	});

describe("manual Per-Title adjustment advice", () => {
	it.each([
		"en",
		"ja",
	] as const)("shows exact changes after an edit, without adopting them (%s)", (locale) => {
		const session = source();
		const onAdopt = vi.fn();
		const view = renderLocalized(
			<PerTitleAdvisor goal={session} session={session} onAdopt={onAdopt} />,
			locale,
		);
		expect(
			screen.queryByRole("button", {
				name: locale === "en" ? "Use this adjustment" : "この調整を採用",
			}),
		).toBeNull();
		const edited = { ...session, maxBitrate: 8_000_000 };
		view.rerender(
			<PerTitleAdvisor goal={edited} session={session} onAdopt={onAdopt} />,
		);
		expect(
			screen.getByRole("region", {
				name: locale === "en" ? "Suggested adjustment" : "調整案",
			}),
		).toHaveTextContent("4,000 → 8,000 kbps");
		expect(edited.rows?.[0]?.highComplexityBoundaryForMaxBitrate).toBe(
			4_000_000,
		);
		expect(onAdopt).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "en" ? "Use this adjustment" : "この調整を採用",
			}),
		);
		expect(onAdopt).toHaveBeenCalledTimes(1);
		const accepted = applyPerTitleAdvice(edited, onAdopt.mock.calls[0]?.[0]);
		expect(accepted?.maxBitrate).toBe(8_000_000);
		expect(accepted?.rows?.[0]?.highComplexityBoundaryForMaxBitrate).toBe(
			8_000_000,
		);
		expect(
			screen.queryByRole("button", {
				name: locale === "en" ? "Use this adjustment" : "この調整を採用",
			}),
		).toBeNull();
	});
	it("retains the original dependency through intermediate numeric edits", () => {
		const session = source();
		const onAdopt = vi.fn();
		const view = renderLocalized(
			<PerTitleAdvisor goal={session} session={session} onAdopt={onAdopt} />,
		);
		for (const maximum of [8_000, 80_000, 800_000, 8_000_000])
			view.rerender(
				<PerTitleAdvisor
					goal={{ ...session, maxBitrate: maximum }}
					session={session}
					onAdopt={onAdopt}
				/>,
			);
		expect(
			screen.getByRole("region", { name: "Suggested adjustment" }),
		).toHaveTextContent("4,000 → 8,000 kbps");
		expect(onAdopt).not.toHaveBeenCalled();
	});
	it("clears old advice on load, codec change, or a multi-field replacement", () => {
		const session = source();
		const onAdopt = vi.fn();
		const view = renderLocalized(
			<PerTitleAdvisor goal={session} session={session} onAdopt={onAdopt} />,
		);
		view.rerender(
			<PerTitleAdvisor
				goal={{ ...session, maxBitrate: 8_000_000 }}
				session={session}
				onAdopt={onAdopt}
			/>,
		);
		expect(
			screen.getByRole("button", { name: "Use this adjustment" }),
		).toBeInTheDocument();
		const loaded = source();
		view.rerender(
			<PerTitleAdvisor
				goal={{ ...loaded, maxBitrate: 9_000_000 }}
				session={loaded}
				onAdopt={onAdopt}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: "Use this adjustment" }),
		).toBeNull();
		view.rerender(
			<PerTitleAdvisor
				goal={{ ...loaded, codec: "VP9", maxBitrate: 10_000_000 }}
				session={loaded}
				onAdopt={onAdopt}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: "Use this adjustment" }),
		).toBeNull();
		view.rerender(
			<PerTitleAdvisor
				goal={{ ...loaded, minBitrate: 200_000, maxBitrate: 11_000_000 }}
				session={loaded}
				onAdopt={onAdopt}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: "Use this adjustment" }),
		).toBeNull();
	});
	it("drops the previous suggestion when a different field is edited", () => {
		const session = source();
		const onAdopt = vi.fn();
		const view = renderLocalized(
			<PerTitleAdvisor goal={session} session={session} onAdopt={onAdopt} />,
		);
		const changed = { ...session, maxBitrate: 8_000_000 };
		view.rerender(
			<PerTitleAdvisor goal={changed} session={session} onAdopt={onAdopt} />,
		);
		expect(
			screen.getByRole("button", { name: "Use this adjustment" }),
		).toBeInTheDocument();
		view.rerender(
			<PerTitleAdvisor
				goal={{ ...changed, targetQualityCrf: 20 }}
				session={session}
				onAdopt={onAdopt}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: "Use this adjustment" }),
		).toBeNull();
	});
	it("explains the automatic workflow after an edit without offering incompatible advice", () => {
		const session: PerTitleGoal = {
			...source(),
			adjustments: {
				global: { targetQualityCrf: { mode: "auto", method: "default" } },
			},
		};
		const onAdopt = vi.fn();
		const view = renderLocalized(
			<PerTitleAdvisor goal={session} session={session} onAdopt={onAdopt} />,
		);
		expect(screen.queryByRole("status")).toBeNull();
		view.rerender(
			<PerTitleAdvisor
				goal={{ ...session, maxBitrate: 8_000_000 }}
				session={session}
				onAdopt={onAdopt}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: "Use this adjustment" }),
		).toBeNull();
		expect(screen.getByRole("status")).toHaveTextContent(
			"Set the fields to Fixed",
		);
		view.rerender(
			<PerTitleAdvisor
				goal={{ ...session, maxBitrate: 9_000_000, targetQualityCrf: 19 }}
				session={session}
				onAdopt={onAdopt}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			"Set the fields to Fixed",
		);
	});
	it("displays the exact proposed step rather than a rounded adjustment", () => {
		const session: PerTitleGoal = {
			strategy: "count",
			codec: "VP9",
			minBitrate: 100_000,
			maxBitrate: 8_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind: "exact", count: 5 },
		};
		const changed: PerTitleGoal = {
			...session,
			countPolicy: { kind: "exact", count: 3 },
		};
		const advice = perTitleAdvice(session, changed, {
			scope: "count",
			key: "countPolicy",
		})[0];
		expect(advice).toBeDefined();
		const view = renderLocalized(
			<PerTitleAdvisor goal={session} session={session} onAdopt={vi.fn()} />,
		);
		view.rerender(
			<PerTitleAdvisor goal={changed} session={session} onAdopt={vi.fn()} />,
		);
		const region = screen.getByRole("region", { name: "Suggested adjustment" });
		for (const change of advice?.changes ?? [])
			expect(region).toHaveTextContent(String(change.after));
	});
	it("shows lower-boundary integer truncation in bps, including sub-kbps values", () => {
		const session: PerTitleGoal = {
			...source(),
			rows: source().rows?.map((row) => ({
				...row,
				minBitrate: 1_000_001,
				lowComplexityBoundaryForMaxBitrate: 1_250_001,
			})),
		};
		const changed: PerTitleGoal = {
			...session,
			rows: session.rows?.map((row) => ({ ...row, minBitrate: 1_200_001 })),
		};
		const view = renderLocalized(
			<PerTitleAdvisor goal={session} session={session} onAdopt={vi.fn()} />,
		);
		view.rerender(
			<PerTitleAdvisor goal={changed} session={session} onAdopt={vi.fn()} />,
		);
		expect(
			screen.getByRole("region", { name: "Suggested adjustment" }),
		).toHaveTextContent("trunc(1,200,001 × 1.25) = 1,500,001 bps");
	});
	it.each([
		"en",
		"ja",
	] as const)("keeps current values without editing data, and recalculates after release (%s)", (locale) => {
		const session: PerTitleGoal = {
			strategy: "count",
			codec: "VP9",
			minBitrate: 100_000,
			maxBitrate: 8_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind: "exact", count: 5 },
		};
		const current: PerTitleGoal = {
			...session,
			countPolicy: { kind: "exact", count: 3 },
		};
		const snapshot = structuredClone(current),
			onAdopt = vi.fn();
		const view = renderLocalized(
			<PerTitleAdvisor goal={session} session={session} onAdopt={onAdopt} />,
			locale,
		);
		view.rerender(
			<PerTitleAdvisor goal={current} session={session} onAdopt={onAdopt} />,
		);
		const field =
			locale === "en" ? "Maximum bitrate ratio" : "ビットレート間隔の上限";
		fireEvent.click(
			screen.getByRole("button", {
				name: `${locale === "en" ? "Keep current value" : "現在値を維持"}: ${field}`,
			}),
		);
		const maintained = screen.getByRole("region", {
			name: locale === "en" ? "Maintained values" : "維持する値",
		});
		expect(maintained).toHaveTextContent("1.9");
		expect(
			screen.getByRole("button", {
				name: `${locale === "en" ? "Release" : "解除"}: ${field}`,
			}),
		).toHaveFocus();
		expect(
			screen.queryByRole("button", {
				name: locale === "en" ? "Use this adjustment" : "この調整を採用",
			}),
		).toBeNull();
		expect(screen.getByRole("status")).toHaveTextContent(
			locale === "en"
				? "No checked adjustment"
				: "確認できる調整案はありません",
		);
		expect(current).toEqual(snapshot);
		expect(onAdopt).not.toHaveBeenCalled();
		const oldAdvice = perTitleAdvice(session, current, {
			scope: "count",
			key: "count",
		})[0];
		if (!oldAdvice) throw new Error("Expected initial advice.");
		expect(
			applyPerTitleAdvice(current, oldAdvice, {
				protectedFields: [{ scope: "global", key: "maxBitrateStepSize" }],
			}),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", {
				name: `${locale === "en" ? "Release" : "解除"}: ${field}`,
			}),
		);
		expect(
			screen.queryByRole("region", {
				name: locale === "en" ? "Maintained values" : "維持する値",
			}),
		).toBeNull();
		expect(
			screen.getByRole("button", {
				name: locale === "en" ? "Use this adjustment" : "この調整を採用",
			}),
		).toHaveFocus();
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "en" ? "Use this adjustment" : "この調整を採用",
			}),
		);
		expect(onAdopt).toHaveBeenCalledTimes(1);
		expect(onAdopt.mock.calls[0]?.[1]).toEqual({ protectedFields: [] });
	});
	it("keeps the latest manually edited pin through adoption, and clears it on a new session", () => {
		const session: PerTitleGoal = {
			strategy: "count",
			codec: "VP9",
			minBitrate: 100_000,
			maxBitrate: 8_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind: "exact", count: 5 },
		};
		let current: PerTitleGoal = {
			...session,
			countPolicy: { kind: "exact", count: 3 },
		};
		const onAdopt = vi.fn();
		const view = renderLocalized(
			<PerTitleAdvisor goal={session} session={session} onAdopt={onAdopt} />,
		);
		view.rerender(
			<PerTitleAdvisor goal={current} session={session} onAdopt={onAdopt} />,
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Keep current value: Maximum bitrate ratio",
			}),
		);
		current = { ...current, maxBitrateStepSize: 2.5 };
		view.rerender(
			<PerTitleAdvisor goal={current} session={session} onAdopt={onAdopt} />,
		);
		expect(
			screen.getByRole("region", { name: "Maintained values" }),
		).toHaveTextContent("2.5");
		current = { ...current, countPolicy: { kind: "exact", count: 5 } };
		view.rerender(
			<PerTitleAdvisor goal={current} session={session} onAdopt={onAdopt} />,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Use this adjustment" }),
		);
		const [advice, options] = onAdopt.mock.calls[0] ?? [];
		expect(options).toEqual({
			protectedFields: [{ scope: "global", key: "maxBitrateStepSize" }],
		});
		const accepted = applyPerTitleAdvice(current, advice, options);
		expect(accepted).not.toBeNull();
		expect(accepted?.maxBitrateStepSize).toBe(2.5);
		view.rerender(
			<PerTitleAdvisor
				goal={accepted ?? current}
				session={session}
				onAdopt={onAdopt}
			/>,
		);
		expect(
			screen.getByRole("region", { name: "Maintained values" }),
		).toHaveTextContent("2.5");

		view.rerender(
			<PerTitleAdvisor
				goal={{ ...(accepted ?? current), codec: "H264" }}
				session={session}
				onAdopt={onAdopt}
			/>,
		);
		expect(
			screen.queryByRole("region", { name: "Maintained values" }),
		).toBeNull();
		const loaded = { ...session };
		view.rerender(
			<PerTitleAdvisor goal={loaded} session={loaded} onAdopt={onAdopt} />,
		);
		expect(
			screen.queryByRole("region", { name: "Maintained values" }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: /Release:/ })).toBeNull();
	});
	it("prunes a maintained field only when its rendition is removed", () => {
		const session = source(),
			onAdopt = vi.fn();
		const current = { ...session, maxBitrate: 8_000_000 };
		const view = renderLocalized(
			<PerTitleAdvisor goal={session} session={session} onAdopt={onAdopt} />,
		);
		view.rerender(
			<PerTitleAdvisor goal={current} session={session} onAdopt={onAdopt} />,
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Keep current value: Maximum bitrate (kbps), rendition 1",
			}),
		);
		expect(
			screen.getByRole("region", { name: "Maintained values" }),
		).toHaveTextContent("1,600 kbps");
		view.rerender(
			<PerTitleAdvisor
				goal={{ ...current, rows: [] }}
				session={session}
				onAdopt={onAdopt}
			/>,
		);
		expect(
			screen.queryByRole("region", { name: "Maintained values" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: /Release:.*rendition/ }),
		).toBeNull();
		expect(onAdopt).not.toHaveBeenCalled();
	});
});
