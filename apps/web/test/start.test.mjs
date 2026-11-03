import assert from "node:assert/strict";
import { test } from "node:test";
import { colourEnv, isDroppedLine } from "../bin/next-output.mjs";
import nextConfig from "../next.config.mjs";

test("the start banner's Network line is dropped, plain or coloured", () => {
  assert.equal(isDroppedLine("   - Network:      http://127.0.0.1:4777"), true);
  assert.equal(isDroppedLine("   \u001b[2m- Network:\u001b[22m      http://127.0.0.1:4777"), true);
});

test("every other line of next start passes through", () => {
  for (const line of [
    "   ▲ Next.js 15.5.28",
    "   - Local:        http://127.0.0.1:4777",
    " ✓ Ready in 412ms",
    "Network: an error message that happens to start with the word",
    "",
  ]) {
    assert.equal(isDroppedLine(line), false, line);
  }
});

test("FORCE_COLOR is added only on a colour terminal the caller left alone", () => {
  assert.deepEqual(colourEnv({}, true), { FORCE_COLOR: "1" });
  assert.deepEqual(colourEnv({ TERM: "xterm-256color" }, true), { FORCE_COLOR: "1" });
  assert.deepEqual(colourEnv({}, false), {});
  assert.deepEqual(colourEnv({}, undefined), {});
  assert.deepEqual(colourEnv({ FORCE_COLOR: "0" }, true), {});
  assert.deepEqual(colourEnv({ NO_COLOR: "1" }, true), {});
  assert.deepEqual(colourEnv({ NO_COLOR: "" }, true), {});
  assert.deepEqual(colourEnv({ TERM: "dumb" }, true), {});
});

test("/runs redirects to the run list, temporarily, and only the bare path", async () => {
  const redirects = await nextConfig.redirects();
  assert.deepEqual(redirects, [{ source: "/runs", destination: "/", permanent: false }]);
});
