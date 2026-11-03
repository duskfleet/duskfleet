/**
 * Module resolution for the component tests (docs/development.md, "Quality gates").
 *
 * `pretest` compiles the tests and what they import with `tsc -p tsconfig.test.json` into
 * `.test-build/` (JSX to `react/jsx-runtime`, imports left as written). `node --import` loads
 * this file first; it resolves what tsc does not rewrite, for modules inside `.test-build/` only:
 * the `@/` alias, extensionless relative imports, and the Next.js modules a plain Node process
 * cannot run, which go to the stubs in `test/stubs/` (never stubbed in the component code).
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const build = new URL("../.test-build/", import.meta.url);

const STUBS = {
  "next/link": "test/stubs/next-link.js",
  "next/navigation": "test/stubs/next-navigation.js",
  // A "use server" module: it reads the database through lib/data.
  "@/app/schedules/actions": "test/stubs/schedule-actions.js",
  // A "use server" module: it writes duskfleet.yaml through core.
  "@/app/settings/actions": "test/stubs/settings-actions.js",
};

/** `./RunRow` -> `./RunRow.js`, `./lib` -> `./lib/index.js`, as a bundler would. */
function withJs(url) {
  if (/\.[cm]?js$/.test(url.pathname)) return url.href;
  for (const candidate of [`${url.href}.js`, `${url.href}/index.js`]) {
    if (existsSync(fileURLToPath(candidate))) return candidate;
  }
  return url.href;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.startsWith(build.href)) return nextResolve(specifier, context);
    const stub = STUBS[specifier];
    if (stub) return { url: new URL(stub, build).href, shortCircuit: true };
    if (specifier.startsWith("@/")) return { url: withJs(new URL(specifier.slice(2), build)), shortCircuit: true };
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      return { url: withJs(new URL(specifier, context.parentURL)), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
