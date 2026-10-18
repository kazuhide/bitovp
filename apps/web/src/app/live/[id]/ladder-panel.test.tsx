import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveChannelPlanSchema } from "@bitovp/core";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { LadderPanel } from "./ladder-panel";

/**
 *  item 2. The FIRST fixture here was `as unknown as` with
 * lowercase codecs — a shape the schema cannot produce — and it pinned the
 * defect: the panel's forked lowercase sets never matched the UPPERCASE wire
 * literals, so real plans rendered ONE "other" table and the suite stayed
 * green (review of PR #177, C1/C2). This fixture is a REAL golden run
 * through liveChannelPlanSchema.parse, so the test measures the world the
 * schema actually produces, plus one webvtt rendition for the other-group
 * pin (review I2: deleting "other" survived — it was the only group real
 * data ever hit).
 */

const realPlan = JSON.parse(
	readFileSync(
		join(
			__dirname,
			"../../../../../../packages/core/src/live/__fixtures__/live-esam-full.plan.json",
		),
		"utf8",
	),
);
// Augment the RAW json before parsing so zod materializes the same
// defaults on the added rendition it puts on the real ones.
realPlan.renditions.push({
	key: "captions",
	ingestKey: realPlan.renditions[0].ingestKey,
	codec: "WEBVTT",
});
const PLAN = liveChannelPlanSchema.parse(realPlan);

describe("LadderPanel", () => {
	it("groups a REAL schema-parsed plan into video / audio / other", async () => {
		renderLocalized(<LadderPanel plan={PLAN} />, "en");
		expect(screen.getByText("Video renditions")).toBeInTheDocument();
		expect(screen.getByText("Audio renditions")).toBeInTheDocument();
		// The webvtt rendition lands VISIBLY in other — deleting the group
		// deletes a rendition from the ladder (review I2's surviving mutation).
		expect(screen.getByText("Other renditions")).toBeInTheDocument();
		expect(screen.getByText("captions")).toBeInTheDocument();
		// ASSOCIATION, not presence (review-177 N3: swapping the video/audio
		// predicates put AAC under "Video renditions" and stayed green — the
		// same failure codec-families.test.ts names, one layer up).
		const videoGroup = screen.getByText("Video renditions").parentElement;
		expect(within(videoGroup as HTMLElement).getAllByText("H264").length).toBe(
			3,
		);
		expect(within(videoGroup as HTMLElement).queryByText("AAC")).toBeNull();
		const audioGroup = screen.getByText("Audio renditions").parentElement;
		expect(within(audioGroup as HTMLElement).getByText("AAC")).toBeTruthy();
		// The #80 pattern: a row's full params open in a DetailPopover whose
		// trigger is named by its visible count.
		const triggers = screen.getAllByRole("button", {
			name: /^\d+ parameters$/,
		});
		expect(triggers.length).toBe(PLAN.renditions.length);
		await userEvent.click(triggers[0] as HTMLElement);
		expect(
			screen.getByRole("dialog", { name: /full parameters/ }),
		).toBeInTheDocument();
	});

	it("renders Japanese group headings under ja", () => {
		renderLocalized(<LadderPanel plan={PLAN} />, "ja");
		expect(screen.getByText("映像レンディション")).toBeInTheDocument();
		expect(screen.getByText("音声レンディション")).toBeInTheDocument();
		expect(screen.getByText("その他のレンディション")).toBeInTheDocument();
	});
});
