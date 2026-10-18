import type { MessageKey } from "@/lib/i18n";

/* The live detail hierarchy is data shared by rendering, navigation, and DOM tests. Monitoring results and emergency controls stay visible; less frequent authoring is disclosed. Per-phase section order and initial open state are explicit, so moving a section in either the component or table without the other fails verification. */

/** The four situations an operator lands in . */
export const LIVE_PHASES = [
	"prepare",
	"starting",
	"onair",
	"finished",
] as const;
export type LivePhase = (typeof LIVE_PHASES)[number];

/**
 * Every addressable block on the page. `sec-*` ids are a CONTRACT, not a
 * styling detail: `liveNextAction` returns one as its "take me there" pointer
 * (core owns that union), deep links use them, and 's section rail will
 * attach to the same ids. Renaming one silently dangles an anchor — which is
 * why the next-action targets below keep the names they had before this
 * reorganisation, including `sec-actions`, which now names the header's
 * lifecycle controls rather than a body section.
 */
export type LiveSectionId =
	// Header layer — the single owner of Start / Stop / Restart.
	| "sec-actions"
	// Phase leads (rendered above the layers; see LEAD_SECTIONS).
	| "sec-ingest"
	| "sec-last-run"
	// Operations
	| "sec-alerts"
	| "sec-manifests"
	| "sec-origin"
	| "sec-slate"
	// : the emergency "stop what is playing" lever, apart from the
	// reservation list it used to sit on top of (audit 5c3d97ca HIGH-8).
	| "sec-insertion-stop"
	// Programme / scheduling
	| "sec-schedule"
	| "sec-insertion"
	| "sec-cue"
	| "sec-esam"
	// Input / pseudo-live
	| "sec-feeders"
	// Delivery / QC
	| "sec-dvr"
	| "sec-dns"
	| "sec-live-to-vod"
	| "sec-vmaf"
	// Diagnostics / history / advanced
	| "sec-heartbeat"
	// The per-run heartbeat LOG (2026-09-02) — under Diagnostics for now; a
	// later WP moves sections.
	| "sec-heartbeat-log"
	| "sec-alert-rules"
	| "sec-runs"
	| "sec-steps"
	| "sec-ladder"
	| "sec-runtime-cap"
	| "sec-advanced"
	// Danger zone
	| "sec-danger";

/**
 * : every section's HEADING copy, once.
 *
 * The rail and the "Jump to" menu label their links with the same words the
 * section's own heading carries — that is what makes a jump legible ("Alerts"
 * in the rail lands on a heading that says "Alerts"). Before this table the
 * titles were `t("alerts.title")` literals scattered through `channel-
 * detail.tsx`'s node map, so a navigation list had to keep a SECOND copy of
 * them; the two would then be free to drift the way §5.6's rail comment drifted
 * from the rail that was never built.
 *
 * `Record<LiveSectionId, MessageKey>` rather than a partial map: a section id
 * added to the union and forgotten here is a compile error, so the rail can
 * never render a section it has no word for.
 */
export const LIVE_SECTION_TITLE_KEYS: Record<LiveSectionId, MessageKey> = {
	"sec-actions": "live.actions",
	"sec-ingest": "live.ingestCoordinates",
	"sec-last-run": "live.lastRun",
	"sec-alerts": "alerts.title",
	"sec-manifests": "jobDetail.manifests",
	"sec-origin": "origin.title",
	"sec-slate": "live.slateNow",
	"sec-insertion-stop": "contentInsertion.stopTitle",
	"sec-schedule": "schedule.title",
	"sec-insertion": "live.contentInsertion",
	"sec-cue": "live.insertCue",
	"sec-esam": "esam.title",
	"sec-feeders": "live.feeders",
	"sec-dvr": "live.dvr",
	"sec-dns": "live.dnsMappings",
	"sec-live-to-vod": "live.liveToVod",
	"sec-vmaf": "live.vmafCapture",
	"sec-heartbeat": "live.health.ingestDetails",
	"sec-heartbeat-log": "heartbeatLog.title",
	"sec-alert-rules": "alerts.rulesTitle",
	"sec-runs": "runs.heading",
	"sec-steps": "live.stepTimeline",
	"sec-ladder": "live.ladder",
	"sec-runtime-cap": "schedule.capTitle",
	"sec-advanced": "live.advanced",
	"sec-danger": "live.dangerZone",
};

