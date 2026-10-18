import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ObjectTable } from "@/app/storage/object-table";
import { SelectionPanel } from "@/app/storage/selection-panel";
import { renderLocalized as render } from "@/test/render";

/**
 * Battery batch 2c : the storage browser's two prop-driven
 * components, never rendered by any test. ObjectTable is the surface every
 * bucket browse and every wizard picker goes through; its local-vs-server
 * filter split (the doc comment on ObjectTableSearch) is behaviour, not
 * plumbing — filtering locally in server mode is exactly the defect the
 * split was built to remove.
 */

const OBJECTS = [
	{ key: "media/movie.mp4", size: 1_048_576, lastModified: undefined },
	{ key: "media/notes.txt", size: 12, lastModified: undefined },
];

function tableProps() {
	return {
		prefixes: ["media/sub/"],
		objects: OBJECTS,
		isLoading: false,
		hasNextPage: false,
		isFetchingNextPage: false,
		onFetchNextPage: vi.fn(),
		onOpenPrefix: vi.fn(),
	};
}

describe("ObjectTable (ledger #149 batch 2c)", () => {
	it("renders folders and objects; opening a folder reports the prefix", () => {
		const props = tableProps();
		render(<ObjectTable {...props} />);
		fireEvent.click(screen.getByRole("button", { name: /sub\// }));
		expect(props.onOpenPrefix).toHaveBeenCalledWith("media/sub/");
		// Local mode displays baseName(key) — one folder, no recursion.
		expect(screen.getByText("movie.mp4")).toBeInTheDocument();
		expect(screen.getByText("1.0 MB")).toBeInTheDocument();
	});

	it("picker mode: absent callbacks render no action buttons", () => {
		render(<ObjectTable {...tableProps()} />);
		expect(screen.queryByText("Use as input")).toBeNull();
		expect(screen.queryByText("Use as output")).toBeNull();
	});

	it("browser mode: the actions carry the row's own key", () => {
		const onUseAsInput = vi.fn();
		const onUseAsOutput = vi.fn();
		render(
			<ObjectTable
				{...tableProps()}
				onUseAsInput={onUseAsInput}
				onUseAsOutput={onUseAsOutput}
			/>,
		);
		fireEvent.click(
			screen.getAllByRole("button", { name: /Use as input/ })[0] as HTMLElement,
		);
		expect(onUseAsInput).toHaveBeenCalledWith("media/movie.mp4");
		fireEvent.click(screen.getByRole("button", { name: "Use as output" }));
		expect(onUseAsOutput).toHaveBeenCalledWith("media/sub/");
	});

	it("local mode filters the rows in hand", () => {
		render(<ObjectTable {...tableProps()} />);
		fireEvent.change(screen.getByLabelText("Filter by name"), {
			target: { value: "movie" },
		});
		expect(screen.getByText("movie.mp4")).toBeInTheDocument();
		expect(screen.queryByText("notes.txt")).toBeNull();
	});

	it("server mode must NOT filter locally — it reports upward instead", () => {
		const onQueryChange = vi.fn();
		// query is CONTROLLED at "movie" — the state a parent holds mid-search.
		// The rows are whatever the parent handed down, including one a local
		// "movie" filter would drop: if it disappears, this table re-narrowed
		// the server's match set to the loaded pages — the old defect.
		render(
			<ObjectTable
				{...tableProps()}
				search={{
					query: "movie",
					extension: "",
					onQueryChange,
					onExtensionChange: vi.fn(),
					prefix: "media/",
				}}
			/>,
		);
		expect(screen.getByText("movie.mp4")).toBeInTheDocument();
		expect(screen.getByText("notes.txt")).toBeInTheDocument();
		// Typing reports upward instead of touching the rows.
		fireEvent.change(screen.getByLabelText("Filter by name"), {
			target: { value: "movies" },
		});
		expect(onQueryChange).toHaveBeenCalledWith("movies");
	});

	it("empty and loading are said out loud, never a blank panel", () => {
		const { unmount } = render(
			<ObjectTable {...tableProps()} prefixes={[]} objects={[]} />,
		);
		expect(
			screen.getByText("Nothing here — empty prefix or filtered out."),
		).toBeInTheDocument();
		unmount();
		render(
			<ObjectTable {...tableProps()} prefixes={[]} objects={[]} isLoading />,
		);
		expect(screen.getByRole("status")).toBeInTheDocument();
	});

	it("offers Load more exactly when a next page exists", () => {
		const props = { ...tableProps(), hasNextPage: true };
		render(<ObjectTable {...props} />);
		fireEvent.click(
			screen.getByRole("button", { name: "Load more (100/page)" }),
		);
		expect(props.onFetchNextPage).toHaveBeenCalledOnce();
	});
});

describe("SelectionPanel (ledger #149 batch 2c)", () => {
	it("renders nothing at all without a selection", () => {
		const { container } = render(
			<SelectionPanel
				selection={{}}
				savePending={false}
				saveError={null}
				onSavePreset={vi.fn()}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("saves the output as a location preset with the chosen role", async () => {
		const onSavePreset = vi.fn().mockResolvedValue(undefined);
		render(
			<SelectionPanel
				selection={{
					output: {
						uri: "s3://bkt/out/",
						bucket: "bkt",
						prefix: "out/",
					},
				}}
				savePending={false}
				saveError={null}
				onSavePreset={onSavePreset}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Save as location preset"), {
			target: { value: "prod output" },
		});
		fireEvent.change(screen.getByLabelText("Preset role"), {
			target: { value: "INPUT" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(onSavePreset).toHaveBeenCalledWith({
			label: "prod output",
			bucket: "bkt",
			prefix: "out/",
			role: "INPUT",
		});
	});

	it("shows the save error the parent hands it", () => {
		render(
			<SelectionPanel
				selection={{ output: { uri: "s3://b/p/", bucket: "b", prefix: "p/" } }}
				savePending={false}
				saveError="save failed: 500"
				onSavePreset={vi.fn()}
			/>,
		);
		expect(screen.getByRole("alert")).toHaveTextContent("save failed: 500");
	});
});
