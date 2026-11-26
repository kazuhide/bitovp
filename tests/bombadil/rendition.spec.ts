import { always } from "@antithesishq/bombadil";
import {
	actions,
	extract,
	registerCustomAction,
} from "@antithesishq/bombadil/browser";
import { renditionInvariants } from "./rendition-model.ts";

const state = extract(({ document }) => {
	const text = document.querySelector("#oracle")?.textContent;
	const select = document.querySelector<HTMLSelectElement>("#component select");
	if (!text || !select) return null;
	const model = JSON.parse(text);
	return {
		...model,
		selected:
			select.selectedIndex === 0
				? null
				: (select.selectedOptions[0]?.textContent ?? null),
		options: select.options.length,
	};
});

// Expected labels come from fixture inputs and captured DOM intent, never from
// the component's key lookup or the value returned through onAdd.
export const defaultCopySourceIsLast = always(() =>
	renditionInvariants.defaultCopySourceIsLast(state.current),
);
export const explicitSelectionIsNotRedirected = always(() =>
	renditionInvariants.explicitSelectionIsNotRedirected(state.current),
);
export const copiedSourceMatchesVisibleChoice = always(() =>
	renditionInvariants.copiedSourceMatchesVisibleChoice(state.current),
);
export const eachAddHasOneReceipt = always(() =>
	renditionInvariants.eachAddHasOneReceipt(state.current),
);

const selectSource = registerCustomAction(
	"selectCopySource",
	async (document, window, index: number) => {
		const select =
			document.querySelector<HTMLSelectElement>("#component select");
		if (!select || index < 0 || index >= select.options.length)
			throw new Error("Invalid generated selection");
		select.selectedIndex = index;
		select.dispatchEvent(new window.Event("change", { bubbles: true }));
	},
);
const control = registerCustomAction(
	"fixtureControl",
	async (document, _window, id: string) => {
		const button =
			id === "add"
				? [
						...document.querySelectorAll<HTMLButtonElement>(
							"#component button",
						),
					].find((candidate) => candidate.textContent === "Add rendition")
				: document.getElementById(id);
		if (!(button instanceof HTMLButtonElement))
			throw new Error("Missing generated control");
		button.click();
	},
);

export const renditionActions = actions(() => {
	const current = state.current;
	if (!current) return [];
	// A short coverage prefix is still executed and checked by Bombadil. After
	// reaching every action class, Bombadil explores their random interleavings.
	if (!current.counts.collision) return [control("collision")];
	if (!current.counts.reorder) return [control("reorder")];
	if (!current.counts.select) return [selectSource(2)];
	if (!current.counts.add) return [control("add")];
	if (!current.counts.reset) return [control("reset")];
	return [
		control("collision"),
		control("reorder"),
		control("reset"),
		...(current.rows.length < 8 ? [control("add")] : []),
		...Array.from({ length: current.options }, (_, index) =>
			selectSource(index),
		),
	];
});
