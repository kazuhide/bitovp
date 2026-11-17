import { always } from "@antithesishq/bombadil";
import {
	actions,
	extract,
	registerCustomAction,
} from "@antithesishq/bombadil/browser";
import type {
	InstalledRow,
	InstalledWizardOracle,
} from "./installed-wizard-model";

const state = extract(({ document, window }) => {
	const model = (
		window as typeof window & { __bitovpWizard?: InstalledWizardOracle }
	).__bitovpWizard;
	const fields = Array.from(
		document.querySelectorAll<HTMLInputElement>(
			'input[id^="wz-v-"][id$="-height"]',
		),
	);
	const actual = fields.map((field, index) => ({
		height: Number(field.value),
		bitrate: Number(
			document.querySelector<HTMLInputElement>(`#wz-v-${index}-bitrate`)?.value,
		),
	}));
	let serialized: InstalledRow[] | null = null;
	try {
		const plan = JSON.parse(
			document.querySelector('[data-testid="plan-json"]')?.textContent ??
				"null",
		);
		serialized = plan.renditions
			.filter((row: { codec: string }) => row.codec === "H264")
			.map((row: InstalledRow) => ({
				height: row.height,
				bitrate: row.bitrate,
			}));
	} catch {
		/* Missing or incomplete serialization is never successful readiness. */
	}
	return {
		ready: !!model && actual.length > 0 && serialized !== null,
		expected: model?.rows,
		actual,
		serialized,
		counts: model?.counts,
		faults: model?.faults,
		guarded: model?.guarded,
		selected: model?.selected,
		actualSelected: document.querySelector<HTMLSelectElement>(
			'select[aria-label="Video settings to reuse"]',
		)?.selectedIndex,
	};
});

export const hydratedWizardRemainsAvailable = always(
	() => state.current?.ready === true,
);
export const configuredRenditionsMatchIntent = always(
	() =>
		JSON.stringify(state.current?.actual) ===
			JSON.stringify(state.current?.expected) &&
		JSON.stringify(state.current?.serialized) ===
			JSON.stringify(state.current?.expected),
);
export const explicitCopySelectionMatchesIntent = always(
	() =>
		state.current?.selected == null ||
		state.current.selected === state.current.actualSelected,
);
export const networkGuardRemainsClosed = always(
	() =>
		!state.current?.counts?.edit ||
		(state.current.guarded?.mutation === true &&
			state.current.guarded.external === true),
);

const operate = registerCustomAction(
	"installedWizardOperation",
	async (document, window, kind: string, index: number, value: number) => {
		const model = (
			window as typeof window & { __bitovpWizard: InstalledWizardOracle }
		).__bitovpWizard;
		if (!model) throw new Error("Installed oracle missing");
		if (!model.guarded) {
			const blocked = (url: string) =>
				window.fetch(url, { method: "POST" }).then(
					() => false,
					() => true,
				);
			const [mutation, external] = await Promise.all([
				blocked("/api/bombadil-guard"),
				blocked(model.tripwire),
			]);
			model.guarded = { mutation, external };
		}
		const select = document.querySelector<HTMLSelectElement>(
			'select[aria-label="Video settings to reuse"]',
		);
		if (!select) throw new Error("Installed copy selector missing");
		const click = (selector: string) => {
			const button = document.querySelector<HTMLButtonElement>(selector);
			if (!button || button.disabled)
				throw new Error(`Missing enabled control: ${selector}`);
			button.click();
		};
		const settle = () =>
			new Promise<void>((done) =>
				window.requestAnimationFrame(() =>
					window.requestAnimationFrame(() => done()),
				),
			);
		model.selected = null;
		if (kind === "height" || kind === "bitrate") {
			const input = document.querySelector<HTMLInputElement>(
				`#wz-v-${index}-${kind}`,
			);
			const row = model.rows[index];
			if (!input || !row) throw new Error("Generated edit is out of range");
			row[kind] = value;
			model.counts.edit++;
			Object.getOwnPropertyDescriptor(
				window.HTMLInputElement.prototype,
				"value",
			)?.set?.call(input, String(value));
			input.dispatchEvent(new window.Event("input", { bubbles: true }));
			input.dispatchEvent(new window.Event("change", { bubbles: true }));
		} else if (kind === "select") {
			if (index < 1 || index >= select.options.length)
				throw new Error("Generated selection is out of range");
			model.selected = index;
			model.counts.select++;
			select.selectedIndex = index;
			select.dispatchEvent(new window.Event("change", { bubbles: true }));
		} else if (kind === "add") {
			// Capture visible intent before any injected redirection; never read option keys.
			const source = model.rows[select.selectedIndex - 1];
			if (!source) throw new Error("Add requires a visible source row");
			model.rows.push({ ...source });
			model.counts.add++;
			if (model.fault && model.faults === 0) {
				// Negative control only: redirect a user's selection before the real click.
				// This is an action-routing fault, not a production source mutation.
				select.selectedIndex = select.selectedIndex === 1 ? 2 : 1;
				select.dispatchEvent(new window.Event("change", { bubbles: true }));
				model.faults++;
				await settle();
			}
			const button = Array.from(
				document.querySelectorAll<HTMLButtonElement>("button"),
			).find((button) => button.textContent === "Add video");
			if (!button) throw new Error("Installed Add video control missing");
			button.click();
		} else if (kind === "remove") {
			if (model.rows.length <= 2 || !model.rows[index])
				throw new Error("Generated removal is out of range");
			model.rows.splice(index, 1);
			model.counts.remove++;
			click(`button[aria-label="Remove video ${index + 1}"]`);
		} else if (kind === "revisit") {
			const step = (prefix: string) => {
				const button = Array.from(
					document.querySelectorAll<HTMLButtonElement>(
						'nav[aria-label="Wizard steps"] button',
					),
				).find((button) => button.textContent?.startsWith(prefix));
				if (!button)
					throw new Error(`Installed wizard step missing: ${prefix}`);
				button.click();
			};
			step("1.");
			await settle();
			step("3.");
			await settle();
			model.counts.revisit++;
		} else throw new Error("Unknown generated wizard action");
	},
);

export const installedWizardActions = actions(() => {
	const current = state.current;
	if (!current?.ready || !current.counts || !current.expected) return [];
	if (!current.counts.edit) return [operate("height", 0, 480)];
	if (!current.counts.select) return [operate("select", 1, 0)];
	if (!current.counts.add) return [operate("add", 0, 0)];
	if (!current.counts.remove) return [operate("remove", 1, 0)];
	if (!current.counts.revisit) return [operate("revisit", 0, 0)];
	return [
		operate("revisit", 0, 0),
		...(current.expected.length < 6 ? [operate("add", 0, 0)] : []),
		...current.expected.flatMap((row, index) => [
			operate("select", index + 1, 0),
			operate("height", index, row.height === 720 ? 480 : 720),
			operate(
				"bitrate",
				index,
				row.bitrate === 1_000_000 ? 2_000_000 : 1_000_000,
			),
			...(current.expected.length > 2 ? [operate("remove", index, 0)] : []),
		]),
	];
});
