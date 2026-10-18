import { loadAuthConfig } from "@/lib/auth/config";
import { ensureSetupCode } from "@/lib/auth/setup-code";
import { anyUsersExist } from "@/lib/auth/users";
import { localizedTitle } from "@/lib/i18n/metadata";
import { SetupForm } from "./setup-form";

export const generateMetadata = localizedTitle("pageTitles.setup");

/** The gate only lets this render under users-mode ∧ zero-users (#32 §3c) —
 * every other state redirects before the component runs. The re-check here
 * is belt-and-braces for direct rendering paths, and the DB read at request
 * time is the point: prerendering a setup page would freeze the world. */
export const dynamic = "force-dynamic";

export default async function SetupPage() {
	const config = loadAuthConfig();
	if (config.ok && config.settings.mode === "users") {
		const populated = await anyUsersExist();
		if (!populated) {
			// Lazy mint-on-visit : create-if-absent, print ONCE at mint —
			// re-printing on every load would put the code in the log N times
			// for one use. The "setup-code" token is what the UI hint greps.
			const { minted } = await ensureSetupCode();
			if (minted) {
				console.log(
					`[auth] setup-code: ${minted} (valid 60 minutes; enter it at /setup)`,
				);
			}
		}
	}
	return <SetupForm />;
}
