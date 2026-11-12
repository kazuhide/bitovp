import { Link2, Unlink2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTimelineLabels } from "./labels";

export function EditorToolbar({
	disabled,
	canUndo,
	canRedo,
	canSplit,
	canMoveEarlier,
	canMoveLater,
	canDelete,
	audioEnabled,
	linked,
	linkAvailable,
	targetLabel,
	onUndo,
	onRedo,
	onSplit,
	onEarlier,
	onLater,
	onDelete,
	onAudio,
	onLinked,
}: {
	disabled: boolean;
	canUndo: boolean;
	canRedo: boolean;
	canSplit: boolean;
	canMoveEarlier: boolean;
	canMoveLater: boolean;
	canDelete: boolean;
	audioEnabled: boolean;
	linked: boolean;
	linkAvailable: boolean;
	targetLabel: string;
	onUndo: () => void;
	onRedo: () => void;
	onSplit: () => void;
	onEarlier: () => void;
	onLater: () => void;
	onDelete: () => void;
	onAudio: (enabled: boolean) => void;
	onLinked: (linked: boolean) => void;
}) {
	const l = useTimelineLabels();
	return (
		<div className="flex flex-wrap items-center gap-1 border-zinc-800 border-t pt-3">
			<output
				aria-label={l.editTarget}
				className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300"
			>
				{targetLabel}
			</output>
			<Button
				size="sm"
				variant="ghost"
				aria-label={linked ? l.unlink : l.link}
				aria-pressed={linked}
				disabled={disabled || !linkAvailable}
				onClick={() => onLinked(!linked)}
			>
				{linked ? (
					<Link2 aria-hidden className="h-4 w-4" />
				) : (
					<Unlink2 aria-hidden className="h-4 w-4" />
				)}
			</Button>
			<Button
				size="sm"
				variant="ghost"
				disabled={disabled || !canUndo}
				onClick={onUndo}
			>
				{l.undo}
			</Button>
			<Button
				size="sm"
				variant="ghost"
				disabled={disabled || !canRedo}
				onClick={onRedo}
			>
				{l.redo}
			</Button>
			<Button
				size="sm"
				variant="secondary"
				disabled={disabled || !canSplit}
				onClick={onSplit}
			>
				{l.split}
			</Button>
			<Button
				size="sm"
				variant="ghost"
				disabled={disabled || !canMoveEarlier}
				onClick={onEarlier}
			>
				{l.earlier}
			</Button>
			<Button
				size="sm"
				variant="ghost"
				disabled={disabled || !canMoveLater}
				onClick={onLater}
			>
				{l.later}
			</Button>
			<Button
				size="sm"
				variant="ghost"
				disabled={disabled || !canDelete}
				onClick={onDelete}
			>
				{l.remove}
			</Button>
			<label className="ml-auto flex items-center gap-2 whitespace-nowrap pl-2 text-xs text-zinc-300">
				<input
					type="checkbox"
					checked={audioEnabled}
					disabled={disabled}
					className="accent-emerald-500"
					onChange={(event) => onAudio(event.target.checked)}
				/>
				{l.includeAudio}
			</label>
		</div>
	);
}
