import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import * as adviceModule from "./per-title-simulator-advice";
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

function keepCurrent(label: string, locale: "en" | "ja" = "en") {
	fireEvent.change(
		screen.getByRole("combobox", {
			name: `${locale === "en" ? "Decision" : "選択"}: ${label}`,
		}),
		{ target: { value: "keep" } },
	);
	fireEvent.click(
		screen.getByRole("button", {
			name:
				locale === "en"
					? "Re-evaluate selected decisions"
					: "選択した内容で再評価",
		}),
	);
}
function expectBoundaryChange(locale: "en" | "ja" = "en") {
	const row = screen
		.getByRole("combobox", {
			name:
				locale === "en"
					? "Decision: Upper complexity boundary (kbps), rendition 1"
					: "選択: 複雑度の上側境界 (kbps), 段 1",
		})
		.closest("tr");
	if (!row) throw new Error("Expected a parameter comparison row.");
	expect(
		within(row).getByRole("cell", { name: "4,000 kbps" }),
	).toBeInTheDocument();
	expect(
		within(row).getByRole("cell", { name: "8,000 kbps" }),
	).toBeInTheDocument();
}

describe("manual Per-Title adjustment advice", () => {
	it.each([
		"en",
		"ja",
	] as const)("shows only the highest-ranked recommendation and retains partial decisions (%s)", (locale) => {
		const session = source();
		const current = { ...session, maxBitrate: 8_000_000 };
		const candidate = perTitleAdvice(session, current, {
			scope: "global",
			key: "maxBitrate",
		})[0];
		if (!candidate) throw new Error("Expected an adjustment.");
		const other = { ...candidate, id: "alternative" };
		const spy = vi
			.spyOn(adviceModule, "perTitleAdvice")
			.mockReturnValue([candidate, other]);
		const onAdopt = vi.fn();
		try {
			const view = renderLocalized(
				<PerTitleAdvisor goal={session} session={session} onAdopt={onAdopt} />,
				locale,
			);
			view.rerender(
				<PerTitleAdvisor goal={current} session={session} onAdopt={onAdopt} />,
			);
			expect(
				screen.queryByRole("combobox", {
					name: locale === "en" ? "Adjustment to review" : "表示する案",
				}),
			).toBeNull();
			expect(
				screen.getAllByRole("table", {
					name: locale === "en" ? "Review parameter changes" : "項目ごとの変更",
				}),
			).toHaveLength(1);
			const all = screen.getByRole("button", {
				name: locale === "en" ? "Use this adjustment" : "この調整を採用",
			});
			fireEvent.change(
				screen.getByRole("combobox", {
					name:
						locale === "en"
							? "Decision: Maximum bitrate ratio"
							: "選択: ビットレート間隔の上限",
				}),
				{ target: { value: "keep" } },
			);
			expect(all).toBeDisabled();
			expect(onAdopt).not.toHaveBeenCalled();
			expect(
				screen.queryByRole("region", {
					name: locale === "en" ? "Maintained values" : "維持する値",
				}),
			).toBeNull();
			fireEvent.click(
				screen.getByRole("button", {
					name: locale === "en" ? "Clear decisions" : "選択をクリア",
				}),
			);
			fireEvent.click(all);
			expect(onAdopt).toHaveBeenCalledTimes(1);
			expect(onAdopt.mock.calls[0]?.[0]).toBe(candidate);
		} finally {
			spy.mockRestore();
		}
	});
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
		expectBoundaryChange(locale);
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
		const [advice, options] = onAdopt.mock.calls[0] ?? [];
		expect(options.referenceGoal).toBe(session);
		const accepted = applyPerTitleAdvice(edited, advice, options);
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
		expectBoundaryChange();
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
		keepCurrent(field, locale);
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
		expect(onAdopt.mock.calls[0]?.[1]).toEqual({
			protectedFields: [],
			referenceGoal: session,
		});
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
		keepCurrent("Maximum bitrate ratio");
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
			referenceGoal: session,
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
	it("focuses the remaining release after adopting a multi-pin adjustment", () => {
		const session: PerTitleGoal = {
				...source(),
				rows: [
					...(source().rows ?? []),
					{
						id: "b",
						height: 1080,
						minBitrate: 2_000_000,
						maxBitrate: 3_000_000,
						bitrateSelectionMode: "COMPLEXITY_RANGE",
						lowComplexityBoundaryForMaxBitrate: 2_500_000,
						highComplexityBoundaryForMaxBitrate: 4_000_000,
					},
				],
				automaticTemplates: [
					{ id: "base", height: 120 },
					{ id: "top", height: 1440 },
				],
			},
			onAdopt = vi.fn();
		const current = { ...session, maxBitrate: 8_000_000 };
		let view = renderLocalized(
			<PerTitleAdvisor goal={session} session={session} onAdopt={onAdopt} />,
		);
		view.rerender(
			<PerTitleAdvisor goal={current} session={session} onAdopt={onAdopt} />,
		);
		keepCurrent("Maximum bitrate (kbps), rendition 1");
		keepCurrent("Maximum bitrate (kbps), rendition 2");
		const initialRelease = screen.getByRole("button", {
			name: "Release: Maximum bitrate (kbps), rendition 1",
		});
		initialRelease.focus();
		fireEvent.click(initialRelease);
		expect(
			screen.getByRole("button", { name: "Use this adjustment" }),
		).toHaveFocus();
		view.unmount();
		view = renderLocalized(
			<PerTitleAdvisor goal={session} session={session} onAdopt={onAdopt} />,
		);
		view.rerender(
			<PerTitleAdvisor goal={current} session={session} onAdopt={onAdopt} />,
		);
		for (const rendition of [1, 2])
			keepCurrent(`Maximum bitrate (kbps), rendition ${rendition}`);
		fireEvent.click(
			screen.getByRole("button", { name: "Use this adjustment" }),
		);
		const [advice, options] = onAdopt.mock.calls[0] ?? [];
		expect(options.protectedFields).toHaveLength(2);
		expect(advice.changes.length).toBeGreaterThan(1);
		const accepted = applyPerTitleAdvice(current, advice, options);
		expect(accepted).not.toBeNull();
		if (!accepted) throw new Error("Expected checked adjustment.");
		view.rerender(
			<PerTitleAdvisor goal={accepted} session={session} onAdopt={onAdopt} />,
		);
		const release = screen.getByRole("button", {
			name: "Release: Maximum bitrate (kbps), rendition 1",
		});
		release.focus();
		fireEvent.click(release);
		expect(
			screen.queryByRole("button", { name: "Use this adjustment" }),
		).toBeNull();
		expect(
			screen.getByRole("button", {
				name: "Release: Maximum bitrate (kbps), rendition 2",
			}),
		).toHaveFocus();
	});

	it("does not carry a release focus request into a later manual edit", () => {
		const session = source(),
			onAdopt = vi.fn();
		let current = { ...session, maxBitrate: 8_000_000 };
		const content = (goal: PerTitleGoal) => (
			<>
				<input aria-label="Manual maximum" />
				<PerTitleAdvisor goal={goal} session={session} onAdopt={onAdopt} />
			</>
		);
		const view = renderLocalized(content(session));
		view.rerender(content(current));
		keepCurrent("Maximum bitrate (kbps), rendition 1");
		fireEvent.click(
			screen.getByRole("button", { name: "Use this adjustment" }),
		);
		const [advice, options] = onAdopt.mock.calls[0] ?? [];
		expect(advice.changes.length).toBeGreaterThan(1);
		const accepted = applyPerTitleAdvice(current, advice, options);
		expect(accepted).not.toBeNull();
		if (!accepted) throw new Error("Expected checked adjustment.");
		view.rerender(content(accepted));
		fireEvent.click(
			screen.getByRole("button", {
				name: "Release: Maximum bitrate (kbps), rendition 1",
			}),
		);
		expect(
			screen.queryByRole("button", { name: "Use this adjustment" }),
		).toBeNull();
		const input = screen.getByRole("textbox", { name: "Manual maximum" });
		input.focus();
		current = { ...accepted, maxBitrate: 16_000_000 };
		view.rerender(content(current));
		expect(
			screen.getByRole("button", { name: "Use this adjustment" }),
		).toBeInTheDocument();
		expect(input).toHaveFocus();
	});

	it.each([
		"en",
		"ja",
	] as const)("explains checked rounding and final common versus per-row H (%s)", (locale) => {
		const session = source(),
			current = { ...session, maxBitrate: 8_000_000 };
		const original = perTitleAdvice(session, current, {
			scope: "global",
			key: "maxBitrate",
		}).find((item) => item.reason === "joint-range");
		if (!original) throw new Error("Expected joint adjustment.");
		const fixed = original.proposal.api.streams.find(
			(row) =>
				row.perTitleSettings?.bitrateSelectionMode === "COMPLEXITY_RANGE",
		);
		if (!fixed?.perTitleSettings)
			throw new Error("Expected fixed complexity settings.");
		const spy = vi.spyOn(adviceModule, "perTitleAdvice");
		try {
			for (const shared of [true, false]) {
				const item = structuredClone(original);
				item.facts.roundingDigits = 3;
				item.facts.sharedHighBoundary = 99_000_000;
				item.proposal.api.streams = [
					{
						...fixed,
						perTitleSettings: {
							...fixed.perTitleSettings,
							highComplexityBoundaryForMaxBitrate: 8_000_000,
						},
					},
					{
						...fixed,
						rowId: "b",
						height: 1080,
						perTitleSettings: {
							...fixed.perTitleSettings,
							highComplexityBoundaryForMaxBitrate: shared
								? 8_000_000
								: 7_000_000,
						},
					},
				];
				spy.mockReturnValue([item]);
				const view = renderLocalized(
					<PerTitleAdvisor
						goal={session}
						session={session}
						onAdopt={vi.fn()}
					/>,
					locale,
				);
				view.rerender(
					<PerTitleAdvisor
						goal={current}
						session={session}
						onAdopt={vi.fn()}
					/>,
				);
				const details = screen
					.getByText(locale === "en" ? "Reasoning and scope" : "根拠と確認範囲")
					.closest("details");
				if (!details) throw new Error("Expected closed reasoning.");
				expect(details).not.toHaveAttribute("open");
				fireEvent.click(details.querySelector("summary") as HTMLElement);
				expect(details).toHaveTextContent(
					locale === "en" ? "3 significant digits" : "有効数字3桁",
				);
				expect(details).toHaveTextContent(
					locale === "en"
						? "Kept values are unchanged"
						: "維持する値は変更しません",
				);
				expect(details).toHaveTextContent(
					shared
						? locale === "en"
							? "Common H: 8,000 kbps"
							: "共通H: 8,000 kbps"
						: locale === "en"
							? "H is set per rendition"
							: "Hは各段で設定",
				);
				expect(details).not.toHaveTextContent("99,000");
				expect(details).toHaveTextContent(
					locale === "en"
						? "each rendition's own maximum"
						: "各段それぞれの最大値",
				);
				view.unmount();
			}
		} finally {
			spy.mockRestore();
		}
	});

	it.each([
		0, 2, 4,
	])("shows checked precision %s without inventing a common H for one row", (digits) => {
		const session = source(),
			current = { ...session, maxBitrate: 8_000_000 };
		const item = perTitleAdvice(session, current, {
			scope: "global",
			key: "maxBitrate",
		}).find((candidate) => candidate.reason === "joint-range");
		if (!item) throw new Error("Expected joint adjustment.");
		item.facts.roundingDigits = digits;
		item.facts.sharedHighBoundary = 99_000_000;
		const spy = vi
			.spyOn(adviceModule, "perTitleAdvice")
			.mockReturnValue([item]);
		try {
			const view = renderLocalized(
				<PerTitleAdvisor goal={session} session={session} onAdopt={vi.fn()} />,
			);
			view.rerender(
				<PerTitleAdvisor goal={current} session={session} onAdopt={vi.fn()} />,
			);
			const details = screen
				.getByText("Reasoning and scope")
				.closest("details");
			if (!details) throw new Error("Expected reasoning.");
			fireEvent.click(details.querySelector("summary") as HTMLElement);
			expect(details).toHaveTextContent(
				digits === 0
					? "Checked unrounded values are used"
					: `${digits} decimal places`,
			);
			expect(details).toHaveTextContent("H is set per rendition");
			expect(details).not.toHaveTextContent("Common H:");
		} finally {
			spy.mockRestore();
		}
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
		keepCurrent("Maximum bitrate (kbps), rendition 1");
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
