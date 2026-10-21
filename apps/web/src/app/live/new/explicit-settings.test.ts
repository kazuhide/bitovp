import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileLiveChannel,
	liveChannelPlanSchema,
	validateLiveChannel,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "./build-live-plan";
import {
	planToLiveWizardState,
	tryImportLiveChannelIntoWizard,
} from "./live-plan-to-wizard";

function channel() {
	return liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
				),
				"utf8",
			),
		),
	);
}

describe("Live wizard explicit settings", () => {
	it("keeps untouched restart settings absent", () => {
		const state = planToLiveWizardState(channel());
		state.start.autoRestart = structuredClone(
			DEFAULT_LIVE_WIZARD_STATE.start.autoRestart,
		);
		expect(buildLiveChannelPlan(state).start.autoRestart).toBeUndefined();
	});

	it.each([
		false,
		true,
	])("preserves restartOnEncoderError=%s through import and compilation", (restartOnEncoderError) => {
		const plan = channel();
		plan.start.autoRestart = { restartOnEncoderError };
		const state = planToLiveWizardState(plan);
		const rebuilt = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
		expect(rebuilt).toEqual(plan);
		expect(tryImportLiveChannelIntoWizard(plan).ok).toBe(true);
		expect(
			compileLiveChannel(rebuilt).find(
				(operation) => operation.kind === "START_LIVE_ENCODING",
			)?.payload.autoRestartConfiguration,
		).toEqual({ restartOnEncoderError });
	});

	it("emits false after an enabled restart option is cleared", () => {
		const state = planToLiveWizardState(channel());
		state.start.autoRestart.restartOnEncoderError = false;
		expect(
			buildLiveChannelPlan(state).start.autoRestart?.restartOnEncoderError,
		).toBe(false);
	});

	it("preserves explicit PRIVATE destinations through import", () => {
		const plan = channel();
		for (const entry of [...plan.muxings, ...plan.liveManifests]) {
			if (entry.destination) entry.destination.acl = "PRIVATE";
		}
		const rebuilt = liveChannelPlanSchema.parse(
			buildLiveChannelPlan(planToLiveWizardState(plan)),
		);
		expect(rebuilt).toEqual(plan);
		expect(tryImportLiveChannelIntoWizard(plan).ok).toBe(true);
		expect(
			validateLiveChannel(rebuilt).filter((i) => i.level === "error"),
		).toEqual([]);
		const destinations = compileLiveChannel(rebuilt)
			.filter((operation) => operation.refs.outputId)
			.map((operation) => operation.payload.acl);
		expect(destinations.length).toBeGreaterThan(0);
		expect(destinations.every((acl) => acl === "PRIVATE")).toBe(true);
	});

	it("keeps an unspecified ACL absent", () => {
		const plan = channel();
		const rebuilt = liveChannelPlanSchema.parse(
			buildLiveChannelPlan(planToLiveWizardState(plan)),
		);
		expect(rebuilt).toEqual(plan);
		expect(
			[...rebuilt.muxings, ...rebuilt.liveManifests].every(
				(entry) => entry.destination?.acl === undefined,
			),
		).toBe(true);
	});

	it("lets the public-read control override imported private destinations", () => {
		const plan = channel();
		for (const entry of [...plan.muxings, ...plan.liveManifests]) {
			if (entry.destination) entry.destination.acl = "PRIVATE";
		}
		const state = planToLiveWizardState(plan);
		state.output.publicRead = true;
		const rebuilt = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
		expect(
			[...rebuilt.muxings, ...rebuilt.liveManifests].every(
				(entry) => entry.destination?.acl === "PUBLIC_READ",
			),
		).toBe(true);
	});

	it("preserves manifest access permissions independently of segmented media", () => {
		const plan = channel();
		if (!plan.liveManifests[0]) throw new Error("missing manifest");
		plan.liveManifests[0].destination.acl = "PRIVATE";
		expect(tryImportLiveChannelIntoWizard(plan).ok).toBe(true);
		const rebuilt = liveChannelPlanSchema.parse(
			buildLiveChannelPlan(planToLiveWizardState(plan)),
		);
		expect(rebuilt).toEqual(plan);
		expect(rebuilt.liveManifests[0]?.destination.acl).toBe("PRIVATE");
		expect(rebuilt.muxings.every((m) => m.destination?.acl === undefined)).toBe(
			true,
		);
		expect(
			validateLiveChannel(rebuilt).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});

	it.each([
		"FMP4",
		"CMAF",
	] as const)("preserves private %s delivery when switching to an Origin without manifests", (container) => {
		const plan = channel();
		for (const entry of [...plan.muxings, ...plan.liveManifests]) {
			if (entry.destination) entry.destination.acl = "PRIVATE";
		}
		const state = planToLiveWizardState(plan);
		state.output = {
			...state.output,
			kind: "LIVE_MEDIA_INGEST",
			credentialId: "00000000-0000-4000-8000-000000000001",
			name: "Origin",
		};
		state.manifests.hls.enabled = false;
		state.manifests.dash.enabled = false;
		for (const row of [...state.videos, ...state.audios]) {
			row.container = container;
		}
		const origin = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
		expect(origin.liveManifests).toEqual([]);
		expect(origin.muxings.every((m) => m.destination?.acl === "PRIVATE")).toBe(
			true,
		);
		expect(
			validateLiveChannel(origin).filter((i) => i.level === "error"),
		).toEqual([]);
		expect(tryImportLiveChannelIntoWizard(origin).ok).toBe(true);
		expect(
			liveChannelPlanSchema.parse(
				buildLiveChannelPlan(planToLiveWizardState(origin)),
			),
		).toEqual(origin);
		const firstDestination = origin.muxings[0]?.destination;
		if (!firstDestination) throw new Error("missing segmented destination");
		delete firstDestination.acl;
		expect(tryImportLiveChannelIntoWizard(origin).ok).toBe(false);
	});
});
