import type { VodInputTimelineDocument } from "@bitovp/core/vod-input-timeline";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentOrganizationContext } from "@/components/providers";
import { apiFetch } from "@/lib/api";
import { renderLocalized } from "@/test/render";
import type { WizardInputFile } from "../build-plan";
import { VodInputTimelineEditor } from "./input-timeline-editor";
import {
	credentialId,
	facts,
	organizationId,
	previewTask,
	taskB,
	taskId,
	timeline,
} from "./test-fixtures";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});
const sources: WizardInputFile[] = ["a", "b"].map((key) => ({
	key,
	inputKey: key,
	kind: "S3",
	credentialId,
	bucket: "sources",
	path: `${key}.mp4`,
}));
function Harness({ inputs = sources }: { inputs?: WizardInputFile[] }) {
	const [document, setDocument] = useState<VodInputTimelineDocument>(
		timeline(),
	);
	return (
		<DocumentOrganizationContext.Provider value={organizationId}>
			<VodInputTimelineEditor
				document={document}
				onChange={setDocument}
				sources={inputs}
				onAddSource={() => {}}
			/>
		</DocumentOrganizationContext.Provider>
	);
}

it("keeps output-logo images out of media preparation and timeline readiness", async () => {
	vi.mocked(apiFetch).mockImplementation((_url, init) => {
		if (init?.method === "DELETE") return Promise.resolve(undefined);
		const request = JSON.parse(String(init?.body));
		return Promise.resolve({
			task:
				request.kind === "PROBE"
					? previewTask({ kind: "PROBE", result: { sources: facts } })
					: previewTask({
							result: {
								preview: {
									...request.range,
									size: 1024,
									sha256: "b".repeat(64),
								},
							},
						}),
		});
	});
	renderLocalized(
		<Harness
			inputs={[
				...sources,
				{
					key: "logo",
					inputKey: "a",
					kind: "S3",
					credentialId,
					bucket: "sources",
					path: "logo.png",
					purpose: "FILTER_IMAGE",
				},
			]}
		/>,
	);
	await screen.findByText("Preview ready");
	const probes = vi
		.mocked(apiFetch)
		.mock.calls.filter(([, init]) =>
			String(init?.body).includes('"kind":"PROBE"'),
		)
		.map(([, init]) => JSON.parse(String(init?.body)));
	expect(probes).toHaveLength(1);
	expect(
		probes[0].sources.map((source: { key: string }) => source.key),
	).toEqual(["a", "b"]);
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("blocks sequence preview for a missing audio track until audio is explicitly disabled", async () => {
	vi.mocked(apiFetch).mockImplementation((_url, init) => {
		if (init?.method === "DELETE") return Promise.resolve(undefined);
		const request = JSON.parse(String(init?.body));
		return Promise.resolve({
			task:
				request.kind === "PROBE"
					? previewTask({
							kind: "PROBE",
							result: { sources: [facts[0], { ...facts[1], audio: null }] },
						})
					: previewTask({
							result: {
								preview: {
									...request.range,
									size: 1024,
									sha256: "b".repeat(64),
								},
							},
						}),
		});
	});
	renderLocalized(<Harness />);
	await screen.findByText(/A selected source has no audio/);
	expect(
		vi
			.mocked(apiFetch)
			.mock.calls.some(([, init]) =>
				String(init?.body).includes('"kind":"PREVIEW"'),
			),
	).toBe(false);
	fireEvent.click(screen.getByRole("checkbox", { name: "Include audio" }));
	await waitFor(() =>
		expect(
			vi
				.mocked(apiFetch)
				.mock.calls.some(([, init]) =>
					String(init?.body).includes('"audioEnabled":false'),
				),
		).toBe(true),
	);
});

it("prepares fresh source identity before retrying a failed preview", async () => {
	let probes = 0;
	vi.mocked(apiFetch).mockImplementation((_url, init) => {
		if (init?.method === "DELETE") return Promise.resolve(undefined);
		const request = JSON.parse(String(init?.body));
		if (request.kind === "PROBE") {
			probes++;
			return Promise.resolve({
				task: previewTask({
					id: probes === 1 ? taskId : taskB,
					kind: "PROBE",
					result: { sources: facts },
				}),
			});
		}
		return Promise.resolve({
			task:
				probes === 1
					? previewTask({
							status: "FAILED",
							result: undefined,
							error: { code: "SOURCE_CHANGED", message: "Source changed" },
						})
					: previewTask({
							result: {
								preview: {
									...request.range,
									size: 1024,
									sha256: "b".repeat(64),
								},
							},
						}),
		});
	});
	renderLocalized(<Harness />);
	await screen.findByText("Source changed");
	fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
	await waitFor(() => expect(probes).toBe(2), { timeout: 1000 });
	await screen.findByText("Preview ready");
});
