import type { LocalStoryTrailerIntent } from "@bitovp/core";
import { wholeFramesForDuration } from "./generation-settings";

const trailer = /予告(?:編|動画|映像)|トレーラー|\b(?:trailer|teaser)\b/gu;
const japaneseDuration =
	/(?<value>\d+(?:\.\d+)?|[一二三四五六七八九十百]+)\s*秒\s*(?<modifier>以内|以下|ちょうど|丁度|ぴったり|程度|くらい)?/gu;
const englishDuration =
	/(?:(?<prefix>up to|at most|within|exactly|about|around)\s+)?(?<value>\d+(?:\.\d+)?)\s*-?\s*(?:seconds?|secs?|s)\b(?:\s+(?<suffix>exactly))?/gu;
const setupOnly =
	/(?:導入|冒頭)(?:だけ|のみ)|\b(?:setup|introduction) only\b/gu;
const setupAndQuestion =
	/導入と(?:未解決の)?問いまで|\bsetup and (?:the )?open question\b/gu;
const spoilerAvoidance =
	/ネタバレ(?:を|は)?(?:避けて|防いで|しないで|なし(?:で)?)|(?:結末|核心)(?:を|は)(?:伏せて|明かさ(?:ないで|ず)|見せないで)|\b(?:spoiler[- ]free|avoid spoilers?|no spoilers?|without spoilers?|do not reveal the ending|keep the ending hidden)\b/gu;
const requestWords =
	/作って(?:ください)?|作成(?:して(?:ください)?)?|制作(?:して(?:ください)?)?|生成(?:して(?:ください)?)?|お願いします|お願い|ください|\b(?:make|create|draft|plan|generate|please|a|an|the|of|with|in|long|for|me)\b/gu;

type BriefError =
	| "TRAILER_REQUIRED"
	| "DURATION_REQUIRED"
	| "INVALID_DURATION"
	| "UNSUPPORTED";
export type TrailerBriefResult =
	| { ok: true; seconds: number; intent: LocalStoryTrailerIntent }
	| { ok: false; reason: BriefError };

function readSeconds(value: string): number {
	if (/^\d/u.test(value)) return Number(value);
	const parts =
		/^(?:(?<hundreds>[一二三四五六七八九]?)百)?(?:(?<tens>[一二三四五六七八九]?)十)?(?<ones>[一二三四五六七八九])?$/u.exec(
			value,
		)?.groups;
	if (!parts) return Number.NaN;
	const digit = (part: string | undefined) =>
		part === undefined
			? 0
			: part === ""
				? 1
				: "〇一二三四五六七八九".indexOf(part);
	return (
		digit(parts.hundreds) * 100 + digit(parts.tens) * 10 + digit(parts.ones)
	);
}

/** Interpret the supported editing instructions. Unknown requirements need explicit review. */
export function parseTrailerBrief(prompt: string): TrailerBriefResult {
	const normalized = prompt
		.normalize("NFKC")
		.trim()
		.toLowerCase()
		.replace(/[‐‑–]/gu, "-");
	if (normalized.length > 512) return { ok: false, reason: "UNSUPPORTED" };
	if (normalized.replace(trailer, "") === normalized)
		return { ok: false, reason: "TRAILER_REQUIRED" };
	const durations = [
		...normalized.matchAll(japaneseDuration),
		...normalized.matchAll(englishDuration),
	];
	if (durations.length > 1) return { ok: false, reason: "UNSUPPORTED" };
	const duration = durations[0];
	if (!duration?.groups?.value)
		return { ok: false, reason: "DURATION_REQUIRED" };
	const seconds = readSeconds(duration.groups.value);
	if (wholeFramesForDuration(String(seconds)) === null)
		return { ok: false, reason: "INVALID_DURATION" };
	const qualifier =
		duration.groups.modifier ??
		duration.groups.prefix ??
		duration.groups.suffix ??
		"";
	if (
		duration.groups.prefix &&
		duration.groups.suffix &&
		duration.groups.prefix !== "exactly"
	)
		return { ok: false, reason: "UNSUPPORTED" };
	const durationMode = ["以内", "以下", "up to", "at most", "within"].includes(
		qualifier,
	)
		? "UP_TO"
		: ["exactly", "ちょうど", "丁度", "ぴったり"].includes(qualifier)
			? "EXACT"
			: "TARGET";
	const withoutSetupOnly = normalized.replace(setupOnly, "");
	const setupOnlyRequested = withoutSetupOnly !== normalized;
	if (
		setupOnlyRequested &&
		normalized.replace(setupAndQuestion, "") !== normalized
	)
		return { ok: false, reason: "UNSUPPORTED" };
	const unclaimed = withoutSetupOnly
		.replace(duration[0], "")
		.replace(trailer, "")
		.replace(setupAndQuestion, "")
		.replace(spoilerAvoidance, "")
		.replace(requestWords, "")
		.replace(/[\s、。,.!！?？「」『』"“”]+/gu, "");
	if (!/^[をのではに]*$/u.test(unclaimed))
		return { ok: false, reason: "UNSUPPORTED" };
	return {
		ok: true,
		seconds,
		intent: {
			durationMode,
			disclosure: setupOnlyRequested ? "SETUP_ONLY" : "SETUP_AND_QUESTION",
		},
	};
}
