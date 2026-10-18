import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderWithQuery as render } from "@/test/render";
import {
	DEFAULT_WIZARD_STATE,
	remapEncodingKeyRefs,
	type WizardState,
} from "./build-plan";
import { SourcesSection } from "./sources-section";
import { LadderSection } from "./wizard-sections";

function mount(initial: WizardState, ladder = false) {
	function Harness() {
		const [state, setState] = useState(initial);
		const patch = (partial: Partial<WizardState>) =>
			setState((prev) => ({ ...prev, ...partial }));
		return (
			<>
				{ladder ? (
					<LadderSection state={state} credentials={[]} onPatch={patch} />
				) : (
					<SourcesSection state={state} onPatch={patch} />
				)}
				<output data-testid="state">{JSON.stringify(state)}</output>
			</>
		);
	}
	return render(<Harness />);
}
const stateNow = () =>
	JSON.parse(screen.getByTestId("state").textContent ?? "{}") as WizardState;
const base: WizardState = {
	...DEFAULT_WIZARD_STATE,
	videos: [
		{
			height: 720,
			bitrate: 1000000,
			extras: {
				source: "trim1",
				filters: [{ filterKey: "deint1", position: 0 }],
			},
		},
	],
	filters: [{ key: "deint1" }],
	sources: {
		audioMixStreams: [
			{
				key: "mix",
				audioMixChannels: [
					{
						sourceKey: "trim1",
						outputChannelType: "FRONT_LEFT",
						sourceChannels: [{ type: "FRONT_LEFT" }],
					},
				],
			},
		],
		trimmingStreams: [
			{ key: "trim1", kind: "TIME_BASED", sourceKey: "video", duration: 10 },
		],
		concatenationStreams: [
			{
				key: "concat1",
				sources: [{ sourceKey: "trim1", position: 0, isMain: true }],
			},
		],
	},
};
describe("source resource editing", () => {
	it("allows a complete trim rename without losing focus and preserves references", async () => {
		const user = userEvent.setup();
		mount(base);
		const key = document.getElementById("wz-trim-0-key") as HTMLInputElement;
		key.closest("details")?.setAttribute("open", "");
		await user.clear(key);
		await user.type(key, "scene-a");
		expect(key).toHaveFocus();
		expect(key).toHaveValue("scene-a");
		fireEvent.blur(key);
		expect(stateNow().videos[0]?.extras?.source).toBe("scene-a");
		expect(
			stateNow().sources?.audioMixStreams?.[0]?.audioMixChannels[0]?.sourceKey,
		).toBe("scene-a");
		expect(
			stateNow().sources?.concatenationStreams?.[0]?.sources[0]?.sourceKey,
		).toBe("scene-a");
	});
	it("renames a concatenation source while preserving rendition references", async () => {
		const user = userEvent.setup();
		mount({
			...base,
			videos: [
				{ height: 720, bitrate: 1000000, extras: { source: "concat1" } },
			],
		});
		const key = document.getElementById("wz-concat-0-key") as HTMLInputElement;
		key.closest("details")?.setAttribute("open", "");
		await user.clear(key);
		await user.type(key, "joined-scenes");
		fireEvent.blur(key);
		expect(stateNow().sources?.concatenationStreams?.[0]?.key).toBe(
			"joined-scenes",
		);
		expect(stateNow().videos[0]?.extras?.source).toBe("joined-scenes");
	});
	it("renames filter definitions without detaching their consumers", () => {
		mount(base, true);
		const key = document.getElementById("wz-flt-0-key") as HTMLInputElement;
		fireEvent.change(key, { target: { value: "custom" } });
		fireEvent.blur(key);
		expect(stateNow().videos[0]?.extras?.filters?.[0]?.filterKey).toBe(
			"custom",
		);
	});
	it("shows missing sources and filters instead of claiming the implicit/default selection", () => {
		mount({ ...base, sources: {}, filters: [] }, true);
		expect(document.getElementById("wz-v-0-x-source")).toHaveValue("trim1");
		expect(document.getElementById("wz-v-0-x-flt-0")).toHaveValue("deint1");
	});
	it("keeps trim and concat encoding assignments consistent with partition renames and removal", () => {
		const state = {
			...base,
			sources: {
				...base.sources,
				trimmingStreams: base.sources?.trimmingStreams?.map((row) => ({
					...row,
					encodingKey: "enc1",
				})),
				concatenationStreams: base.sources?.concatenationStreams?.map(
					(row) => ({ ...row, encodingKey: "enc1" }),
				),
			},
		};
		for (const to of ["renamed", undefined]) {
			const patch = remapEncodingKeyRefs(state, "enc1", to);
			expect(patch.sources?.trimmingStreams?.[0]?.encodingKey).toBe(to);
			expect(patch.sources?.concatenationStreams?.[0]?.encodingKey).toBe(to);
		}
	});
	it("new streams use the imported primary file key", () => {
		mount({
			...base,
			inputFiles: [
				{
					key: "imported-main",
					inputKey: "main",
					kind: "S3",
					credentialId: "",
					bucket: "",
					path: "",
				},
			],
		});
		fireEvent.click(screen.getByText("Add ingest track"));
		expect(stateNow().sources?.tracks?.[0]?.inputFile).toBe("imported-main");
	});
});

