import { localizedTitle } from "@/lib/i18n/metadata";
import { NotFoundView } from "./not-found-view";

export const generateMetadata = localizedTitle("pageTitles.notFound");

/**
 * Replaces Next.js's built-in 404, which renders "This page could not be found." in
 * English regardless of locale — inside chrome that is otherwise fully translated.
 *
 * Body lives in the client component beside this one, because `useT` is a client
 * hook; same split as `page.tsx` → `dashboard-home.tsx`.
 */
export default function NotFound() {
	return <NotFoundView />;
}