/**
 * Audit 5c3d97ca §8.5 — every section's TITLE-LEVEL HELP, once, beside the
 * title keys it explains. Partial on purpose: a section with no entry renders
 * no mark. The entries are the §8.5 table — the concepts an AWS MediaLive
 * operator does not share (input state vs. output monitoring, a slate
 * insertion vs. an input switch, a file input vs. an Input resource, an
 * automatic stop that can end the broadcast early) — and the four contents
 * §14.6 makes mandatory live in `liveHelp.heartbeat`, `.slate`, `.runtimeCap`
 * and the wizard's auto-restart body. `section-card.test.tsx` walks this map
 * against the rendered page.
 */
export const LIVE_SECTION_HELP_KEYS: Partial<
	Record<LiveSectionId, MessageKey>
> = {
	"sec-ingest": "liveHelp.ingest",
	"sec-origin": "liveHelp.origin",
	"sec-slate": "liveHelp.slate",
	"sec-insertion": "liveHelp.insertion",
	"sec-schedule": "liveHelp.schedule",
	"sec-insertion-stop": "liveHelp.insertionStop",
	"sec-feeders": "liveHelp.feeders",
	"sec-live-to-vod": "liveHelp.liveToVod",
	"sec-heartbeat": "liveHelp.heartbeat",
	"sec-runtime-cap": "liveHelp.runtimeCap",
};

export type LiveLayerId =
	| "layer-operations"
	| "layer-programme"
	| "layer-input"
	| "layer-delivery"
	| "layer-diagnostics"
	| "layer-danger";

/**
 * The six body layers, in the order §5.7 asks for: what an on-air operator
 * READS first, then what they PROGRAMME, then the input side, then delivery,
 * then the diagnostic long tail, then the one destructive control on its own.
 *
 * Each layer is a named landmark with a visible `h2`; the sections inside carry
 * `h3`. 's rail and its "Jump to" menu now render FROM this array —
 * one list of links, laid out as a right rail at `xl` and as a disclosed menu
 * below it — so a layer removed here disappears from the navigation and from
 * the page in the same edit.
 */
export const LIVE_LAYERS: readonly {
	id: LiveLayerId;
	titleKey: MessageKey;
	/** Why this layer exists, one line, under its heading. */
	leadKey: MessageKey;
	/**
	 * Audit 5c3d97ca §8.5: the two layers whose NAME is a concept (channel
	 * state; output and delivery) carry a one-sentence help beside the `h2`,
	 * so the lead can be a plain descriptor instead of a conversational line.
	 */
	helpKey?: MessageKey;
	sections: readonly LiveSectionId[];
}[] = [
	{
		id: "layer-operations",
		titleKey: "liveLayer.operations",
		leadKey: "liveLayer.operationsLead",
		helpKey: "liveLayer.operationsHelp",
		sections: ["sec-alerts", "sec-manifests", "sec-slate"],
	},
	{
		id: "layer-programme",
		titleKey: "liveLayer.programme",
		leadKey: "liveLayer.programmeLead",
		sections: [
			// Slate-insertion workflow, in operator order: register the content,
			// schedule the timed insert, stop it if needed .
			"sec-insertion",
			"sec-schedule",
			"sec-insertion-stop",
			"sec-cue",
			"sec-esam",
		],
	},
	{
		id: "layer-input",
		titleKey: "liveLayer.input",
		leadKey: "liveLayer.inputLead",
		// `sec-ingest` is here ONLY when the phase did not hoist it into the
		// lead — the one section with conditional PLACEMENT , kept
		// because pasting an ingest URL is the whole job before air.
		sections: ["sec-ingest", "sec-feeders"],
	},
	{
		id: "layer-delivery",
		titleKey: "liveLayer.delivery",
		leadKey: "liveLayer.deliveryLead",
		helpKey: "liveLayer.deliveryHelp",
		sections: ["sec-dvr", "sec-dns", "sec-live-to-vod", "sec-vmaf"],
	},
	{
		id: "layer-diagnostics",
		titleKey: "liveLayer.diagnostics",
		leadKey: "liveLayer.diagnosticsLead",
		sections: [
			"sec-heartbeat-log",
			"sec-alert-rules",
			"sec-runs",
			"sec-steps",
			"sec-ladder",
			"sec-runtime-cap",
			"sec-advanced",
		],
	},
	{
		id: "layer-danger",
		titleKey: "liveLayer.danger",
		leadKey: "liveLayer.dangerLead",
		sections: ["sec-danger"],
	},
];

