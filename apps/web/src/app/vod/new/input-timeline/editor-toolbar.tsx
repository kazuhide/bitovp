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
	onUndo,
	onRedo,
	onSplit,
	onEarlier,
	onLater,
	onDelete,
	onAudio,
}: {
	disabled: boolean;
	canUndo: boolean;
	canRedo: boolean;
	canSplit: boolean;
	canMoveEarlier: boolean;
	canMoveLater: boolean;
	canDelete: boolean;
	audioEnabled: boolean;
	onUndo: () => void;
	onRedo: () => void;
	onSplit: () => void;
	onEarlier: () => void;
	onLater: () => void;
	onDelete: () => void;
	onAudio: (enabled: boolean) => void;
}) {
	const l = useTimelineLabels();
	return (
		<div className="flex flex-wrap items-center gap-1 border-zinc-800 border-t pt-3">
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
