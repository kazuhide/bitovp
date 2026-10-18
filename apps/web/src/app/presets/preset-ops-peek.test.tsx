import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compilePlan, encodingPlanSchema } from "@bitovp/core";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

/**
 *  item 13: the "{count} ops" badge opens the compiled operation
 * list. The fixture goes through the REAL schema and the REAL compiler —
 * the same `compilePlan` core pins every preset's `opCount` to — so this
 * test asserts the popover list AGREES with the badge by construction.
 */

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { PresetOpsPeek } from "./preset-ops-peek";

const rawPlan = JSON.parse(
	readFileSync(
		join(
			__dirname,
			"../../../../../packages/core/src/plan/__fixtures__/deinterlace-filter.plan.json",
		),
		"utf8",
	),
);
const ops = compilePlan(encodingPlanSchema.parse(rawPlan));

beforeEach(() => {
	vi.clearAllMocks();
});

describe("PresetOpsPeek", () => {
	it("opens the compiled op list, one row per badge-counted op", async () => {
		apiFetch.mockResolvedValue(rawPlan);
		renderWithQuery(
			<PresetOpsPeek name="deinterlace-filter" opCount={ops.length} />,
		);
		await userEvent.click(
			screen.getByRole("button", { name: `${ops.length} ops` }),
		);
		const dialog = await screen.findByRole("dialog", {
			name: /deinterlace-filter.*compiled operations/,
		});
		const first = ops[0];
		if (!first) {
			throw new Error("compiled plan must have ops");
		}
		expect(await within(dialog).findByText(first.step)).toBeInTheDocument();
		expect(within(dialog).getAllByRole("listitem")).toHaveLength(ops.length);
		expect(apiFetch).toHaveBeenCalledWith(
			"/api/sample-presets/deinterlace-filter",
		);
	});

	it("each op's kind opens its PAYLOAD — the peek no longer reproduces #80 S4", async () => {
		apiFetch.mockResolvedValue(rawPlan);
		renderWithQuery(
			<PresetOpsPeek name="deinterlace-filter" opCount={ops.length} />,
		);
		await userEvent.click(
			screen.getByRole("button", { name: `${ops.length} ops` }),
		);
		const dialog = await screen.findByRole("dialog", {
			name: /deinterlace-filter.*compiled operations/,
		});
		const first = ops[0];
		if (!first) {
			throw new Error("compiled plan must have ops");
		}
		const distinctive = Object.values(first.payload).find(
			(v): v is string => typeof v === "string" && v.length > 3,
		);
		if (!distinctive) {
			throw new Error("first op payload has no distinctive string value");
		}
		expect(within(dialog).queryByText(new RegExp(distinctive))).toBeNull();
		const [trigger] = within(dialog).getAllByRole("button", {
			name: first.kind,
		});
		if (!trigger) {
			throw new Error("no payload trigger rendered");
		}
		await userEvent.click(trigger);
		const payloadPanel = await screen.findByRole("dialog", {
			name: `Step ${first.step} — operation payload`,
		});
		expect(payloadPanel.textContent).toContain(distinctive);
	});

	it("two peeks with different names do NOT share a cache entry (review-179 N2/M3)", async () => {
		// queryKey ["sample-preset-ops"] without the name SURVIVED: with
		// staleTime Infinity, 56 cards on one page would all show the FIRST
		// opened preset's ops forever. Two presets, two fetches, each dialog
		// carrying its own first step.
		const other = JSON.parse(JSON.stringify(rawPlan));
		other.name = "other-preset";
		other.ingest = rawPlan.ingest.map((entry: Record<string, unknown>) => ({
			...entry,
			inputPath: "other.mov",
		}));
		apiFetch.mockImplementation((url: string) =>
			Promise.resolve(url.includes("other-preset") ? other : rawPlan),
		);
		renderWithQuery(
			<>
				<PresetOpsPeek name="deinterlace-filter" opCount={ops.length} />
				<PresetOpsPeek name="other-preset" opCount={ops.length} />
			</>,
		);
		const triggers = screen.getAllByRole("button", {
			name: `${ops.length} ops`,
		});
		await userEvent.click(triggers[0] as HTMLElement);
		await screen.findByRole("dialog", {
			name: /deinterlace-filter.*compiled operations/,
		});
		await userEvent.click(triggers[1] as HTMLElement);
		const second = await screen.findByRole("dialog", {
			name: /other-preset.*compiled operations/,
		});
		expect(await within(second).findByText(ops[0]?.step ?? "")).toBeVisible();
		const urls = apiFetch.mock.calls.map((call) => call[0]);
		expect(urls).toContain("/api/sample-presets/deinterlace-filter");
		expect(urls).toContain("/api/sample-presets/other-preset");
	});

	it("does NOT fetch until opened, and a failed fetch names the failure", async () => {
		apiFetch.mockRejectedValue(new Error("boom"));
		renderWithQuery(<PresetOpsPeek name="broken" opCount={5} />);
		expect(apiFetch).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "5 ops" }));
		expect(
			await screen.findByText("Could not load the operation list."),
		).toBeInTheDocument();
	});
});
