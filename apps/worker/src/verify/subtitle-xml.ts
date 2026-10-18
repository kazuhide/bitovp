import { XMLParser, XMLValidator } from "fast-xml-parser";

/** Matches the verification adapter's maximum text-object read. */
export const MAX_SUBTITLE_XML_BYTES = 8 * 1024 * 1024;
const TTML_NAMESPACE = "http://www.w3.org/ns/ttml";
type XmlNode = Record<string, unknown>;
export type SubtitleXmlValidation = { valid: boolean; detail: string };

/** XMLValidator syntax checks and TTML root, not full IMSC profile conformance. */
export function validateSubtitleXml(xml: string): SubtitleXmlValidation {
	const fail = (detail: string): SubtitleXmlValidation => ({
		valid: false,
		detail,
	});
	if (Buffer.byteLength(xml, "utf8") > MAX_SUBTITLE_XML_BYTES)
		return fail("Subtitle XML exceeds the 8 MiB verification limit");
	// DTD/entity declarations are unnecessary for TTML and must never expand.
	if (/<!DOCTYPE\b/i.test(xml))
		return fail("Subtitle XML must not contain a DOCTYPE");
	const validation = XMLValidator.validate(xml, {
		allowBooleanAttributes: false,
	});
	if (validation !== true) {
		const { code, line, col } = validation.err;
		return fail(
			`Malformed subtitle XML (${code}) at line ${line}, column ${col}`,
		);
	}
	try {
		const document: XmlNode[] = new XMLParser({
			preserveOrder: true,
			ignoreAttributes: false,
			parseTagValue: false,
			parseAttributeValue: false,
			processEntities: false,
			ignoreDeclaration: true,
			ignorePiTags: true,
			commentPropName: "#comment",
		}).parse(xml);
		const roots = document.filter((node) => !Object.hasOwn(node, "#comment"));
		const root = roots[0];
		const name = root && Object.keys(root).find((key) => key !== ":@");
		const names = name?.split(":") ?? [];
		const attributes = root?.[":@"] as Record<string, string> | undefined;
		const namespace =
			attributes?.[names.length === 2 ? `@_xmlns:${names[0]}` : "@_xmlns"];
		if (
			roots.length !== 1 ||
			names.length > 2 ||
			names.at(-1) !== "tt" ||
			namespace !== TTML_NAMESPACE
		)
			return fail("Subtitle XML must have one tt root in the TTML namespace");
		return {
			valid: true,
			detail: "Subtitle XML passes validation and has a TTML root",
		};
	} catch {
		return fail("Subtitle XML could not be parsed");
	}
}
