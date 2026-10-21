import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
	liveBasePath,
	liveManifestDestination,
} from "./build-live-plan";
import { liveMirrorEntries, liveOutputEntries } from "./live-output-model";

export function addLiveMirror(
	state: LiveWizardState,
): Partial<LiveWizardState> {
	const used = new Set([
		...liveOutputEntries(state).map((entry) => entry.key),
		...(state.outputOrder ?? []),
	]);
	let n = 1;
	while (used.has(`mirror-${n}`)) n++;
	const output = { ...DEFAULT_LIVE_WIZARD_STATE.output, basePath: "" };
	return liveMirrorEntries(state).length === 0 && n === 1
		? { mirror: output }
		: {
				additionalMirrors: [
					...(state.additionalMirrors ?? []),
					{ key: `mirror-${n}`, output },
				],
			};
}

export function addLiveManifest(
	state: LiveWizardState,
	kind: "HLS" | "DASH",
): Partial<LiveWizardState> {
	const plan = buildLiveChannelPlan(state);
	const configured = [
		state.manifests.hls,
		state.manifests.dash,
		...(state.manifests.additionalHls ?? []),
		...(state.manifests.additionalDash ?? []),
	];
	const keys = new Set([
		...plan.liveManifests.map((manifest) => manifest.key),
		...configured.map((manifest) => manifest.key),
		...(state.manifestOrder ?? []),
	]);
	const paths = new Set([
		...plan.liveManifests.map((manifest) => manifest.destination.path),
		...configured.map((manifest) => manifest.destination?.path),
		...plan.muxings.flatMap((muxing) =>
			muxing.destination ? [muxing.destination.path] : [],
		),
	]);
	const prefix = kind.toLowerCase();
	let n = 2;
	while (
		keys.has(`${prefix}-${n}`) ||
		paths.has(`${liveBasePath(state)}/${prefix}-${n}`)
	)
		n++;
	const key = `${prefix}-${n}`;
	const destination = {
		...liveManifestDestination(state),
		path: `${liveBasePath(state)}/${key}`,
	};
	const manifests = state.manifests;
	return {
		manifests:
			kind === "HLS"
				? {
						...manifests,
						additionalHls: [
							...(manifests.additionalHls ?? []),
							{
								...DEFAULT_LIVE_WIZARD_STATE.manifests.hls,
								key,
								enabled: true,
								destination,
							},
						],
					}
				: {
						...manifests,
						additionalDash: [
							...(manifests.additionalDash ?? []),
							{
								...DEFAULT_LIVE_WIZARD_STATE.manifests.dash,
								key,
								enabled: true,
								destination,
							},
						],
					},
	};
}
