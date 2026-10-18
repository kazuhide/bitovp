import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodingPlanSchema, renditionSummaries } from "@bitovp/core";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { RenditionTables } from "./rendition-tables";

/**
 * A shared container has to SAY so, on the page — .
 *
 * The core view model computed `sharedWith` correctly and nothing rendered it.
 * The audio row therefore went from "No muxings" — visibly wrong, which an
 * operator distrusts — to two containers whose destinations read
 * `origin:output/…/video/360p` and `…/video/720p` with no explanation. That is
 * strictly worse: it reads as a fact, and it sends someone looking for an
 * audio artefact among .ts segments.
 *
 * THIS TEST EXISTS BECAUSE THE OTHER ONE PASSED. `muxed-container.test.ts`
 * asserts the field's VALUE, and it was green across the whole gap — the exact
 * shape of "a named slot is not a filled one", and of testing the rule while
 * leaving the call site pinned by nothing. The population this field exists
 * for is the page, so the page is where it has to be asserted.
 */

const plan = encodingPlanSchema.parse(
	JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../../../packages/core/src/plan/__fixtures__/hls-ts-muxed-av.plan.json",
			),
			"utf8",
		),
	),
);

async function renderAllRows() {
	const summaries = renditionSummaries(plan);
	renderLocalized(
		<RenditionTables
			video={summaries.video}
			audio={summaries.audio}
			subtitle={summaries.subtitle}
			renditions={plan.renditions}
			filters={plan.filters}
		/>,
	);
	for (const expander of screen.getAllByRole("button", { expanded: false })) {
		await userEvent.click(expander);
	}
	return summaries;
}

describe("RenditionTables — a container shared between renditions", () => {
	it("tells the AUDIO row whose container it is riding in", async () => {
		await renderAllRows();
		// The muxed fixture packages a128 inside both video TS containers.
		expect(screen.getAllByText(/inside v360's container/)).not.toHaveLength(0);
		expect(screen.getAllByText(/inside v720's container/)).not.toHaveLength(0);
	});

	it("tells the VIDEO row it is carrying a passenger", async () => {
		await renderAllRows();
		// The opposite sentence, because the destination on THIS row is its own.
		// One symmetric label would have been wrong on one of the two rows.
		expect(screen.getAllByText(/also carries a128/)).toHaveLength(2);
	});

	it("says neither on a container that carries one rendition", async () => {
		// The counterfactual: a page that printed the marker unconditionally
		// would pass both arms above while labelling every ordinary container.
		const solo = encodingPlanSchema.parse({
			...plan,
			muxings: plan.muxings.map((m) => ({
				...m,
				additionalStreamKeys: undefined,
			})),
		});
		const summaries = renditionSummaries(solo);
		renderLocalized(
			<RenditionTables
				video={summaries.video}
				audio={summaries.audio}
				subtitle={summaries.subtitle}
				renditions={solo.renditions}
				filters={solo.filters}
			/>,
		);
		for (const expander of screen.getAllByRole("button", {
			expanded: false,
		})) {
			await userEvent.click(expander);
		}
		expect(screen.queryByText(/also carries/)).toBeNull();
		expect(screen.queryByText(/inside .*'s container/)).toBeNull();
	});
});
