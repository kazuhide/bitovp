import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, Fragment } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ResourceIdPicker } from "@/components/resource-id-picker";
import { LocaleProvider } from "@/lib/i18n/context";
import { renderWithQuery } from "@/test/render";
import { Field } from "./field";
import { mergeDescription } from "./field-description";
import { Input, SelectNative, Textarea } from "./input";

/**
 *  — the trailing slot exists to END the drift class the owner
 * kept seeing: an outer `flex items-end` around Field+Button bottom-aligned
 * the button with the HINT line whenever a hint or error rendered. The
 * structural contract pinned here: the trailing control is a SAME-ROW
 * sibling of the input, and the hint renders BELOW that whole row.
 */
describe("Field trailing", () => {
	it("puts the trailing control on the INPUT row and the hint under both", () => {
		const { container } = renderWithQuery(
			<Field
				label="Source"
				htmlFor="f-src"
				hint="Pick via browse"
				trailing={<button type="button">Browse</button>}
			>
				<Input id="f-src" readOnly value="" />
			</Field>,
		);
		const input = container.querySelector("#f-src");
		const button = screen.getByRole("button", { name: "Browse" });
		const hint = screen.getByText("Pick via browse");
		// Input and button share a flex-row ancestor…
		const row = input?.closest(".flex");
		expect(row).not.toBeNull();
		expect(row?.contains(button)).toBe(true);
		// …and the hint is OUTSIDE that row (below it), never inside.
		expect(row?.contains(hint)).toBe(false);
	});

	it("without trailing, children render unwrapped (no layout change for the ~326 untouched call sites — 333 measured minus the 7 converted)", () => {
		const { container } = renderWithQuery(
			<Field label="Plain" htmlFor="f-plain">
				<Input id="f-plain" readOnly value="" />
			</Field>,
		);
		expect(container.querySelector("#f-plain")?.closest(".flex")).toBeNull();
	});
});

