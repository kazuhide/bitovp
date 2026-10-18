import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodingPlanSchema } from "@bitovp/core";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { AuxOutputsPanel } from "./aux-outputs-panel";

/**
 *  item 6 (aux half). Real golden fixtures through the real
 * schema — the panel renders what the plan actually carries, and each row's
 * FULL config opens in place. The absent case pins the null render so the
 * panel never shows an empty heading on plans without aux outputs.
 */

const FIXTURES = join(
	__dirname,
	"../../../../../../../packages/core/src/plan/__fixtures__",
);

function load(name: string) {
	return encodingPlanSchema.parse(
		JSON.parse(readFileSync(join(FIXTURES, name), "utf8")),
	);
}

describe("AuxOutputsPanel", () => {
	it("renders sprites from a REAL plan and opens the full config", async () => {
		const plan = load("sprites-trickplay.plan.json");
		const sprite = plan.sprites[0];
		if (!sprite) {
			throw new Error("fixture must carry a sprite");
		}
		renderLocalized(<AuxOutputsPanel plan={plan} />);
		expect(screen.getByText("Sprites (trick play)")).toBeInTheDocument();
		expect(screen.getByText(sprite.key)).toBeInTheDocument();
		// The accessible name carries an sr-only ", {key}" suffix so N
		// sibling triggers are distinguishable (review-179 N4) — the visible
		// count stays the prefix.
		const trigger = screen.getByRole("button", {
			name: `${Object.keys(sprite).length} parameters, ${sprite.key}`,
		});
		await userEvent.click(trigger);
		const dialog = screen.getByRole("dialog", {
			name: new RegExp(`${sprite.key}.*full configuration`),
		});
		// A dt↔dd pair on fields whose values are UNIQUE in this fixture —
		// several sprite numerics share "10", so distance could not tell the
		// right row from a wrong one (review-179 N8 named vttName as the
		// unambiguous pair).
		if (!sprite.vttName) {
			throw new Error("fixture sprite must declare a vttName");
		}
		expect(within(dialog).getByText("vttName")).toBeInTheDocument();
		expect(within(dialog).getByText(sprite.vttName)).toBeInTheDocument();
		expect(within(dialog).getByText("creationMode")).toBeInTheDocument();
	});

	it("renders keyframes with their times", () => {
		const plan = load("keyframes-segment-aligned.plan.json");
		const keyframe = plan.keyframes[0];
		if (!keyframe) {
			throw new Error("fixture must carry a keyframe");
		}
		renderLocalized(<AuxOutputsPanel plan={plan} />);
		expect(screen.getByText("Keyframes")).toBeInTheDocument();
		expect(screen.getByText(`at ${keyframe.time}s`)).toBeInTheDocument();
	});

	it("a keyframe row opens its OWN record (review-179 N8)", async () => {
		// AuxRow is shared, but the per-group record= wiring is not — a group
		// passing the wrong object would still render its inline text.
		const plan = load("keyframes-segment-aligned.plan.json");
		const keyframe = plan.keyframes[0];
		if (!keyframe) {
			throw new Error("fixture must carry a keyframe");
		}
		renderLocalized(<AuxOutputsPanel plan={plan} />);
		await userEvent.click(
			screen.getByRole("button", {
				name: `${Object.keys(keyframe).length} parameters, ${keyframe.key}`,
			}),
		);
		const dialog = screen.getByRole("dialog", {
			name: new RegExp(`${keyframe.key}.*full configuration`),
		});
		expect(within(dialog).getByText("time")).toBeInTheDocument();
		expect(within(dialog).getByText(String(keyframe.time))).toBeInTheDocument();
	});

	it("renders thumbnails with stream, height and position count", () => {
		const plan = load(
			"fixed-bitrate-dash-hls-streamcondition-thumbnail-on-aws.plan.json",
		);
		const thumb = plan.thumbnails[0];
		if (!thumb) {
			throw new Error("fixture must carry a thumbnail");
		}
		renderLocalized(<AuxOutputsPanel plan={plan} />);
		expect(screen.getByText("Thumbnails")).toBeInTheDocument();
		expect(
			screen.getByText(
				// "position(s)", the samplePlaceholderPaths idiom — the first cut said
				// "{count} positions" and BOTH thumbnail goldens carry positions: [10],
				// so the shipped panel read "1 positions" and this test pinned the
				// defect (review-179 N5).
				`stream ${thumb.streamKey} · ${thumb.height}p · ${thumb.positions.length} position(s) (${thumb.unit})`,
			),
		).toBeInTheDocument();
	});

	it("renders NOTHING for a plan without aux outputs", () => {
		const plan = load("deinterlace-filter.plan.json");
		expect(plan.thumbnails).toHaveLength(0);
		expect(plan.sprites).toHaveLength(0);
		expect(plan.keyframes).toHaveLength(0);
		const { container } = renderLocalized(<AuxOutputsPanel plan={plan} />);
		expect(container.firstChild).toBeNull();
	});
});
