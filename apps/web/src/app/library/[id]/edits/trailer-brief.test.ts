import { expect, it } from "vitest";
import { parseTrailerBrief } from "./trailer-brief";

it.each([
	[
		"予告編を30秒で作って。ネタバレを避けて",
		30,
		"TARGET",
		"SETUP_AND_QUESTION",
	],
	[
		"ネタバレなしで三十秒以内の予告編をお願いします。",
		30,
		"UP_TO",
		"SETUP_AND_QUESTION",
	],
	[
		"結末は伏せて、３０秒ぴったりの予告動画を作ってください。導入だけ。",
		30,
		"EXACT",
		"SETUP_ONLY",
	],
	[
		"Make a 30-second spoiler-free trailer.",
		30,
		"TARGET",
		"SETUP_AND_QUESTION",
	],
	[
		"Make a trailer with no spoilers in up to 30 seconds.",
		30,
		"UP_TO",
		"SETUP_AND_QUESTION",
	],
	[
		"Create a trailer exactly 30 seconds long, setup only.",
		30,
		"EXACT",
		"SETUP_ONLY",
	],
])("interprets %s", (prompt, seconds, durationMode, disclosure) => {
	expect(parseTrailerBrief(prompt)).toEqual({
		ok: true,
		seconds,
		intent: { durationMode, disclosure },
	});
});

it.each([
	["30秒でハイライトを作って", "TRAILER_REQUIRED"],
	["ネタバレなしの予告編", "DURATION_REQUIRED"],
	["0秒の予告編", "INVALID_DURATION"],
	["190秒の予告編", "INVALID_DURATION"],
	["30秒と60秒で予告編を作って", "UNSUPPORTED"],
	["30秒以内で、ちょうど30秒の予告編", "UNSUPPORTED"],
	["30秒の予告編。結末も見せて", "UNSUPPORTED"],
	["Create a 30-second trailer featuring Alex.", "UNSUPPORTED"],
])("does not silently discard constraints in %s", (prompt, reason) => {
	expect(parseTrailerBrief(prompt)).toEqual({ ok: false, reason });
});
