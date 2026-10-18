import { DELIVERY_SPECS } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized as render } from "@/test/render";
import { countPendingPlaceholders, parseImportedPlan } from "./plan-import";
import { PresetChecklist } from "./preset-checklist";

/**
 * Battery batch 2e : the sample-preset checklist — 285 lines
 * no test had rendered. Its one promise: the badge and the wizard's Start
 * gate derive from the SAME count (`countPendingPlaceholders`), so
 * resolving a placeholder through this panel must demonstrably move that
 * count, not just repaint the row.
 */

const ZERO = "00000000-0000-0000-0000-000000000000";

/** A real spec plan with fixture credentials, parsed by the wizard's own
 * import path — the same route a loaded sample preset takes. */
function importedWithZeros() {
	const spec = DELIVERY_SPECS[0];
	if (!spec) throw new Error("no shipped delivery specs");
	const plan = JSON.parse(JSON.stringify(spec.plan)) as {
		inputs?: { credentialId?: string }[];
		outputs?: { credentialId?: string }[];
	};
	for (const i of plan.inputs ?? []) i.credentialId = ZERO;
	for (const o of plan.outputs ?? []) o.credentialId = ZERO;
	const result = parseImportedPlan(JSON.stringify(plan));
	if (!result.ok) throw new Error("fixture plan does not parse");
	return result.imported;
}

const CREDENTIALS = [
	{
		id: "11111111-1111-4111-8111-111111111111",
		label: "vault-s3",
		provider: "S3",
	},
] as never[];

describe("PresetChecklist (ledger #149 batch 2e)", () => {
	it("counts the placeholder credential in the badge that gates Start", () => {
		const imported = importedWithZeros();
		render(
			<PresetChecklist
				imported={imported}
				credentials={CREDENTIALS}
				onUpdate={vi.fn()}
			/>,
		);
		expect(
			screen.getByText(`${countPendingPlaceholders(imported.raw)} to resolve`),
		).toBeInTheDocument();
		expect(screen.getByText("placeholder")).toBeInTheDocument();
	});

	it("swapping in a vault credential re-parses and MOVES the pending count", () => {
		const imported = importedWithZeros();
		const before = countPendingPlaceholders(imported.raw);
		expect(before).toBeGreaterThan(0);
		const onUpdate = vi.fn();
		render(
			<PresetChecklist
				imported={imported}
				credentials={CREDENTIALS}
				onUpdate={onUpdate}
			/>,
		);
		fireEvent.change(
			screen.getByLabelText(`Replacement credential for ${ZERO}`),
			{ target: { value: "11111111-1111-4111-8111-111111111111" } },
		);
		expect(onUpdate).toHaveBeenCalledOnce();
		const next = onUpdate.mock.calls[0]?.[0] as {
			raw: Record<string, unknown>;
		};
		// The substituted plan went back through the import parser (the rail
		// and previews stay truthful) and the gate count actually dropped.
		expect(countPendingPlaceholders(next.raw)).toBeLessThan(before);
		expect(JSON.stringify(next.raw)).not.toContain(ZERO);
	});

	it("a fully-resolved plan reads as resolved", () => {
		const spec = DELIVERY_SPECS[0];
		if (!spec) throw new Error("no shipped delivery specs");
		const plan = JSON.parse(JSON.stringify(spec.plan)) as {
			inputs?: { credentialId?: string }[];
			outputs?: { credentialId?: string }[];
		};
		const real = "11111111-1111-4111-8111-111111111111";
		for (const i of plan.inputs ?? []) i.credentialId = real;
		for (const o of plan.outputs ?? []) o.credentialId = real;
		const result = parseImportedPlan(JSON.stringify(plan));
		if (!result.ok) throw new Error("fixture plan does not parse");
		render(
			<PresetChecklist
				imported={result.imported}
				credentials={CREDENTIALS}
				onUpdate={vi.fn()}
			/>,
		);
		expect(screen.getByText("placeholders resolved")).toBeInTheDocument();
	});
});
