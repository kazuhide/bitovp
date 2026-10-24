import type { PerTitleGoal } from "@bitovp/core";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { type ComponentProps, useState } from "react";
import { flushSync } from "react-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import {
	applyPerTitleAdvice,
	applySelectedPerTitleAdvice,
	type PerTitleAdvice,
	type PerTitleAdviceField,
	type PerTitleAdviceOptions,
} from "./per-title-simulator-advice";
import { PerTitleAdvisor } from "./per-title-simulator-advisor";

const reviewControl = vi.hoisted(() => ({
	current: null as
		| null
		| ((
				selected: PerTitleAdviceField[],
				kept: PerTitleAdviceField[],
		  ) => boolean),
}));
const analysisControl = vi.hoisted(() => ({ offerRelaxation: false }));

vi.mock("./per-title-simulator-advice-changes", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("./per-title-simulator-advice-changes")
		>();
	return {
		...original,
		PerTitleAdviceChanges: (
			props: ComponentProps<typeof original.PerTitleAdviceChanges>,
		) => {
			reviewControl.current = (selected, kept) =>
				props.onReview(props.advice, selected, kept) !== false;
			return <original.PerTitleAdviceChanges {...props} />;
		},
	};
});

// Keep the session tests independent of the analyzer's candidate ranking. Every
// offered fixture still goes through the real current-input certificate and apply.
vi.mock("./per-title-simulator-analysis", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("./per-title-simulator-analysis")>();
	const { createPerTitleEvaluationAdvice, perTitleAdviceFieldKey } =
		await import("./per-title-simulator-advice");
	return {
		...original,
		analyzePerTitleSettings: (
			goal: PerTitleGoal,
			intent: Parameters<typeof original.analyzePerTitleSettings>[1],
			options: PerTitleAdviceOptions = {},
		) => {
			const result = original.analyzePerTitleSettings(goal, intent, options);
			const held = new Set(
				(options.protectedFields ?? []).map(perTitleAdviceFieldKey),
			);
			const candidate = { ...goal };
			for (const key of ["minBitrateStepSize", "maxBitrateStepSize"] as const)
				if (!held.has(perTitleAdviceFieldKey({ scope: "global", key })))
					candidate[key] = Number(((goal[key] ?? 1.5) * 1.1).toFixed(6));
			const advice = createPerTitleEvaluationAdvice(goal, candidate, options);
			return {
				...result,
				advice: advice ? [advice] : [],
				relaxation:
					!advice && analysisControl.offerRelaxation
						? {
								fields: [
									{ scope: "global" as const, key: "minBitrateStepSize" },
								],
								certifiedAlternatives: 1,
							}
						: undefined,
			};
		},
	};
});

const source = (): PerTitleGoal => ({
	strategy: "automatic",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 8_000_000,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 1.9,
	countPolicy: { kind: "unrestricted" },
});

type Acknowledgement = "normal" | "flush" | "reject-flush" | "reset-flush";
function Harness({
	session,
	onAdopt,
	deferred = false,
	acknowledgement = "normal",
}: {
	session: PerTitleGoal;
	deferred?: boolean;
	acknowledgement?: Acknowledgement;
	onAdopt: (
		advice: PerTitleAdvice,
		options?: PerTitleAdviceOptions,
		selected?: readonly PerTitleAdviceField[],
	) => void;
}) {
	const [goal, setGoal] = useState(session);
	const [loadedSession, setLoadedSession] = useState(session);
	const [pending, setPending] = useState<{
		advice: PerTitleAdvice;
		options?: PerTitleAdviceOptions;
		selected?: readonly PerTitleAdviceField[];
	} | null>(null);
	const adopt = (
		advice: PerTitleAdvice,
		options?: PerTitleAdviceOptions,
		selected?: readonly PerTitleAdviceField[],
	) => {
		onAdopt(advice, options, selected);
		if (deferred) {
			setPending({ advice, options, selected });
			return;
		}
		if (acknowledgement === "reset-flush") {
			const loaded = { ...source(), maxBitrate: 9_000_000 };
			flushSync(() => {
				setGoal(loaded);
				setLoadedSession(loaded);
			});
			return;
		}
		const update = () =>
			setGoal((current) => {
				if (acknowledgement === "reject-flush")
					return { ...current, maxBitrate: current.maxBitrate + 1 };
				return (
					(selected
						? applySelectedPerTitleAdvice(current, advice, selected, options)
						: applyPerTitleAdvice(current, advice, options)) ?? current
				);
			});
		if (acknowledgement === "normal") update();
		else flushSync(update);
	};
	const acknowledge = (reject = false) => {
		if (!pending) return;
		const { advice, options, selected } = pending;
		setGoal((current) => {
			const latest = reject
				? { ...current, maxBitrate: current.maxBitrate + 1 }
				: current;
			return (
				(selected
					? applySelectedPerTitleAdvice(latest, advice, selected, options)
					: applyPerTitleAdvice(latest, advice, options)) ?? latest
			);
		});
		setPending(null);
	};
	return (
		<>
			<PerTitleAdvisor goal={goal} session={loadedSession} onAdopt={adopt} />
			{deferred ? (
				<>
					<button
						type="button"
						disabled={!pending}
						onClick={() => acknowledge()}
					>
						Acknowledge adoption
					</button>
					<button
						type="button"
						disabled={!pending}
						onClick={() => acknowledge(true)}
					>
						Reject adoption
					</button>
				</>
			) : null}
			<output data-testid="analysis-current-goal">
				{JSON.stringify(goal)}
			</output>
		</>
	);
}

