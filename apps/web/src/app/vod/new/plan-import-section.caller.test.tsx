import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import type { ImportedPlan } from "./plan-import";
import { PlanImportSection } from "./plan-import-section";

/**
 * The CALLER-level pin review-174's C1 demanded: PR #174's first push
 * threaded an optional translator that NO production caller passed — the
 * threading pin was green over a population it could not reach ("a named
 * slot is not a filled one", fourth bite in this repo). This renders a real
 * component under `ja`, drives the real paste path, and asserts the zod
 * sentence localized THROUGH the component's own useT — the exact wiring
 * the direct-call pin cannot see. Mutation "caller omits t" goes RED here.
 */

describe("PlanImportSection — the caller passes its own t (ledger #79c)", () => {
	it("a schema-invalid plan pastes to a JAPANESE zod message under ja", async () => {
		const onLoad = vi.fn((imported: ImportedPlan) => imported);
		renderLocalized(
			<PlanImportSection imported={null} onLoad={onLoad} onDiscard={vi.fn()} />,
			"ja",
		);
		// Parses as JSON and as an object, but fails the plan schema with an
		// empty name — zod's too_small(min 1, string) → zerr.zRequired.
		await userEvent.click(screen.getByRole("textbox"));
		await userEvent.paste(JSON.stringify({ planVersion: 1, name: "" }));
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		expect(textarea.value).toContain("planVersion");
		const loadButton = screen.getByRole("button", { name: "検証して読み込む" });
		await userEvent.click(loadButton);
		// The imported rail carries evaluation.zodMessage built by
		// parseImportedPlan WITH the component's translator.
		expect(onLoad).toHaveBeenCalledTimes(1);
		const evaluation = (onLoad.mock.calls[0]?.[0] as ImportedPlan).evaluation;
		if (evaluation.ok) {
			throw new Error("empty name must fail the plan schema");
		}
		expect(evaluation.zodMessage).toContain("必須です");
		expect(evaluation.zodMessage).not.toContain("Too small");
	});
});
