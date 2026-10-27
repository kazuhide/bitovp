import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import {
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "./build-live-plan";
import { LiveLadderSection } from "./ladder-section";
import { LivePackagingSection } from "./packaging-section";

function Harness({
	initial = structuredClone(DEFAULT_LIVE_WIZARD_STATE),
}: {
	initial?: LiveWizardState;
}) {
	const [state, setState] = useState(initial);
	return (
		<>
			<LiveLadderSection
				state={state}
				onPatch={(patch) => setState((current) => ({ ...current, ...patch }))}
			/>
			<LivePackagingSection
				state={state}
				credentials={[]}
				onPatch={(patch) => setState((current) => ({ ...current, ...patch }))}
			/>
			<output data-testid="state">{JSON.stringify(state)}</output>
		</>
	);
}

function current(): LiveWizardState {
	return JSON.parse(screen.getByTestId("state").textContent ?? "{}");
}

function field(id: string): HTMLElement {
	const element = document.getElementById(id);
	if (!element) throw new Error(`Missing ${id}`);
	return element;
}

describe("Live rendition optional fields", () => {
	it.each([
		"en",
		"ja",
	] as const)("keeps optional controls inside collapsed details in %s", (locale) => {
		renderLocalized(<Harness />, locale);
		for (const prefix of ["lw-v-0", "lw-a-0"]) {
			const input = field(`${prefix}-input-position`);
			expect(input.closest("details")).not.toHaveAttribute("open");
			expect(input).toHaveValue(null);
			expect(
				field(`${prefix}-media-path`).closest("details"),
			).not.toHaveAttribute("open");
		}
		expect(current().videos[0]?.input).toBeUndefined();
		expect(current().audios[0]?.muxing).toBeUndefined();
	});

	it("edits and clears input selection without an internal resource-key control", () => {
		renderLocalized(<Harness />);
		fireEvent.change(field("lw-a-0-input-position"), {
			target: { value: "0" },
		});
		fireEvent.change(field("lw-a-0-input-path"), {
			target: { value: "/audio" },
		});
		expect(current().audios[0]?.input).toEqual({
			position: 0,
			inputPath: "/audio",
		});
		fireEvent.change(field("lw-a-0-input-position"), { target: { value: "" } });
		fireEvent.change(field("lw-a-0-input-path"), { target: { value: "" } });
		expect(current().audios[0]?.input).toBeUndefined();
		expect(screen.queryByLabelText(/ingest.*key/i)).toBeNull();
	});

	it("makes literal and template naming mutually exclusive and clearing restores defaults", () => {
		renderLocalized(<Harness />);
		fireEvent.change(field("lw-v-0-media-segmentNamingTemplate"), {
			target: { value: "seg_{rand_chars:8}_%number%.m4s" },
		});
		expect(field("lw-v-0-media-segmentNaming")).toBeDisabled();
		fireEvent.change(field("lw-v-0-media-segmentNamingTemplate"), {
			target: { value: "" },
		});
		expect(field("lw-v-0-media-segmentNaming")).not.toBeDisabled();
		expect(current().videos[0]?.muxing).toBeUndefined();
	});

	it.each([
		"video",
		"audio",
	] as const)("copies %s source tracks and naming while allocating a separate custom media folder", (kind) => {
		const initial = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
		const source = kind === "video" ? initial.videos[0] : initial.audios[0];
		if (!source) throw new Error("Missing video");
		source.input = { position: 2, inputPath: "/input" };
		source.muxing = { path: "custom/picture", segmentNaming: "v_%number%.m4s" };
		renderLocalized(<Harness initial={initial} />);
		fireEvent.click(
			screen.getByRole("button", {
				name: kind === "video" ? /Add video/i : /Add audio/i,
			}),
		);
		const values = kind === "video" ? current().videos : current().audios;
		expect(values[1]?.input).toEqual(source.input);
		expect(values[1]?.muxing?.segmentNaming).toBe(source.muxing.segmentNaming);
		expect(values[1]?.muxing?.path).not.toBe(source.muxing.path);
		fireEvent.click(
			screen.getByRole("button", {
				name:
					kind === "video"
						? /Remove video rendition 1/i
						: /Remove audio rendition 1/i,
			}),
		);
		expect(
			(kind === "video" ? current().videos : current().audios)[0]?.input,
		).toEqual(source.input);
	});

	it("keeps MSL storage settings unavailable while input selection remains editable", () => {
		const initial = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
		initial.output.kind = "AKAMAI_MSL";
		renderLocalized(<Harness initial={initial} />);
		expect(document.getElementById("lw-v-0-media-path")).toBeNull();
		expect(field("lw-v-0-input-position")).not.toBeDisabled();
	});
});
