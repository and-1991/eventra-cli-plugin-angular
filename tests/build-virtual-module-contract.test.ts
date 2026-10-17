import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildVirtualModule, qualifyWithThis, TEMPLATE_EVENT_CALLEE } from "../src/build-virtual-module";
import type { TemplateEventBinding } from "../src/parse-angular-template";

// The exact text of the generated module, for every shape of input.
const DECL = `declare function ${TEMPLATE_EVENT_CALLEE}(name: string): void;`;
const REGION_START = "// --- angular template (auto-generated) ---";
const REGION_END = "// --- end template ---";

let dir: string;
let html: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ng-vm-"));
  html = path.join(dir, "c.component.html");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const withClass = (source: string): void => fs.writeFileSync(path.join(dir, "c.component.ts"), source);

const literal = (value: string): TemplateEventBinding => ({ kind: "literal", value });
const dynamic = (value: string): TemplateEventBinding => ({ kind: "dynamic", value });

describe("buildVirtualModule: nothing to emit", () => {
  it("is an empty module for no bindings and no calls, without reading the class", () => {
    withClass("export class A {}");
    expect(buildVirtualModule(html, [], [])).toBe("export {}\n");
    expect(buildVirtualModule(html, [])).toBe("export {}\n");
  });
});

describe("buildVirtualModule: a plain function, when the class is not needed or not found", () => {
  it("emits literal bindings as a top-level function, even when a component class exists", () => {
    withClass("export class A {}\n");
    expect(buildVirtualModule(html, [literal("signup"), literal("login")])).toBe(
      [DECL, "function __eventraAngularTemplate() {", `  ${TEMPLATE_EVENT_CALLEE}("signup");`, `  ${TEMPLATE_EVENT_CALLEE}("login");`, "}", ""].join("\n"),
    );
  });

  it("escapes backslashes and double quotes in a literal, in that order", () => {
    const line = (value: string) => buildVirtualModule(html, [literal(value)]).split("\n")[2];
    expect(line(String.raw`a\b`)).toBe(`  ${TEMPLATE_EVENT_CALLEE}("a\\\\b");`);
    expect(line('say "hi"')).toBe(`  ${TEMPLATE_EVENT_CALLEE}("say \\"hi\\"");`);
    expect(line(String.raw`a\"b`)).toBe(`  ${TEMPLATE_EVENT_CALLEE}("a\\\\\\"b");`);
  });

  it("emits a dynamic binding as written (no this.) when there is no class to put it in", () => {
    expect(buildVirtualModule(html, [dynamic("title")])).toBe(
      [DECL, "function __eventraAngularTemplate() {", `  ${TEMPLATE_EVENT_CALLEE}(title);`, "}", ""].join("\n"),
    );
  });

  it("also falls back when the sibling file has no class", () => {
    withClass("export const x = 1;\n");
    expect(buildVirtualModule(html, [dynamic("title")])).toBe(
      [DECL, "function __eventraAngularTemplate() {", `  ${TEMPLATE_EVENT_CALLEE}(title);`, "}", ""].join("\n"),
    );
  });

  it("wraps template calls in the region markers, after the declaration and around the function", () => {
    expect(buildVirtualModule(html, [], ["this.track('x');"])).toBe(
      [DECL, REGION_START, "function __eventraAngularTemplate() {", "  this.track('x');", "}", REGION_END, ""].join("\n"),
    );
  });

  it("puts literals before calls inside the function", () => {
    expect(buildVirtualModule(html, [literal("e")], ["this.track('x');"])).toBe(
      [DECL, REGION_START, "function __eventraAngularTemplate() {", `  ${TEMPLATE_EVENT_CALLEE}("e");`, "  this.track('x');", "}", REGION_END, ""].join("\n"),
    );
  });

  it("has no region markers when there are no calls", () => {
    const text = buildVirtualModule(html, [literal("e")]);
    expect(text).not.toContain("auto-generated");
    expect(text).not.toContain("end template");
  });
});

