import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { RenditionAddControls } from "../../apps/web/src/app/vod/new/rendition-add-controls";
import { LocaleProvider } from "../../apps/web/src/lib/i18n/context";

type Row = { id: number; label: string };
type Receipt = {
	expected: string | null;
	actual: string | null;
	valid: boolean;
};
const initialRows = (): Row[] =>
	[1, 2, 3].map((id) => ({ id, label: `Rendition ${id}` }));

function Fixture() {
	const [rows, setRows] = useState(initialRows);
	const [collision, setCollision] = useState(false);
	const [revision, setRevision] = useState(0);
	const [generation, setGeneration] = useState(0);
	const [intent, setIntent] = useState<{
		label: string | null;
		revision: number;
	} | null>(null);
	const [pristine, setPristine] = useState(true);
	const [addClicks, setAddClicks] = useState(0);
	const nextId = useRef(4);
	const receipts = useRef<Receipt[]>([]);
	const captured = useRef<{ expected: string | null; before: number } | null>(
		null,
	);
	const counts = useRef({
		select: 0,
		collision: 0,
		reorder: 0,
		add: 0,
		reset: 0,
	});
	const scope = useRef<HTMLDivElement>(null);
	const oracle = {
		ready: true,
		rows,
		revision,
		collision,
		pristine,
		addClicks,
		intent,
		counts: counts.current,
		receipts: receipts.current,
	};
	const changeRows = (next: Row[]) => {
		setRows(next);
		setRevision((value) => value + 1);
	};
	return (
		<main>
			<h1>Rendition copy component fixture</h1>
			<p>Only synthetic component state. No application session or provider.</p>
			<button
				id="collision"
				type="button"
				onClick={() => {
					counts.current.collision++;
					setCollision((value) => !value);
					setRevision((value) => value + 1);
				}}
			>
				Toggle duplicate keys
			</button>
			<button
				id="reorder"
				type="button"
				onClick={() => {
					counts.current.reorder++;
					const reordered = [...rows.slice(1), rows[0]];
					// Duplicate keys have only positional identity. Preserve that explicit
					// fallback while ambiguous; unique-key reorder must preserve the row.
					if (collision && intent?.label !== null && intent) {
						const selectedIndex =
							scope.current?.querySelector("select")?.selectedIndex ?? 0;
						setIntent({
							label: reordered[selectedIndex - 1]?.label ?? null,
							revision: revision + 1,
						});
					}
					changeRows(reordered);
				}}
			>
				Rotate choices
			</button>
			<button
				id="reset"
				type="button"
				onClick={() => {
					counts.current.reset++;
					changeRows(initialRows());
					setGeneration((value) => value + 1);
					setPristine(true);
					setIntent(null);
				}}
			>
				Reset selection
			</button>
			<div
				ref={scope}
				id="component"
				onChangeCapture={(event) => {
					if (!(event.target instanceof HTMLSelectElement)) return;
					const select = event.target;
					counts.current.select++;
					setPristine(false);
					setIntent({
						label:
							select.selectedIndex === 0
								? null
								: (select.selectedOptions[0]?.textContent ?? null),
						revision,
					});
				}}
				onClickCapture={(event) => {
					if (
						!(event.target instanceof Element) ||
						event.target.closest("button")?.textContent !== "Add rendition"
					)
						return;
					const select = scope.current?.querySelector("select");
					if (!select) throw new Error("Missing real copy selector");
					setAddClicks((value) => value + 1);
					captured.current = {
						expected:
							select.selectedIndex === 0
								? null
								: (select.selectedOptions[0]?.textContent ?? null),
						before: rows.length,
					};
				}}
			>
				<RenditionAddControls
					key={generation}
					kind="video"
					label="Add rendition"
					choices={rows.map((row, index) => ({
						key: collision ? "duplicate" : `key-${row.id}`,
						index,
						label: row.label,
					}))}
					onAdd={(index) => {
						const capture = captured.current;
						if (!capture)
							throw new Error("Callback without a captured Add click");
						const valid =
							index === undefined ||
							(Number.isInteger(index) && index >= 0 && index < rows.length);
						receipts.current.push({
							expected: capture.expected,
							actual:
								index === undefined ? null : (rows[index]?.label ?? "INVALID"),
							valid: valid && capture.before === rows.length,
						});
						counts.current.add++;
						captured.current = null;
						const id = nextId.current++;
						if (collision && intent?.label !== null) {
							// The component contract deliberately drops ambiguous positional
							// identity when row count changes, returning to last-row default.
							setIntent(null);
							setPristine(true);
						}
						changeRows([...rows, { id, label: `Rendition ${id}` }]);
					}}
				/>
			</div>
			<output id="oracle">{JSON.stringify(oracle)}</output>
		</main>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
	<LocaleProvider locale="en">
		<Fixture />
	</LocaleProvider>,
);
