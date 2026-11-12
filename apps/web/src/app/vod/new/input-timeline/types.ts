import type { CredentialSummaryWire } from "@bitovp/core";
import type {
	VodInputFavoriteWire,
	VodInputTimelineDocument,
	VodInputTimelineSourceFacts,
} from "@bitovp/core/vod-input-timeline";
import type { WizardInputFile } from "../build-plan";
import type { ImageOutputLocation } from "./image-placement-dialog";

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
	onUseFavorite?: (favorite: VodInputFavoriteWire) => void;
	canUseLogo?: boolean;
	canUseMedia?: boolean;
	imageOutput?: ImageOutputLocation;
	imageCredentials?: CredentialSummaryWire[];
	onImportPreparedSource?: (source: WizardInputFile) => void;
	disabled?: boolean;
	onReadinessChange?: (state: InputTimelineReadiness) => void;
};
