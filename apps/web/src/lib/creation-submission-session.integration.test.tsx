import { webcrypto } from "node:crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PageAccessGate } from "@/components/page-access-gate";
import type { SessionDto } from "./auth/dto";
import { SESSION_QUERY_KEY, useSession } from "./auth/use-session";
import { useCreationSubmission } from "./creation-submission-hook";
import { LocaleProvider } from "./i18n/context";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("./api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const SESSION: SessionDto = {
	mode: "users",
	configured: true,
	authenticated: true,
	loginKind: "password-form",
	organizationId: "11111111-1111-4111-8111-111111111111",
	effectiveUserId: "22222222-2222-4222-8222-222222222222",
	role: "OPERATOR",
};
const CREATED = { id: "33333333-3333-4333-8333-333333333333" };
const clients: QueryClient[] = [];

beforeEach(() => {
	apiFetch.mockReset();
	apiFetch.mockImplementation((path: string) =>
		Promise.resolve(path === "/api/auth/session" ? SESSION : CREATED),
	);
	vi.stubGlobal("crypto", webcrypto);
	sessionStorage.clear();
});

afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function postCalls() {
	return apiFetch.mock.calls.filter(([, init]) => init?.method === "POST");
}

function sessionCalls() {
	return apiFetch.mock.calls.filter(([path]) => path === "/api/auth/session");
}

async function settled(client: QueryClient) {
	await waitFor(() => expect(client.isFetching()).toBe(0));
	// Deliver TanStack Query's queued observer notifications before submitting.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function renderCreation(kind: "vod" | "live" = "vod", copies = 1) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: 15_000, refetchOnWindowFocus: false },
		},
	});
	clients.push(client);
	let creation: ReturnType<typeof useCreationSubmission> | undefined;
	let passiveReader = false;
	function Form({ index }: { index: number }) {
		const current = useCreationSubmission(kind, `wizard:${index}`);
		if (index === 0) creation = current;
		return index === 0 ? <h1>Creation form</h1> : null;
	}
	function PassiveReader() {
		useSession();
		return null;
	}
	const tree = () => (
		<LocaleProvider locale="en">
			<QueryClientProvider client={client}>
				<PageAccessGate pathname={`/${kind}/new`}>
					{Array.from({ length: copies }, (_, index) => (
						<Form key={index} index={index} />
					))}
					{passiveReader ? <PassiveReader /> : null}
				</PageAccessGate>
			</QueryClientProvider>
		</LocaleProvider>
	);
	const view = render(tree());
	return {
		client,
		rerender() {
			view.rerender(tree());
		},
		addPassiveReader() {
			passiveReader = true;
			view.rerender(tree());
		},
		current() {
			if (!creation) throw new Error("The creation form has not mounted");
			return creation;
		},
	};
}

it.each([
	"vod",
	"live",
] as const)("submits %s after the page gate has already fetched a fresh session", async (kind) => {
	const { client, current } = renderCreation(kind);
	await screen.findByRole("heading", { name: "Creation form" });
	await settled(client);
	let result: unknown;
	let error: string | undefined;
	await act(async () => {
		try {
			result = await current().submit({ plan: {} });
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}
	});
	expect({
		result,
		error,
		posts: postCalls().map(([path]) => path),
	}).toEqual({
		result: CREATED,
		error: undefined,
		posts: [kind === "vod" ? "/api/encoding-jobs" : "/api/live-channels"],
	});
});

it("withholds submission while the form's own session confirmation is pending", async () => {
	const confirmation = deferred<SessionDto>();
	apiFetch
		.mockResolvedValueOnce(SESSION)
		.mockReturnValueOnce(confirmation.promise);
	const { client, current } = renderCreation();
	await screen.findByRole("heading", { name: "Creation form" });
	await waitFor(() => expect(sessionCalls()).toHaveLength(2));
	await expect(current().submit({ plan: {} })).rejects.toThrow(
		"session could not be confirmed",
	);
	expect(postCalls()).toEqual([]);
	expect(sessionStorage.length).toBe(0);
	await act(async () => confirmation.resolve(SESSION));
	await settled(client);
	await expect(current().submit({ plan: {} })).resolves.toEqual(CREATED);
});

it("does not submit from the gate's cached identity when confirmation fails", async () => {
	const confirmation = deferred<SessionDto>();
	apiFetch
		.mockResolvedValueOnce(SESSION)
		.mockReturnValueOnce(confirmation.promise);
	const { current } = renderCreation();
	await screen.findByRole("heading", { name: "Creation form" });
	await waitFor(() => expect(sessionCalls()).toHaveLength(2));
	const unconfirmed = current();
	await act(async () => confirmation.reject(new Error("Session unavailable")));
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Your permissions could not be confirmed",
	);
	await expect(unconfirmed.submit({ plan: {} })).rejects.toThrow(
		"session could not be confirmed",
	);
	expect(postCalls()).toEqual([]);
	expect(sessionStorage.length).toBe(0);
});

it.each([
	"organizationId",
	"effectiveUserId",
] as const)("rejects an in-flight submission after the confirmed %s changes", async (field) => {
	const { client, current } = renderCreation();
	await screen.findByRole("heading", { name: "Creation form" });
	await settled(client);
	const hashing = deferred<void>();
	const resume = deferred<void>();
	let first = true;
	vi.stubGlobal("crypto", {
		randomUUID: () => webcrypto.randomUUID(),
		subtle: {
			digest: async (...args: Parameters<typeof webcrypto.subtle.digest>) => {
				if (first) {
					first = false;
					hashing.resolve();
					await resume.promise;
				}
				return webcrypto.subtle.digest(...args);
			},
		},
	});
	const submission = current().submit({ plan: {} });
	const outcome = submission.catch((error: unknown) => error);
	await hashing.promise;
	apiFetch.mockResolvedValueOnce({
		...SESSION,
		[field]: "44444444-4444-4444-8444-444444444444",
	});
	await act(async () => {
		await client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
	});
	await settled(client);
	await expect(current().submit({ plan: {} })).rejects.toThrow(
		"session could not be confirmed",
	);
	resume.resolve();
	expect(await outcome).toMatchObject({
		message: expect.stringContaining("session could not be confirmed"),
	});
	expect(postCalls()).toEqual([]);
});

it("shares concurrent form confirmation without refetching on rerenders or passive reads", async () => {
	const confirmation = deferred<SessionDto>();
	apiFetch
		.mockResolvedValueOnce(SESSION)
		.mockReturnValueOnce(confirmation.promise);
	const { client, rerender, addPassiveReader } = renderCreation("vod", 2);
	await screen.findByRole("heading", { name: "Creation form" });
	await waitFor(() => expect(sessionCalls()).toHaveLength(2));
	await act(async () => confirmation.resolve(SESSION));
	await settled(client);
	for (let index = 0; index < 3; index++) rerender();
	addPassiveReader();
	await settled(client);
	expect(sessionCalls()).toHaveLength(2);
	expect(postCalls()).toEqual([]);
});
