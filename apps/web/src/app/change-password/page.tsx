import { localizedTitle } from "@/lib/i18n/metadata";
import { RotateForm } from "./rotate-form";

export const generateMetadata = localizedTitle("pageTitles.changePassword");

/** Forced-rotate screen (#32 §3c): the ONE page a mustChangePassword session
 * may reach — the gate bounces every other path here. Also reachable
 * voluntarily by any signed-in user who wants a new password. */
export default function ChangePasswordPage() {
	return <RotateForm />;
}
