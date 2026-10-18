import { describe, expect, it } from "vitest";
import { MAX_SUBTITLE_XML_BYTES, validateSubtitleXml } from "./subtitle-xml";

const NS = "http://www.w3.org/ns/ttml";
describe("TTML subtitle XML validation", () => {
	it.each([
		`<tt xmlns="${NS}"/>`,
		`<?xml version="1.0"?><!-- retained --><tt xmlns="${NS}"><body><div><p begin="00:00:01.000" end="00:00:03.000" style="s1">IMSC 最初の字幕 &amp; &lt; &gt; &quot; &apos; &#65; &#x1F600;</p></div></body></tt>`,
		`<t:tt xmlns:t="${NS}"><t:body><t:div><t:p><![CDATA[Literal &unknown; text]]></t:p></t:div></t:body></t:tt>`,
	])("accepts valid TTML without requiring a cue", (xml) => {
		expect(validateSubtitleXml(xml).valid).toBe(true);
	});
	it.each([
		`<tt xmlns="${NS}"><body><p end="00:00:03.000"style="s1">cue</p></body></tt>`,
		`<tt xmlns="${NS}"><body></tt>`,
		`<tt xmlns="${NS}" invalid/>`,
		`<tt xmlns="${NS}"/><tt xmlns="${NS}"/>`,
		`<html/>`,
		`<tt/>`,
		`<tt xmlns="urn:wrong"/>`,
		"",
		`<!DOCTYPE tt [<!ENTITY x SYSTEM "file:///private">]><tt xmlns="${NS}"/>`,
	])("rejects malformed, non-TTML or unsafe XML", (xml) => {
		expect(validateSubtitleXml(xml).valid).toBe(false);
	});
	it("bounds UTF-8 bytes before XML parsing", () => {
		expect(
			validateSubtitleXml("あ".repeat(Math.ceil(MAX_SUBTITLE_XML_BYTES / 3)))
				.detail,
		).toContain("8 MiB");
	});
});
