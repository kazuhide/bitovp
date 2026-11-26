import type { EncodingOutput } from "@bitmovin/api-sdk";

/** Role-based publication requires the explicit ACL for each destination path. */
export function roleOutputAclsMatch(
	roleOutputIds: readonly string[] | undefined,
	expected: readonly EncodingOutput[] | undefined,
	observed: readonly EncodingOutput[] | undefined,
): boolean {
	if (!roleOutputIds?.length) return true;
	return roleOutputIds.every((id) => {
		const targets = expected?.filter((output) => output.outputId === id);
		const found = observed?.filter((output) => output.outputId === id);
		if (!targets?.length || found?.length !== targets.length) return false;
		return targets.every((target) => {
			const matches = found.filter(
				(output) => output.outputPath === target.outputPath,
			);
			const grant = matches[0]?.acl;
			const requested = target.acl?.[0]?.permission;
			return (
				target.outputPath !== undefined &&
				matches.length === 1 &&
				target.acl?.length === 1 &&
				requested !== undefined &&
				grant?.length === 1 &&
				grant[0]?.permission === requested
			);
		});
	});
}
