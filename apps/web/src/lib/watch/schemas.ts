import { z } from "zod";

/**
 * Watch rule create schema  — client-safe module: the
 * settings form pre-validates with the SAME schema the route enforces
 * (the route file itself imports server context and must not be pulled
 * into the client bundle).
 */
/**
 * review-87b I-3: without a uniquifying token every object's outputs land
 * on the SAME paths — encoding #2 silently overwrites #1 in the customer's
 * bucket while both job rows read success. Shared by create AND the [id]
 * PATCH so the requirement cannot be bypassed by an update.
 */
export const watchOutputPrefixTemplateSchema = z
	.string()
	.min(1)
	.max(512)
	.refine((value) => value.includes("{basename}") || value.includes("{uuid}"), {
		// No literal {braces} here: translate treats them as placeholder
		// slots and throws when unfilled.
		message:
			"Template must contain the basename or uuid token — outputs would overwrite each other",
	});

export const watchRuleCreateSchema = z.strictObject({
	name: z
		.string()
		.min(1)
		.max(80)
		.regex(
			/^[a-z0-9][a-z0-9-]*$/,
			"Rule names are lowercase letters, digits and hyphens",
		),
	credentialId: z.uuid(),
	bucket: z.string().min(1).max(255),
	prefix: z.string().max(1024).default(""),
	extensions: z
		.array(z.string().min(1).max(16).toLowerCase())
		.max(20)
		.default([]),
	presetId: z.uuid(),
	outputPrefixTemplate: watchOutputPrefixTemplateSchema,
	labels: z.array(z.string().min(1).max(64)).max(10).default([]),
	pollIntervalSec: z.number().int().min(60).max(3_600).default(120),
	stabilityChecks: z.number().int().min(1).max(10).default(2),
	maxConcurrentJobs: z.number().int().min(1).max(20).default(3),
	enabled: z.boolean().default(true),
});

export type WatchRuleCreate = z.infer<typeof watchRuleCreateSchema>;
