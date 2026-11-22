import { notFound } from "next/navigation";
import { loadAuthConfig } from "@/lib/auth/config";
import { localizedTitle } from "@/lib/i18n/metadata";
import { ExperimentsClient } from "./experiments-client";

export const generateMetadata = localizedTitle("experiments.title");

export default function EncodingExperimentsPage() {
	const auth = loadAuthConfig();
	if (!auth.ok || auth.settings.mode === "none") notFound();
	return <ExperimentsClient />;
}
