import { CREDENTIAL_PROVIDERS } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	liveOutputKindForProvider,
	outputKindForProvider,
} from "@/app/vod/new/stream-model";
import type { LiveWizardState } from "./build-live-plan";

/**
 * Every destination the live plan can express must be REACHABLE from the form.
 *
 * The owner, 2026-08-21: an MSL4 credential was created and the live channel
 * screen greyed it out. It had been unreachable since the refactor that made
 * MSL a credential — which deleted the bespoke destination selector on the
 * correct premise that "the credential picker sets the kind", and then never
 * added the case that makes that true. `storageKindForProvider` returned null,
 * `outputSelectable` read null as "not an output", and the one credential an
 * Akamai live customer has was disabled.
 *
 * Nothing failed. The plan schema knew AKAMAI_MSL, the compiler emitted it, a
 * golden fixture pinned it, C31 validated it, and the round-trip through
 * `live-plan-to-wizard` restored it — every one of those paths starts from a
 * plan that ALREADY has an MSL output. Not one of them starts where a person
 * does, at the dropdown.
 *
 * So this test goes the other way: from the kinds the state can hold to the
 * providers that produce them. A kind no provider maps to is a destination
 * that exists everywhere except in the UI.
 */

/**
 * Derived from the union in `build-live-plan.ts` — a Record with no index
 * signature, so adding a kind to that union makes THIS file a type error until
 * the new kind is classified. A hand-written array would have gone stale in
 * exactly the way the feature did.
 */
const LIVE_OUTPUT_KINDS: Record<LiveWizardState["output"]["kind"], true> = {
	S3: true,
	AZURE: true,
	SFTP: true,
	GENERIC_S3: true,
	GCS: true,
	GCS_SERVICE_ACCOUNT: true,
	AKAMAI_NETSTORAGE: true,
	AKAMAI_MSL: true,
	LIVE_MEDIA_INGEST: true,
};

describe("every live output kind is reachable from a credential", () => {
	it("maps at least one provider to each kind", () => {
		const reachable = new Set(
			CREDENTIAL_PROVIDERS.map((p) => liveOutputKindForProvider(p)).filter(
				(k): k is NonNullable<typeof k> => k !== null,
			),
		);
		const unreachable = Object.keys(LIVE_OUTPUT_KINDS).filter(
			(kind) => !reachable.has(kind as never),
		);
		expect(
			unreachable,
			"a destination the plan can express but no credential can select — this is how MSL was greyed out for an Akamai customer",
		).toEqual([]);
	});

	it("makes an MSL credential selectable, by name", () => {
		// Stated on its own because it is the specific report, and because the
		// loop above would still pass if some OTHER provider happened to produce
		// AKAMAI_MSL.
		expect(liveOutputKindForProvider("AKAMAI_MSL")).toBe("AKAMAI_MSL");
	});

	it("keeps MSL OUT of the VOD mapping", () => {
		// The other direction, and it matters: a VOD encoding cannot deliver to
		// MSL (no bucket, no path — live-to-VOD refuses it outright). Widening
		// the shared mapping instead of adding a live one would have made an
		// impossible VOD output selectable, which is a worse bug than the one
		// being fixed because it fails at submit rather than at the dropdown.
		expect(outputKindForProvider("AKAMAI_MSL")).toBeNull();
	});

	it("still refuses providers that are not storage at all", () => {
		// The guard must not have been satisfied by making everything selectable.
		for (const provider of ["DRM_CENC", "KANTAR", "NOTIFICATION_WEBHOOK"]) {
			expect(liveOutputKindForProvider(provider), provider).toBeNull();
		}
	});
});
