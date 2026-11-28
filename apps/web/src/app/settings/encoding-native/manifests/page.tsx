import { localizedTitle } from "@/lib/i18n/metadata";
import { NativeManifestClient } from "./native-manifest-client";

export const generateMetadata = localizedTitle("jobDetail.manifests");

export default function NativeManifestsPage() {
	return <NativeManifestClient />;
}
