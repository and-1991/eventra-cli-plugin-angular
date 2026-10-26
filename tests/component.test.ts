import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { buildVirtualModule } from "../src/build-virtual-module";
import { buildComponentMethod, findChildComponents, matchesSelector, readComponentInfo } from "../src/component";
import { parseAngularTemplate } from "../src/parse-angular-template";
import { transformAngularTemplate } from "../src/transform";

function makeProject(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-plugin-angular-component-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const component = (body: string, metadata = `selector: "app-x", templateUrl: "./x.component.html"`): string =>
  `@Component({ ${metadata} })\nexport class XComponent { ${body} }`;

describe("readComponentInfo", () => {
  it("reads the selector, the template file and decorator inputs", () => {
    const info = readComponentInfo(component(`@Input() a!: string; @Input("b2") b!: string; @Input({ alias: "c2", required: true }) c!: string; plain = 1;`), "x.ts");
    expect(info).toMatchObject({ className: "XComponent", selector: "app-x", templateUrl: "./x.component.html" });
    expect(info?.inputs.map(({ local, publicName, signal }) => [local, publicName, signal])).toEqual([
      ["a", "a", false],
      ["b", "b2", false],
      ["c", "c2", false],
    ]);
  });

  it("reads setter inputs and signal inputs, with their aliases", () => {
    const info = readComponentInfo(component(`@Input() set s(v: string) {} s2 = input<string>(); r = input.required<string>({ alias: "r2" }); m = model("x"); d = input("d", { alias: "d2" }); other = signal(1); x = foo.input();`), "x.ts");
    expect(info?.inputs.map(({ local, publicName, signal, setter }) => [local, publicName, signal, setter !== null])).toEqual([
      ["s", "s", false, true],
      ["s2", "s2", true, false],
      ["r", "r2", true, false],
      ["m", "m", true, false],
      ["d", "d2", true, false],
    ]);
  });

  it("ignores static members, a setter without @Input and members that are not plain names", () => {
    const info = readComponentInfo(component(`@Input() static s = 1; set t(v: string) {} @Input() ["computed"] = 1; @Input() 'quoted' = 1; @Output() out = 1; static u = input();`), "x.ts");
    expect(info?.inputs).toEqual([]);
  });

  it("has no selector or template file when the metadata does not give them as literals", () => {
    expect(readComponentInfo(component("", `selector: SEL, template: "x"`), "x.ts")).toMatchObject({ selector: null, templateUrl: null });
    expect(readComponentInfo(`@Component() export class X {}`, "x.ts")).toMatchObject({ selector: null, templateUrl: null });
    expect(readComponentInfo("@Component({ selector: `app-t` }) export class X {}", "x.ts")?.selector).toBe("app-t");
  });

  it("finds the metadata behind another decorator", () => {
    expect(readComponentInfo(`@Injectable() @Component({ selector: "app-y" }) export class Y {}`, "x.ts")?.selector).toBe("app-y");
  });

  it("is null for a file without a named class", () => {
    expect(readComponentInfo("export const a = 1;", "x.ts")).toBeNull();
    expect(readComponentInfo("export default class {}", "x.ts")).toBeNull();
  });
});

describe("buildComponentMethod", () => {
  const method = (body: string): string | undefined => buildComponentMethod(component(body), "x.ts")?.method;

  it("is null for a component without inputs or a file without a class", () => {
    expect(buildComponentMethod(component("x = 1;"), "x.ts")).toBeNull();
    expect(buildComponentMethod("export const a = 1;", "x.ts")).toBeNull();
  });

  it("takes the inputs as one parameter, named after the class, and reads them where the class did", () => {
    const built = buildComponentMethod(component(`@Input() track!: string; @Input("n2") name!: string; go(extra: string) { this.t.track(this.track + extra, this.name, this.other); }`), "x.ts");
    expect(built?.name).toBe("XComponent");
    expect(built?.method).toBe(
      [
        "  XComponent({ track, n2: name }: any) {",
        "    ((extra: string) => { this.t.track(track + extra, name, this.other); });",
        "  }",
      ].join("\n"),
    );
  });

  it("reads a signal input by calling it, and leaves a call with arguments or the bare signal alone", () => {
    expect(method(`s = input<string>(); go() { a(this.s()); b(this.s); c(this.s(1)); }`)).toContain("{ a(s); b(this.s); c(this.s(1)); }");
    // a call of anything else on `this`, with no arguments, is left as it is
    expect(method(`s = input<string>(); go() { this.helper(); }`)).toContain("{ this.helper(); }");
  });

  it("copies async methods, generic methods and arrow properties", () => {
    const text = method(`@Input() a!: string; async go<T>(x: T) { await f(this.a); } fire = () => this.t(this.a); expr = this.a; helper = function () {};`);
    expect(text).toContain("XComponent({ a }: any) {".replace("XComponent", "async XComponent"));
    expect(text).toContain("(async <T>(x: T) => { await f(a); });");
    expect(text).toContain("(() => this.t(a));");
    expect(text).not.toContain("helper");
    expect(text).not.toContain("expr");
  });

  it("does not copy generators, static members, bodiless methods or getters", () => {
    const text = method(`@Input() a!: string; *gen() { this.a; } static s() { this.a; } abstract_(): void; get g() { return this.a; } constructor() { this.a; }`);
    expect(text).toBe("  XComponent({ a }: any) {\n  }");
  });

  it("runs the setter of an input with the bound value", () => {
    expect(method(`@Input() set track(v: string) { this.t.track(v); }`)).toBe(
      ["  XComponent({ track }: any) {", "    { const v: any = track;  this.t.track(v); }", "  }"].join("\n"),
    );
  });

  it("does not copy the setter of something that is not an input, or one that has no plain parameter", () => {
    expect(method(`@Input() a!: string; set other(v: string) { f(v); } @Input() set b({ x }: any) { f(x); }`)).toBe("  XComponent({ a, b }: any) {\n  }");
  });
});

describe("matchesSelector", () => {
  const match = (selector: string, tag: string, attributes: string[] = []): boolean => matchesSelector(selector, tag, new Set(attributes));

  it("matches an element, an attribute and an element with an attribute", () => {
    expect(match("app-x", "app-x")).toBe(true);
    expect(match("app-x", "app-y")).toBe(false);
    expect(match("[appX]", "div", ["appX"])).toBe(true);
    expect(match("[appX]", "div", ["other"])).toBe(false);
    expect(match("b[appX]", "b", ["appX"])).toBe(true);
    expect(match("b[appX]", "i", ["appX"])).toBe(false);
  });

  it("matches any selector of a list and none of one it does not understand", () => {
    expect(match("app-a, [appB]", "div", ["appB"])).toBe(true);
    expect(match(".cls", "div")).toBe(false);
    expect(match(":not(a)", "div")).toBe(false);
    expect(match("", "div")).toBe(false);
  });
});

describe("findChildComponents", () => {
  it("finds the components its imports point at, and the ones beside it, that have a template and inputs", () => {
    const { root, cleanup } = makeProject({
      "page.component.ts": `import { A } from "./a/a.component";\nimport { B } from "./b";\nimport x from "lib";`,
      "a/a.component.ts": `@Component({ selector: "app-a", templateUrl: "./a.component.html" }) export class AComponent { @Input() v!: string; }`,
      "b/index.ts": `@Component({ selector: "app-b", templateUrl: "./b.html" }) export class BComponent { @Input() v!: string; }`,
      "side.component.ts": `@Component({ selector: "app-side", templateUrl: "./side.component.html" }) export class SideComponent { @Input() v!: string; }`,
      "noinputs.component.ts": `@Component({ selector: "app-n", templateUrl: "./n.html" }) export class NComponent {}`,
      "inline.component.ts": `@Component({ selector: "app-i", template: "x" }) export class IComponent { @Input() v!: string; }`,
      "noselector.component.ts": `@Component({ templateUrl: "./n.html" }) export class NsComponent { @Input() v!: string; }`,
      "plain.ts": `export class Plain {}`,
      "types.d.ts": `@Component({ selector: "app-d", templateUrl: "./d.html" }) export class D { @Input() v!: string; }`,
      "side.component.spec.ts": `@Component({ selector: "app-spec", templateUrl: "./s.html" }) export class S { @Input() v!: string; }`,
    });
    try {
      const page = path.join(root, "page.component.html");
      const found = findChildComponents(page, fs.readFileSync(path.join(root, "page.component.ts"), "utf8"));
      expect(found.map((child) => child.info.selector).sort()).toEqual(["app-a", "app-b", "app-side"]);
      expect(found.find((child) => child.info.selector === "app-b")?.templatePath).toBe(path.join(root, "b", "b.html"));
    } finally {
      cleanup();
    }
  });

  it("finds nothing when the folder cannot be read", () => {
    expect(findChildComponents("/no/such/folder/x.component.html", `import a from "./a";`)).toEqual([]);
  });
});

describe("parseAngularTemplate: component usages", () => {
  const usages = (template: string) => parseAngularTemplate(template).componentUsages;

  it("collects the literal and bound props of every element, and the attribute names for attribute selectors", () => {
    expect(usages(`<app-x track="a" [label]="text" [attr.aria-x]="y" [class.on]="z" plain>t</app-x>`)).toEqual([
      {
        tag: "app-x",
        attributes: ["track", "plain", "label"],
        props: [
          { name: "track", kind: "literal", value: "a" },
          { name: "label", kind: "expression", value: "this.text" },
        ],
      },
    ]);
  });

  it("renders a bound expression as code in the class, and sees elements inside structural directives and blocks", () => {
    const found = usages(`<div *ngIf="a"><app-x [n]="a | pipe"></app-x></div>@if (b) { <app-x [n]="'s'"></app-x> }`);
    expect(found.map((usage) => usage.props[0]?.value)).toEqual(["(undefined as any)", `"s"`]);
  });

  it("skips an element with nothing bound, and a bound attribute without an expression", () => {
    expect(usages(`<app-x></app-x><ng-template></ng-template>`)).toEqual([]);
  });
});

describe("buildVirtualModule: component functions", () => {
  const files = {
    "child.component.ts": `@Component({ selector: "app-child", templateUrl: "./child.component.html" })\nexport class ChildComponent { @Input() track!: string; go() { sdk.track(this.track); } }`,
    "child.component.html": `<button (click)="go()">x</button>`,
    "page.component.ts": `@Component({ selector: "app-page", templateUrl: "./page.component.html" })\nexport class PageComponent { text = "x"; }`,
    "page.component.html": `<app-child track="a" [track]="text" unrelated="u"></app-child>`,
  };

  it("adds the component method and exports the class for a component with inputs, even with an empty template", () => {
    const { root, cleanup } = makeProject({ "child.component.ts": files["child.component.ts"] });
    try {
      const text = buildVirtualModule(path.join(root, "child.component.html"), []);
      expect(text).toContain("  // --- angular template (auto-generated) ---\n");
      expect(text).toContain("  ChildComponent({ track }: any) {\n    (() => { sdk.track(track); });\n  }\n  // --- end template ---\n}");
      expect(text).not.toContain("__eventraAngularTemplate");
      expect(text.endsWith("export { ChildComponent as __eventraAngularComponent };\n")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("turns a use of a component into a call of its method, importing the child's template module", () => {
    const { root, cleanup } = makeProject(files);
    try {
      const page = path.join(root, "page.component.html");
      const { componentUsages } = parseAngularTemplate(fs.readFileSync(page, "utf8"));
      const text = buildVirtualModule(page, [], [], componentUsages);
      expect(text.split("\n")[0]).toContain(`import { __eventraAngularComponent as __eventraChild0 } from "./child.component.html";`);
      expect(text).toContain(`    __eventraChild0.prototype.ChildComponent({ track: "a", track: this.text });`);
      expect(text).not.toContain("unrelated");
    } finally {
      cleanup();
    }
  });

  it("imports one child once, however many times it is used, and does not follow an input whose name is not an identifier", () => {
    const { root, cleanup } = makeProject({
      ...files,
      "child.component.ts": files["child.component.ts"].replace("@Input() track", `@Input("data-x") dx!: string; @Input() track`),
    });
    try {
      const page = path.join(root, "page.component.html");
      const usage = { tag: "app-child", attributes: [], props: [{ name: "track", kind: "literal" as const, value: "1" }, { name: "data-x", kind: "literal" as const, value: "2" }] };
      const text = buildVirtualModule(page, [], [], [usage, usage]);
      expect(text.match(/import \{/g)).toHaveLength(1);
      expect(text.match(/prototype\.ChildComponent\(\{ track: "1" \}\)/g)).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it("puts a child's relative path in the import when the child is in another folder", () => {
    const { root, cleanup } = makeProject({
      "ui/child.component.ts": files["child.component.ts"],
      "page.component.ts": `import { ChildComponent } from "./ui/child.component";\n@Component({ selector: "app-page", templateUrl: "./page.component.html" })\nexport class PageComponent {}`,
    });
    try {
      const page = path.join(root, "page.component.html");
      const text = buildVirtualModule(page, [], [], [{ tag: "app-child", attributes: [], props: [{ name: "track", kind: "literal", value: "a" }] }]);
      expect(text).toContain(`from "./ui/child.component.html";`);
    } finally {
      cleanup();
    }
  });

  it("reaches a child in a folder above with a path that starts with the parent folder", () => {
    const { root, cleanup } = makeProject({
      "child.component.ts": files["child.component.ts"],
      "pages/page.component.ts": `import { ChildComponent } from "../child.component";\n@Component({ selector: "app-page", templateUrl: "./page.component.html" })\nexport class PageComponent {}`,
    });
    try {
      const page = path.join(root, "pages", "page.component.html");
      const text = buildVirtualModule(page, [], [], [{ tag: "app-child", attributes: [], props: [{ name: "track", kind: "literal", value: "a" }] }]);
      expect(text).toContain(`from "../child.component.html";`);
    } finally {
      cleanup();
    }
  });

  it("is a stub when the component's class has no name to call it by", () => {
    const { root, cleanup } = makeProject({ "a.component.ts": `export default class { @Input() x!: string; }` });
    try {
      expect(buildVirtualModule(path.join(root, "a.component.html"), [])).toBe("export {}\n");
    } finally {
      cleanup();
    }
  });

  it("leaves a use of a component alone when no child matches or none of its inputs is bound, or the component itself is the child", () => {
    const { root, cleanup } = makeProject(files);
    try {
      const page = path.join(root, "page.component.html");
      const usage = (tag: string, name: string) => ({ tag, attributes: [], props: [{ name, kind: "literal" as const, value: "v" }] });
      expect(buildVirtualModule(page, [], [], [usage("app-other", "track")])).toBe("export {}\n");
      expect(buildVirtualModule(page, [], [], [usage("app-child", "unrelated")])).toBe("export {}\n");
      const own = path.join(root, "child.component.html");
      expect(buildVirtualModule(own, [], [], [usage("app-child", "track")])).not.toContain("prototype");
    } finally {
      cleanup();
    }
  });

  it("is unchanged for a component without inputs, and for a template whose component cannot be read", () => {
    const { root, cleanup } = makeProject({ "a.component.ts": `@Component({}) export class AComponent { x = 1; }` });
    try {
      expect(buildVirtualModule(path.join(root, "a.component.html"), [])).toBe("export {}\n");
      expect(buildVirtualModule(path.join(root, "missing.component.html"), [], [], [{ tag: "app-child", attributes: [], props: [] }])).toBe("export {}\n");
    } finally {
      cleanup();
    }
  });

  it("goes through the whole transform", async () => {
    const { root, cleanup } = makeProject(files);
    try {
      const page = path.join(root, "page.component.html");
      const result = await transformAngularTemplate({ path: page, source: fs.readFileSync(page, "utf8") });
      expect(result.modules[0]?.content).toContain("__eventraChild0.prototype.ChildComponent(");
    } finally {
      cleanup();
    }
  });
});
