/** Masks the password of URL userinfo: `scheme://user:pass@host`. */
const URL_USERINFO = /([/\\]{2}[^/\\:@]+:)[^/\\]*@/g;

export const REDACTED = "[REDACTED]";

export function maskUrlUserinfo(value: string): string {
	return value.replace(URL_USERINFO, `$1${REDACTED}@`);
}
/** Both historical Worker masks are deterministic. The oldest replaced
 * through the first @ and its successor through the last @ in a segment. */
export function matchesHistoricalUserinfoMask(
	actual: string,
	compiled: string,
) {
	if (!actual.includes(REDACTED) || actual === compiled) return false;
	return (
		actual === maskUrlUserinfo(compiled) ||
		actual === compiled.replace(/(\/\/[^/\s:@]+:)[^@/\s]+@/g, `$1${REDACTED}@`)
	);
}
