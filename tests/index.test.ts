import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import pkg from "../package.json";
import { createCliPluginAngular } from "../src/index";
import { isComponentTemplate } from "../src/component-scope";
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
    expect(plugin.version).toBe(pkg.version);
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

  // a template that a component uses: its parse errors must surface, never be mistaken for "no events"
  function componentTemplate(name: string, source: string) {
    const project = makeProject();
    const html = path.join(project.root, `${name}.component.html`);
    fs.writeFileSync(html, source);
    fs.writeFileSync(
      path.join(project.root, `${name}.component.ts`),
      `@Component({ selector: "x", templateUrl: "./${name}.component.html" }) export class C {}`,
    );
    return { ...project, html, source };
  }

  it("throws (rather than silently returning an empty module) when a text node starting with a control-flow-like word breaks the Angular parser", async () => {
    const plugin = createCliPluginAngular();
    const project = componentTemplate("broken", `<button event="checkout.cta">@if control-flow event</button>`);
    try {
      await expect(plugin.transform({ path: project.html, source: project.source })).rejects.toThrow(
        /Failed to parse Angular template .*broken\.component\.html/,
      );
    } finally {
      project.cleanup();
    }
  });

  it("throws on any other template parse error too, e.g. malformed markup", async () => {
    const plugin = createCliPluginAngular();
    const project = componentTemplate("malformed", "<div><span></div>");
    try {
      await expect(plugin.transform({ path: project.html, source: project.source })).rejects.toThrow(
        /Failed to parse Angular template/,
      );
    } finally {
      project.cleanup();
    }
  });

  it("still reports an error in a template that a component with another name points at", async () => {
    const plugin = createCliPluginAngular();
    const project = makeProject();
    try {
      const html = path.join(project.root, "layout.html");
      fs.writeFileSync(path.join(project.root, "app.component.ts"), `@Component({ templateUrl: './layout.html' }) export class App {}`);
      await expect(plugin.transform({ path: html, source: "<div><span></div>" })).rejects.toThrow(/Failed to parse Angular template/);
      // the same name written without ./, and a .d.ts or an unrelated .ts next to it
      fs.writeFileSync(path.join(project.root, "app.component.ts"), `@Component({ templateUrl: "layout.html" }) export class App {}`);
      fs.writeFileSync(path.join(project.root, "types.d.ts"), `templateUrl: 'other.html'`);
      fs.writeFileSync(path.join(project.root, "util.ts"), `export const x = 1;`);
      await expect(plugin.transform({ path: html, source: "<div><span></div>" })).rejects.toThrow(/Failed to parse Angular template/);
      // a page another file's templateUrl does not name stays skipped
      const other = await plugin.transform({ path: path.join(project.root, "docs.html"), source: "<div><span></div>" });
      expect(other.modules[0]?.content).toBe("export {}\n");
    } finally {
      project.cleanup();
    }
  });

  it("isComponentTemplate is false for a folder that cannot be read and ignores a .ts that cannot be read", () => {
    expect(isComponentTemplate("/definitely/not/here/x.html")).toBe(false);
    const project = makeProject();
    try {
      // a directory named like a TypeScript file: listed, but not readable as one
      fs.mkdirSync(path.join(project.root, "odd.ts"));
      expect(isComponentTemplate(path.join(project.root, "x.html"))).toBe(false);
    } finally {
      project.cleanup();
    }
  });

  it("skips quietly an .html file that is not a component's template, even when it does not parse", async () => {
    const plugin = createCliPluginAngular();
    const project = makeProject();
    try {
      const html = path.join(project.root, "docs.html");
      // generated API docs: a sibling .ts exists but uses no templateUrl, and there is no sibling at all for the other
      fs.writeFileSync(path.join(project.root, "docs.ts"), "export const x = 1;");
      const withSibling = await plugin.transform({ path: html, source: "<div><span></div>" });
      const noSibling = await plugin.transform({ path: path.join(project.root, "other.html"), source: "<div><span></div>" });
      expect(withSibling.modules).toEqual([{ path: `${html}.ts`, content: "export {}\n" }]);
      expect(noSibling.modules[0]?.content).toBe("export {}\n");
    } finally {
      project.cleanup();
    }
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
