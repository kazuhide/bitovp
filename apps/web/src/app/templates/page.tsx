import { redirect } from "next/navigation";
import { localizedTitle } from "@/lib/i18n/metadata";

export const generateMetadata = localizedTitle("pageTitles.templates");

/** Preserve bookmarks and wizard return links through the canonical hub. */
export default function TemplatesPage() {
	redirect("/presets?tab=templates");
}
