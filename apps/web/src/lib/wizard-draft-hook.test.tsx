import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_WIZARD_STATE } from "@/app/vod/new/build-plan";
import { draftKey, readWizardDraft, writeWizardDraft } from "./wizard-draft";

const { session } = vi.hoisted(() => ({
	session: {
		status: "success",
		isFetching: false,
		isFetchedAfterMount: true,
		data: {
			mode: "users",
			configured: true,
			authenticated: true,
			loginKind: "password-form",
			role: "OPERATOR",
			effectiveUserId: "user",
			organizationId: "org",
			isImpersonating: false,
		},
	},
}));
vi.mock("./auth/use-session", () => ({ useSession: () => session }));

import { useWizardDraft } from "./wizard-draft-hook";

const key = draftKey(["org", "user"], "vod", "new");
const value = { ...DEFAULT_WIZARD_STATE, name: "current" };
beforeEach(() => {
	localStorage.clear();
	vi.useFakeTimers();
	session.status = "success";
	session.isFetching = false;
	session.isFetchedAfterMount = true;
	session.data.effectiveUserId = "user";
	session.data.isImpersonating = false;
});
afterEach(() => vi.useRealTimers());
it("offers manual restoration without replacing a saved draft with fresh defaults", () => {
	writeWizardDraft(key, "vod", value, 4);
	const restore = vi.fn();
	const hook = renderHook(() =>
		useWizardDraft({
			kind: "vod",
			context: "new",
			value: DEFAULT_WIZARD_STATE,
			step: 0,
			onRestore: restore,
		}),
	);
	expect(hook.result.current.available).toBe(true);
	act(() => vi.advanceTimersByTime(2000));
	expect(readWizardDraft(key, "vod")?.value.name).toBe("current");
	expect(restore).not.toHaveBeenCalled();
	act(() => hook.result.current.restore());
	expect(restore).toHaveBeenCalledWith(
		expect.objectContaining({
			step: 4,
			value: expect.objectContaining({ name: "current" }),
		}),
	);
});
it("debounces edited fields, retains a failed submission and cancels pending saves on success", () => {
	const hook = renderHook(
		({ value }) =>
			useWizardDraft({
				kind: "vod",
				context: "new",
				value,
				step: 1,
				onRestore: vi.fn(),
			}),
		{ initialProps: { value: DEFAULT_WIZARD_STATE } },
	);
	act(() => hook.rerender({ value }));
	act(() => vi.advanceTimersByTime(299));
	expect(localStorage.getItem(key)).toBeNull();
	act(() => vi.advanceTimersByTime(1));
	expect(readWizardDraft(key, "vod")?.value.name).toBe("current");
	// A failed submit leaves the same draft; only the caller's success clears it.
	act(() => hook.rerender({ value: { ...value, name: "pending" } }));
	act(() => hook.result.current.afterSubmission()?.());
	act(() => vi.advanceTimersByTime(1000));
	expect(localStorage.getItem(key)).toBeNull();
});
it.each([
	"error",
	"fetching",
	"cached",
	"view-as",
	"identity",
])("cannot restore or save after session becomes %s", (mode) => {
	writeWizardDraft(key, "vod", value, 2);
	const restore = vi.fn();
	const hook = renderHook(() =>
		useWizardDraft({
			kind: "vod",
			context: "new",
			value: DEFAULT_WIZARD_STATE,
			step: 0,
			onRestore: restore,
		}),
	);
	if (mode === "error") session.status = "error";
	if (mode === "fetching") session.isFetching = true;
	if (mode === "cached") session.isFetchedAfterMount = false;
	if (mode === "view-as") session.data.isImpersonating = true;
	if (mode === "identity") session.data.effectiveUserId = "another";
	act(() => hook.rerender());
	expect(hook.result.current.available).toBe(false);
	act(() => hook.result.current.restore());
	act(() => vi.advanceTimersByTime(1000));
	expect(restore).not.toHaveBeenCalled();
	expect(readWizardDraft(key, "vod")?.value.name).toBe("current");
	expect(
		localStorage.getItem(draftKey(["org", "another"], "vod", "new")),
	).toBeNull();
});
it("never offers revision A under a freshly applied revision B", () => {
	writeWizardDraft(
		draftKey(["org", "user"], "vod", "edit:a:A"),
		"vod",
		value,
		2,
	);
	const hook = renderHook(() =>
		useWizardDraft({
			kind: "vod",
			context: "edit:a:B",
			value: DEFAULT_WIZARD_STATE,
			step: 0,
			onRestore: vi.fn(),
		}),
	);
	expect(hook.result.current.available).toBe(false);
});
it("clears its bound draft when success occurs during session refresh, without recreating it", () => {
	const hook = renderHook(
		({ value }) =>
			useWizardDraft({
				kind: "vod",
				context: "new",
				value,
				step: 0,
				onRestore: vi.fn(),
			}),
		{ initialProps: { value: DEFAULT_WIZARD_STATE } },
	);
	act(() => hook.rerender({ value }));
	act(() => vi.advanceTimersByTime(300));
	expect(localStorage.getItem(key)).not.toBeNull();
	act(() => hook.rerender({ value: { ...value, name: "pending" } }));
	session.isFetching = true;
	act(() => hook.rerender({ value }));
	act(() => hook.result.current.afterSubmission()?.());
	hook.unmount();
	act(() => vi.advanceTimersByTime(1000));
	expect(localStorage.getItem(key)).toBeNull();
});
it("does not touch storage while a query import or source is pending", () => {
	writeWizardDraft(key, "vod", value, 2);
	const get = vi.spyOn(Storage.prototype, "getItem");
	const hook = renderHook(() =>
		useWizardDraft({
			kind: "vod",
			context: null,
			value,
			step: 0,
			onRestore: vi.fn(),
		}),
	);
	expect(hook.result.current.available).toBe(false);
	act(() => vi.advanceTimersByTime(1000));
	expect(get).not.toHaveBeenCalled();
	get.mockRestore();
});

