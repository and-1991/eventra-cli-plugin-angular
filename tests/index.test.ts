import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { createCliPluginAngular } from "../src/index";
import { virtualPath } from "../src/transform";

function makeProject(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-plugin-angular-index-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("virtualPath", () => {
  it("appends .ts to the .html path", () => {
    expect(virtualPath("/project/foo.component.html")).toBe("/project/foo.component.html.ts");
  });
});

describe("createCliPluginAngular", () => {
  it("exposes the expected plugin shape", () => {
    const plugin = createCliPluginAngular();

    expect(plugin.id).toBe("angular");
    expect(plugin.match("foo.component.html")).toBe(true);
    expect(plugin.match("foo.component.ts")).toBe(false);
    expect(plugin.includeGlobs).toContain("**/*.html");
    expect(plugin.staticSinks?.[0]?.callee).toBe("__eventra_angular_template_event__");
    expect(plugin.staticSinks?.[0]?.eventNameArgumentIndex).toBe(0);
  });

  it("transforms a template with a literal binding into a single virtual module", async () => {
    const plugin = createCliPluginAngular();
    const result = await plugin.transform({
      path: "/project/empty.component.html",
      source: `<button event="checkout.cta"></button>`,
    });

    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]?.path).toBe("/project/empty.component.html.ts");
    expect(result.modules[0]?.content).toContain("checkout.cta");
  });

  it("returns an export stub for a template with no event bindings", async () => {
    const plugin = createCliPluginAngular();
    const result = await plugin.transform({ path: "/project/plain.component.html", source: "<div>hi</div>" });

    expect(result.modules[0]?.content.trim()).toBe("export {}");
  });

  it("resolves a dynamic binding through the real paired component class end-to-end", async () => {
    const project = makeProject();
    try {
      fs.writeFileSync(
        path.join(project.root, "foo.component.ts"),
        [
          'import { Component } from "@angular/core";',
          "",
          "@Component({ templateUrl: './foo.component.html' })",
          "export class FooComponent {",
          '  computedEventName = "checkout.dynamic";',
          "}",
          "",
        ].join("\n"),
      );

      const plugin = createCliPluginAngular();
      const result = await plugin.transform({
        path: path.join(project.root, "foo.component.html"),
        source: `<button [event]="computedEventName"></button>`,
      });

      expect(result.modules[0]?.content).toContain("__eventra_angular_template_event__(this.computedEventName);");
    } finally {
      project.cleanup();
    }
  });
});
