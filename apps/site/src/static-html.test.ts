import { expect, it } from "vitest";
import { prepareStaticHtml } from "./static-html";

const moduleScript =
	'<script type="module" crossorigin src="/assets/index.js"></script>';
const content =
	'<link rel="stylesheet" href="/assets/index.css"><link rel="preload" as="image" href="/image.png"><main><a href="/guide/">Guide</a></main>';

it.each([
	'<link rel="modulepreload" crossorigin href="/assets/rolldown-runtime-CNC7AqOf.js">',
	"<link href='/assets/runtime.js' rel='modulepreload'>",
	'<link rel="preload" as="script" href="/assets/runtime.js">',
	'<link href="/assets/runtime.js" as="script" rel="preload">',
])("removes script preload %s from landing and guide HTML", (preload) => {
	for (const interactive of [true, false]) {
		const result = prepareStaticHtml(
			content + preload + moduleScript,
			interactive,
		);
		expect(result).toBe(content + (interactive ? moduleScript : ""));
	}
});

it("preserves the landing module and its normal import path", () => {
	expect(prepareStaticHtml(content + moduleScript, true)).toBe(
		content + moduleScript,
	);
});

it("removes inline and external guide scripts while retaining guide content", () => {
	expect(
		prepareStaticHtml(
			`${content}<script>window.example = true;</script>${moduleScript}`,
			false,
		),
	).toBe(content);
});