it.each([
	"vod",
	"live",
] as const)("preserves original %s settings after metadata restore and reload while the new form autosaves", (kind) => {
	const key = draftKey(["org", "user"], kind, "new");
	const original = {
		name: "Old title",
		audios: [{ bitrate: 64000 }],
		output: { basePath: "edited-folder/" },
	};
	const raw = JSON.stringify({
		kind,
		version: kind === "vod" ? 1 : 2,
		step: 2,
		savedAt: Date.now(),
		value: original,
	});
	localStorage.setItem(key, raw);
	const restore = vi.fn();
	const mount = () =>
		renderHook(
			({ form }) =>
				useWizardDraft({
					kind,
					context: "new",
					value: form,
					step: 1,
					onRestore: restore,
				}),
			{ initialProps: { form: value } },
		);
	const first = mount();
	act(() => first.result.current.restore(true));
	expect(first.result.current.retained?.value.output).toEqual(original.output);
	act(() => first.rerender({ form: { ...value, name: "After restore" } }));
	act(() => vi.advanceTimersByTime(301));
	expect(localStorage.getItem(key)).toBe(raw);
	first.unmount();
	const second = mount();
	expect(second.result.current.pending?.value.name).toBe("After restore");
	expect(second.result.current.retained?.value.output).toEqual(original.output);
	act(() => second.result.current.discard());
	act(() => vi.advanceTimersByTime(400));
	expect(localStorage.getItem(`${key}:working`)).toBeNull();
	expect(readWizardDraft(key, kind)?.value.output).toEqual(original.output);
	session.data.effectiveUserId = "someone-else";
	act(() => second.rerender({ form: value }));
	expect(second.result.current.retained).toBeNull();
});

it("autosaves edits entered while a previous draft offer is pending if the operator discards the offer", () => {
	writeWizardDraft(key, "vod", { ...value, name: "previous" }, 2);
	const hook = renderHook(
		({ form }) =>
			useWizardDraft({
				kind: "vod",
				value: form,
				context: "new",
				step: 1,
				onRestore: vi.fn(),
			}),
		{ initialProps: { form: value } },
	);
	const newer = { ...value, name: "typed before discard" };
	act(() => hook.rerender({ form: newer }));
	act(() => hook.result.current.discard());
	act(() => vi.advanceTimersByTime(301));
	expect(readWizardDraft(key, "vod")?.value.name).toBe(newer.name);
});

