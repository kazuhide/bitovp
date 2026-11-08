import { type CompositionDocument, toCompositionDocument } from "@bitovp/core";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { editingProjectFixture } from "../editing-fixtures";
import { useDirectCropGesture } from "./use-direct-crop-gesture";

function document(): CompositionDocument {
	return toCompositionDocument(editingProjectFixture().draft);
}

function setup() {
	const base = document();
	const committed = vi.fn();
	const pending = vi.fn();
	const apply = vi.fn((value: CompositionDocument, x: number) =>
		x === 0
			? value
			: {
					...value,
					clips: value.clips.map((clip, index) =>
						index === 0
							? { ...clip, fallbackCrop: { x, y: 0, w: 0.2, h: 1 } }
							: clip,
					),
				},
	);
	const options = {
		document: base,
		contextKey: "clip:0:actor:revision",
		disabled: false,
		apply,
		onCommit: committed,
		onPending: pending,
	};
	const view = renderHook((props) => useDirectCropGesture(props), {
		initialProps: options,
	});
	return { ...view, base, options, committed, pending, apply };
}

describe("direct crop gesture transaction", () => {
	it("shows every preview but records one edit when the pointer is released", () => {
		const view = setup();
		act(() => expect(view.result.current.begin()).toBe(true));
		act(() => view.result.current.preview(0.1));
		act(() => view.result.current.preview(0.2));
		expect(view.result.current.document.clips[0]?.fallbackCrop?.x).toBe(0.2);
		expect(view.committed).not.toHaveBeenCalled();
		act(() => view.result.current.commit(0.3));
		expect(view.committed).toHaveBeenCalledTimes(1);
		expect(view.committed.mock.calls[0]?.[0].clips[0].fallbackCrop.x).toBe(0.3);
		expect(view.result.current.active).toBe(false);
		expect(view.result.current.document).toBe(view.base);
		expect(view.pending.mock.calls).toEqual([[true], [false]]);
	});

	it("restores the base document on cancellation and ignores a delayed release", () => {
		const view = setup();
		act(() => view.result.current.begin());
		act(() => view.result.current.preview(0.2));
		act(() => view.result.current.cancel());
		act(() => view.result.current.commit(0.3));
		expect(view.result.current.document).toBe(view.base);
		expect(view.committed).not.toHaveBeenCalled();
		expect(view.pending.mock.calls).toEqual([[true], [false]]);
	});

	it.each([
		"document",
		"context",
		"permission",
	])("cancels when %s changes without recording an edit", (change) => {
		const view = setup();
		act(() => view.result.current.begin());
		act(() => view.result.current.preview(0.2));
		view.rerender({
			...view.options,
			...(change === "document"
				? { document: structuredClone(view.base) }
				: {}),
			...(change === "context" ? { contextKey: "clip:1:actor:revision" } : {}),
			...(change === "permission" ? { disabled: true } : {}),
		});
		act(() => view.result.current.commit(0.3));
		expect(view.result.current.active).toBe(false);
		expect(view.committed).not.toHaveBeenCalled();
		expect(view.pending.mock.calls.at(-1)).toEqual([false]);
	});

	it("does not create history for an unchanged gesture or allow a disabled start", () => {
		const view = setup();
		act(() => view.result.current.begin());
		act(() => view.result.current.commit(0));
		expect(view.committed).not.toHaveBeenCalled();
		view.rerender({ ...view.options, disabled: true });
		act(() => expect(view.result.current.begin()).toBe(false));
		expect(view.result.current.active).toBe(false);
	});

	it("clears the pending transaction when the editor unmounts", () => {
		const view = setup();
		act(() => view.result.current.begin());
		view.unmount();
		expect(view.pending.mock.calls).toEqual([[true], [false]]);
		expect(view.committed).not.toHaveBeenCalled();
	});
});
