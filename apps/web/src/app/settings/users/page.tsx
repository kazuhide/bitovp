import { localizedTitle } from "@/lib/i18n/metadata";
import { UsersClient } from "./users-client";

export const generateMetadata = localizedTitle("pageTitles.users");

export default function UsersPage() {
	return <UsersClient />;
}
