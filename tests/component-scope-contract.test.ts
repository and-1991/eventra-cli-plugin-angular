import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isComponentTemplate, readComponentScope } from "../src/component-scope";

// Real files in a temp directory, because the module's whole contract is what it finds next to a template.
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ng-scope-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, content: string): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
};

/** The class end offset for a sibling .ts with this source, or `undefined` when no scope is read. */
const endOffsetOf = (source: string): number | null | undefined => {
  write("c.component.ts", source);
  return readComponentScope(path.join(dir, "c.component.html"))?.classEndOffset;
};

describe("readComponentScope: which file is read", () => {
  it("reads the sibling .ts and returns its raw source", () => {
    const source = "export class A {}\n";
    write("a.component.ts", source);
    expect(readComponentScope(path.join(dir, "a.component.html"))).toEqual({ content: source, classEndOffset: source.indexOf("}") });
  });

  it("matches the .html extension case-insensitively", () => {
    write("A.ts", "export class A {}");
    expect(readComponentScope(path.join(dir, "A.HTML"))?.content).toBe("export class A {}");
  });

  it("swaps only the final extension, not an earlier .html in the name", () => {
    write("x.html.component.ts", "export class A {}");
    expect(readComponentScope(path.join(dir, "x.html.component.html"))?.content).toBe("export class A {}");
  });

  it("is null for a path that is not an .html file", () => {
    write("a.ts", "export class A {}");
    expect(readComponentScope(path.join(dir, "a.ts"))).toBeNull();
    expect(readComponentScope(path.join(dir, "a.htm"))).toBeNull();
    expect(readComponentScope(path.join(dir, "a.html.txt"))).toBeNull();
  });

  it("is null when the sibling .ts does not exist", () => {
    expect(readComponentScope(path.join(dir, "missing.component.html"))).toBeNull();
  });

  it("is null when the sibling .ts cannot be read (it is a directory)", () => {
    fs.mkdirSync(path.join(dir, "dir.component.ts"));
    expect(readComponentScope(path.join(dir, "dir.component.html"))).toBeNull();
  });
});

describe("readComponentScope: which class is the component", () => {
  it("is the offset of the closing brace of the class", () => {
    const source = "export class A {\n  x = 1;\n}\nconst tail = 1;\n";
    const offset = endOffsetOf(source);
    expect(offset).toBe(source.indexOf("}\nconst"));
    expect(source[offset as number]).toBe("}");
  });

  it("is null when the file has no class", () => {
    expect(endOffsetOf("export const a = 1;\nfunction f() {}\n")).toBeNull();
  });

  it("is null for an empty file, with the empty content still returned", () => {
    write("c.component.ts", "");
    expect(readComponentScope(path.join(dir, "c.component.html"))).toEqual({ content: "", classEndOffset: null });
  });

  it("prefers the class decorated with @Component over an earlier plain class", () => {
    const source = "class Helper {}\n@Component({ selector: 'x' })\nclass Comp {}\n";
    expect(endOffsetOf(source)).toBe(source.lastIndexOf("}"));
  });

  it("takes the first @Component class when several carry it", () => {
    const source = "@Component({})\nclass First {}\n@Component({})\nclass Second {}\n";
    expect(endOffsetOf(source)).toBe(source.indexOf("}", source.indexOf("class First")));
  });

  it("falls back to the first class, not the last, when none is decorated", () => {
    const source = "class First {}\nclass Second {}\nclass Third {}\n";
    expect(endOffsetOf(source)).toBe(source.indexOf("}"));
  });

  it("ignores decorators other than Component: a call to another decorator does not count", () => {
    const source = "@Injectable()\nclass Service {}\n@Component({})\nclass Comp {}\n";
    expect(endOffsetOf(source)).toBe(source.lastIndexOf("}"));
  });

  it("does not take another decorator for Component, so the first class is the fallback", () => {
    const source = "@Directive({})\nclass First {}\n@Injectable()\nclass Second {}\n";
    expect(endOffsetOf(source)).toBe(source.indexOf("}", source.indexOf("class First")));
  });

  it("does not count a bare @Component (no call) as the decorator", () => {
    const source = "class First {}\n@Component\nclass Second {}\n";
    expect(endOffsetOf(source)).toBe(source.indexOf("}"));
  });

  it("does not count a namespaced @core.Component(...) as the decorator", () => {
    const source = "class First {}\n@core.Component({})\nclass Second {}\n";
    expect(endOffsetOf(source)).toBe(source.indexOf("}"));
  });

  it("does not count a decorator whose name merely contains Component", () => {
    const source = "class First {}\n@MyComponent({})\nclass Second {}\n";
    expect(endOffsetOf(source)).toBe(source.indexOf("}"));
  });

  it("only looks at top-level classes, not a class nested in a function or a class expression", () => {
    const source = "function f() { class Inner {} }\nconst C = class {};\nclass Top {}\n";
    expect(endOffsetOf(source)).toBe(source.lastIndexOf("}"));
  });

  it("finds the end of an exported and of an abstract class", () => {
    const source = "export abstract class A {\n  abstract x(): void;\n}\n";
    expect(endOffsetOf(source)).toBe(source.lastIndexOf("}"));
  });

  it("uses the offset after any leading text (decorators, comments) of the class", () => {
    const source = "// header\n/** doc */\n@Component({ template: '{}' })\nexport class A { m() { return { a: 1 }; } }\n";
    expect(endOffsetOf(source)).toBe(source.lastIndexOf("}"));
  });
});

