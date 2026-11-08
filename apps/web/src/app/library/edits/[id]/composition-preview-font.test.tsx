import { compileComposition, toCompositionDocument } from "@bitovp/core";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import { CompositionPreview } from "./composition-preview";

const construct = vi.fn(),
	add = vi.fn(),
	remove = vi.fn();
const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const bytes = new Uint8Array([79, 84, 84, 79, 1, 2, 3, 4]);
let fontDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
	construct.mockReset();
	add.mockReset();
	remove.mockReset();
	fontDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
	Object.defineProperty(document, "fonts", {
		configurable: true,
		value: { add, delete: remove },
	});
	vi.stubGlobal(
		"FontFace",
		class {
			constructor(family: string, source: string | ArrayBuffer) {
				construct(family, source);
			}
			async load() {
				return this;
			}
		},
	);
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.resetModules();
	if (fontDescriptor) Object.defineProperty(document, "fonts", fontDescriptor);
	else Reflect.deleteProperty(document, "fonts");
});
function preview() {
	const project = editingProjectFixture(),
		draft = toCompositionDocument(project.draft);
	draft.clips = draft.clips.map((clip) => ({
		...clip,
		audio: { mode: "MUTE" },
	}));
	if (!project.media.timeMap) throw new Error("Missing time map");
	const plan = compileComposition(draft, [
		{
			mediaVersionId: project.media.id,
			timeMap: project.media.timeMap,
			width: 1920,
			height: 1080,
			hasAudio: true,
		},
	]);
	return renderLocalized(
		<CompositionPreview
			plan={plan}
			media={[project.media]}
			imageAssets={[]}
			frame={0}
			onFrame={() => {}}
		/>,
	);
}
it("loads font bytes through the document-bound browser fetch before constructing FontFace", async () => {
	const original = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes));
	vi.stubGlobal("fetch", original);
	const { installTenantFetch } = await import("@/lib/tenant-fetch");
	installTenantFetch(org);
	const view = preview();
	await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
	expect(original).toHaveBeenCalledTimes(1);
	expect(original.mock.calls[0]?.[0]).toBe("/api/library/editing-font");
	expect(
		new Headers(original.mock.calls[0]?.[1]?.headers).get(
			"x-bitovp-expected-org",
		),
	).toBe(org);
	expect(construct.mock.calls[0]?.[0]).toBe("BitOVPEditing");
	expect(construct.mock.calls[0]?.[1]).toBeInstanceOf(ArrayBuffer);
	expect(new Uint8Array(construct.mock.calls[0]?.[1])).toEqual(bytes);
	view.unmount();
	expect(remove).toHaveBeenCalledWith(add.mock.calls[0]?.[0]);
});
it("does not install a font rejected by the organization guard", async () => {
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValue(new Response("Organization changed", { status: 409 })),
	);
	preview();
	await screen.findByText(
		"Caption font is unavailable. The export uses the managed Japanese font.",
	);
	expect(construct).not.toHaveBeenCalled();
	expect(add).not.toHaveBeenCalled();
});
it("aborts an unfinished font request and never installs it after unmount", async () => {
	let finish: (response: Response) => void = () => {};
	const original = vi.fn<typeof fetch>().mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	vi.stubGlobal("fetch", original);
	const view = preview();
	await waitFor(() => expect(original).toHaveBeenCalledTimes(1));
	const signal = original.mock.calls[0]?.[1]?.signal;
	view.unmount();
	expect(signal?.aborted).toBe(true);
	finish(new Response(bytes));
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(add).not.toHaveBeenCalled();
});
