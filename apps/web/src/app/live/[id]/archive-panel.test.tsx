// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as render } from "@/test/render";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), allowed: true }));
vi.mock("@/lib/api", async (load) => ({
	...(await load<object>()),
	apiFetch: mocks.apiFetch,
}));

vi.mock("@/lib/auth/use-role-access", () => ({
	useRoleAccess: () => mocks.allowed,
}));
vi.mock("@/lib/i18n/context", async (load) => ({
	...(await load<object>()),
	useT: () => ({ t: (key: string) => key }),
}));
vi.mock("@/app/storage/inspect-dialog", () => ({
	InspectDialog: ({ target }: { target: unknown }) =>
		target ? (
			<div data-testid="inspection">{JSON.stringify(target)}</div>
		) : null,
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rebaseLivePlanForRun } from "@bitovp/core";
import { LiveArchivePanel } from "./archive-panel";

const raw = JSON.parse(
	readFileSync(
		join(
			__dirname,
			"../../../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
		),
		"utf8",
	),
);
raw.muxings.push({
	key: "archive",
	kind: "MP4",
	streamKey: "v1080",
	additionalStreamKeys: ["a128"],
	filename: "archive.mp4",
	destination: { outputKey: "origin", path: "qa/archive" },
});
const run = {
	id: "12345678-1234-1234-1234-123456789abc",
	seq: 1,
	outputPrefix: "",
	status: "STOPPED",
};
describe("MP4 archive inspection entry", () => {
	beforeEach(() => {
		mocks.allowed = true;
		mocks.apiFetch.mockReset().mockImplementation(async (url: string) => ({
			objects: [
				{
					key: new URL(url, "http://localhost").searchParams.get("prefix"),
					size: 81604684,
				},
			],
		}));
	});
	it("does not read until explicitly requested, then opens the exact archive with its measured size", async () => {
		render(<LiveArchivePanel plan={raw} run={run} />);
		expect(screen.queryByTestId("inspection")).toBeNull();
		expect(mocks.apiFetch).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", { name: "storage.inspect archive.mp4" }),
		);
		expect((await screen.findByTestId("inspection")).textContent).toContain(
			'"objectKey":"qa/archive/archive.mp4"',
		);
		expect(screen.getByTestId("inspection").textContent).toContain(
			'"objectSize":81604684',
		);
		const url = new URL(mocks.apiFetch.mock.calls[0]?.[0], "http://localhost");
		expect(url.pathname).toBe(
			`/api/credentials/${raw.outputs[0].credentialId}/storage/objects`,
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			bucket: raw.outputs[0].bucket,
			prefix: "qa/archive/archive.mp4",
			limit: "100",
		});
		expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
	});
	it.each([
		"",
		"/",
	])("inspects a bucket-root archive at path %j using its exact key", async (path) => {
		const plan = structuredClone(raw);
		plan.muxings.find(
			(m: { key: string }) => m.key === "archive",
		).destination.path = path;
		mocks.apiFetch.mockResolvedValue({
			objects: [{ key: "archive.mp4", size: 1024 }],
		});
		render(<LiveArchivePanel plan={plan} run={run} />);
		fireEvent.click(
			screen.getByRole("button", { name: "storage.inspect archive.mp4" }),
		);
		expect((await screen.findByTestId("inspection")).textContent).toContain(
			'"objectKey":"archive.mp4"',
		);
		expect(screen.getByTestId("inspection").textContent).toContain(
			'"objectSize":1024',
		);
		expect(
			new URL(
				mocks.apiFetch.mock.calls[0]?.[0],
				"http://localhost",
			).searchParams.get("prefix"),
		).toBe("archive.mp4");
	});
	it.each(
		[
			[],
			[{ key: "qa/archive/archive.mp4.other", size: 10 }],
			[{ key: "qa/archive/archive.mp4", size: undefined }],
			[{ key: "qa/archive/archive.mp4", size: -1 }],
			[
				{ key: "qa/archive/archive.mp4", size: 10 },
				{ key: "qa/archive/archive.mp4", size: 10 },
			],
		].map((objects) => ({ objects })),
	)("does not start inspection without one exact sized object: %j", async ({
		objects,
	}) => {
		mocks.apiFetch.mockResolvedValue({ objects });
		render(<LiveArchivePanel plan={raw} run={run} />);
		fireEvent.click(
			screen.getByRole("button", { name: "storage.inspect archive.mp4" }),
		);
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.queryByTestId("inspection")).toBeNull();
	});
	it("does not start inspection after a failed metadata read, and permits retry", async () => {
		mocks.apiFetch.mockRejectedValueOnce(new Error("private provider detail"));
		render(<LiveArchivePanel plan={raw} run={run} />);
		fireEvent.click(
			screen.getByRole("button", { name: "storage.inspect archive.mp4" }),
		);
		expect((await screen.findByRole("alert")).textContent).toBe(
			"storage.listFailed",
		);
		expect(screen.queryByTestId("inspection")).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "storage.inspect archive.mp4" }),
		);
		expect(await screen.findByTestId("inspection")).toBeTruthy();
	});
	it("does not expose or read archive metadata for a viewer", () => {
		mocks.allowed = false;
		render(<LiveArchivePanel plan={raw} run={run} />);
		expect(screen.queryByRole("button")).toBeNull();
		expect(mocks.apiFetch).not.toHaveBeenCalled();
	});
	it("does not offer a finalized-file inspection while running", () => {
		render(<LiveArchivePanel plan={raw} run={{ ...run, status: "RUNNING" }} />);
		expect(
			screen
				.getByRole("button", { name: "storage.inspect archive.mp4" })
				.hasAttribute("disabled"),
		).toBe(true);
	});
	it("uses the exact second-run prefix and fails closed on a mismatched prefix", async () => {
		const rebased = rebaseLivePlanForRun(raw, { runId: run.id, seq: 2 });
		const rendered = render(
			<LiveArchivePanel
				plan={raw}
				run={{ ...run, seq: 2, outputPrefix: rebased.outputPrefix }}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "storage.inspect archive.mp4" }),
		);
		expect((await screen.findByTestId("inspection")).textContent).toContain(
			rebased.outputPrefix,
		);
		rendered.rerender(
			<LiveArchivePanel
				plan={raw}
				run={{ ...run, seq: 2, outputPrefix: "wrong" }}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: "storage.inspect archive.mp4" }),
		).toBeNull();
	});
});
