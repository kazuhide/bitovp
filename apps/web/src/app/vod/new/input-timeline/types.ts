import type {
	VodInputTimelineDocument,
	VodInputTimelineSourceFacts,
} from "@bitovp/core/vod-input-timeline";
import type { WizardInputFile } from "../build-plan";

export type InputTimelineReadiness = {
	ready: boolean;
	probeId: string | null;
	facts: VodInputTimelineSourceFacts[];
	error: string | null;
};
export type VodInputTimelineEditorProps = {
	document: VodInputTimelineDocument;
	onChange: (next: VodInputTimelineDocument) => void;
	sources: WizardInputFile[];
	onAddSource: () => void;
	disabled?: boolean;
	onReadinessChange?: (state: InputTimelineReadiness) => void;
};
