import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { renderWithQuery } from "@/test/render";
import { ErrorDefinitionsClient } from "./error-definitions-client";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const accounts = [
	{ id: A, label: "Primary" },
	{ id: B, label: "Other" },
];
const catalogue = {
	totalCount: 5,
	items: [
		{
			code: 1000,
			category: "INPUT",
			message: "Input {1} missing",
			description: "Check input path",
			retryHint: "NO_RETRY",
		},
		{
			code: 2000,
			category: "TRANSFER",
			message: "Upload failed",
			retryHint: "RETRY",
		},
		{
			code: 3000,
			category: "REGION",
			message: "Region unavailable",
			retryHint: "RETRY_IN_DIFFERENT_REGION",
		},
		{ code: 4000, message: "No recommendation" },
		{ code: 5000, message: "Future recommendation", retryHint: "FUTURE_HINT" },
	],
};
const endpoint = (id: string) =>
	`/api/encoding-error-definitions?bitmovinAccountId=${id}`;

beforeEach(() => {
	apiFetch.mockReset();
	apiFetch.mockImplementation(async (url: string) =>
		url === "/api/bitmovin-accounts" ? accounts : catalogue,
	);
});

describe("ErrorDefinitionsClient", () => {
	it("loads an account-scoped catalogue and preserves definition placeholders", async () => {
		renderWithQuery(<ErrorDefinitionsClient />);
		expect(await screen.findByText("Input {1} missing")).toBeInTheDocument();
		expect(apiFetch).toHaveBeenCalledWith(
			endpoint(A),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(screen.getByText("Check input path")).toBeInTheDocument();
		expect(screen.getByText("Retry suggested")).toBeInTheDocument();
		expect(screen.getByText("Do not retry unchanged")).toBeInTheDocument();
		expect(screen.getByText("Try another region")).toBeInTheDocument();
		expect(screen.getAllByText("No recommendation")).toHaveLength(3);
	});

	it.each([
		"1000",
		"input",
		"CHECK INPUT PATH",
	])("searches codes, categories and descriptions for %s", async (query) => {
		renderWithQuery(<ErrorDefinitionsClient />);
		await screen.findByText("Input {1} missing");
		fireEvent.change(
			screen.getByRole("searchbox", { name: "Search error definitions" }),
			{ target: { value: query } },
		);
		expect(screen.getByText("Input {1} missing")).toBeInTheDocument();
		expect(screen.queryByText("Upload failed")).not.toBeInTheDocument();
	});

	it("keeps a missing linked account explicit instead of silently switching accounts", async () => {
		renderWithQuery(
			<ErrorDefinitionsClient initialAccountId="deleted-account" />,
		);
		expect(
			await screen.findByText(
				"The linked account is unavailable. Choose an account.",
			),
		).toBeInTheDocument();
		expect(
			apiFetch.mock.calls.filter(([url]) =>
				String(url).startsWith("/api/encoding-error-definitions"),
			),
		).toHaveLength(0);
		fireEvent.change(
			screen.getByRole("combobox", { name: "Bitmovin account" }),
			{ target: { value: B } },
		);
		await screen.findByText("Upload failed");
		expect(apiFetch).toHaveBeenCalledWith(endpoint(B), expect.anything());
	});

	it("does not show the previous account catalogue while the next account is loading", async () => {
		apiFetch.mockImplementation((url: string) =>
			url === "/api/bitmovin-accounts"
				? Promise.resolve(accounts)
				: url === endpoint(A)
					? Promise.resolve(catalogue)
					: new Promise(() => {}),
		);
		renderWithQuery(<ErrorDefinitionsClient />);
		await screen.findByText("Input {1} missing");
		fireEvent.change(
			screen.getByRole("combobox", { name: "Bitmovin account" }),
			{ target: { value: B } },
		);
		expect(screen.queryByText("Input {1} missing")).not.toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(
			"Loading error definitions…",
		);
	});

	it("hides stale data after a failed refresh and allows a read-only reload", async () => {
		const { client } = renderWithQuery(<ErrorDefinitionsClient />);
		await screen.findByText("Input {1} missing");
		apiFetch.mockRejectedValue(new ApiError(502, "Upstream unavailable"));
		await act(async () => {
			await client.invalidateQueries({
				queryKey: ["encoding-error-definitions", A],
			});
		});
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not load error definitions.",
		);
		expect(screen.queryByText("Input {1} missing")).not.toBeInTheDocument();
		apiFetch.mockResolvedValue(catalogue);
		fireEvent.click(screen.getByRole("button", { name: "Reload" }));
		await screen.findByText("Input {1} missing");
	});

	it("distinguishes account setup, empty catalogue, and unmatched search", async () => {
		apiFetch.mockResolvedValueOnce([]);
		const first = renderWithQuery(<ErrorDefinitionsClient />);
		expect(
			await screen.findByRole("link", { name: "Add a Bitmovin account" }),
		).toHaveAttribute("href", "/settings/bitmovin");
		first.unmount();
		apiFetch.mockImplementation(async (url: string) =>
			url === "/api/bitmovin-accounts"
				? accounts
				: { items: [], totalCount: 0 },
		);
		const second = renderWithQuery(<ErrorDefinitionsClient />);
		expect(
			await screen.findByText("No error definitions returned."),
		).toBeInTheDocument();
		second.unmount();
		apiFetch.mockImplementation(async (url: string) =>
			url === "/api/bitmovin-accounts" ? accounts : catalogue,
		);
		renderWithQuery(<ErrorDefinitionsClient />);
		await screen.findByText("Input {1} missing");
		fireEvent.change(screen.getByRole("searchbox"), {
			target: { value: "nonexistent" },
		});
		expect(
			screen.getByText("No matching error definitions."),
		).toBeInTheDocument();
	});

	it("keeps account-fetch failures separate from an empty account list", async () => {
		apiFetch.mockRejectedValue(new Error("network failed"));
		renderWithQuery(<ErrorDefinitionsClient />);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not load accounts.",
		);
		expect(
			screen.queryByRole("link", { name: "Add a Bitmovin account" }),
		).not.toBeInTheDocument();
	});

	it("uses the linked account and Japanese labels without changing provider text", async () => {
		renderWithQuery(<ErrorDefinitionsClient initialAccountId={B} />, "ja");
		await screen.findByText("Input {1} missing");
		expect(
			screen.getByRole("heading", { name: "エラー定義" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("別リージョンでの再試行を推奨"),
		).toBeInTheDocument();
		await waitFor(() =>
			expect(apiFetch).toHaveBeenCalledWith(endpoint(B), expect.anything()),
		);
	});

	it("searches across the full catalogue and resets pagination for a new search", async () => {
		const items = Array.from({ length: 60 }, (_, i) => ({
			code: i + 1,
			message: `Definition ${i + 1}`,
		}));
		apiFetch.mockImplementation(async (url: string) =>
			url === "/api/bitmovin-accounts" ? accounts : { items, totalCount: 60 },
		);
		renderWithQuery(<ErrorDefinitionsClient />);
		await screen.findByText("Definition 1");
		expect(screen.queryByText("Definition 60")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		expect(screen.getByText("Definition 60")).toBeInTheDocument();
		fireEvent.change(screen.getByRole("searchbox"), {
			target: { value: "Definition 1" },
		});
		expect(screen.getByText("Definition 1")).toBeInTheDocument();
		expect(
			screen.queryByRole("navigation", { name: "Error definitions pages" }),
		).not.toBeInTheDocument();
	});
});