/**
 * Sections rendered ABOVE the layers, per phase — #126's contextual lead, kept
 * verbatim. `sec-ingest` leads before air (paste-ready coordinates); the
 * last-broadcast summary leads after it. On air and after air the ingest card
 * returns to the Input layer, so it renders exactly once either way.
 */
export const LEAD_SECTIONS: Record<LivePhase, readonly LiveSectionId[]> = {
	prepare: ["sec-ingest"],
	starting: ["sec-ingest"],
	onair: [],
	finished: ["sec-last-run"],
};

/** Detail anchors retained inside the delivery-status panel. */
export const PANEL_SECTIONS: readonly LiveSectionId[] = [
	"sec-heartbeat",
	"sec-origin",
];

/**
 * What is OPEN on arrival, per phase (§5.7's phase table). Everything else
 * renders closed with its live summary line, which is the whole point of
 * `SectionCard`: the closed row still says enough to decide whether to open it.
 *
 * The explicit `Record<LivePhase, …>` annotation rather than a bare object: a
 * phase added to `LIVE_PHASES` and forgotten here is a compile error, not a
 * phase that silently opens nothing. (`satisfies` would give the same
 * totality but keep the literal element types, and `.includes(someSectionId)`
 * on a literal tuple narrows its own argument to `never` — the check would
 * then only compile for ids that phase already lists.)
 */
export const PHASE_DEFAULT_OPEN: Record<LivePhase, readonly LiveSectionId[]> = {
	// Paste the ingest URL, see what is scheduled, check the feeder can reach
	// its source. Start itself is the header button.
	prepare: ["sec-ingest", "sec-schedule", "sec-feeders"],
	// Watch it come up and catch a stuck step — plus the coordinates, still
	// pasteable while the encoder allocates.
	starting: ["sec-ingest", "sec-steps"],
	// The on-air readout: is input arriving, is anything alerting, is there a
	// playable output, is the feeder pushing, what fires next. Stop is the
	// header button.
	onair: [
		"sec-ingest",
		"sec-alerts",
		"sec-manifests",
		"sec-feeders",
		"sec-schedule",
	],
	// What happened, what is still unresolved, and the two things worth doing
	// afterwards (a new run — the header button — and harvesting the VOD).
	finished: [
		"sec-last-run",
		"sec-alerts",
		"sec-alert-rules",
		"sec-live-to-vod",
	],
};

/**
 * The layers this phase actually renders, with the sections each one actually
 * renders — ONE derivation, used both by the page (to emit the JSX) and by
 * `liveSectionOrder` (to state the expected order). Two derivations would be
 * two chances for the page and its pin to disagree while both stay green.
 *
 * Two subtractions:
 *  - the phase's LEAD sections, because a hoisted ingest card must render once,
 *    not twice — the one section with conditional placement ;
 *  - `omit`, the sections a given channel has no business showing at all: the
 *    VMAF capture entry when the deployment's flag is off , and
 *    the last-broadcast lead on a channel that has never run. Passing them in
 *    keeps this module free of feature flags and of the channel row.
 */
export function liveBodyLayers(
	phase: LivePhase,
	omit: readonly LiveSectionId[] = [],
): {
	id: LiveLayerId;
	titleKey: MessageKey;
	leadKey: MessageKey;
	helpKey?: MessageKey;
	sections: LiveSectionId[];
}[] {
	const dropped = new Set<LiveSectionId>([...LEAD_SECTIONS[phase], ...omit]);
	return LIVE_LAYERS.map((layer) => ({
		id: layer.id,
		titleKey: layer.titleKey,
		leadKey: layer.leadKey,
		...(layer.helpKey ? { helpKey: layer.helpKey } : {}),
		sections: layer.sections.filter((id) => !dropped.has(id)),
	})).filter((layer) => layer.sections.length > 0);
}

/**
 * The full top-to-bottom order for a phase: the header's action anchor, then
 * the phase lead, then every rendered layer's sections.
 */
export function liveSectionOrder(
	phase: LivePhase,
	omit: readonly LiveSectionId[] = [],
): LiveSectionId[] {
	const dropped = new Set(omit);
	const lead = LEAD_SECTIONS[phase].filter((id) => !dropped.has(id));
	return [
		"sec-actions",
		...lead,
		...(phase === "prepare"
			? []
			: PANEL_SECTIONS.filter((id) => !dropped.has(id))),
		...liveBodyLayers(phase, omit).flatMap((layer) => layer.sections),
	];
}
