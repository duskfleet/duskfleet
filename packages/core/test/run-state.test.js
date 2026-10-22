/** Run state machine: every (from, to) pair, allowed or not, through assertTransition. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertTransition, IllegalTransitionError, RUN_STATUSES, TERMINAL_STATUSES } from "@duskfleet/core";

const ALLOWED = new Set([
  "pending>running",
  "pending>failed",
  "pending>cancelled",
  "running>completed",
  "running>failed",
  "running>cancelled",
  "running>timed_out",
]);

test("the table covers every status pair", () => {
  assert.deepEqual([...RUN_STATUSES].sort(), ["cancelled", "completed", "failed", "pending", "running", "timed_out"]);
});

for (const from of RUN_STATUSES) {
  for (const to of RUN_STATUSES) {
    const allowed = ALLOWED.has(`${from}>${to}`);
    test(`${from} -> ${to} is ${allowed ? "allowed" : "forbidden"}`, () => {
      if (allowed) {
        assert.doesNotThrow(() => assertTransition(from, to));
      } else {
        assert.throws(
          () => assertTransition(from, to),
          (err) => err instanceof IllegalTransitionError && err.message === `illegal run transition ${from} -> ${to}`,
        );
      }
    });
  }
}

test("terminal statuses have no way out", () => {
  for (const from of TERMINAL_STATUSES) {
    for (const to of RUN_STATUSES) assert.throws(() => assertTransition(from, to), IllegalTransitionError);
  }
});
