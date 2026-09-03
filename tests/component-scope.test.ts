import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { readComponentScope } from "../src/component-scope";

function makeProject(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-plugin-angular-scope-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("readComponentScope", () => {
  it("finds the @Component-decorated class and returns the offset of its closing brace", () => {
    const project = makeProject();
    try {
      const tsPath = path.join(project.root, "foo.component.ts");
      const content = [
        'import { Component } from "@angular/core";',
        "",
        "@Component({ templateUrl: './foo.component.html' })",
        "export class FooComponent {",
        '  EVENT_NAME = "checkout";',
        "}",
        "",
      ].join("\n");
      fs.writeFileSync(tsPath, content);

      const scope = readComponentScope(path.join(project.root, "foo.component.html"));
      expect(scope).not.toBeNull();
      expect(scope!.content).toBe(content);
      expect(scope!.classEndOffset).not.toBeNull();
      // The character at the returned offset must be the class's own closing brace.
      expect(content[scope!.classEndOffset!]).toBe("}");
      // Splicing text at the offset lands inside the class body, before its own closing brace.
      const spliced = content.slice(0, scope!.classEndOffset!) + "  X;\n" + content.slice(scope!.classEndOffset!);
      expect(spliced).toContain("X;\n}");
    } finally {
      project.cleanup();
    }
  });

  it("falls back to the first class when no class has an @Component decorator", () => {
    const project = makeProject();
    try {
      const tsPath = path.join(project.root, "foo.component.ts");
      const content = ["export class NotDecorated {", "  x = 1;", "}", ""].join("\n");
      fs.writeFileSync(tsPath, content);

      const scope = readComponentScope(path.join(project.root, "foo.component.html"));
      expect(scope).not.toBeNull();
      expect(scope!.classEndOffset).not.toBeNull();
    } finally {
      project.cleanup();
    }
  });

  it("prefers the @Component-decorated class over an earlier undecorated one", () => {
    const project = makeProject();
    try {
      const tsPath = path.join(project.root, "foo.component.ts");
      const content = [
        "class Helper {",
        "  helperField = 1;",
        "}",
        "",
        'import { Component } from "@angular/core";',
        "@Component({})",
        "export class FooComponent {",
        '  EVENT_NAME = "real_component";',
        "}",
        "",
      ].join("\n");
      fs.writeFileSync(tsPath, content);

      const scope = readComponentScope(path.join(project.root, "foo.component.html"));
      const classText = content.slice(0, scope!.classEndOffset!);
      expect(classText).toContain("real_component");
    } finally {
      project.cleanup();
    }
  });

  it("returns classEndOffset: null when the file has no class declaration at all", () => {
    const project = makeProject();
    try {
      const tsPath = path.join(project.root, "foo.component.ts");
      fs.writeFileSync(tsPath, "export const notAClass = 1;\n");

      const scope = readComponentScope(path.join(project.root, "foo.component.html"));
      expect(scope).toEqual({ content: "export const notAClass = 1;\n", classEndOffset: null });
    } finally {
      project.cleanup();
    }
  });

  it("returns null when the paired .ts file doesn't exist", () => {
    const project = makeProject();
    try {
      const scope = readComponentScope(path.join(project.root, "missing.component.html"));
      expect(scope).toBeNull();
    } finally {
      project.cleanup();
    }
  });

  it("returns null when the given path doesn't end in .html", () => {
    expect(readComponentScope("/project/foo.component.ts")).toBeNull();
  });
});
