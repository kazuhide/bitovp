import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveChannelPlanSchema } from "@bitovp/core";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLocalized, renderWithQuery } from "@/test/render";
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
const TEMPLATE_PLAN = { ...PLAN, renditions: [] };
const RUN = { channelId: "channel-1", runId: "run-1", encodingId: "encoder-1" };
const { apiFetch, canRead } = vi.hoisted(() => ({
	apiFetch: vi.fn(),
	canRead: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/auth/use-role-access", () => ({ useMutationAccess: canRead }));

function outputStats(data: unknown, identity = RUN) {
	return {
		kind: "ladder",
		runId: identity.runId,
		encodingId: identity.encodingId,
		fetchedAt: "2026-10-01T00:00:00.000Z",
		data,
	};
}

beforeEach(() => {
	apiFetch.mockReset();
	canRead.mockReturnValue(true);
});

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

	it("lazily reports exact-run output even when the template plan has no renditions", async () => {
		apiFetch.mockResolvedValue(
			outputStats([
				{ streamId: "video-1", codec: "H264", height: 720, bitrate: 2_500_000 },
				{ streamId: "audio-1", codec: "AAC", bitrate: 128_000 },
			]),
		);
		const { rerender } = renderWithQuery(
			<LadderPanel plan={TEMPLATE_PLAN} run={RUN} open={false} />,
		);
		expect(apiFetch).not.toHaveBeenCalled();
		rerender(<LadderPanel plan={TEMPLATE_PLAN} run={RUN} open />);
		expect(screen.getByText("No ladder in the channel plan")).toBeVisible();
		const output = await screen.findByRole("table", {
			name: "Observed ladder",
		});
		expect(within(output).getByText("720p")).toBeVisible();
		expect(within(output).getByText("H264")).toBeVisible();
		expect(within(output).getByText("AAC")).toBeVisible();
		expect(within(output).getByText("128 kbps")).toBeVisible();
		expect(apiFetch).toHaveBeenCalledExactlyOnceWith(
			"/api/live-channels/channel-1/runs/run-1/diagnostics?kind=ladder",
			expect.objectContaining({ signal: expect.anything() }),
		);
	});

	it.each([
		[null, "Output statistics unavailable"],
		[[], "No encoded streams recorded"],
	])("shows the actual availability of %j", async (data, message) => {
		apiFetch.mockResolvedValue(outputStats(data));
		renderWithQuery(<LadderPanel run={RUN} open />);
		expect(await screen.findByText(message)).toBeVisible();
		expect(screen.getByText("unknown")).toBeVisible();
		expect(screen.queryByText("No ladder in the channel plan")).toBeNull();
	});

	it("never renders a response for another run or makes a request as a viewer", async () => {
		canRead.mockReturnValue(false);
		apiFetch.mockResolvedValue(outputStats([], { ...RUN, runId: "other-run" }));
		const { rerender } = renderWithQuery(<LadderPanel run={RUN} open />);
		expect(apiFetch).not.toHaveBeenCalled();
		canRead.mockReturnValue(true);
		rerender(<LadderPanel run={RUN} open />);
		await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
		expect(
			await screen.findByText("Output statistics unavailable"),
		).toBeVisible();
		expect(
			screen.queryByText("No encoded streams recorded"),
		).not.toBeInTheDocument();
	});
});
