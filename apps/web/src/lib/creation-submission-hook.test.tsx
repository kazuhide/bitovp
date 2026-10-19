import { webcrypto } from "node:crypto";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { useCreationSubmission } from "./creation-submission-hook";
import { LocaleProvider } from "./i18n/context";

const { send, session } = vi.hoisted(() => ({
	send: vi.fn(),
	session: { current: {} as Record<string, unknown> },
}));
vi.mock("./api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => send(...args),
}));
vi.mock("./auth/use-session", () => ({ useSession: () => session.current }));
const wrapper = ({ children }: { children: ReactNode }) => (
	<LocaleProvider locale="en">{children}</LocaleProvider>
);
const trusted = () => ({
	status: "success",
	isFetchedAfterMount: true,
	isFetching: false,
	data: {
		configured: true,
		authenticated: true,
		mode: "users",
		organizationId: "org",
		effectiveUserId: "user",
		role: "OPERATOR",
	},
});
beforeEach(() => {
	vi.stubGlobal("crypto", webcrypto);
	vi.clearAllMocks();
	sessionStorage.clear();
	session.current = trusted();
	send.mockResolvedValue({ id: "created" });
});

it.each([
	{ status: "error" },
	{ isFetching: true },
	{ isFetchedAfterMount: false },
	{ data: { ...trusted().data, isImpersonating: true } },
	{ data: { ...trusted().data, role: "VIEWER" } },
	{ data: { ...trusted().data, organizationUnavailable: true } },
])("refuses unconfirmed or unauthorized identity %j", async (change) => {
	session.current = { ...trusted(), ...change };
	const view = renderHook(() => useCreationSubmission("vod", "wizard"), {
		wrapper,
	});
	await expect(view.result.current.submit({ plan: {} })).rejects.toThrow(
		"session could not be confirmed",
	);
	expect(send).not.toHaveBeenCalled();
	expect(sessionStorage.length).toBe(0);
});

it("never migrates a mounted form to another organization or user", async () => {
	const view = renderHook(() => useCreationSubmission("vod", "wizard"), {
		wrapper,
	});
	session.current = {
		...trusted(),
		data: { ...trusted().data, effectiveUserId: "other" },
	};
	view.rerender();
	await expect(view.result.current.submit({ plan: {} })).rejects.toThrow(
		"session could not be confirmed",
	);
	expect(send).not.toHaveBeenCalled();
});

it("rechecks the mounted identity after hashing and before posting", async () => {
	let resume!: () => void;
	let first = true;
	vi.stubGlobal("crypto", {
		randomUUID: () => webcrypto.randomUUID(),
		subtle: {
			digest: async (algorithm: string, data: Uint8Array) => {
				if (first) {
					first = false;
					await new Promise<void>((resolve) => {
						resume = resolve;
					});
				}
				return webcrypto.subtle.digest(algorithm, data);
			},
		},
	});
	const view = renderHook(() => useCreationSubmission("vod", "wizard"), {
		wrapper,
	});
	const pending = view.result.current.submit({ plan: {} });
	session.current = {
		...trusted(),
		data: { ...trusted().data, organizationId: "other" },
	};
	view.rerender();
	await act(async () => resume());
	await expect(pending).rejects.toThrow("session could not be confirmed");
	expect(send).not.toHaveBeenCalled();
});
