import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { renderLocalized } from "@/test/render";
import {
	editingIds,
	editingProjectFixture,
} from "../../edits/editing-fixtures";
import { AutoPortraitForm } from "./auto-portrait-form";
import type { EditingEligibility } from "./editing-forms";

const apiFetch = vi.fn();
const push = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const analysisId = "77777777-7777-4777-8777-777777777777";
function eligibility(): EditingEligibility {
	return {
		sourceId: editingIds.source,
		files: [],
		mediaVersions: [editingProjectFixture().media],
		analyses: [{ id: analysisId, locale: "en", title: "Interview analysis" }],
	};
}
function form(data = eligibility(), disabled = false) {
	return (
		<AutoPortraitForm
			contentId={editingIds.content}
			initialTitle="Interview"
			eligibility={data}
			disabled={disabled}
		/>
	);
}
beforeEach(() => {
	apiFetch.mockReset();
	push.mockReset();
});

it("offers only the three required inputs, defaults to 30 seconds and navigates to the real result", async () => {
	apiFetch.mockResolvedValue({ projectId: editingIds.project });
	renderLocalized(form());
	expect(screen.getAllByRole("combobox")).toHaveLength(2);
	expect(screen.getByLabelText("Desired length (seconds)")).toHaveValue(30);
	expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
	fireEvent.click(
		screen.getByRole("button", { name: "Generate portrait video" }),
	);
	await waitFor(() =>
		expect(push).toHaveBeenCalledWith(
			`/library/edits/${editingIds.project}/result`,
		),
	);
	expect(apiFetch).toHaveBeenCalledTimes(1);
	expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/library/portrait-generations");
	expect(JSON.parse(String(apiFetch.mock.calls[0]?.[1]?.body))).toEqual({
		contentId: editingIds.content,
		mediaVersionId: editingIds.media,
		analysisRevisionId: analysisId,
		targetDurationFrames: 900,
		requestKey: expect.stringMatching(/^[a-f0-9-]{36}$/),
	});
});

it("blocks synchronous double submissions until navigation", async () => {
	let resolve!: (value: unknown) => void;
	apiFetch.mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	renderLocalized(form());
	const button = screen.getByRole("button", {
		name: "Generate portrait video",
	});
	act(() => {
		fireEvent.click(button);
		fireEvent.click(button);
	});
	expect(apiFetch).toHaveBeenCalledTimes(1);
	await act(async () => resolve({ projectId: editingIds.project }));
	expect(
		screen.getByRole("button", { name: "Starting generation…" }),
	).toBeDisabled();
});

it("retains an unknown request key for retry and starts a new request after input changes", async () => {
	apiFetch.mockRejectedValue(new TypeError("network detail must not appear"));
	renderLocalized(form());
	const generate = () =>
		fireEvent.click(
			screen.getByRole("button", { name: "Generate portrait video" }),
		);
	generate();
	await screen.findByRole("alert");
	generate();
	await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "Generate portrait video" }),
		).toBeEnabled(),
	);
	fireEvent.click(screen.getByRole("button", { name: "30 s" }));
	generate();
	await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "Generate portrait video" }),
		).toBeEnabled(),
	);
	fireEvent.click(screen.getByRole("button", { name: "15 s" }));
	generate();
	await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(4));
	const bodies = apiFetch.mock.calls.map(([, init]) =>
		JSON.parse(String(init.body)),
	);
	expect(bodies[1].requestKey).toBe(bodies[0].requestKey);
	expect(bodies[2].requestKey).toBe(bodies[1].requestKey);
	expect(bodies[3].requestKey).not.toBe(bodies[2].requestKey);
	expect(bodies[3].targetDurationFrames).toBe(450);
	expect(screen.queryByText(/network detail/)).not.toBeInTheDocument();
});

it("does not navigate after leaving the form while the request is pending", async () => {
	let resolve!: (value: unknown) => void;
	apiFetch.mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	const view = renderLocalized(form());
	fireEvent.click(
		screen.getByRole("button", { name: "Generate portrait video" }),
	);
	view.unmount();
	await act(async () => resolve({ projectId: editingIds.project }));
	expect(push).not.toHaveBeenCalled();
});

it.each([
	"",
	"0",
	"181",
	"1.01",
	"NaN",
])("rejects an invalid duration %s without posting", (value) => {
	renderLocalized(form());
	fireEvent.change(screen.getByLabelText("Desired length (seconds)"), {
		target: { value },
	});
	expect(
		screen.getByRole("button", { name: "Generate portrait video" }),
	).toBeDisabled();
	expect(screen.getByRole("alert")).toHaveTextContent("whole 30 fps frames");
	expect(apiFetch).not.toHaveBeenCalled();
});

it("accepts fractional seconds that are a whole frame and supports keyboard form submission", async () => {
	apiFetch.mockResolvedValue({ projectId: editingIds.project });
	renderLocalized(form());
	const input = screen.getByLabelText("Desired length (seconds)");
	fireEvent.change(input, { target: { value: "1.5" } });
	input.focus();
	await userEvent.setup().keyboard("{Enter}");
	await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
	expect(
		JSON.parse(String(apiFetch.mock.calls[0]?.[1]?.body)).targetDurationFrames,
	).toBe(45);
});

it.each([
	"no media",
	"unready media",
	"no analysis",
	"read only",
])("disables generation for %s", (state) => {
	const data = eligibility();
	if (state === "no media") data.mediaVersions = [];
	if (state === "unready media")
		data.mediaVersions = data.mediaVersions.map((media) => ({
			...media,
			state: "PREPARING",
		}));
	if (state === "no analysis") data.analyses = [];
	renderLocalized(form(data, state === "read only"));
	expect(
		screen.getByRole("button", { name: "Generate portrait video" }),
	).toBeDisabled();
	fireEvent.click(
		screen.getByRole("button", { name: "Generate portrait video" }),
	);
	expect(apiFetch).not.toHaveBeenCalled();
	if (state === "read only")
		expect(screen.getByLabelText("Source video")).toBeDisabled();
	else expect(screen.getByRole("status")).toBeInTheDocument();
});

it("shows safe binding errors and treats malformed success responses as uncertain", async () => {
	apiFetch.mockRejectedValueOnce(
		new ApiError(422, "ANALYSIS_BINDING_UNVERIFIED"),
	);
	renderLocalized(form());
	fireEvent.click(
		screen.getByRole("button", { name: "Generate portrait video" }),
	);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"analysis-to-material match",
	);
	apiFetch.mockResolvedValue(null);
	fireEvent.click(
		screen.getByRole("button", { name: "Generate portrait video" }),
	);
	await screen.findByText(/request result could not be confirmed/);
	expect(push).not.toHaveBeenCalled();
});