function evaluate() {
	fireEvent.click(screen.getByRole("button", { name: "Evaluate" }));
}
function decision(label: string, value: "skip" | "keep" | "apply") {
	fireEvent.change(
		screen.getByRole("combobox", { name: `Decision: ${label}` }),
		{ target: { value } },
	);
}
function review() {
	fireEvent.click(
		screen.getByRole("button", { name: "Re-evaluate selected decisions" }),
	);
}
function release(label: string) {
	fireEvent.click(screen.getByRole("button", { name: `Release: ${label}` }));
}
function currentGoal(): PerTitleGoal {
	return JSON.parse(
		screen.getByTestId("analysis-current-goal").textContent ?? "{}",
	);
}
function expectPin(label: string) {
	expect(
		screen.getByRole("button", { name: `Release: ${label}` }),
	).toBeInTheDocument();
}
function expectNoPin(label: string) {
	expect(
		screen.queryByRole("button", { name: `Release: ${label}` }),
	).toBeNull();
}

beforeEach(() => {
	reviewControl.current = null;
	analysisControl.offerRelaxation = false;
});

describe("current analysis adoption sessions", () => {
	it("retains partial decisions across a purpose change and certifies adoption in the new context", () => {
		const session = source(),
			onAdopt = vi.fn();
		renderLocalized(<Harness session={session} onAdopt={onAdopt} />);
		expect(screen.getByRole("combobox", { name: "Goal" })).toHaveValue(
			"adaptive",
		);
		evaluate();
		decision("Minimum bitrate ratio", "apply");
		decision("Maximum bitrate ratio", "keep");
		review();
		expect(onAdopt.mock.calls[0]?.[1]?.contextKey).toBe("analysis:adaptive");
		expect(currentGoal().minBitrateStepSize).toBe(1.65);
		expect(currentGoal().maxBitrateStepSize).toBe(1.9);
		fireEvent.change(screen.getByRole("combobox", { name: "Goal" }), {
			target: { value: "preserve" },
		});
		expectPin("Minimum bitrate ratio");
		expectPin("Maximum bitrate ratio");
		release("Minimum bitrate ratio");
		evaluate();
		decision("Minimum bitrate ratio", "apply");
		review();
		expect(onAdopt).toHaveBeenCalledTimes(2);
		expect(onAdopt.mock.calls[1]?.[1]?.contextKey).toBe("analysis:preserve");
		expect(onAdopt.mock.calls[1]?.[1]?.protectedFields).toEqual([
			{ scope: "global", key: "maxBitrateStepSize" },
		]);
		expect(currentGoal().minBitrateStepSize).toBe(1.815);
		expect(currentGoal().maxBitrateStepSize).toBe(1.9);
		expectPin("Maximum bitrate ratio");
	});

	it.each([
		"en",
		"ja",
	] as const)("releases only the identified maintained values and re-evaluates without adopting (%s)", (locale) => {
		analysisControl.offerRelaxation = true;
		const session = source();
		const onAdopt = vi.fn();
		renderLocalized(<Harness session={session} onAdopt={onAdopt} />, locale);
		const ja = locale === "ja";
		fireEvent.click(
			screen.getByRole("button", { name: ja ? "評価する" : "Evaluate" }),
		);
		for (const label of ja
			? ["ビットレート間隔の下限", "ビットレート間隔の上限"]
			: ["Minimum bitrate ratio", "Maximum bitrate ratio"]) {
			fireEvent.change(
				screen.getByRole("combobox", {
					name: `${ja ? "選択" : "Decision"}: ${label}`,
				}),
				{ target: { value: "keep" } },
			);
		}
		fireEvent.click(
			screen.getByRole("button", {
				name: ja ? "選択した内容で再評価" : "Re-evaluate selected decisions",
			}),
		);
		expect(
			screen.queryByRole("region", {
				name: ja ? "調整案" : "Suggested adjustment",
			}),
		).toBeNull();
		const panel = screen.getByRole("region", {
			name: ja ? "現在の設定を評価" : "Evaluate current settings",
		});
		expect(panel).toHaveTextContent(
			ja
				? "維持を解除すると検証済みの別案があります"
				: "A checked alternative is available if you release these maintained values",
		);
		fireEvent.click(
			within(panel).getByRole("button", {
				name: ja
					? "該当項目の維持を解除して再評価"
					: "Release these maintained values and re-evaluate",
			}),
		);
		expect(
			screen.getByRole("region", {
				name: ja ? "調整案" : "Suggested adjustment",
			}),
		).toBeVisible();
		const maintained = screen.getByRole("region", {
			name: ja ? "維持する値" : "Maintained values",
		});
		expect(within(maintained).getAllByRole("button")).toHaveLength(1);
		expect(maintained).toHaveTextContent(
			ja ? "ビットレート間隔の上限" : "Maximum bitrate ratio",
		);
		expect(maintained).not.toHaveTextContent(
			ja ? "ビットレート間隔の下限" : "Minimum bitrate ratio",
		);
		expect(currentGoal()).toEqual(session);
		expect(onAdopt).not.toHaveBeenCalled();
	});

	it("does not blame maintained values without a certified alternative", () => {
		renderLocalized(<Harness session={source()} onAdopt={vi.fn()} />);
		evaluate();
		decision("Minimum bitrate ratio", "keep");
		decision("Maximum bitrate ratio", "keep");
		review();
		expect(
			screen.queryByRole("button", {
				name: "Release these maintained values and re-evaluate",
			}),
		).toBeNull();
		expect(
			screen.queryByText(/A checked alternative is available if/),
		).toBeNull();
		expectPin("Minimum bitrate ratio");
		expectPin("Maximum bitrate ratio");
	});
	it("stages decisions without changing settings, pins, or dispatching adoption", () => {
		const session = source(),
			onAdopt = vi.fn();
		renderLocalized(<Harness session={session} onAdopt={onAdopt} />);
		evaluate();
		decision("Minimum bitrate ratio", "apply");
		decision("Maximum bitrate ratio", "keep");
		expect(currentGoal()).toEqual(session);
		expect(
			screen.queryByRole("region", { name: "Maintained values" }),
		).toBeNull();
		expect(onAdopt).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Use this adjustment" }),
		).toBeDisabled();
		decision("Minimum bitrate ratio", "skip");
		decision("Maximum bitrate ratio", "skip");
		expect(
			screen.getByRole("button", { name: "Use this adjustment" }),
		).toBeEnabled();
	});

	it("resets uncommitted decisions when the identical input is evaluated again", () => {
		const session = source();
		const onAdopt = vi.fn();
		renderLocalized(<Harness session={session} onAdopt={onAdopt} />);
		evaluate();
		decision("Minimum bitrate ratio", "apply");
		decision("Maximum bitrate ratio", "keep");
		evaluate();
		expect(
			screen.getByRole("combobox", { name: "Decision: Minimum bitrate ratio" }),
		).toHaveValue("skip");
		expect(
			screen.getByRole("combobox", { name: "Decision: Maximum bitrate ratio" }),
		).toHaveValue("skip");
		expect(
			screen.getByRole("button", { name: "Re-evaluate selected decisions" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Use this adjustment" }),
		).toBeEnabled();
		expect(currentGoal()).toEqual(session);
		expect(
			screen.queryByRole("region", { name: "Maintained values" }),
		).toBeNull();
		expect(onAdopt).not.toHaveBeenCalled();
	});

	it("commits mixed decisions once using the original protection options", () => {
		const session = source(),
			onAdopt = vi.fn();
		renderLocalized(<Harness session={session} onAdopt={onAdopt} />);
		evaluate();
		decision("Minimum bitrate ratio", "apply");
		decision("Maximum bitrate ratio", "keep");
		review();
		expect(onAdopt).toHaveBeenCalledTimes(1);
		expect(onAdopt.mock.calls[0]?.[1]?.protectedFields).toEqual([]);
		expect(onAdopt.mock.calls[0]?.[1]?.referenceGoal).toBe(session);
		expect(onAdopt.mock.calls[0]?.[1]?.contextKey).toBe("analysis:adaptive");
		expect(onAdopt.mock.calls[0]?.[2]).toEqual([
			{ scope: "global", key: "minBitrateStepSize" },
		]);
		expect(currentGoal().minBitrateStepSize).toBe(1.65);
		expect(currentGoal().maxBitrateStepSize).toBe(1.9);
		expectPin("Minimum bitrate ratio");
		expectPin("Maximum bitrate ratio");
	});

	it("preserves a release before full adoption acknowledgement and keeps only the acknowledged value afterward", () => {
		const session = source(),
			onAdopt = vi.fn();
		renderLocalized(<Harness session={session} onAdopt={onAdopt} deferred />);
		evaluate();
		decision("Minimum bitrate ratio", "keep");
		review();
		fireEvent.click(
			screen.getByRole("button", { name: "Use this adjustment" }),
		);
		release("Minimum bitrate ratio");
		expect(currentGoal()).toEqual(session);
		expect(
			screen.queryByRole("region", { name: "Maintained values" }),
		).toBeNull();
		expect(onAdopt).toHaveBeenCalledTimes(1);
		fireEvent.click(
			screen.getByRole("button", { name: "Acknowledge adoption" }),
		);
		expect(currentGoal().maxBitrateStepSize).toBe(2.09);
		expectNoPin("Minimum bitrate ratio");
		expectNoPin("Maximum bitrate ratio");
		decision("Maximum bitrate ratio", "keep");
		review();
		expect(
			screen.getByRole("region", { name: "Maintained values" }),
		).toHaveTextContent("2.09");
		expectPin("Maximum bitrate ratio");
		expectNoPin("Minimum bitrate ratio");
		expect(onAdopt).toHaveBeenCalledTimes(1);
	});

	it("adds selected fields only on exact acknowledgement while publishing mixed kept fields immediately", () => {
		const session = source(),
			onAdopt = vi.fn();
		renderLocalized(<Harness session={session} onAdopt={onAdopt} deferred />);
		evaluate();
		decision("Minimum bitrate ratio", "apply");
		decision("Maximum bitrate ratio", "keep");
		review();
		expect(currentGoal()).toEqual(session);
		expectNoPin("Minimum bitrate ratio");
		expectPin("Maximum bitrate ratio");
		expect(onAdopt).toHaveBeenCalledTimes(1);
		fireEvent.click(
			screen.getByRole("button", { name: "Acknowledge adoption" }),
		);
		expect(currentGoal().minBitrateStepSize).toBe(1.65);
		expect(currentGoal().maxBitrateStepSize).toBe(1.9);
		expectPin("Minimum bitrate ratio");
		expectPin("Maximum bitrate ratio");
	});

	it.each([
		"en",
		"ja",
	] as const)("explains the pending acknowledgement instead of accepting a silent evaluation (%s)", (locale) => {
		const session = source();
		const onAdopt = vi.fn();
		renderLocalized(
			<Harness session={session} onAdopt={onAdopt} deferred />,
			locale,
		);
		const ja = locale === "ja";
		const evaluateButton = () =>
			screen.getByRole("button", {
				name: ja ? "評価する" : "Evaluate",
			});
		fireEvent.click(evaluateButton());
		fireEvent.click(
			screen.getByRole("button", {
				name: ja ? "この調整を採用" : "Use this adjustment",
			}),
		);
		expect(evaluateButton()).toBeDisabled();
		const panel = screen.getByRole("region", {
			name: ja ? "現在の設定を評価" : "Evaluate current settings",
		});
		expect(panel).toHaveAttribute("aria-busy", "true");
		expect(within(panel).getByRole("status")).toHaveTextContent(
			ja
				? "調整の反映を待っています"
				: "Waiting for the adjustment to be applied",
		);
		fireEvent.click(evaluateButton());
		expect(onAdopt).toHaveBeenCalledOnce();
		expect(currentGoal()).toEqual(session);
		fireEvent.click(
			screen.getByRole("button", { name: "Acknowledge adoption" }),
		);
		expect(evaluateButton()).toBeEnabled();
		expect(panel).not.toHaveAttribute("aria-busy", "true");
	});

	it("does not restore a released pin when a partial adoption is acknowledged", () => {
		renderLocalized(<Harness session={source()} onAdopt={vi.fn()} deferred />);
		evaluate();
		decision("Minimum bitrate ratio", "keep");
		review();
		decision("Maximum bitrate ratio", "apply");
		review();
		release("Minimum bitrate ratio");
		expect(
			screen.queryByRole("region", { name: "Maintained values" }),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "Acknowledge adoption" }),
		);
		expect(currentGoal().maxBitrateStepSize).toBe(2.09);
		expectPin("Maximum bitrate ratio");
		expectNoPin("Minimum bitrate ratio");
	});

	it("merges a later unrelated keep-only batch into a pending partial acknowledgement", () => {
		const session = source();
		const onAdopt = vi.fn();
		renderLocalized(<Harness session={session} onAdopt={onAdopt} deferred />);
		evaluate();
		decision("Minimum bitrate ratio", "apply");
		review();
		decision("Maximum bitrate ratio", "keep");
		review();
		expect(currentGoal()).toEqual(session);
		expectNoPin("Minimum bitrate ratio");
		expectPin("Maximum bitrate ratio");
		expect(onAdopt).toHaveBeenCalledTimes(1);
		fireEvent.click(
			screen.getByRole("button", { name: "Acknowledge adoption" }),
		);
		expect(currentGoal().minBitrateStepSize).toBe(1.65);
		expect(currentGoal().maxBitrateStepSize).toBe(1.9);
		expectPin("Minimum bitrate ratio");
		expectPin("Maximum bitrate ratio");
	});

	it("rejects keeping an in-flight changed value while allowing an unrelated keep before acknowledgement", () => {
		const session = source();
		const onAdopt = vi.fn();
		renderLocalized(<Harness session={session} onAdopt={onAdopt} deferred />);
		evaluate();
		decision("Minimum bitrate ratio", "apply");
		review();
		const pendingReview = reviewControl.current;
		if (!pendingReview)
			throw new Error("Expected the pending review callback.");
		act(() => {
			expect(
				pendingReview([], [{ scope: "global", key: "minBitrateStepSize" }]),
			).toBe(false);
		});
		expect(currentGoal()).toEqual(session);
		expectNoPin("Minimum bitrate ratio");
		expect(
			screen.queryByRole("region", { name: "Maintained values" }),
		).toBeNull();
		act(() => {
			expect(
				pendingReview([], [{ scope: "global", key: "maxBitrateStepSize" }]),
			).toBe(true);
		});
		expectPin("Maximum bitrate ratio");
		expectNoPin("Minimum bitrate ratio");
		expect(onAdopt).toHaveBeenCalledTimes(1);
		fireEvent.click(
			screen.getByRole("button", { name: "Acknowledge adoption" }),
		);
		expect(currentGoal().minBitrateStepSize).toBe(1.65);
		expect(currentGoal().maxBitrateStepSize).toBe(1.9);
		expectPin("Minimum bitrate ratio");
		expectPin("Maximum bitrate ratio");
		expect(
			screen.getByRole("region", { name: "Maintained values" }),
		).toHaveTextContent("Minimum bitrate ratio: 1.65");
	});

	it("honors explicit release of a selected field after its exact acknowledgement", () => {
		const onAdopt = vi.fn();
		renderLocalized(<Harness session={source()} onAdopt={onAdopt} deferred />);
		evaluate();
		decision("Minimum bitrate ratio", "apply");
		review();
		expect(
			screen.queryByRole("region", { name: "Maintained values" }),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "Acknowledge adoption" }),
		);
		expect(currentGoal().minBitrateStepSize).toBe(1.65);
		expectPin("Minimum bitrate ratio");
		release("Minimum bitrate ratio");
		expect(currentGoal().minBitrateStepSize).toBe(1.65);
		expect(
			screen.queryByRole("region", { name: "Maintained values" }),
		).toBeNull();
		expect(onAdopt).toHaveBeenCalledTimes(1);
	});

	it("never publishes selected pins when the parent rejects the old goal", () => {
		renderLocalized(<Harness session={source()} onAdopt={vi.fn()} deferred />);
		evaluate();
		decision("Minimum bitrate ratio", "apply");
		decision("Maximum bitrate ratio", "keep");
		review();
		fireEvent.click(screen.getByRole("button", { name: "Reject adoption" }));
		expect(currentGoal().minBitrateStepSize).toBe(1.5);
		expect(currentGoal().maxBitrate).toBe(8_000_001);
		expectNoPin("Minimum bitrate ratio");
		expectPin("Maximum bitrate ratio");
	});

	it("keeps pins through re-evaluation and releases a current value without changing it", () => {
		const session = source(),
			onAdopt = vi.fn();
		renderLocalized(<Harness session={session} onAdopt={onAdopt} />);
		evaluate();
		decision("Minimum bitrate ratio", "keep");
		review();
		evaluate();
		expect(
			screen.queryByRole("combobox", {
				name: "Decision: Minimum bitrate ratio",
			}),
		).toBeNull();
		expect(
			screen.getByRole("region", { name: "Maintained values" }),
		).toHaveTextContent("1.5");
		release("Minimum bitrate ratio");
		expect(
			screen.getByRole("combobox", { name: "Decision: Minimum bitrate ratio" }),
		).toHaveValue("skip");
		expect(currentGoal()).toEqual(session);
		expect(onAdopt).not.toHaveBeenCalled();
	});

	it("acknowledges a partial adoption, recalculates in analysis mode, then releases its pin", () => {
		const session = source(),
			onAdopt = vi.fn();
		renderLocalized(<Harness session={session} onAdopt={onAdopt} />);
		evaluate();
		decision("Minimum bitrate ratio", "apply");
		review();
		expect(currentGoal().minBitrateStepSize).toBe(1.65);
		expect(currentGoal().maxBitrateStepSize).toBe(1.9);
		expect(
			screen.getByRole("region", { name: "Maintained values" }),
		).toHaveTextContent("1.65");
		expect(
			screen.queryByRole("combobox", {
				name: "Decision: Minimum bitrate ratio",
			}),
		).toBeNull();
		expect(
			screen.getByRole("combobox", { name: "Decision: Maximum bitrate ratio" }),
		).toHaveValue("skip");
		release("Minimum bitrate ratio");
		expect(currentGoal().minBitrateStepSize).toBe(1.65);
		expect(
			screen.getByRole("combobox", { name: "Decision: Minimum bitrate ratio" }),
		).toHaveValue("skip");
		fireEvent.click(
			screen.getByRole("button", { name: "Use this adjustment" }),
		);
		expect(currentGoal().minBitrateStepSize).toBe(1.815);
		expect(onAdopt).toHaveBeenCalledTimes(2);
		expect(
			within(
				screen.getByRole("region", { name: "Evaluate current settings" }),
			).getByRole("status"),
		).toBeInTheDocument();
	});

	it.each([
		"selected",
		"complete",
	] as const)("rejects an old %s proposal when intent changes in the same batch", (kind) => {
		const session = source(),
			onAdopt = vi.fn();
		renderLocalized(<Harness session={session} onAdopt={onAdopt} />);
		evaluate();
		if (kind === "selected") decision("Minimum bitrate ratio", "apply");
		const stale = screen.getByRole("button", {
			name:
				kind === "selected"
					? "Re-evaluate selected decisions"
					: "Use this adjustment",
		});
		act(() => {
			fireEvent.change(screen.getByRole("combobox", { name: "Goal" }), {
				target: { value: "preserve" },
			});
			fireEvent.click(stale);
		});
		expect(onAdopt).not.toHaveBeenCalled();
		expect(currentGoal()).toEqual(session);
		expect(screen.queryByRole("combobox", { name: /Decision:/ })).toBeNull();
		evaluate();
		expect(
			screen.getByRole("combobox", { name: "Decision: Minimum bitrate ratio" }),
		).toHaveValue("skip");
	});

	it("rejects a stale selected callback after a keep-only batch commits", () => {
		const session = source(),
			onAdopt = vi.fn();
		renderLocalized(<Harness session={session} onAdopt={onAdopt} />);
		evaluate();
		const stale = reviewControl.current;
		if (!stale) throw new Error("Expected a current review callback.");
		decision("Maximum bitrate ratio", "keep");
		act(() => {
			review();
			expect(stale([{ scope: "global", key: "minBitrateStepSize" }], [])).toBe(
				false,
			);
		});
		expect(onAdopt).not.toHaveBeenCalled();
		expect(currentGoal()).toEqual(session);
		expectPin("Maximum bitrate ratio");
		expectNoPin("Minimum bitrate ratio");
		expect(
			screen.getByRole("combobox", { name: "Decision: Minimum bitrate ratio" }),
		).toHaveValue("skip");
		expect(
			screen.getByRole("button", { name: "Re-evaluate selected decisions" }),
		).toBeDisabled();
	});

	it("clears analysis and staged decisions when another session is loaded", () => {
		const session = source(),
			onAdopt = vi.fn();
		const view = renderLocalized(
			<PerTitleAdvisor goal={session} session={session} onAdopt={onAdopt} />,
		);
		evaluate();
		decision("Minimum bitrate ratio", "apply");
		decision("Maximum bitrate ratio", "keep");
		const loaded = source();
		view.rerender(
			<PerTitleAdvisor goal={loaded} session={loaded} onAdopt={onAdopt} />,
		);
		expect(screen.queryByRole("combobox", { name: /Decision:/ })).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();
		evaluate();
		expect(
			screen.getByRole("combobox", { name: "Decision: Minimum bitrate ratio" }),
		).toHaveValue("skip");
		expect(
			screen.getByRole("combobox", { name: "Decision: Maximum bitrate ratio" }),
		).toHaveValue("skip");
		expect(onAdopt).not.toHaveBeenCalled();
	});

	it.each([
		"flush",
		"reject-flush",
	] as const)("preserves the right mixed pins through a %s parent update", (acknowledgement) => {
		const onAdopt = vi.fn();
		renderLocalized(
			<Harness
				session={source()}
				onAdopt={onAdopt}
				acknowledgement={acknowledgement}
			/>,
		);
		evaluate();
		decision("Minimum bitrate ratio", "apply");
		decision("Maximum bitrate ratio", "keep");
		review();
		expect(onAdopt).toHaveBeenCalledTimes(1);
		expect(currentGoal().minBitrateStepSize).toBe(
			acknowledgement === "flush" ? 1.65 : 1.5,
		);
		if (acknowledgement === "flush") expectPin("Minimum bitrate ratio");
		else {
			expectNoPin("Minimum bitrate ratio");
			expect(currentGoal().maxBitrate).toBe(8_000_001);
		}
		expectPin("Maximum bitrate ratio");
	});

	it("does not restore old-session kept fields after a synchronous parent reset", () => {
		const onAdopt = vi.fn();
		renderLocalized(
			<Harness
				session={source()}
				onAdopt={onAdopt}
				acknowledgement="reset-flush"
			/>,
		);
		evaluate();
		decision("Minimum bitrate ratio", "apply");
		decision("Maximum bitrate ratio", "keep");
		review();
		expect(onAdopt).toHaveBeenCalledTimes(1);
		expect(currentGoal().maxBitrate).toBe(9_000_000);
		expect(
			screen.queryByRole("region", { name: "Maintained values" }),
		).toBeNull();
		evaluate();
		expect(
			screen.getByRole("combobox", { name: "Decision: Minimum bitrate ratio" }),
		).toHaveValue("skip");
		expect(
			screen.getByRole("combobox", { name: "Decision: Maximum bitrate ratio" }),
		).toHaveValue("skip");
	});

	it("rejects another selected commit while preserving the first pending acknowledgement", () => {
		const onAdopt = vi.fn();
		renderLocalized(<Harness session={source()} onAdopt={onAdopt} deferred />);
		evaluate();
		decision("Minimum bitrate ratio", "apply");
		review();
		expect(
			screen.getByRole("button", { name: "Use this adjustment" }),
		).toBeDisabled();
		decision("Maximum bitrate ratio", "apply");
		review();
		const pendingReview = reviewControl.current;
		if (!pendingReview)
			throw new Error("Expected the pending review callback.");
		act(() => {
			expect(
				pendingReview([{ scope: "global", key: "maxBitrateStepSize" }], []),
			).toBe(false);
		});
		expect(onAdopt).toHaveBeenCalledTimes(1);
		fireEvent.click(
			screen.getByRole("button", { name: "Acknowledge adoption" }),
		);
		expect(currentGoal().minBitrateStepSize).toBe(1.65);
		expect(currentGoal().maxBitrateStepSize).toBe(1.9);
		expectPin("Minimum bitrate ratio");
		expectNoPin("Maximum bitrate ratio");
	});
});