describe("Field descriptions", () => {
	for (const Control of [
		Input,
		SelectNative,
		Textarea,
		"input",
		"select",
		"textarea",
	] as const) {
		it(`associates ${typeof Control === "string" ? Control : Control.name} with visible help and errors`, () => {
			const view = (error?: string) => (
				<Field
					label="Value"
					htmlFor="value"
					hint="Capability instructions"
					error={error}
				>
					<div>
						<Control id="value" aria-describedby="existing" />
					</div>
					<p id="existing">Existing description</p>
				</Field>
			);
			const { rerender } = renderWithQuery(view());
			const control = screen.getByLabelText("Value");
			expect(control).toHaveAccessibleDescription(
				"Existing description Capability instructions",
			);
			rerender(view("Invalid value"));
			expect(control).toHaveAccessibleDescription(
				"Existing description Invalid value",
			);
			expect(
				screen.queryByText("Capability instructions"),
			).not.toBeInTheDocument();
			rerender(
				<Field label="Value" htmlFor="value">
					<div>
						<Control id="value" aria-describedby="existing" />
					</div>
					<p id="existing">Existing description</p>
				</Field>,
			);
			expect(control).toHaveAttribute("aria-describedby", "existing");
		});
	}

	it("reaches a composite control, but not its unrelated input or trailing action", () => {
		function Composite() {
			return (
				<>
					<Input id="primary" />
					<Input aria-label="Other input" />
				</>
			);
		}
		renderWithQuery(
			<Field
				label="Primary"
				htmlFor="primary"
				hint="Primary hint"
				trailing={<button type="button">Browse</button>}
			>
				<Composite />
			</Field>,
		);
		expect(screen.getByLabelText("Primary")).toHaveAccessibleDescription(
			"Primary hint",
		);
		expect(screen.getByLabelText("Other input")).not.toHaveAttribute(
			"aria-describedby",
		);
		expect(screen.getByRole("button", { name: "Browse" })).not.toHaveAttribute(
			"aria-describedby",
		);
	});

	it("keeps nested fields isolated and never references hidden overlay prose", () => {
		renderWithQuery(
			<Field label="Outer" htmlFor="outer" hint="Outer hint" help="Hidden help">
				<Input id="outer" />
				<Field label="Inner" htmlFor="inner" error="Inner error">
					<Input id="inner" />
				</Field>
			</Field>,
		);
		expect(screen.getByLabelText("Outer")).toHaveAccessibleDescription(
			"Outer hint",
		);
		expect(screen.getByLabelText("Inner")).toHaveAccessibleDescription(
			"Inner error",
		);
	});

	it("keeps existing description tokens in order without duplicates", () => {
		expect(mergeDescription("first  second first", "second")).toBe(
			"first second",
		);
		expect(mergeDescription("first second", "hint")).toBe("first second hint");
	});

	it("leaves controls without a matching nonempty htmlFor and opaque native controls alone", () => {
		function OpaqueNative() {
			return <input id="opaque" aria-label="Opaque" />;
		}
		renderWithQuery(
			<>
				<Field label="No target" htmlFor="" hint="Not associated">
					<Input aria-label="Unbound" />
				</Field>
				<Field label="Custom" htmlFor="opaque" hint="Custom must opt in">
					<OpaqueNative />
				</Field>
				<Field label="Missing" htmlFor="absent" hint="No match">
					<input id="other" aria-label="Other" />
				</Field>
			</>,
		);
		for (const name of ["Unbound", "Opaque", "Other"])
			expect(screen.getByLabelText(name)).not.toHaveAttribute(
				"aria-describedby",
			);
	});

	for (const locale of ["ja", "en"] as const) {
		it(`associates the real ResourceIdPicker input, retaining keyboard entry (${locale})`, async () => {
			const onChange = vi.fn();
			const user = userEvent.setup();
			renderWithQuery(
				<Field label="ID" htmlFor="resource" hint="Paste ID">
					<ResourceIdPicker
						inputId="resource"
						value=""
						onChange={onChange}
						candidates={[]}
						isLoading={false}
						emptyMessage="Empty"
						listLabel="Resources"
						copyLabel="ID"
					/>
				</Field>,
				locale,
			);
			const input = screen.getByLabelText("ID");
			expect(input).toHaveAccessibleDescription("Paste ID");
			await user.tab();
			expect(input).toHaveFocus();
			await user.keyboard("a");
			expect(onChange).toHaveBeenCalledWith("a");
		});
	}

	it("preserves native refs, label focus and event handlers through a Fragment", async () => {
		const ref = createRef<HTMLInputElement>();
		const onChange = vi.fn();
		const user = userEvent.setup();
		renderWithQuery(
			<Field label="Native" htmlFor="native" hint="Native hint">
				<Fragment key="native-controls">
					<input id="native" ref={ref} onChange={onChange} />
					<span>Unrelated sibling</span>
				</Fragment>
			</Field>,
		);
		const input = screen.getByLabelText("Native");
		expect(ref.current).toBe(input);
		await user.click(screen.getByText("Native", { selector: "label" }));
		expect(input).toHaveFocus();
		await user.keyboard("x");
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(input).toHaveAccessibleDescription("Native hint");
	});

	it("keeps unique description IDs and associations stable through SSR hydration", async () => {
		const tree = (
			<LocaleProvider locale="en">
				<Field label="One" htmlFor="one" hint="First">
					<Input id="one" />
				</Field>
				<Field label="Two" htmlFor="two" error="Second">
					<textarea id="two" />
				</Field>
			</LocaleProvider>
		);
		const container = document.createElement("div");
		container.innerHTML = renderToString(tree);
		document.body.append(container);
		const before = [...container.querySelectorAll("[aria-describedby]")].map(
			(el) => el.getAttribute("aria-describedby"),
		);
		expect(new Set(before).size).toBe(2);
		const onRecoverableError = vi.fn();
		let root: ReturnType<typeof hydrateRoot>;
		await act(async () => {
			root = hydrateRoot(container, tree, { onRecoverableError });
		});
		expect(
			[...container.querySelectorAll("[aria-describedby]")].map((el) =>
				el.getAttribute("aria-describedby"),
			),
		).toEqual(before);
		expect(container.querySelector("#one")).toHaveAccessibleDescription(
			"First",
		);
		expect(container.querySelector("#two")).toHaveAccessibleDescription(
			"Second",
		);
		expect(onRecoverableError).not.toHaveBeenCalled();
		await act(async () => root.unmount());
		container.remove();
	});
});
