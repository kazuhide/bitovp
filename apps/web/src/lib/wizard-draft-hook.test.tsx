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
	act(() => hook.result.current.clear());
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
	act(() => hook.result.current.clear());
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
