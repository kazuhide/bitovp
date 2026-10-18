import { Suspense } from "react";
import { localizedTitle } from "@/lib/i18n/metadata";
import { LoginForm } from "./login-form";

export const generateMetadata = localizedTitle("pageTitles.signIn");

export default function LoginPage() {
	return (
		<Suspense fallback={null}>
			<LoginForm />
		</Suspense>
	);
}
