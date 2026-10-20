export function prepareStaticHtml(html: string, interactive: boolean) {
	if (!interactive) {
		html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
	}
	// Preloads can fetch JavaScript even when scripting is disabled. The landing
	// module still imports its dependencies normally when scripting is enabled.
	return html.replace(
		/<link\b(?=[^>]*\s(?:rel\s*=\s*["']modulepreload["']|as\s*=\s*["']script["']))[^>]*>/gi,
		"",
	);
}
