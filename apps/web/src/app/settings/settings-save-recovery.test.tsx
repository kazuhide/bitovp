import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { BitmovinClient } from "./bitmovin/bitmovin-client";
import { CredentialsClient } from "./credentials/credentials-client";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));
vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(),
}));
const apiFetch = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("./credentials/credential-form", () => ({
	CredentialForm: ({ onSubmit }: { onSubmit: (body: unknown) => void }) => (
		<button type="button" onClick={() => onSubmit({ label: "Origin" })}>
			Submit credential
		</button>
	),
}));
vi.mock("./bitmovin/bitmovin-form", () => ({
	BitmovinForm: ({ onSubmit }: { onSubmit: (body: unknown) => void }) => (
		<button type="button" onClick={() => onSubmit({ label: "Account" })}>
			Submit account
		</button>
	),
}));
beforeEach(() => apiFetch.mockReset());

it.each([
	["credential", CredentialsClient, "Add credential"],
	["account", BitmovinClient, "Add account"],
] as const)("keeps a failed %s save visible inside the open dialog and permits retry", async (kind, Component, addLabel) => {
	let fail = true;
	apiFetch.mockImplementation((_url: string, init?: RequestInit) =>
		init?.method
			? fail
				? Promise.reject(new Error("offline"))
				: Promise.resolve({})
			: Promise.resolve([]),
	);
	renderWithQuery(<Component />);
	await userEvent.click(await screen.findByRole("button", { name: addLabel }));
	const dialog = screen.getByRole("dialog");
	await userEvent.click(
		within(dialog).getByRole("button", { name: `Submit ${kind}` }),
	);
	expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
	fail = false;
	await userEvent.click(
		within(dialog).getByRole("button", { name: `Submit ${kind}` }),
	);
	expect(
		await screen.findByRole("button", { name: addLabel }),
	).toBeInTheDocument();
});
