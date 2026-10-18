import "server-only";
import { version } from "../../../package.json";

/** Public identity of this Web process only, not other services or encoders. */
export type WebBuildInfo = {
	version: string;
	commit: string | null;
};

/** Read inside a dynamic server page, never at module initialization. */
export function getWebBuildInfo(): WebBuildInfo {
	const commit = process.env.BITOVP_COMMIT;
	return {
		version,
		commit:
			commit?.length === 40 && /^[0-9a-f]{40}$/i.test(commit) ? commit : null,
	};
}
