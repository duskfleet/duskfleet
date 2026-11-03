import { readFileSync } from "node:fs";

// The footer's version string, inlined at build time (@duskfleet/web shares the duskfleet version).
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // @duskfleet/core is bundled into the server build (it is never published on its own, so the
  // @duskfleet/web tarball cannot require it at runtime). Its node: builtins (node:sqlite,
  // child_process) stay external: webpack leaves them to the Node.js server runtime.
  env: { DUSKFLEET_VERSION: version ?? "" },
  // The run list is the home page; /runs (a natural guess, every other list has its own path)
  // lands there. Next.js keeps the query string, so /runs?agent=x opens /?agent=x.
  async redirects() {
    return [{ source: "/runs", destination: "/", permanent: false }];
  },
};

export default nextConfig;
