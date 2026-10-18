import { parseFeederError } from "@bitovp/core";
import type { MessageKey } from ".";
import type { Translator } from "./context";
import { mediaDifferencesMessage } from "./media-difference";

/**
 * Render a stored feeder / slate refusal (`FeederSession.error` or
 * `LiveSchedule.error`) for the operator .
 *
 * - A STRUCTURED payload (`{code, params}` JSON, written by the live ingest
 *   gates) is translated: `feederError.<code>` with its params. A
 *   `sourceMismatch` first resolves its `originKind` to the localized
 *   parenthetical, then interpolates it as `{origin}`.
 * - A LEGACY plain string can contain worker/provider prose, so customer
 *   surfaces receive a locale-owned generic failure. The stored forensic
 *   value remains available only through the ADMIN diagnostics response.
 *
 * NEVER throws. `translate` throws on a missing catalogue key or an unfilled
 * `{placeholder}`; a malformed structured error (a param the writer forgot, a
 * bad `originKind`) is caught here and falls back to localized generic copy, so a
 * panel renders something safe rather than crashing.
 */
export function feederErrorMessage(t: Translator, stored: string): string {
	const parsed = parseFeederError(stored);
	if (!parsed) return t("feeder.internalFailure");
	try {
		const values: Record<string, string | number> = { ...parsed.params };
		if (parsed.differences)
			values.differences = mediaDifferencesMessage(
				t,
				parsed.differences,
				parsed.code === "sourceMismatch",
			);
		if (parsed.code === "sourceMismatch") {
			// The reference kind is a code, not prose — resolve it through the
			// catalogue before interpolating the sentence.
			values.origin = t(
				`feederError.origin.${parsed.params.originKind}` as MessageKey,
			);
			delete values.originKind;
		}
		return t(`feederError.${parsed.code}` as MessageKey, values);
	} catch {
		return t("feeder.internalFailure");
	}
}

/**
 * Legacy rows can contain implementation diagnostics written before feeder
 * failures became structured/localizable. Customer feeder screens must not
 * expose process names, signals, command-line flags or repository identity;
 * the raw value remains available through the ADMIN Diagnostics response.
 *
 * Structured ingest-gate errors retain their actionable detail. This is a
 * display boundary, not a mutation of the stored forensic record.
 */
export function customerFeederErrorMessage(
	t: Translator,
	stored: string,
): string {
	if (parseFeederError(stored)) {
		return feederErrorMessage(t, stored);
	}
	return t("feeder.internalFailure");
}
