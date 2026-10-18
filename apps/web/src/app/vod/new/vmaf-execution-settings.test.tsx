import type { VmafExecution } from "@bitovp/core";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import {
	useVmafExecutionValidation,
	VmafExecutionSettings,
} from "./vmaf-execution-settings";

afterEach(() => vi.resetAllMocks());
const profiles = [
	{ id: "gcp-test", label: "GCP test", region: "asia-northeast1" },
	{ id: "aws-test", label: "AWS test", region: "us-east-1" },
];
function Harness({ initial }: { initial?: VmafExecution }) {
	const [execution, setExecution] = useState(initial);
	const { invalid } = useVmafExecutionValidation(execution, true);
	return (
		<>
			<VmafExecutionSettings execution={execution} onChange={setExecution} />
			<button type="button" disabled={invalid}>
				Start
			</button>
			<output data-testid="execution">{JSON.stringify(execution)}</output>
		</>
	);
}
function saved() {
	return JSON.parse(screen.getByTestId("execution").textContent || "null");
}
it("defaults to Local with a visible explanation when no profiles exist", async () => {
	apiFetch.mockResolvedValue({ items: [] });
	renderWithQuery(<Harness />);
	expect(screen.getByLabelText("Run on")).toHaveValue("");
	expect(
		await screen.findByText(
			"No cloud profiles configured. Measurements run locally.",
		),
	).toBeInTheDocument();
	expect(screen.queryByLabelText("Budget (USD)")).toBeNull();
	expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
});
it("requires an explicit positive budget and resets it when the target changes", async () => {
	apiFetch.mockResolvedValue({ items: profiles });
	renderWithQuery(<Harness />);
	const user = userEvent.setup();
	await screen.findByRole("option", { name: "GCP test · asia-northeast1" });
	await user.selectOptions(screen.getByLabelText("Run on"), "gcp-test");
	expect(saved()).toEqual({
		backend: "CLOUD",
		profileId: "gcp-test",
		budgetUsd: 0,
	});
	expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
	await user.type(screen.getByLabelText("Budget (USD)"), "12.5");
	expect(saved().budgetUsd).toBe(12.5);
	expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
	await user.selectOptions(screen.getByLabelText("Run on"), "aws-test");
	expect(screen.getByLabelText("Budget (USD)")).toHaveValue(null);
	expect(saved().budgetUsd).toBe(0);
	expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
	await user.selectOptions(screen.getByLabelText("Run on"), "");
	expect(saved()).toEqual({ backend: "LOCAL" });
	expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
});
it.each([
	0,
	-1,
	100001,
	Number.NaN,
])("blocks an invalid restored budget %s", async (budgetUsd) => {
	apiFetch.mockResolvedValue({ items: profiles });
	renderWithQuery(
		<Harness
			initial={{ backend: "CLOUD", profileId: "gcp-test", budgetUsd }}
		/>,
	);
	await screen.findByRole("option", { name: "GCP test · asia-northeast1" });
	expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
	fireEvent.change(screen.getByLabelText("Budget (USD)"), {
		target: { value: "10" },
	});
	expect(saved().budgetUsd).toBe(10);
	expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
});
it("preserves a cloud draft while loading, and blocks until the selected profile is available", async () => {
	let resolve!: (value: unknown) => void;
	apiFetch.mockImplementation(
		() =>
			new Promise((r) => {
				resolve = r;
			}),
	);
	const execution = {
		backend: "CLOUD",
		profileId: "gcp-test",
		budgetUsd: 12,
	} as const;
	renderWithQuery(<Harness initial={execution} />);
	expect(screen.getByLabelText("Run on")).toHaveValue("gcp-test");
	expect(saved()).toEqual(execution);
	expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
	await act(async () => resolve({ items: profiles }));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Start" })).toBeEnabled(),
	);
	expect(saved()).toEqual(execution);
});
it("preserves a removed selection and budget instead of silently returning to Local", async () => {
	apiFetch.mockResolvedValue({ items: profiles });
	const execution = {
		backend: "CLOUD",
		profileId: "gcp-test",
		budgetUsd: 12,
	} as const;
	const { client } = renderWithQuery(<Harness initial={execution} />);
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Start" })).toBeEnabled(),
	);
	act(() => client.setQueryData(["vmaf-compute-profiles"], { items: [] }));
	await screen.findByRole("alert");
	expect(screen.getByLabelText("Run on")).toHaveValue("gcp-test");
	expect(saved()).toEqual(execution);
	expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
});
it("blocks a cloud selection during refresh errors and retries without losing its budget", async () => {
	let failed = false;
	apiFetch.mockImplementation(() =>
		failed
			? Promise.reject(new Error("offline"))
			: Promise.resolve({ items: profiles }),
	);
	const execution = {
		backend: "CLOUD",
		profileId: "gcp-test",
		budgetUsd: 12,
	} as const;
	const { client } = renderWithQuery(<Harness initial={execution} />);
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Start" })).toBeEnabled(),
	);
	failed = true;
	await act(async () => {
		await client.refetchQueries({ queryKey: ["vmaf-compute-profiles"] });
	});
	await screen.findByText(
		"Cloud profiles could not be loaded. Local execution is available.",
	);
	expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
	expect(saved()).toEqual(execution);
	failed = false;
	await userEvent.click(screen.getByRole("button", { name: "Retry" }));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Start" })).toBeEnabled(),
	);
	expect(saved()).toEqual(execution);
});
it("keeps Local available during profile query errors", async () => {
	apiFetch.mockRejectedValue(new Error("offline"));
	renderWithQuery(<Harness />, "ja");
	await screen.findByRole("button", { name: "再試行" });
	expect(screen.getByLabelText("実行先")).toHaveValue("");
	expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
});
