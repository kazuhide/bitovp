import { webcrypto } from "node:crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { SESSION_QUERY_KEY } from "./auth/use-session";
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
vi.mock("./auth/use-session", async (original) => ({
	...(await original<Record<string, unknown>>()),
	useSession: () => session.current,
}));
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={client}>
		<LocaleProvider locale="en">{children}</LocaleProvider>
	</QueryClientProvider>
);
const trusted = () => ({
	status: "success",
	fetchStatus: "idle",
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
	client = new QueryClient();
	client.setQueryData(SESSION_QUERY_KEY, trusted().data);
	vi.stubGlobal("crypto", webcrypto);
	vi.clearAllMocks();
	sessionStorage.clear();
	session.current = trusted();
	send.mockResolvedValue({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1" });
});

it("blocks a queued creation when the live session query has paused before React re-renders", async () => {
	const view = renderHook(() => useCreationSubmission("vod", "wizard"), {
		wrapper,
	});
	const query = client
		.getQueryCache()
		.find({ queryKey: SESSION_QUERY_KEY, exact: true });
	if (!query) throw new Error("Missing session query");
	query.setState({ fetchStatus: "paused" });
	await expect(view.result.current.submit({ plan: {} })).rejects.toThrow(
		"session could not be confirmed",
	);
	expect(send).not.toHaveBeenCalled();
});

it.each([
	{ status: "error" },
	{ isFetching: true },
	{ fetchStatus: "paused" },
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

it("never exposes a previous template seed while the new scope prepares", async () => {
	const observed: { context: string; nonce: string | null }[] = [];
	const view = renderHook(
		({ context }) => {
			const creation = useCreationSubmission("vod", context, true);
			observed.push({ context, nonce: creation.seed?.nonce ?? null });
			return creation;
		},
		{ wrapper, initialProps: { context: "template:first:1" } },
	);
	await waitFor(() => expect(view.result.current.seed).not.toBeNull());
	const firstNonce = view.result.current.seed?.nonce;
	view.rerender({ context: "template:second:2" });
	expect(
		observed.find((entry) => entry.context === "template:second:2")?.nonce,
	).toBeNull();
	await waitFor(() => expect(view.result.current.seed).not.toBeNull());
	expect(view.result.current.seed?.nonce).not.toBe(firstNonce);
});

it.each([
	"vod",
	"live",
] as const)("resumes only the original %s scope after an outstanding session refresh", async (kind) => {
	const view = renderHook(
		({ context }) => useCreationSubmission(kind, context),
		{ wrapper, initialProps: { context: "first" } },
	);
	session.current = { ...trusted(), isFetching: true };
	view.rerender({ context: "first" });
	const paused = view.result.current.submit;
	await expect(paused({ plan: { name: "offline" } })).rejects.toThrow(
		"session could not be confirmed",
	);
	expect(send).not.toHaveBeenCalled();
	session.current = trusted();
	view.rerender({ context: "first" });
	await expect(paused({ plan: { name: "offline" } })).resolves.toMatchObject({
		id: expect.any(String),
	});
	send.mockClear();
	view.rerender({ context: "other" });
	await expect(paused({ plan: { name: "offline" } })).rejects.toThrow(
		"session could not be confirmed",
	);
	expect(send).not.toHaveBeenCalled();
});