it("new resource keys avoid existing keys after deletion", () => {
	const { unmount } = mount({
		...base,
		sources: { encodings: [{ key: "enc2", name: "encoding 2" }] },
	});
	fireEvent.click(screen.getByText("Add encoding"));
	const encodings = stateNow().sources?.encodings ?? [];
	expect(new Set(encodings.map((row) => row.key)).size).toBe(2);
	unmount();
	mount({ ...base, filters: [{ key: "deint2" }] }, true);
	fireEvent.click(screen.getByText("Add filter"));
	const filters = stateNow().filters ?? [];
	expect(new Set(filters.map((row) => row.key)).size).toBe(2);
});
it("missing separate audio and subtitle files remain visibly selected", () => {
	const { unmount } = mount({ ...base, audioInputFile: "removed" });
	expect(document.getElementById("wz-implicit-audio")).toHaveValue("removed");
	unmount();
	mount({ ...base, subtitles: [{ source: "removed" }] }, true);
	expect(document.getElementById("wz-s-0-src")).toHaveValue("removed");
});
it("duplicate target names do not rewrite references to another resource", () => {
	mount({
		...base,
		sources: {
			...base.sources,
			trimmingStreams: [
				...(base.sources?.trimmingStreams ?? []),
				{ key: "existing", kind: "TIME_BASED", sourceKey: "video" },
			],
		},
	});
	const key = document.getElementById("wz-trim-0-key") as HTMLInputElement;
	fireEvent.change(key, { target: { value: "existing" } });
	fireEvent.blur(key);
	expect(stateNow().videos[0]?.extras?.source).toBe("trim1");
});

it("type changes rename default filter keys without breaking attached renditions", () => {
	mount(
		{
			...base,
			filters: [{ key: "crop", kind: "CROP", left: 0 }],
			videos: [
				{
					height: 720,
					bitrate: 1000000,
					extras: { filters: [{ filterKey: "crop", position: 3 }] },
				},
			],
		},
		true,
	);
	fireEvent.change(screen.getByLabelText("Filter type"), {
		target: { value: "ROTATE" },
	});
	expect(screen.getByLabelText("Filter key")).toHaveValue("rotate");
	expect(stateNow().videos[0]?.extras?.filters).toEqual([
		{ filterKey: "rotate", position: 3 },
	]);
	fireEvent.change(screen.getByLabelText("Filter type"), {
		target: { value: "TEXT" },
	});
	expect(screen.getByLabelText("Filter key")).toHaveValue("text");
	expect(stateNow().videos[0]?.extras?.filters?.[0]?.filterKey).toBe("text");
});

it("allocates a free type-based key and preserves manually named keys across remounts", () => {
	const view = mount(
		{
			...base,
			filters: [
				{ key: "deint1" },
				{ key: "crop", kind: "CROP", left: 0 },
				{ key: "crop2", kind: "CROP", left: 0 },
			],
		},
		true,
	);
	fireEvent.change(
		screen.getByLabelText("Filter type", { selector: "#wz-flt-0-kind" }),
		{
			target: { value: "CROP" },
		},
	);
	expect(screen.getAllByLabelText("Filter key")[0]).toHaveValue("crop3");
	const key = screen.getByLabelText("Filter key", {
		selector: "#wz-flt-0-key",
	});
	// A deliberate type-looking name remains manual, even after leaving Ladder.
	fireEvent.change(key, { target: { value: "crop9" } });
	fireEvent.blur(key);
	const saved = stateNow();
	view.unmount();
	mount(saved, true);
	fireEvent.change(
		screen.getByLabelText("Filter type", { selector: "#wz-flt-0-kind" }),
		{
			target: { value: "TEXT" },
		},
	);
	expect(screen.getAllByLabelText("Filter key")[0]).toHaveValue("crop9");
	expect(stateNow().videos[0]?.extras?.filters?.[0]?.filterKey).toBe("crop9");
});

it("keeps a copied descriptive filter key when the type changes", () => {
	mount(
		{
			...base,
			filters: [
				{ key: "title-overlay", kind: "TEXT", text: "Title", x: "0", y: "0" },
			],
		},
		true,
	);
	fireEvent.change(screen.getByLabelText("Filter type"), {
		target: { value: "WATERMARK" },
	});
	expect(screen.getByLabelText("Filter key")).toHaveValue("title-overlay");
});
