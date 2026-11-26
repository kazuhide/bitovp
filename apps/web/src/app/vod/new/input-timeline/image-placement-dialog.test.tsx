import type { VodInputFavoriteWire } from "@bitovp/core/vod-input-timeline";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { ImagePlacementDialog } from "./image-placement-dialog";
import { credentialId, facts, previewTask } from "./test-fixtures";

const { useTask } = vi.hoisted(() => ({ useTask: vi.fn() }));
vi.mock("./use-preview-task", () => ({ usePreviewTask: useTask }));
vi.mock("@/components/storage-picker", () => ({
	StoragePicker: ({
		open,
		onSelect,
	}: {
		open: boolean;
		onSelect: (value: unknown) => void;
	}) =>
		open ? (
			<button
				type="button"
				onClick={() =>
					onSelect({ credentialId, bucket: "media", path: "assets" })
				}
			>
				Choose test folder
			</button>
		) : null,
}));
const favorite: VodInputFavoriteWire = {
	id: "10000000-0000-4000-8000-000000000040",
	credentialId,
	bucket: "media",
	objectKey: "cover.png",
	label: "Cover",
	kind: "IMAGE",
	availability: "AVAILABLE",
	inputKind: "S3",
};
const prepared = {
	source: {
		key: "img_cover",
		credentialId,
		bucket: "media",
		objectKey: "assets/generated.mp4",
	},
	facts: { ...facts[0], key: "img_cover" },
	requestedDurationMs: 5000,
	sha256: "f".repeat(64),
};
const place = vi.fn(),
	close = vi.fn();
const credentials = [
	{
		id: credentialId,
		label: "Storage",
		provider: "AWS_S3" as const,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	},
];
function renderDialog(
	output:
		| { credentialId: string; bucket: string; prefix: string }
		| undefined = { credentialId, bucket: "media", prefix: "assets" },
) {
	return renderLocalized(
		<ImagePlacementDialog
			favorite={favorite}
			initialOutput={output}
			credentials={credentials}
			positionMs={7000}
			durationMs={10000}
			disabled={false}
			onPlace={place}
			onClose={close}
		/>,
	);
}
afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});
function idle() {
	useTask.mockReturnValue({
		ready: null,
		task: null,
		pending: false,
		error: null,
		retry: vi.fn(),
	});
}

it("requires an explicit placement action and sends the chosen duration with opaque storage refs", async () => {
	idle();
	renderDialog();
	expect(useTask.mock.lastCall?.[0]).toBeNull();
	fireEvent.change(screen.getByLabelText("Display duration (seconds)"), {
		target: { value: "4.5" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Place" }));
	await waitFor(() =>
		expect(useTask.mock.lastCall?.[0]).toMatchObject({
			kind: "IMAGE_PREPARE",
			durationMs: 4500,
			source: { credentialId, bucket: "media", objectKey: "cover.png" },
			output: { credentialId, bucket: "media", prefix: "assets" },
		}),
	);
	expect(place).not.toHaveBeenCalled();
	expect(close).not.toHaveBeenCalled();
});
it("constrains V1 overwrite to the remaining program and does not change duration while appending", () => {
	idle();
	renderDialog();
	fireEvent.change(screen.getByLabelText("Placement"), {
		target: { value: "overwrite" },
	});
	expect(screen.getByLabelText("Display duration (seconds)")).toHaveValue(3);
	fireEvent.change(screen.getByLabelText("Display duration (seconds)"), {
		target: { value: "4" },
	});
	expect(screen.getByRole("button", { name: "Place" })).toBeDisabled();
	fireEvent.change(screen.getByLabelText("Placement"), {
		target: { value: "append" },
	});
	expect(screen.getByRole("button", { name: "Place" })).toBeEnabled();
});
it("requires an explicit generated-source folder if no supported output is selected", () => {
	idle();
	renderDialog({ credentialId: "", bucket: "", prefix: "" });
	expect(screen.getByRole("button", { name: "Place" })).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
	fireEvent.click(screen.getByRole("button", { name: "Choose test folder" }));
	expect(screen.getByRole("button", { name: "Place" })).toBeEnabled();
});
it("adopts one successful task once, using its measured prepared source", async () => {
	idle();
	const view = renderDialog();
	fireEvent.click(screen.getByRole("button", { name: "Place" }));
	useTask.mockReturnValue({
		ready: previewTask({ kind: "IMAGE_PREPARE", result: { prepared } }),
		pending: false,
		error: null,
		task: null,
		retry: vi.fn(),
	});
	view.rerender(
		<ImagePlacementDialog
			favorite={favorite}
			initialOutput={{ credentialId, bucket: "media", prefix: "assets" }}
			credentials={credentials}
			positionMs={7000}
			durationMs={10000}
			disabled={false}
			onPlace={place}
			onClose={close}
		/>,
	);
	await waitFor(() => expect(place).toHaveBeenCalledTimes(1));
	expect(place).toHaveBeenCalledWith(
		prepared,
		{ mode: "append", atMs: 7000 },
		"S3",
	);
	expect(close).toHaveBeenCalledTimes(1);
});

it("clears the intent on loss of permission and ignores a late completed task", async () => {
	idle();
	const view = renderDialog();
	fireEvent.click(screen.getByRole("button", { name: "Place" }));
	useTask.mockReturnValue({
		ready: previewTask({ kind: "IMAGE_PREPARE", result: { prepared } }),
		pending: false,
		error: null,
		task: null,
		retry: vi.fn(),
	});
	view.rerender(
		<ImagePlacementDialog
			favorite={favorite}
			initialOutput={{ credentialId, bucket: "media", prefix: "assets" }}
			credentials={credentials}
			positionMs={7000}
			durationMs={10000}
			disabled
			onPlace={place}
			onClose={close}
		/>,
	);
	await waitFor(() => expect(useTask.mock.lastCall?.[0]).toBeNull());
	view.rerender(
		<ImagePlacementDialog
			favorite={favorite}
			initialOutput={{ credentialId, bucket: "media", prefix: "assets" }}
			credentials={credentials}
			positionMs={7000}
			durationMs={10000}
			disabled={false}
			onPlace={place}
			onClose={close}
		/>,
	);
	expect(useTask.mock.lastCall?.[0]).toBeNull();
	expect(place).not.toHaveBeenCalled();
	expect(close).not.toHaveBeenCalled();
});
