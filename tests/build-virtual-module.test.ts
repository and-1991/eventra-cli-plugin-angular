import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { buildVirtualModule, qualifyWithThis } from "../src/build-virtual-module";
import type { TemplateEventBinding } from "../src/parse-angular-template";

function makeProject(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-plugin-angular-build-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("qualifyWithThis", () => {
  it("prefixes a bare identifier", () => {
    expect(qualifyWithThis("computedEventName")).toBe("this.computedEventName");
  });

  it("prefixes a simple property chain", () => {
    expect(qualifyWithThis("config.eventName")).toBe("this.config.eventName");
  });

  it("prefixes an optional-chained property access", () => {
    expect(qualifyWithThis("config?.eventName")).toBe("this.config?.eventName");
  });

  it("prefixes an element-access chain", () => {
    expect(qualifyWithThis("map['key']")).toBe("this.map['key']");
  });

  it("leaves a method call expression as-is", () => {
    expect(qualifyWithThis("getEventName()")).toBe("getEventName()");
  });

  it("leaves a binary expression as-is", () => {
    expect(qualifyWithThis("a + b")).toBe("a + b");
  });

  it("leaves a string literal as-is", () => {
    expect(qualifyWithThis('"literal"')).toBe('"literal"');
  });
});

describe("buildVirtualModule", () => {
  it("returns an export stub when there are no template events", () => {
    expect(buildVirtualModule("/project/foo.component.html", [])).toBe("export {}\n");
  });

  it("builds a plain top-level function when every binding is literal (no scope lookup needed)", () => {
    const bindings: TemplateEventBinding[] = [{ kind: "literal", value: "checkout.cta" }];
    const content = buildVirtualModule("/project/does-not-exist.component.html", bindings);
    expect(content).toContain('__eventra_angular_template_event__("checkout.cta");');
    expect(content).toContain("function __eventraAngularTemplate()");
    expect(content).not.toContain("class");
  });

  it("splices a synthetic method into the paired component class for dynamic bindings", () => {
    const project = makeProject();
    try {
      const tsPath = path.join(project.root, "foo.component.ts");
      fs.writeFileSync(
        tsPath,
        [
          'import { Component } from "@angular/core";',
          "",
          "@Component({})",
          "export class FooComponent {",
          '  computedEventName = "checkout.dynamic";',
          "}",
          "",
        ].join("\n"),
      );

      const bindings: TemplateEventBinding[] = [
        { kind: "literal", value: "checkout.cta" },
        { kind: "dynamic", value: "computedEventName" },
      ];
      const content = buildVirtualModule(path.join(project.root, "foo.component.html"), bindings);

      expect(content).toContain("export class FooComponent {");
      expect(content).toContain("__eventraAngularTemplate() {");
      expect(content).toContain('__eventra_angular_template_event__("checkout.cta");');
      expect(content).toContain("__eventra_angular_template_event__(this.computedEventName);");
      // The synthetic method must land inside the class, before its own closing brace.
      expect(content.indexOf("__eventraAngularTemplate")).toBeLessThan(content.lastIndexOf("}"));
    } finally {
      project.cleanup();
    }
  });

  it("falls back to a plain top-level function (dynamic bindings unprefixed) when no component class is found", () => {
    const bindings: TemplateEventBinding[] = [{ kind: "dynamic", value: "computedEventName" }];
    const content = buildVirtualModule("/project/missing.component.html", bindings);

    expect(content).toContain("function __eventraAngularTemplate()");
    expect(content).toContain("__eventra_angular_template_event__(computedEventName);");
    expect(content).not.toContain("this.computedEventName");
  });

  it("falls back to a plain top-level function when the paired .ts file has no class at all", () => {
    const project = makeProject();
    try {
      fs.writeFileSync(path.join(project.root, "foo.component.ts"), "export const notAClass = 1;\n");

      const bindings: TemplateEventBinding[] = [{ kind: "dynamic", value: "computedEventName" }];
      const content = buildVirtualModule(path.join(project.root, "foo.component.html"), bindings);

      expect(content).toContain("function __eventraAngularTemplate()");
      expect(content).toContain("__eventra_angular_template_event__(computedEventName);");
    } finally {
      project.cleanup();
    }
  });
});