function openLegacyDraftTabs() {
	const original = { name: "Old title", output: { basePath: "edited/" } };
	localStorage.setItem(
		key,
		JSON.stringify({
			version: 1,
			kind: "vod",
			step: 2,
			savedAt: Date.now(),
			value: original,
		}),
	);
	const mount = () =>
		renderHook(
			({ form }) =>
				useWizardDraft({
					kind: "vod",
					value: form,
					context: "new",
					step: 1,
					onRestore: vi.fn(),
				}),
			{ initialProps: { form: value } },
		);
	return { older: mount(), newer: mount(), reopen: mount };
}

it("resumes the last saved work across two tabs and keeps it when the older tab submits", () => {
	const { older, newer, reopen: mount } = openLegacyDraftTabs();
	act(() => older.result.current.restore(true));
	act(() =>
		older.rerender({ form: { ...value, name: "Older recovered job" } }),
	);
	act(() => vi.advanceTimersByTime(301));
	act(() => newer.result.current.discard());
	act(() => newer.rerender({ form: { ...value, name: "Newer job" } }));
	act(() => vi.advanceTimersByTime(301));
	const reopened = mount();
	expect(reopened.result.current.pending?.value.name).toBe("Newer job");
	act(() => older.result.current.afterSubmission()?.());
	const afterSubmit = mount();
	expect(afterSubmit.result.current.pending?.value.name).toBe("Newer job");
});

it("keeps a newer saved edit when another tab accepts a stale metadata offer", () => {
	const { older, newer, reopen } = openLegacyDraftTabs();
	act(() => newer.result.current.discard());
	act(() =>
		newer.rerender({ form: { ...value, name: "New bitrate settings" } }),
	);
	act(() => vi.advanceTimersByTime(301));
	act(() => older.result.current.restore(true));
	act(() => vi.advanceTimersByTime(301));
	expect(reopen().result.current.pending?.value.name).toBe(
		"New bitrate settings",
	);
	expect(older.result.current.pending?.value.name).toBe("New bitrate settings");
});

it("clears the submitted working draft when a second tab already discarded the original", () => {
	const { older, newer, reopen } = openLegacyDraftTabs();
	act(() => newer.result.current.discard());
	act(() => older.result.current.restore(true));
	act(() => older.rerender({ form: { ...value, name: "Completed form" } }));
	act(() => vi.advanceTimersByTime(301));
	expect(readWizardDraft(`${key}:working`, "vod")?.value.name).toBe(
		"Completed form",
	);
	act(() => older.result.current.afterSubmission()?.());
	expect(reopen().result.current.available).toBe(false);
});

it("keeps another tab's offered form when the operator submits without restoring it", () => {
	const { older, newer, reopen } = openLegacyDraftTabs();
	act(() => newer.result.current.discard());
	act(() =>
		newer.rerender({ form: { ...value, name: "Other operator window" } }),
	);
	act(() => vi.advanceTimersByTime(301));
	act(() => older.result.current.restore(true));
	expect(older.result.current.pending?.value.name).toBe(
		"Other operator window",
	);
	act(() => older.result.current.afterSubmission()?.());
	expect(reopen().result.current.pending?.value.name).toBe(
		"Other operator window",
	);
});

it("saves the first edit after another tab discards the active form's previous save", () => {
	writeWizardDraft(key, "vod", value, 1);
	const mount = () =>
		renderHook(
			({ form }) =>
				useWizardDraft({
					kind: "vod",
					context: "new",
					value: form,
					step: 1,
					onRestore: vi.fn(),
				}),
			{ initialProps: { form: value } },
		);
	const active = mount();
	act(() => active.result.current.restore());
	const discarding = mount();
	act(() => discarding.result.current.discard());
	expect(readWizardDraft(key, "vod")).toBeNull();
	act(() =>
		active.rerender({ form: { ...value, name: "First edit after discard" } }),
	);
	act(() => vi.advanceTimersByTime(301));
	expect(readWizardDraft(key, "vod")?.value.name).toBe(
		"First edit after discard",
	);
});

