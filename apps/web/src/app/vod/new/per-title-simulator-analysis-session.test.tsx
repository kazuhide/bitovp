import type { PerTitleGoal } from "@bitovp/core";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import {
	applyPerTitleAdvice,
	applySelectedPerTitleAdvice,
	type PerTitleAdvice,
	type PerTitleAdviceField,
	type PerTitleAdviceOptions,
} from "./per-title-simulator-advice";
import { PerTitleAdvisor } from "./per-title-simulator-advisor";

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
			return { ...result, advice: advice ? [advice] : [] };
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

function Harness({
	session,
	onAdopt,
	deferred = false,
}: {
	session: PerTitleGoal;
	deferred?: boolean;
	onAdopt: (
		advice: PerTitleAdvice,
		options?: PerTitleAdviceOptions,
		selected?: readonly PerTitleAdviceField[],
	) => void;
}) {
	const [goal, setGoal] = useState(session);
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
		setGoal(
			(current) =>
				(selected
					? applySelectedPerTitleAdvice(current, advice, selected, options)
					: applyPerTitleAdvice(current, advice, options)) ?? current,
		);
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
			<PerTitleAdvisor goal={goal} session={session} onAdopt={adopt} />
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
function currentGoal(): PerTitleGoal {
	return JSON.parse(
		screen.getByTestId("analysis-current-goal").textContent ?? "{}",
	);
}

describe("current analysis adoption sessions", () => {
	it("preserves a release and new keep made after full adoption but before its exact acknowledgement", () => {
		const session = source();
		renderLocalized(<Harness session={session} onAdopt={vi.fn()} deferred />);
		evaluate();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Keep current value: Minimum bitrate ratio",
			}),
		);
		const adopt = screen.getByRole("button", { name: "Use this adjustment" });
		const release = screen.getByRole("button", {
			name: "Release: Minimum bitrate ratio",
		});
		const keep = screen.getByRole("button", {
			name: "Keep current value: Maximum bitrate ratio",
		});
		act(() => {
			fireEvent.click(adopt);
			fireEvent.click(release);
			fireEvent.click(keep);
		});
		expect(currentGoal()).toEqual(session);
		expect(
			screen.getByRole("region", { name: "Maintained values" }),
		).toHaveTextContent("Maximum bitrate ratio");
		expect(
			screen.getByRole("region", { name: "Maintained values" }),
		).toHaveTextContent("1.9");
		fireEvent.click(
			screen.getByRole("button", { name: "Acknowledge adoption" }),
		);
		expect(currentGoal().maxBitrateStepSize).toBe(2.09);
		// A pin identifies the current field; it does not cancel the dispatched change.
		expect(
			screen.getByRole("region", { name: "Maintained values" }),
		).toHaveTextContent("2.09");
		expect(
			screen.getByRole("button", { name: "Release: Maximum bitrate ratio" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Release: Minimum bitrate ratio" }),
		).toBeNull();
	});

	it("adds selected fields only on exact acknowledgement while preserving a new keep", () => {
		const session = source();
		renderLocalized(<Harness session={session} onAdopt={vi.fn()} deferred />);
		evaluate();
		fireEvent.click(
			screen.getByRole("checkbox", {
				name: "Select change: Minimum bitrate ratio",
			}),
		);
		const apply = screen.getByRole("button", {
			name: "Apply selected changes and recalculate",
		});
		const keep = screen.getByRole("button", {
			name: "Keep current value: Maximum bitrate ratio",
		});
		act(() => {
			fireEvent.click(apply);
			fireEvent.click(keep);
		});
		expect(currentGoal()).toEqual(session);
		expect(
			screen.queryByRole("button", { name: "Release: Minimum bitrate ratio" }),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "Acknowledge adoption" }),
		);
		expect(currentGoal().minBitrateStepSize).toBe(1.65);
		expect(currentGoal().maxBitrateStepSize).toBe(1.9);
		expect(
			screen.getByRole("button", { name: "Release: Minimum bitrate ratio" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Release: Maximum bitrate ratio" }),
		).toBeInTheDocument();
	});

	it("does not restore a released pin when a partial adoption is acknowledged", () => {
		renderLocalized(<Harness session={source()} onAdopt={vi.fn()} deferred />);
		evaluate();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Keep current value: Minimum bitrate ratio",
			}),
		);
		fireEvent.click(
			screen.getByRole("checkbox", {
				name: "Select change: Maximum bitrate ratio",
			}),
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Apply selected changes and recalculate",
			}),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Release: Minimum bitrate ratio" }),
		);
		expect(
			screen.queryByRole("region", { name: "Maintained values" }),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "Acknowledge adoption" }),
		);
		expect(currentGoal().maxBitrateStepSize).toBe(2.09);
		expect(
			screen.getByRole("button", { name: "Release: Maximum bitrate ratio" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Release: Minimum bitrate ratio" }),
		).toBeNull();
	});

	it("honors an explicit release of a selected field before acknowledgement", () => {
		renderLocalized(<Harness session={source()} onAdopt={vi.fn()} deferred />);
		evaluate();
		fireEvent.click(
			screen.getByRole("checkbox", {
				name: "Select change: Minimum bitrate ratio",
			}),
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Apply selected changes and recalculate",
			}),
		);
		expect(
			screen.queryByRole("region", { name: "Maintained values" }),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Keep current value: Minimum bitrate ratio",
			}),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Release: Minimum bitrate ratio" }),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Acknowledge adoption" }),
		);
		expect(currentGoal().minBitrateStepSize).toBe(1.65);
		expect(
			screen.queryByRole("region", { name: "Maintained values" }),
		).toBeNull();
	});

	it("never publishes selected pins when the parent rejects the old goal", () => {
		renderLocalized(<Harness session={source()} onAdopt={vi.fn()} deferred />);
		evaluate();
		fireEvent.click(
			screen.getByRole("checkbox", {
				name: "Select change: Minimum bitrate ratio",
			}),
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Apply selected changes and recalculate",
			}),
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Keep current value: Maximum bitrate ratio",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Reject adoption" }));
		expect(currentGoal().minBitrateStepSize).toBe(1.5);
		expect(currentGoal().maxBitrate).toBe(8_000_001);
		expect(
			screen.queryByRole("button", { name: "Release: Minimum bitrate ratio" }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Release: Maximum bitrate ratio" }),
		).toBeInTheDocument();
	});

	it("keeps pins through re-evaluation and releases a current value without changing it", () => {
		const session = source();
		renderLocalized(<Harness session={session} onAdopt={vi.fn()} />);
		evaluate();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Keep current value: Minimum bitrate ratio",
			}),
		);
		evaluate();
		expect(
			screen.queryByRole("checkbox", {
				name: "Select change: Minimum bitrate ratio",
			}),
		).toBeNull();
		expect(
			screen.getByRole("region", { name: "Maintained values" }),
		).toHaveTextContent("1.5");
		fireEvent.click(
			screen.getByRole("button", { name: "Release: Minimum bitrate ratio" }),
		);
		expect(
			screen.getByRole("checkbox", {
				name: "Select change: Minimum bitrate ratio",
			}),
		).not.toBeChecked();
		expect(currentGoal()).toEqual(session);
	});

	it("acknowledges a partial adoption, recalculates in analysis mode, then releases its pin", () => {
		const session = source();
		const onAdopt = vi.fn();
		renderLocalized(<Harness session={session} onAdopt={onAdopt} />);
		evaluate();
		fireEvent.click(
			screen.getByRole("checkbox", {
				name: "Select change: Minimum bitrate ratio",
			}),
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Apply selected changes and recalculate",
			}),
		);
		expect(currentGoal().minBitrateStepSize).toBe(1.65);
		expect(currentGoal().maxBitrateStepSize).toBe(1.9);
		expect(
			screen.getByRole("region", { name: "Maintained values" }),
		).toHaveTextContent("1.65");
		expect(
			screen.queryByRole("checkbox", {
				name: "Select change: Minimum bitrate ratio",
			}),
		).toBeNull();
		expect(
			screen.getByRole("checkbox", {
				name: "Select change: Maximum bitrate ratio",
			}),
		).not.toBeChecked();
		fireEvent.click(
			screen.getByRole("button", { name: "Release: Minimum bitrate ratio" }),
		);
		expect(currentGoal().minBitrateStepSize).toBe(1.65);
		expect(
			screen.getByRole("checkbox", {
				name: "Select change: Minimum bitrate ratio",
			}),
		).not.toBeChecked();
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

	it("rejects an old selected or complete proposal when the goal changes in the same batch", () => {
		const session = source();
		const onAdopt = vi.fn();
		renderLocalized(<Harness session={session} onAdopt={onAdopt} />);
		evaluate();
		fireEvent.click(
			screen.getByRole("checkbox", {
				name: "Select change: Minimum bitrate ratio",
			}),
		);
		const selected = screen.getByRole("button", {
			name: "Apply selected changes and recalculate",
		});
		const complete = screen.getByRole("button", {
			name: "Use this adjustment",
		});
		act(() => {
			fireEvent.change(screen.getByRole("combobox", { name: "Goal" }), {
				target: { value: "bandwidth" },
			});
			fireEvent.click(selected);
			fireEvent.click(complete);
		});
		expect(onAdopt).not.toHaveBeenCalled();
		expect(currentGoal()).toEqual(session);
		expect(
			screen.queryByRole("checkbox", { name: /Select change:/ }),
		).toBeNull();
		evaluate();
		expect(
			screen.getByRole("checkbox", {
				name: "Select change: Minimum bitrate ratio",
			}),
		).not.toBeChecked();
	});

	it("rejects an old selection when a pin is added in the same batch", () => {
		const onAdopt = vi.fn();
		renderLocalized(<Harness session={source()} onAdopt={onAdopt} />);
		evaluate();
		fireEvent.click(
			screen.getByRole("checkbox", {
				name: "Select change: Minimum bitrate ratio",
			}),
		);
		const selected = screen.getByRole("button", {
			name: "Apply selected changes and recalculate",
		});
		act(() => {
			fireEvent.click(
				screen.getByRole("button", {
					name: "Keep current value: Maximum bitrate ratio",
				}),
			);
			fireEvent.click(selected);
		});
		expect(onAdopt).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", {
				name: "Apply selected changes and recalculate",
			}),
		).toBeDisabled();
	});

	it("clears analysis and selections when another session is loaded", () => {
		const session = source();
		const onAdopt = vi.fn();
		const view = renderLocalized(
			<PerTitleAdvisor goal={session} session={session} onAdopt={onAdopt} />,
		);
		evaluate();
		fireEvent.click(
			screen.getByRole("checkbox", {
				name: "Select change: Minimum bitrate ratio",
			}),
		);
		const loaded = source();
		view.rerender(
			<PerTitleAdvisor goal={loaded} session={loaded} onAdopt={onAdopt} />,
		);
		expect(
			screen.queryByRole("checkbox", { name: /Select change:/ }),
		).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();
		evaluate();
		expect(
			screen.getByRole("checkbox", {
				name: "Select change: Minimum bitrate ratio",
			}),
		).not.toBeChecked();
		expect(onAdopt).not.toHaveBeenCalled();
	});
});