describe("buildVirtualModule: spliced into the component class", () => {
  it("splices a method before the closing brace of the class, qualifying a simple dynamic binding with this", () => {
    withClass("export class A {\n  title = 'x';\n}\n");
    expect(buildVirtualModule(html, [dynamic("title")])).toBe(
      [
        DECL,
        [
          "export class A {",
          "  title = 'x';",
          "",
          "  __eventraAngularTemplate() {",
          `    ${TEMPLATE_EVENT_CALLEE}(this.title);`,
          "  }",
          "}",
          "",
        ].join("\n"),
        "",
      ].join("\n"),
    );
  });

  it("keeps everything after the class, and everything before the splice point, exactly once", () => {
    withClass("const before = 1;\nexport class A {}\nconst after = 2;\n");
    const text = buildVirtualModule(html, [dynamic("a")]);
    expect(text.split("const before = 1;").length).toBe(2);
    expect(text.split("const after = 2;").length).toBe(2);
    expect(text.indexOf("const before")).toBeLessThan(text.indexOf("__eventraAngularTemplate"));
    expect(text.indexOf("__eventraAngularTemplate")).toBeLessThan(text.indexOf("const after"));
  });

  it("puts literals before calls in the method, and wraps the method in the region markers when there are calls", () => {
    withClass("export class A {\n}\n");
    expect(buildVirtualModule(html, [literal("e"), dynamic("title")], ["this.track('x');"])).toBe(
      [
        DECL,
        [
          "export class A {",
          "",
          `  ${REGION_START}`,
          "  __eventraAngularTemplate() {",
          `    ${TEMPLATE_EVENT_CALLEE}("e");`,
          `    ${TEMPLATE_EVENT_CALLEE}(this.title);`,
          "    this.track('x');",
          "  }",
          `  ${REGION_END}`,
          "}",
          "",
        ].join("\n"),
        "",
      ].join("\n"),
    );
  });

  it("reads the class for template calls alone", () => {
    withClass("export class A {}\n");
    expect(buildVirtualModule(html, [], ["this.track('x');"])).toBe(
      [
        DECL,
        ["export class A {", "  " + REGION_START, "  __eventraAngularTemplate() {", "    this.track('x');", "  }", "  " + REGION_END, "}", ""].join("\n"),
        "",
      ].join("\n"),
    );
  });

  it("does not read the class for literals alone, and does not qualify them", () => {
    withClass("export class A {}\n");
    expect(buildVirtualModule(html, [literal("e")])).not.toContain("class A");
  });

  it("does not splice a method into a class when the bindings are all literal, even mixed with nothing", () => {
    withClass("export class A {}\n");
    expect(buildVirtualModule(html, [literal("a"), literal("b")])).not.toContain("export class A");
  });

  it("leaves a complex dynamic binding unqualified", () => {
    withClass("export class A {}\n");
    expect(buildVirtualModule(html, [dynamic("a + b")])).toContain(`${TEMPLATE_EVENT_CALLEE}(a + b);`);
  });
});

describe("qualifyWithThis", () => {
  it.each([
    ["title", "this.title"],
    ["_x", "this._x"],
    ["$x", "this.$x"],
    ["a1", "this.a1"],
    ["user.name", "this.user.name"],
    ["user?.name", "this.user?.name"],
    ["items[0]", "this.items[0]"],
    ["items[idx].label", "this.items[idx].label"],
    ["a.b.c", "this.a.b.c"],
  ])("qualifies the simple expression %s", (input, expected) => {
    expect(qualifyWithThis(input)).toBe(expected);
  });

  it.each([
    ["a + b"],
    ["fn()"],
    ["a | pipe"],
    ["'literal'"],
    ["1abc"],
    ["a."],
    ["a.1"],
    [".a"],
    ["a b"],
    ["a\nb"],
    ["items[a\nb]"],
    ["items[a"],
    [" title"],
    ["title "],
    [""],
  ])("leaves %j as it is", (input) => {
    expect(qualifyWithThis(input)).toBe(input);
  });
});
