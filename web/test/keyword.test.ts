import { expect, test } from "vitest"
import { compileKeywords, keywordsOf } from "../src/lib/keyword"
import fixture from "./fixtures/keywords.json"

// written by pytest itself (see its header), so the port is checked against the real thing
test.each(fixture.cases)("matches like pytest -k: $expression", ({ expression, matches, error }) => {
  const run = () => compileKeywords(expression)(fixture.names)
  if (error !== undefined) expect(run).toThrow(error)
  else expect(run()).toBe(matches)
})

test("matches the names in a test's id, and the keywords the plugin recorded", () => {
  const test = {
    id: "tests/libvirt/test_machine.py::TestGroup::test_run[ppc64le-ssh]",
    name: "TestGroup.test_run",
    module: "tests.libvirt.test_machine",
    params: {},
    log: "",
    keywords: ["slow"],
  }
  expect(keywordsOf(test)).toEqual([
    "tests",
    "libvirt",
    "test_machine.py",
    "TestGroup",
    "test_run[ppc64le-ssh]",
    "slow",
  ])
  expect(keywordsOf({ ...test, keywords: undefined })).not.toContain("slow") // runs of older plugins
})
