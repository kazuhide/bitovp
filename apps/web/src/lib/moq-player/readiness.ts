import { z } from "zod";

export const moqReadinessSchema = z.strictObject({
	status: z.enum([
		"ready",
		"publisher-only",
		"needs-configuration",
		"binding-unverified",
	]),
	issues: z.array(
		z.enum([
			"credential-unavailable",
			"namespace-unsupported",
			"subscriber-url-missing",
			"subscriber-url-invalid",
			"subscribe-only-required",
			"subscriber-expired",
			"subscriber-draft-mismatch",
			"player-license-unavailable",
			"player-bundle-unavailable",
		]),
	),
});

export type MoqReadiness = z.infer<typeof moqReadinessSchema>;
export type MoqReadinessTarget =
	| { channelId: string }
	| {
			credentialId: string;
			draftVersion: "DRAFT_16" | "DRAFT_18";
			namespaceComponents: number;
	  };
