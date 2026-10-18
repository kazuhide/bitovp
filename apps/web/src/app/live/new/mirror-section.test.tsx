import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import {
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "./build-live-plan";
import { LiveMirrorSection } from "./mirror-section";

// The storage browser itself is covered by its own tests; here it is a
// stand-in that answers one fixed selection when opened .
vi.mock("@/components/storage-picker", () => ({
	StoragePicker: ({
		open,
		onSelect,
	}: {
		open: boolean;
		onSelect: (selection: {
			credentialId: string;
			bucket: string;
			path: string;
		}) => void;
	}) =>
		open ? (
			<button
				type="button"
				onClick={() =>
					onSelect({ credentialId: "s3", bucket: "mirror-bucket", path: "x/" })
				}
			>
				mock-pick
			</button>
		) : null,
}));

function Form({
	initial = DEFAULT_LIVE_WIZARD_STATE,
}: {
	initial?: LiveWizardState;
}) {
	const [state, setState] = useState(initial);
	return (
		<>
			<LiveMirrorSection
				state={state}
				credentials={[
					{ id: "azure", label: "Azure archive", provider: "AZURE_BLOB" },
					{ id: "s3", label: "S3 mirror", provider: "AWS_S3" },
				]}
				onPatch={(patch) => setState({ ...state, ...patch })}
			/>
			<output data-testid="mirror">
				{JSON.stringify(state.mirror ?? null)}
			</output>
		</>
	);
}
describe("storage mirror controls", () => {
	it.each([
		"en",
		"ja",
	] as const)("supports keyboard opt-in and honest shared path/ACL copy (%s)", async (locale) => {
		renderWithQuery(<Form />, locale);
		const toggle = screen.getByRole("checkbox", {
			name:
				locale === "ja"
					? "ストレージにも同時出力する"
					: "Also deliver to storage",
		});
		toggle.focus();
		await userEvent.keyboard(" ");
		expect(toggle).toBeChecked();
		const sharedPathText =
			locale === "ja"
				? /主出力と同じパス・公開設定/
				: /primary paths and public-read setting/;
		expect(screen.queryByText(sharedPathText)).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", {
				name:
					locale === "ja"
						? "「ストレージにも同時出力する」の説明"
						: "Also deliver to storage — more information",
			}),
		);
		expect(screen.getByRole("note")).toHaveTextContent(sharedPathText);
		await userEvent.keyboard("{Escape}");
		expect(screen.getAllByRole("checkbox")).toHaveLength(1);
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "azure" },
		});
		expect(
			screen.getByLabelText(locale === "ja" ? "コンテナ" : "Container"),
		).toBeInTheDocument();
	});
	it("keeps an unsupported imported mirror visible and blocked until explicitly removed", async () => {
		const mirror = {
			...DEFAULT_LIVE_WIZARD_STATE.output,
			kind: "AKAMAI_MSL" as const,
			credentialId: "old-msl",
		};
		renderWithQuery(
			<Form initial={{ ...DEFAULT_LIVE_WIZARD_STATE, mirror }} />,
		);
		expect(screen.getByRole("alert")).toHaveTextContent(/not MSL/);
		expect(screen.getByRole("combobox")).toHaveValue("old-msl");
		expect(screen.getByTestId("mirror")).toHaveTextContent("old-msl");
		await userEvent.click(screen.getByRole("checkbox"));
		expect(screen.getByTestId("mirror")).toHaveTextContent("null");
	});
});

describe("storage mirror bucket browser (row #327)", () => {
	it("offers 参照 for a browsable kind and takes credential, kind and bucket from the selection", async () => {
		renderWithQuery(<Form />, "ja");
		await userEvent.click(
			screen.getByRole("checkbox", { name: "ストレージにも同時出力する" }),
		);
		// No credential chosen by hand (review-540 R1): the picker is what
		// must set credentialId and kind, not a pre-selection this test made.
		expect(screen.getByRole("combobox")).toHaveValue("");
		await userEvent.click(screen.getByRole("button", { name: "参照…" }));
		await userEvent.click(screen.getByRole("button", { name: "mock-pick" }));
		const mirror = JSON.parse(screen.getByTestId("mirror").textContent ?? "");
		expect(mirror).toMatchObject({
			credentialId: "s3",
			kind: "S3",
			bucket: "mirror-bucket",
		});
		expect(screen.getByLabelText("バケット")).toHaveValue("mirror-bucket");
	});

	it("shows no 参照 for Azure, which has no browse API", async () => {
		renderWithQuery(<Form />, "ja");
		await userEvent.click(
			screen.getByRole("checkbox", { name: "ストレージにも同時出力する" }),
		);
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "azure" },
		});
		expect(screen.queryByRole("button", { name: "参照…" })).toBeNull();
	});
});
