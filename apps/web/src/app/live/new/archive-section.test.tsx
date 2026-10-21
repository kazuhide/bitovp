import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { liveOutputKindForProvider } from "@/app/vod/new/stream-model";
import { renderWithQuery } from "@/test/render";
import { LiveArchiveSection } from "./archive-section";

// The storage browser is covered by its own tests; this stand-in answers one
// fixed selection when opened .
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
					onSelect({
						credentialId: "storage",
						bucket: "archive-bucket",
						path: "vod/2026/archive/",
					})
				}
			>
				mock-pick
			</button>
		) : null,
}));

import {
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "./build-live-plan";

const credentials = [
	{
		id: "storage",
		label: "Archive storage",
		provider: "AKAMAI_OBJECT_STORAGE" as const,
	},
	{ id: "msl", label: "MSL target", provider: "AKAMAI_MSL" as const },
	{ id: "azure", label: "Azure archive", provider: "AZURE_BLOB" as const },
];
function Form({
	initial = DEFAULT_LIVE_WIZARD_STATE,
}: {
	initial?: LiveWizardState;
}) {
	const [state, setState] = useState(initial);
	return (
		<>
			<LiveArchiveSection
				state={state}
				credentials={credentials}
				onPatch={(patch) => setState({ ...state, ...patch })}
			/>
			<output data-testid="state">
				{JSON.stringify(state.archive ?? null)}
			</output>
		</>
	);
}
describe("Live MP4 archive settings", () => {
	it.each([
		"en",
		"ja",
	] as const)("is opt-in with clear after-stop verification copy (%s)", (locale) => {
		renderWithQuery(<Form />, locale);
		const toggle = screen.getByRole("checkbox", {
			name: locale === "ja" ? "MP4 アーカイブを保存" : "Save an MP4 archive",
		});
		expect(toggle).not.toBeChecked();
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
		fireEvent.click(toggle);
		expect(
			screen.getByText(
				locale === "ja"
					? /PRIVATE を指定.*バケット/
					: /^After stopping.*PRIVATE.*bucket/,
			),
		).toBeVisible();
		expect(
			screen.getByText(
				locale === "ja"
					? /停止後にファイルを取得・再生/
					: /After stopping, download/,
			),
		).toBeInTheDocument();
		expect(
			screen.getByLabelText(locale === "ja" ? "映像" : "Video"),
		).toHaveValue("v720");
		expect(
			screen.getByLabelText(locale === "ja" ? "AAC 音声" : "AAC audio"),
		).toHaveValue("a128");
	});
	it("requires existing H264 and AAC without creating extra renditions", () => {
		renderWithQuery(
			<Form initial={{ ...DEFAULT_LIVE_WIZARD_STATE, audios: [] }} />,
		);
		expect(screen.getByRole("checkbox")).toBeDisabled();
		expect(
			screen.getByText(/Add an H.264 video and AAC audio/),
		).toBeInTheDocument();
	});
	it("offers only storage credentials and explicitly requests a private archive by default", () => {
		renderWithQuery(<Form />);
		fireEvent.click(screen.getByRole("checkbox"));
		fireEvent.change(screen.getByLabelText("Archive destination"), {
			target: { value: "archive-output" },
		});
		expect(
			screen.queryByRole("option", { name: /MSL target/ }),
		).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Credential"), {
			target: { value: "storage" },
		});
		fireEvent.change(screen.getByLabelText("Bucket / container"), {
			target: { value: "private-media" },
		});
		fireEvent.change(screen.getByLabelText("Archive path"), {
			target: { value: "shows/archive" },
		});
		fireEvent.change(screen.getByLabelText("Filename"), {
			target: { value: "show.mp4" },
		});
		const archive = JSON.parse(
			screen.getByTestId("state").textContent ?? "null",
		);
		expect(archive.output).toMatchObject({
			credentialId: "storage",
			kind: "GENERIC_S3",
			bucket: "private-media",
		});
		expect(archive.muxing).toMatchObject({
			filename: "show.mp4",
			destination: { outputKey: "archive-output", path: "shows/archive" },
		});
		expect(archive.muxing.destination.acl).toBe("PRIVATE");
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Save an MP4 archive" }),
		);
		expect(screen.getByTestId("state")).toHaveTextContent("null");
	});
	it("distinguishes private, public and unspecified permissions without changing legacy imports", () => {
		renderWithQuery(
			<Form
				initial={{
					...DEFAULT_LIVE_WIZARD_STATE,
					archive: {
						muxing: {
							key: "archive",
							kind: "MP4",
							streamKey: "v720",
							additionalStreamKeys: ["a128"],
							filename: "archive.mp4",
							destination: { outputKey: "origin", path: "archive" },
						},
					},
				}}
			/>,
		);
		const access = screen.getByRole("combobox", { name: "Archive access" });
		expect(access).toHaveValue("");
		const acl = () =>
			JSON.parse(screen.getByTestId("state").textContent ?? "null").muxing
				.destination.acl;
		expect(acl()).toBeUndefined();
		for (const value of ["PUBLIC_READ", "PRIVATE", ""]) {
			fireEvent.change(access, { target: { value } });
			expect(acl()).toBe(value || undefined);
		}
	});
});

describe("archive-only storage browser (row #327)", () => {
	it("takes credential, kind, bucket AND the picked folder as the archive path", async () => {
		renderWithQuery(<Form />, "ja");
		fireEvent.click(
			screen.getByRole("checkbox", { name: "MP4 アーカイブを保存" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "参照…" }));
		fireEvent.click(screen.getByRole("button", { name: "mock-pick" }));
		const archive = JSON.parse(screen.getByTestId("state").textContent ?? "");
		expect(archive.output).toMatchObject({
			credentialId: "storage",
			bucket: "archive-bucket",
		});
		expect(archive.output.kind).toBe(
			liveOutputKindForProvider("AKAMAI_OBJECT_STORAGE"),
		);
		// The picker's prefix carries a trailing slash; the path field does not.
		expect(archive.muxing.destination.path).toBe("vod/2026/archive");
	});

	it("shows no 参照 once an Azure credential is chosen, which has no browse API (review-540 O1)", () => {
		renderWithQuery(<Form />, "ja");
		fireEvent.click(
			screen.getByRole("checkbox", { name: "MP4 アーカイブを保存" }),
		);
		expect(screen.getByRole("button", { name: "参照…" })).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("接続情報"), {
			target: { value: "azure" },
		});
		expect(screen.queryByRole("button", { name: "参照…" })).toBeNull();
	});
});
