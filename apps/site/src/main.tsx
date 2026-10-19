import { lazy, Suspense, useEffect, useState } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { LandingPage } from "./landing";
import { localeFromPath } from "./site-config";
import "./landing.css";

const DemoApp = lazy(() => import("./demo/app"));
const isDemo = () => window.location.hash.startsWith("#/demo");
const locale = localeFromPath(window.location.pathname);

function Site() {
	const [demo, setDemo] = useState(isDemo);
	useEffect(() => {
		const changed = () => setDemo(isDemo());
		window.addEventListener("hashchange", changed);
		return () => window.removeEventListener("hashchange", changed);
	}, []);
	return demo ? (
		<Suspense
			fallback={
				<p role="status">
					{locale === "ja"
						? "デモを読み込んでいます…"
						: "Loading the interactive demo…"}
				</p>
			}
		>
			<DemoApp locale={locale} />
		</Suspense>
	) : (
		<LandingPage locale={locale} />
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("The site root is missing.");
if (!isDemo() && root.querySelector(".site-landing")) {
	hydrateRoot(root, <Site />);
} else {
	createRoot(root).render(<Site />);
}
