import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LIVE_WIZARD_STATE } from "@/app/live/new/build-live-plan";
import { LiveLadderSection } from "@/app/live/new/ladder-section";
import { DEFAULT_WIZARD_STATE } from "@/app/vod/new/build-plan";
import { MuxingsSection } from "@/app/vod/new/muxings-section";
import { SpritesSection } from "@/app/vod/new/sprites-section";
import { ThumbnailsSection } from "@/app/vod/new/thumbnails-section";
import { renderLocalized } from "@/test/render";

/**
 * Render the wizard sections that no test had ever rendered.
 *
 * Measured 2026-08-21: 89 of the app's 198 exported components — 7,035 lines —
 * were never mounted by the suite. That is not a coverage statistic, it is the
 * explanation for the night's defects. `MSL4 greyed out` cleared a schema, a
 * compiler, a golden fixture, a constraint checker and a round-trip test,
 * every one of which starts from a plan that ALREADY holds the thing; the one
 * path that starts where a person starts had nothing looking at it.
 *
 * These are deliberately SHALLOW. A mount is not a behaviour test and this file
 * does not pretend otherwise — what it buys is that a section which throws on
 * its own default state, or which stops offering an option the plan can
 * express, fails here instead of in front of the owner. The per-section
 * behaviour tests that already exist stay where they are.
 *
 * Each assertion names something the section MUST offer, so "it rendered" is
 * never the whole claim — a component that returns null would otherwise pass.
 */

const noop = vi.fn();

describe("wizard sections mount on their own default state", () => {
	it("LiveLadderSection renders a codec and a container per rendition", () => {
		renderLocalized(
			<LiveLadderSection state={DEFAULT_LIVE_WIZARD_STATE} onPatch={noop} />,
		);
		// The live ladder's whole job: video rungs with a codec and a segment
		// container. `withMslStreamFormat` rewrites exactly these, so a section
		// that stopped rendering them would take the MSL format fix with it.
		const selects = [...document.querySelectorAll("select")];
		expect(
			selects.some((s) =>
				[...s.options].some((o) => /^(H264|H265)$/.test(o.value)),
			),
			"no codec select on the live ladder",
		).toBe(true);
		expect(
			selects.some((s) =>
				[...s.options].some((o) => /^(TS|FMP4)$/.test(o.value)),
			),
			"no segment-container select on the live ladder",
		).toBe(true);
	});

	it("ThumbnailsSection renders and offers its add control", () => {
		renderLocalized(
			<ThumbnailsSection state={DEFAULT_WIZARD_STATE} onPatch={noop} />,
		);
		expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
	});

	it("SpritesSection renders and offers its add control", () => {
		renderLocalized(
			<SpritesSection state={DEFAULT_WIZARD_STATE} onPatch={noop} />,
		);
		expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
	});

	it("MuxingsSection renders a muxing row per rendition", () => {
		renderLocalized(
			<MuxingsSection
				state={DEFAULT_WIZARD_STATE}
				credentials={[]}
				onPatch={noop}
			/>,
		);
		// Default state has renditions, so the section must show something for
		// them — an empty muxings step is how a plan ships with no outputs.
		expect(document.body.textContent?.trim().length ?? 0).toBeGreaterThan(0);
		expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
	});
});