describe("isComponentTemplate", () => {
  it("is true when the sibling .ts mentions templateUrl, even for another file", () => {
    write("a.component.ts", "@Component({ templateUrl: './other.html' }) class A {}");
    expect(isComponentTemplate(path.join(dir, "a.component.html"))).toBe(true);
  });

  it("is true when another .ts in the folder names this file as its templateUrl", () => {
    write("layout.html", "<p></p>");
    write("shell.ts", "@Component({ templateUrl: './layout.html' }) class Shell {}");
    expect(isComponentTemplate(path.join(dir, "layout.html"))).toBe(true);
  });

  it("is false for an .html nothing refers to", () => {
    write("page.html", "<p></p>");
    write("other.ts", "export const x = 1;");
    expect(isComponentTemplate(path.join(dir, "page.html"))).toBe(false);
  });

  it("is false when the folder cannot be listed", () => {
    expect(isComponentTemplate(path.join(dir, "no-such-dir", "a.html"))).toBe(false);
  });

  it("does not count templateUrls or a longer word as the templateUrl property", () => {
    write("a.component.ts", "const templateUrls = []; const mytemplateUrl = 1;");
    expect(isComponentTemplate(path.join(dir, "a.component.html"))).toBe(false);
  });

  it.each([
    ["single quotes", "templateUrl: 'layout.html'"],
    ["double quotes", 'templateUrl: "layout.html"'],
    ["backticks", "templateUrl: `layout.html`"],
    ["a leading ./", "templateUrl: './layout.html'"],
    ["spaces around the colon", "templateUrl  :   'layout.html'"],
    ["no space after the colon", "templateUrl:'layout.html'"],
    ["a newline after the colon", "templateUrl:\n  'layout.html'"],
  ])("recognises a reference written with %s", (_label, snippet) => {
    write("layout.html", "<p></p>");
    write("shell.ts", `@Component({ ${snippet} }) class Shell {}`);
    expect(isComponentTemplate(path.join(dir, "layout.html"))).toBe(true);
  });

  it.each([
    ["a different file with a longer name", "templateUrl: 'my-layout.html'"],
    ["a file in another folder", "templateUrl: '../other/layout.html'"],
    ["a different extension", "templateUrl: 'layout.htm'"],
    ["no quotes", "templateUrl: layout.html"],
    ["a different property", "styleUrl: 'layout.html'"],
  ])("does not take %s for a reference", (_label, snippet) => {
    write("layout.html", "<p></p>");
    write("shell.ts", `@Component({ ${snippet} }) class Shell {}`);
    expect(isComponentTemplate(path.join(dir, "layout.html"))).toBe(false);
  });

  it("treats regex characters in the file name literally", () => {
    write("a.b+c.html", "<p></p>");
    write("shell.ts", "@Component({ templateUrl: './aXb+c.html' }) class Shell {}");
    expect(isComponentTemplate(path.join(dir, "a.b+c.html"))).toBe(false);
    write("shell.ts", "@Component({ templateUrl: './a.b+c.html' }) class Shell {}");
    expect(isComponentTemplate(path.join(dir, "a.b+c.html"))).toBe(true);
  });

  it("only reads .ts files: other extensions and .d.ts declarations do not count", () => {
    write("layout.html", "<p></p>");
    const ref = "@Component({ templateUrl: './layout.html' }) class Shell {}";
    write("shell.js", ref);
    write("shell.tsx", ref);
    write("shell.txt", ref);
    write("shell.d.ts", ref);
    write("ts", ref);
    expect(isComponentTemplate(path.join(dir, "layout.html"))).toBe(false);
    write("shell.ts", ref);
    expect(isComponentTemplate(path.join(dir, "layout.html"))).toBe(true);
  });

  it("skips a folder entry named like a .ts file that cannot be read, and keeps looking", () => {
    write("layout.html", "<p></p>");
    fs.mkdirSync(path.join(dir, "a-dir.ts"));
    write("z.ts", "@Component({ templateUrl: './layout.html' }) class Z {}");
    expect(isComponentTemplate(path.join(dir, "layout.html"))).toBe(true);
  });

  it("is false for a non-.html path without a sibling .ts and no references", () => {
    expect(isComponentTemplate(path.join(dir, "notes.txt"))).toBe(false);
  });
});
