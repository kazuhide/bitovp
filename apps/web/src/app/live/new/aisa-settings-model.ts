import type { MessageKey } from "@/lib/i18n";
import type { LiveWizardState } from "./build-live-plan";

export type AisaLiveWizardSettings = {
	enabled: boolean;
	useManagedGraph: boolean;
	outputId: string;
	recordingPath: string;
	analysisPath: string;
	esVersion: string;
	aicaVersion: string;
};

export const EMPTY_AISA_LIVE_SETTINGS: AisaLiveWizardSettings = {
	enabled: false,
	useManagedGraph: false,
	outputId: "",
	recordingPath: "",
	analysisPath: "",
	esVersion: "",
	aicaVersion: "",
};

/** Keep the normal form intact so switching Preview off is lossless. */
export function setAisaLiveEnabled(
	state: LiveWizardState,
	enabled: boolean,
): LiveWizardState {
	return {
		...state,
		aisaLive: {
			...EMPTY_AISA_LIVE_SETTINGS,
			...state.aisaLive,
			enabled,
		},
	};
}

function configured(value: unknown): boolean {
	if (value === undefined || value === "") return false;
	if (Array.isArray(value)) return value.some(configured);
	if (value !== null && typeof value === "object")
		return Object.values(value).some(configured);
	return true;
}

export function hasAisaUnsupportedSettings(state: LiveWizardState): boolean {
	const start = state.start;
	return (
		configured(state.drm) ||
		configured(state.unencryptedMuxingKeys) ||
		state.mirror !== undefined ||
		configured(state.additionalMirrors) ||
		state.archive !== undefined ||
		configured(state.staticIpId) ||
		configured(state.labels) ||
		configured(state.infrastructure) ||
		configured(state.fallbackCloudRegions) ||
		state.scte35AdMarkers ||
		configured(state.adMarkerOptions) ||
		state.output.scte35Passthrough === true ||
		state.hlsIn.adMarkersSource !== "" ||
		(start.encodingOption !== undefined && start.encodingOption !== "AUTO") ||
		start.liveEncodingMode !== "" ||
		configured(start.autoRestart) ||
		configured(start.autoShutdown) ||
		configured(start.reupload) ||
		configured(start.esam) ||
		configured(start.cacheControl) ||
		configured(start.adInsertion)
	);
}

export function aisaWizardProblem(state: LiveWizardState): MessageKey | null {
	if (!state.aisaLive?.enabled) return null;
	if (!state.aisaLive.useManagedGraph) return "aisaLive.managedGraphRequired";
	if (hasAisaUnsupportedSettings(state)) return "aisaLive.unsupportedSettings";
	if (state.inputKind !== "RTMP" && state.inputKind !== "HLS")
		return "aisaLive.supportedInputs";
	return null;
}

/** Only this explicit UI action removes settings unsupported by the service. */
export function clearAisaUnsupportedSettings(
	state: LiveWizardState,
): LiveWizardState {
	return {
		...state,
		drm: undefined,
		unencryptedMuxingKeys: undefined,
		mirror: undefined,
		mirrorKey: undefined,
		additionalMirrors: undefined,
		archive: undefined,
		staticIpId: undefined,
		labels: undefined,
		infrastructure: undefined,
		fallbackCloudRegions: undefined,
		scte35AdMarkers: false,
		adMarkerOptions: undefined,
		output: { ...state.output, scte35Passthrough: undefined },
		hlsIn: { ...state.hlsIn, adMarkersSource: "" },
		start: {
			encodingOption: "AUTO",
			streamKey: state.start.streamKey,
			liveEncodingMode: "",
			autoRestart: { scheduleExpression: "" },
			autoShutdown: {},
			reupload: {},
		},
	};
}
