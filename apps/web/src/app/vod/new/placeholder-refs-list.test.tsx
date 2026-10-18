import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlaceholderRefsList } from "./placeholder-refs-list";
import { collectPlaceholders } from "./plan-import";

/**
 *  item 3. The refs come from the REAL collector over a
 * placeholder-bearing plan fragment — not a hand-shaped array — so the
 * component and the collector cannot drift apart silently.
 */
describe("PlaceholderRefsList", () => {
	it("renders each token with its plan paths, tokens selectable", () => {
		const refs = collectPlaceholders({
			inputs: [
				{ key: "main", path: "<INSERT YOUR INPUT PATH>" },
				{ key: "alt", path: "<INSERT YOUR INPUT PATH>" },
			],
			output: { basePath: "{YOUR OUTPUT PREFIX}/vod/" },
		});
		render(<PlaceholderRefsList refs={refs} />);
		const insert = screen.getByText("<INSERT YOUR INPUT PATH>");
		expect(insert).toBeInTheDocument();
		expect(insert.className).toContain("select-all");
		// BOTH paths carrying the token are named.
		expect(
			screen.getByText("inputs[0].path, inputs[1].path"),
		).toBeInTheDocument();
		expect(screen.getByText("{YOUR OUTPUT PREFIX}")).toBeInTheDocument();
		expect(screen.getByText("output.basePath")).toBeInTheDocument();
	});

	it("renders nothing for an empty list", () => {
		const { container } = render(<PlaceholderRefsList refs={[]} />);
		expect(container.firstChild).toBeNull();
	});
});

describe("wizard wiring (caller pin)", () => {
	// The component test above stays green if the wizard never mounts the
	// list — the exact gap review-174's C1 named ("a named slot is not a
	// filled one"). Mounting the whole wizard in jsdom is not viable, so this
	// pins the CALLER in source, the #174 totality style: the amber
	// placeholder warning's guarded block must render the list from the real
	// refs. Deleting wizard.tsx:725 or passing different refs goes RED here.
	it("the amber warning block renders PlaceholderRefsList from formPlaceholderRefs", () => {
		const src = readFileSync(join(__dirname, "wizard.tsx"), "utf8");
		const guard = src.indexOf("{formPlaceholders > 0 ? (");
		expect(guard).toBeGreaterThan(-1);
		// Balanced walk of the ternary's consequent parenthesis.
		const open = src.indexOf("(", guard);
		let depth = 0;
		let end = -1;
		for (let i = open; i < src.length; i++) {
			if (src[i] === "(") depth += 1;
			else if (src[i] === ")") {
				depth -= 1;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		expect(end).toBeGreaterThan(open);
		const block = src.slice(open, end);
		// Whitespace-agnostic (review-178 follow-up): a Biome re-wrap of the
		// JSX line must not read as a regression — byte-exact matching fails
		// LOUD but falsely. The name, the prop and its source still pin.
		expect(block).toMatch(
			/<PlaceholderRefsList\s+refs=\{formPlaceholderRefs\}\s*\/>/,
		);
	});
});