it("serializes a submitted removal and the sibling tab's delayed edit under the original scope key", () => {
	const { older, newer } = openLegacyDraftTabs();
	act(() => older.result.current.restore(true));
	act(() => vi.advanceTimersByTime(301));
	act(() => newer.result.current.discard());
	const waiting: (() => void)[] = [];
	const request = vi.spyOn(navigator.locks, "request").mockImplementation(((
		scope: string,
		callback: () => void,
	) => {
		expect(scope).toBe(key);
		waiting.push(callback);
		return Promise.resolve();
	}) as LockManager["request"]);
	try {
		act(() => older.result.current.afterSubmission()?.());
		act(() => newer.rerender({ form: { ...value, name: "Sibling edit" } }));
		act(() => vi.advanceTimersByTime(301));
		expect(waiting).toHaveLength(2);
		expect(readWizardDraft(`${key}:working`, "vod")).not.toBeNull();
		act(() => waiting[0]?.());
		expect(readWizardDraft(`${key}:working`, "vod")).toBeNull();
		act(() => waiting[1]?.());
		expect(readWizardDraft(`${key}:working`, "vod")?.value.name).toBe(
			"Sibling edit",
		);
	} finally {
		request.mockRestore();
	}
});

it("ties a successful request to the accepted snapshots at submission time", () => {
	const { older, newer, reopen } = openLegacyDraftTabs();
	const complete = older.result.current.afterSubmission();
	act(() => newer.result.current.discard());
	act(() =>
		newer.rerender({ form: { ...value, name: "Edited during submission" } }),
	);
	act(() => vi.advanceTimersByTime(301));
	act(() => older.result.current.restore(true));
	act(() => older.result.current.restore());
	act(() => complete?.());
	expect(reopen().result.current.pending?.value.name).toBe(
		"Edited during submission",
	);
});

it("clears the submitted form when its pending autosave finishes during the request", () => {
	const hook = renderHook(
		({ form }) =>
			useWizardDraft({
				kind: "vod",
				context: "new",
				value: form,
				step: 1,
				onRestore: vi.fn(),
			}),
		{ initialProps: { form: value } },
	);
	act(() => hook.rerender({ form: { ...value, name: "Just submitted" } }));
	const complete = hook.result.current.afterSubmission();
	act(() => vi.advanceTimersByTime(301));
	expect(readWizardDraft(key, "vod")?.value.name).toBe("Just submitted");
	act(() => complete?.());
	expect(readWizardDraft(key, "vod")).toBeNull();
});

it("ignores a queued discard from an offer replaced by an earlier queued restore", () => {
	writeWizardDraft(key, "vod", value, 0);
	const mount = () =>
		renderHook(
			({ form }) =>
				useWizardDraft({
					kind: "vod",
					context: "new",
					value: form,
					step: 0,
					onRestore: vi.fn(),
				}),
			{ initialProps: { form: value } },
		);
	const a = mount(),
		b = mount();
	act(() => b.result.current.restore());
	act(() => b.rerender({ form: { ...value, name: "Saved elsewhere" } }));
	act(() => vi.advanceTimersByTime(301));
	const waiting: (() => void)[] = [];
	const request = vi.spyOn(navigator.locks, "request").mockImplementation(((
		_slot: string,
		callback: () => void,
	) => {
		waiting.push(callback);
		return Promise.resolve();
	}) as LockManager["request"]);
	try {
		act(() => a.result.current.restore());
		act(() => a.result.current.discard());
		expect(waiting).toHaveLength(2);
		act(() => waiting[0]?.());
		act(() => waiting[1]?.());
		expect(readWizardDraft(key, "vod")?.value.name).toBe("Saved elsewhere");
		expect(a.result.current.pending?.value.name).toBe("Saved elsewhere");
	} finally {
		request.mockRestore();
	}
});
