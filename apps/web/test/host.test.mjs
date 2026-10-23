import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedHost } from "../lib/host.ts";

test("loopback names on the configured port are allowed", () => {
  for (const host of ["localhost:4777", "127.0.0.1:4777", "[::1]:4777", "LocalHost:4777"]) {
    assert.equal(isAllowedHost(host, "4777"), true, host);
  }
  assert.equal(isAllowedHost("127.0.0.1:5000", "5000"), true);
});

test("a forged or foreign Host is refused", () => {
  for (const host of ["evil.example", "evil.example:4777", "192.168.1.20:4777", "localhost.evil.example:4777"]) {
    assert.equal(isAllowedHost(host, "4777"), false, host);
  }
});

test("a missing Host, a missing port or another port is refused", () => {
  assert.equal(isAllowedHost(null, "4777"), false);
  assert.equal(isAllowedHost("", "4777"), false);
  assert.equal(isAllowedHost("localhost", "4777"), false);
  assert.equal(isAllowedHost("localhost:4778", "4777"), false);
});

test("the default port is 4777", () => {
  assert.equal(isAllowedHost("localhost:4777"), true);
});
