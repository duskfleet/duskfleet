/** @type {import('next').NextConfig} */
const nextConfig = {
  // @duskfleet/core is bundled into the server build (it is never published on its own, so the
  // @duskfleet/web tarball cannot require it at runtime). Its node: builtins (node:sqlite,
  // child_process) stay external: webpack leaves them to the Node.js server runtime.
};

export default nextConfig;
