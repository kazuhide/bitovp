import { describe, expect, it } from "vitest";
import { LOCALES, type MessageKey, messagesFor, translate } from ".";

const STARTUP_HINTS = [
	"nextAction.startEncoderBody",
	"nextAction.bootBody",
	"lifecycle.s2Hint",
] as const satisfies readonly MessageKey[];

describe("region-independent live startup guidance", () => {
	for (const locale of LOCALES) {
		it.each(
			STARTUP_HINTS,
		)(`${locale}: %s does not reuse a historical cohort as an estimate`, (key) => {
			const text = translate(messagesFor(locale), key);
			// These static hints have no region/profile input. A numeric duration
			// or sample count here would apply one old cohort to every channel.
			expect(text).not.toMatch(/\d\s*(?:分|秒|m|s)|\bn\s*=\s*\d/i);
			expect(text).toMatch(locale === "ja" ? /リージョン/ : /region/i);
			expect(text).toMatch(locale === "ja" ? /構成/ : /configuration/i);
		});
	}
});
