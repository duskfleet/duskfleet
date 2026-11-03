import assert from "node:assert/strict";
import { test } from "node:test";
import { listScoped, scopeList } from "../lib/scope.ts";

const run = (id, agentId, projectPath, createdAt) => ({ id, agentId, projectPath, createdAt });
const RUNS = [
  run("r1", "a", "/p", "2026-10-30T10:00:00Z"),
  run("r2", "b", "/p", "2026-10-30T11:00:00Z"),
  run("r3", "a", "/q", "2026-10-30T12:00:00Z"),
  run("r4", "b", "/q", "2026-10-30T09:00:00Z"),
  run("r5", "c", "/p", "2026-10-30T13:00:00Z"),
];
// What core's runs.list does for one pair: newest first, at most `limit`.
const fake = (limit, calls) => (agentId, projectPath) => {
  calls?.push([agentId, projectPath]);
  return RUNS.filter((r) => (!agentId || r.agentId === agentId) && (!projectPath || r.projectPath === projectPath))
    .sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))
    .slice(0, limit);
};

test("scopeList: no values = no filter, repeated values once", () => {
  assert.deepEqual(scopeList(undefined, undefined), [undefined]);
  assert.deepEqual(scopeList("a", []), ["a"]);
  assert.deepEqual(scopeList(undefined, ["/p", "/q", "/p"]), ["/p", "/q"]);
});

test("listScoped asks once per pair and keeps the newest of the union", () => {
  const calls = [];
  const list = listScoped(["a", "b"], ["/p", "/q"], 3, fake(3, calls));
  assert.equal(calls.length, 4);
  assert.deepEqual(
    list.map((r) => r.id),
    ["r3", "r2", "r1"],
  );
});

test("listScoped with one pair returns core's list as is", () => {
  const calls = [];
  assert.deepEqual(
    listScoped([undefined], ["/p"], 2, fake(2, calls)).map((r) => r.id),
    ["r5", "r2"],
  );
  assert.deepEqual(calls, [[undefined, "/p"]]);
});

test("two project ids on one path list each run once", () => {
  const list = listScoped([undefined], scopeList(undefined, ["/p", "/p"]), 10, fake(10));
  assert.deepEqual(
    list.map((r) => r.id),
    ["r5", "r2", "r1"],
  );
});
