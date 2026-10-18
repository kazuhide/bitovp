import {
	compileLiveChannel,
	liveChannelPlanSchema,
	validateLiveChannel,
} from "@bitovp/core";
import type { Translator } from "@/lib/i18n/context";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";
import type { LivePlanEvaluation } from "./live-plan-preview";

/**
 * Expert-mode live plan import — the VOD wizard's pressure valve applied
 * to LiveChannelPlan JSON (e.g. a live golden fixture or a hand-written
 * plan). The submission payload is the imported object verbatim (the
 * server re-parses); the accountId injection exception is shared with the
 * VOD module (plan-import.ts buildSubmissionPlan/importedAccountId).
 */

export type ImportedLivePlan = {
	/** Exactly what was pasted (post-JSON.parse) — the submission payload. */
	raw: Record<string, unknown>;
	evaluation: LivePlanEvaluation;
};

export type LiveImportResult =
	| {
			ok: false;
			/**
			 * A message KEY — this is a module helper with no translator. Narrowed to
			 * the two it can produce, so the render site's `errorDetail` handling is
			 * checkable by the compiler rather than by inspection.
			 */
			errorKey: "wizardX.importNotValidJson" | "wizardX.importLiveMustBeObject";
			/** Untranslated parser detail, spliced into the key when present. */
			errorDetail?: string | null;
	  }
	| { ok: true; imported: ImportedLivePlan };

export function parseImportedLivePlan(
	text: string,
	translate?: Translator,
): LiveImportResult {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return {
			ok: false,
			errorKey: "wizardX.importNotValidJson",
			errorDetail: err instanceof Error ? err.message : null,
		};
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, errorKey: "wizardX.importLiveMustBeObject" };
	}
	const parsed = liveChannelPlanSchema.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.slice(0, 3)
			.map(
				(issue) =>
					`${issue.path.join(".")}: ${translate ? zodIssueMessage(issue, translate) : issue.message}`,
			)
			.join("; ");
		return {
			ok: true,
			imported: {
				raw: raw as Record<string, unknown>,
				evaluation: { ok: false, zodMessage: issues || "Plan is incomplete" },
			},
		};
	}
	const issues = validateLiveChannel(parsed.data);
	const ops = issues.some((i) => i.level === "error")
		? []
		: compileLiveChannel(parsed.data);
	return {
		ok: true,
		imported: {
			raw: raw as Record<string, unknown>,
			evaluation: { ok: true, plan: parsed.data, issues, ops },
		},
	};
}
