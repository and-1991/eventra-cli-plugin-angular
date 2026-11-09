import { describe, expect, it } from "vitest";

import { assertSupportedNode, supportsAngularCompiler } from "../src/node-version";

describe("supportsAngularCompiler", () => {
  it("accepts the Node versions that can require() an ES module", () => {
    for (const version of ["20.19.0", "20.19.6", "22.12.0", "22.20.1", "23.0.0", "24.11.1", "26.1.0"]) {
      expect(supportsAngularCompiler(version)).toBe(true);
    }
  });

  it("refuses the ones that cannot", () => {
    for (const version of ["18.18.0", "20.11.0", "20.18.9", "21.7.3", "22.11.0", "22.0.0"]) {
      expect(supportsAngularCompiler(version)).toBe(false);
    }
  });
});

describe("assertSupportedNode", () => {
  it("says what is wrong and what to do, instead of a raw ERR_REQUIRE_ESM stack", () => {
    expect(() => assertSupportedNode("18.18.0")).toThrow(/needs Node\.js 20\.19\+ or 22\.12\+ \(this is 18\.18\.0\).*remove/s);
  });

  it("is silent on a supported Node", () => {
    expect(() => assertSupportedNode("22.12.0")).not.toThrow();
  });
});
