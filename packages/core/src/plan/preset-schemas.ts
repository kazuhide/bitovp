import { z } from "zod";
import { liveChannelPlanSchema } from "../live/schema";
import { qcGateSchema } from "./qc-gate";
import { encodingPlanSchema } from "./schema";

/**
 * User plan presets . A saved preset is a `FULL_PLAN`
 * `Preset` row whose `body` is an EncodingPlan JSON — the SAME secret-free
 * document as the 56 built-in samples and the raw-JSON import surface
 * (credentials are `credentialId` refs; no keys live in the plan). The wizard
 * saves the currently-built plan; the gallery lists/loads/deletes them.
 *
 * Contracts live in core (the shared contract): the route validates the request with
 * `createPlanPresetSchema` and returns rows shaped by the wire schemas below.
 */

/**
 * Save-as-preset request. `plan` is parsed with the full `encodingPlanSchema`
 * so an invalid plan is rejected at the boundary (the route additionally runs
 * `validatePlan`/`planHasErrors` for cross-field constraints → 400).
 */
/**
 * Delivery-spec metadata : the constraints table + advisory gate
 * an imported delivery preset carries BESIDE its plan (Preset.spec column —
 * body stays the bare plan for every existing consumer).
 */
export const deliverySpecMetaSchema = z.object({
	constraints: z
		.array(
			z.object({
				requirement: z.string().min(1),
				path: z.string().min(1),
				expect: z.object({
					eq: z.unknown().optional(),
					gte: z.number().optional(),
					lte: z.number().optional(),
					oneOf: z.array(z.unknown()).optional(),
				}),
			}),
		)
		.min(1)
		// review-205 N7: unbounded constraint lists run on every wizard
		// render; 200 is far beyond any real spec and cheap to check.
		.max(200),
	suggestedGate: qcGateSchema.optional(),
	sources: z.array(z.string()).optional(),
});
export type DeliverySpecMeta = z.infer<typeof deliverySpecMetaSchema>;

export const createPlanPresetSchema = z.object({
	name: z.string().min(1, "Name is required").max(120),
	description: z.string().max(2000).optional(),
	plan: encodingPlanSchema,
	/** Delivery-preset grouping ; free string, org vocabulary. */
	category: z.string().min(1).max(40).optional(),
	/** Present iff the save is an imported delivery preset. */
	spec: deliverySpecMetaSchema.optional(),
});

export type CreatePlanPresetRequest = z.infer<typeof createPlanPresetSchema>;

/**
 * Launch-form defaults a template carries  — token templates
 * consumed by the launcher (rendered via `renderTemplateOutputPrefix`), never
 * by the plan itself. Kept beside `body`, not inside it, for the same reason
 * `spec` is: body stays a bare EncodingPlan for every existing consumer.
 */
export const presetLaunchDefaultsSchema = z.object({
	outputPrefixTemplate: z.string().min(1).max(300).optional(),
	nameTemplate: z.string().min(1).max(200).optional(),
});
export type PresetLaunchDefaults = z.infer<typeof presetLaunchDefaultsSchema>;

/**
 * Re-edit request : PATCH /api/presets/[id].
 *
 * - `expectedUpdatedAt` is the compare-and-set token — the row's updatedAt as
 *   the client last read it (ISO). A lost race is a 409, never a silent
 *   last-writer-wins.
 * - The wire field for the body is `plan`, matching `createPlanPresetSchema`
 *   (the design §5 sketch wrote `body` after the Prisma column; the API
 *   family's existing noun wins on the wire).
 * - `description`/`launchDefaults`: absent = unchanged, null = clear.
 * - At least one mutable field must be present — an all-absent PATCH would
 *   still bump updatedAt and invalidate other editors' CAS for nothing.
 */
export const patchPlanPresetSchema = z
	.object({
		name: z.string().min(1, "Name is required").max(120).optional(),
		description: z.string().max(2000).nullable().optional(),
		plan: encodingPlanSchema.optional(),
		launchDefaults: presetLaunchDefaultsSchema.nullable().optional(),
		expectedUpdatedAt: z.iso.datetime(),
	})
	.refine(
		(v) =>
			v.name !== undefined ||
			v.description !== undefined ||
			v.plan !== undefined ||
			v.launchDefaults !== undefined,
		{ message: "Nothing to update" },
	);
export type PatchPlanPresetRequest = z.infer<typeof patchPlanPresetSchema>;

/**
 * FULL_PLAN is a job template containing EncodingPlan. LIVE_PLAN is a channel
 * template containing LiveChannelPlan. Partial presets are not templates.
 */
export const templateKindSchema = z.enum(["FULL_PLAN", "LIVE_PLAN"]);
export type TemplateKind = z.infer<typeof templateKindSchema>;

/**
 * Save-as-live-template request from the channel detail screen.
 * The route also validates that the LiveChannelPlan can reopen in the form,
 * using the same rule as a saved FULL_PLAN template.
 */
export const createLivePresetSchema = z.object({
	name: z.string().min(1, "Name is required").max(120),
	description: z.string().max(2000).optional(),
	plan: liveChannelPlanSchema,
});
export type CreateLivePresetRequest = z.infer<typeof createLivePresetSchema>;

/**
 * Live re-edit request : same CAS/bump semantics as
 * `patchPlanPresetSchema`, live plan body. The route picks the schema by the
 * ROW's kind — a LIVE_PLAN row's plan field must parse as a live plan.
 */
export const patchLivePresetSchema = z
	.object({
		name: z.string().min(1, "Name is required").max(120).optional(),
		description: z.string().max(2000).nullable().optional(),
		plan: liveChannelPlanSchema.optional(),
		launchDefaults: presetLaunchDefaultsSchema.nullable().optional(),
		expectedUpdatedAt: z.iso.datetime(),
	})
	.refine(
		(v) =>
			v.name !== undefined ||
			v.description !== undefined ||
			v.plan !== undefined ||
			v.launchDefaults !== undefined,
		{ message: "Nothing to update" },
	);
export type PatchLivePresetRequest = z.infer<typeof patchLivePresetSchema>;

/** Lean list row — no `body` (the gallery only needs id/name/description). */
export const planPresetSummaryWireSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	description: z.string().nullable(),
	/** Delivery-preset grouping ; null for plain plan presets. */
	category: z.string().nullable().optional(),
	createdAt: z.string(),
	/** Template provenance/list display . */
	revision: z.number().int(),
	updatedAt: z.string(),
	/** Uses counts : COUNT over provenance, never stored. */
	_count: z
		.object({
			encodingJobs: z.number().int(),
			liveChannels: z.number().int(),
			watchRules: z.number().int(),
		})
		.optional(),
});

export type PlanPresetSummaryWire = z.infer<typeof planPresetSummaryWireSchema>;
