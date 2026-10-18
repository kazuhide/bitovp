import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodingPlanSchema, renditionSummaries } from "@bitovp/core";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { RenditionTables } from "./rendition-tables";

/**
 *  item 6 (filter half): the chain rendered KINDS only while
 * `plan.filters` carried each filter's full configuration. Real fixture,
 * real summaries — the chain element opens the filter's config in place.
 */

const plan = encodingPlanSchema.parse(
	JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../../../packages/core/src/plan/__fixtures__/deinterlace-filter.plan.json",
			),
			"utf8",
		),
	),
);

describe("RenditionTables — filter chain configs", () => {
	it("a chain element opens the filter's FULL config from plan.filters", async () => {
		const summaries = renditionSummaries(plan);
		const filter = plan.filters[0];
		if (!filter) {
			throw new Error("fixture must carry a filter");
		}
		renderLocalized(
			<RenditionTables
				video={summaries.video}
				audio={summaries.audio}
				subtitle={summaries.subtitle}
				renditions={plan.renditions}
				// A DECOY def first: the corpus has exactly ONE filter-bearing
				// fixture with ONE entry, so `filters[0]` survived the full suite
				// (review-179 I2/M2 — presence is not association). With the decoy,
				// a first-element lookup opens the wrong config and goes RED below.
				filters={[{ ...filter, key: "decoy-filter" }, ...plan.filters]}
			/>,
		);
		// Expand the row that carries the chain (the deinterlaced video rung).
		const expanders = screen.getAllByRole("button", { expanded: false });
		const chained = summaries.video.find((v) => v.filters.length > 0);
		if (!chained) {
			throw new Error("fixture must attach the filter to a video rung");
		}
		for (const expander of expanders) {
			await userEvent.click(expander);
		}
		// The chain element is a popover TRIGGER named by its visible kind —
		// not a plain span — and it opens the config. The name carries an
		// sr-only ", {rendition key}" suffix (review-179 N4) so N deinterlaced
		// rungs stay distinguishable; the visible kind is the prefix.
		const trigger = screen.getByRole("button", {
			name: new RegExp(`^${filter.kind}, `),
		});
		await userEvent.click(trigger);
		const dialog = screen.getByRole("dialog", {
			name: new RegExp(`Filter ${filter.key}`),
		});
		expect(within(dialog).getByText("key")).toBeInTheDocument();
		expect(within(dialog).getByText(filter.key)).toBeInTheDocument();
		expect(within(dialog).getByText("kind")).toBeInTheDocument();
		expect(within(dialog).getByText(filter.kind)).toBeInTheDocument();
	});
});
