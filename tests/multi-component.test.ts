import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { findChildComponents, locateComponent } from "../src/component";

import { readComponentInfos } from "../src/component";
import { transformAngularTemplate } from "../src/transform";

const CALLEE = "__eventra_angular_template_event__";
const run = async (source: string, file = "/p/pair.component.ts") => (await transformAngularTemplate({ path: file, source })).modules;

const TWO = `import { Component } from "@angular/core";
@Component({ selector: "app-first", template: '<button event="first.clicked">1</button>' })
export class FirstComponent {
  name = "one";
}

@Component({ selector: "app-second", template: '<button event="second.clicked">2</button><i [event]="label">x</i>' })
export class SecondComponent {
  label = "second.label";
}
`;

describe("a file that declares several components", () => {
  it("lists every @Component class in order", () => {
    expect(readComponentInfos(TWO, "pair.ts").map((info) => info.className)).toEqual(["FirstComponent", "SecondComponent"]);
  });

  it("falls back to the first class when none is decorated", () => {
    expect(readComponentInfos("class A {}\nclass B {}", "x.ts").map((info) => info.className)).toEqual(["A"]);
    expect(readComponentInfos("export const x = 1;", "x.ts")).toEqual([]);
  });

  it("reads the inline template of every component, not only the first", async () => {
    const [module] = await run(TWO);
    expect(module.content).toContain(`${CALLEE}("first.clicked")`);
    expect(module.content).toContain(`${CALLEE}("second.clicked")`);
  });

  it("resolves a bound event against its own class", async () => {
    const [module] = await run(TWO);
    const second = module.content.slice(module.content.indexOf("class SecondComponent"));
    expect(second).toContain(`${CALLEE}(this.label)`);
    const first = module.content.slice(module.content.indexOf("class FirstComponent"), module.content.indexOf("class SecondComponent"));
    expect(first).not.toContain("this.label");
  });

  it("declares the callee once and keeps the lines of the components' own code", async () => {
    const [module] = await run(TWO);
    expect(module.content.split(`declare function ${CALLEE}`).length - 1).toBe(1);
    const before = TWO.split("\n");
    const after = module.content.split("\n");
    for (const needle of ['name = "one";', 'label = "second.label";', "export class SecondComponent"]) {
      expect(after.findIndex((line) => line.includes(needle))).toBeGreaterThanOrEqual(0);
    }
    // the first class is untouched above its own spliced method
    expect(after.slice(0, before.indexOf('  name = "one";') + 1)).toEqual(before.slice(0, before.indexOf('  name = "one";') + 1));
  });

  it("reads the second component when the first has no inline template", async () => {
    const source = `@Component({ selector: "a", templateUrl: "./a.html" })\nexport class A {}\n\n@Component({ selector: "b", template: '<b event="b.event">x</b>' })\nexport class B {}\n`;
    const [module] = await run(source);
    expect(module.content).toContain(`${CALLEE}("b.event")`);
  });

  it("still returns nothing when no component has an inline template", async () => {
    expect(await run(`@Component({ selector: "a", templateUrl: "./a.html" })\nexport class A {}\n@Component({ selector: "b", templateUrl: "./b.html" })\nexport class B {}\n`)).toEqual([]);
  });

  it("fails the file when a later template does not parse, instead of skipping it silently", async () => {
    const source = `@Component({ selector: "a", template: '<i event="a.ok">x</i>' })\nexport class A {}\n@Component({ selector: "b", template: '<div (click)=">' })\nexport class B {}\n`;
    await expect(run(source)).rejects.toThrow(/inline Angular template of/);
  });

  it("gives each component with inputs its own exported class", async () => {
    const source = `@Component({ selector: "a", template: '<i [event]="track">x</i>' })
export class A { @Input() track = ""; }
@Component({ selector: "b", template: '<i [event]="id">x</i>' })
export class B { @Input() id = ""; }
`;
    const [module] = await run(source);
    expect(module.content).toContain("export { A as __eventraAngularComponent };");
    expect(module.content).toContain("export { B as __eventraAngularComponent1 };");
  });

  it("a single component still produces the same module as before", async () => {
    const source = `@Component({ selector: "a", template: '<i event="only.one">x</i>' })\nexport class A {}\n`;
    const [module] = await run(source);
    expect(module.content.split(`declare function ${CALLEE}`).length - 1).toBe(1);
    expect(module.content).toContain(`${CALLEE}("only.one")`);
  });

  it("returns null for a component index the file does not have", () => {
    expect(readComponentInfos(TWO, "pair.ts")).toHaveLength(2);
    // readComponentInfo with an index past the last component
    return import("../src/component").then(({ readComponentInfo }) => {
      expect(readComponentInfo(TWO, "pair.ts", 1)?.className).toBe("SecondComponent");
      expect(readComponentInfo(TWO, "pair.ts", 5)).toBeNull();
    });
  });
});

describe("children declared next to other components", () => {
  const project = (files: Record<string, string>) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-plugin-angular-multi-"));
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
    return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  };
  const KIDS = `@Component({ selector: "app-one", template: '<i>1</i>' })
export class One { @Input() a = ""; }
@Component({ selector: "app-two", template: '<i>2</i>' })
export class Two { @Input() b = ""; }
@Component({ selector: "app-url", templateUrl: "./url.html" })
export class Url { @Input() c = ""; }
`;

  it("finds every inline component of a file under its own export name, and a templateUrl one under the name its template module uses", () => {
    const { root, cleanup } = project({ "kids.ts": KIDS, "page.component.ts": `import "./kids";` });
    try {
      const found = findChildComponents(path.join(root, "page.component.html"), `import "./kids";`);
      expect(found.map((child) => [child.info.selector, child.exportName])).toEqual([
        ["app-one", "__eventraAngularComponent"],
        ["app-two", "__eventraAngularComponent1"],
        ["app-url", "__eventraAngularComponent"],
      ]);
    } finally {
      cleanup();
    }
  });

  it("a parent inside a second component imports the child under a name of its own", async () => {
    const { root, cleanup } = project({ "kids.ts": KIDS });
    try {
      const parent = `@Component({ selector: "app-p1", template: '<i>p</i>' })
export class P1 {}
@Component({ selector: "app-p2", template: '<app-two b="x.event"></app-two>' })
export class P2 {}
`;
      const [module] = await run(parent, path.join(root, "parent.ts"));
      expect(module.content).toContain('import { __eventraAngularComponent1 as __eventraChild1_0 } from "./kids";');
      expect(module.content).toContain('__eventraChild1_0.prototype.Two({ b: "x.event" });');
    } finally {
      cleanup();
    }
  });
});

describe("@Component imported under another name", () => {
  const ALIASED = `import { Component as Cmp } from "@angular/core";
@Cmp({ selector: "app-a", template: '<button event="aliased.event">go</button>' })
export class AComponent {}
`;

  it("reads the inline template of a component whose decorator is an alias", async () => {
    const [module] = await run(ALIASED);
    expect(module.content).toContain(`${CALLEE}("aliased.event")`);
  });

  it("lists it among the components of the file", () => {
    expect(readComponentInfos(ALIASED, "a.ts").map((info) => info.className)).toEqual(["AComponent"]);
  });

  it("an alias of something else from @angular/core, or a Component from another package, is not a component", async () => {
    expect(await run(`import { Directive as Cmp } from "@angular/core";\n@Cmp({ selector: "x", template: '<i event="no">x</i>' })\nexport class X {}\n`)).toEqual([]);
    const other = `import { Component as Cmp } from "some-lib";\n@Cmp({ selector: "x", template: '<i event="no">x</i>' })\nexport class X {}\n`;
    expect(readComponentInfos(other, "x.ts").map((info) => info.className)).toEqual(["X"]);
    expect(readComponentInfos(other, "x.ts")[0].inlineTemplate).toBeNull();
  });

  it("a namespace import or a side-effect import of @angular/core adds no alias", () => {
    expect(readComponentInfos(`import * as ng from "@angular/core";\nimport "@angular/core";\n@ng.Component({})\nexport class X {}\n`, "x.ts").map((i) => i.className)).toEqual(["X"]);
  });

  it("a child component declared with an alias is found for its parent", () => {
    const { root, cleanup } = (() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-plugin-angular-alias-"));
      fs.writeFileSync(path.join(dir, "kid.ts"), `import { Component as C, Input } from "@angular/core";\n@C({ selector: "app-kid", template: '<i>k</i>' })\nexport class Kid { @Input() v = ""; }\n`);
      return { root: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    })();
    try {
      const found = findChildComponents(path.join(root, "page.component.html"), `import "./kid";`);
      expect(found.map((child) => child.info.selector)).toEqual(["app-kid"]);
    } finally {
      cleanup();
    }
  });
});

describe("looking at the files beside a template", () => {
  const kid = (selector: string) => `import { Component, Input } from "@angular/core";\n@Component({ selector: "${selector}", template: '<i>k</i>' })\nexport class Kid { @Input() v = ""; }\n`;
  const folder = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-plugin-angular-cache-"));
    return { dir, page: path.join(dir, "page.component.html"), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  };
  const selectors = (page: string) => findChildComponents(page, `import "./kid";`).map((child) => child.info.selector);

  it("sees an edit to a neighbour, a new file and a removed one", () => {
    const { dir, page, cleanup } = folder();
    try {
      fs.writeFileSync(path.join(dir, "kid.ts"), kid("app-one"));
      expect(selectors(page)).toEqual(["app-one"]);
      expect(selectors(page)).toEqual(["app-one"]);
      fs.writeFileSync(path.join(dir, "kid.ts"), kid("app-renamed-longer"));
      expect(selectors(page)).toEqual(["app-renamed-longer"]);
      fs.writeFileSync(path.join(dir, "other.ts"), kid("app-other"));
      expect(selectors(page).sort()).toEqual(["app-other", "app-renamed-longer"]);
      fs.rmSync(path.join(dir, "kid.ts"));
      expect(selectors(page)).toEqual(["app-other"]);
    } finally {
      cleanup();
    }
  });

  it("skips a neighbour it cannot read (a folder named like a file)", () => {
    const { dir, page, cleanup } = folder();
    try {
      fs.mkdirSync(path.join(dir, "weird.ts"));
      fs.writeFileSync(path.join(dir, "kid.ts"), kid("app-one"));
      expect(selectors(page)).toEqual(["app-one"]);
      expect(selectors(page)).toEqual(["app-one"]);
    } finally {
      cleanup();
    }
  });

  it("a folder of a few hundred components is not read over and over", () => {
    const { dir, page, cleanup } = folder();
    try {
      for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(dir, `c${i}.ts`), kid(`app-c${i}`));
      const started = Date.now();
      for (let i = 0; i < 300; i++) findChildComponents(page, `import "./c${i}";`);
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      cleanup();
    }
  });
});

describe("a template whose file name differs from its component's", () => {
  const project = (files: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-plugin-angular-pair-"));
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  };
  const build = async (dir: string, html: string, source: string) => {
    const result = await transformAngularTemplate({ path: path.join(dir, html), source });
    return result.modules[0]?.content ?? "";
  };

  it("pairs a.html with the component that names it in templateUrl, so this.field resolves against that class", async () => {
    const { dir, cleanup } = project({
      "app.component.ts": `@Component({ selector: "app-root", templateUrl: "./layout.html" })\nexport class AppComponent {\n  label = "app.label";\n}\n`,
    });
    try {
      const module = await build(dir, "layout.html", `<button [attr.event]="label">x</button>`);
      expect(module).toContain("class AppComponent");
      expect(module).toContain(`${CALLEE}(this.label)`);
    } finally {
      cleanup();
    }
  });

  it("takes the right class when the file declares several", async () => {
    const { dir, cleanup } = project({
      "pair.ts": `@Component({ selector: "a", templateUrl: "./a.html" })\nexport class A { first = "a.field"; }\n@Component({ selector: "b", templateUrl: "./b.html" })\nexport class B { second = "b.field"; }\n`,
    });
    try {
      const module = await build(dir, "b.html", `<i [attr.event]="second">x</i>`);
      const spliced = module.slice(module.indexOf("class B"));
      expect(spliced).toContain(`${CALLEE}(this.second)`);
      expect(module.slice(module.indexOf("class A"), module.indexOf("class B"))).not.toContain("this.second");
    } finally {
      cleanup();
    }
  });

  it("the same-named file still wins when it names the template, and is the fallback when nothing does", async () => {
    const { dir, cleanup } = project({
      "x.component.ts": `@Component({ selector: "x", templateUrl: "./x.component.html" })\nexport class X { name = "x.name"; }\n`,
      "y.component.ts": `export class Y { name = "y.name"; }\n`,
    });
    try {
      expect(await build(dir, "x.component.html", `<i [attr.event]="name">x</i>`)).toContain("class X");
      expect(await build(dir, "y.component.html", `<i [attr.event]="name">x</i>`)).toContain("class Y");
    } finally {
      cleanup();
    }
  });

  it("a template with no component at all keeps working without a class", async () => {
    const { dir, cleanup } = project({ "lonely.txt": "x" });
    try {
      const module = await build(dir, "lonely.html", `<i event="lit.event">x</i>`);
      expect(module).toContain(`${CALLEE}("lit.event")`);
    } finally {
      cleanup();
    }
  });

  it("ignores .d.ts, .spec.ts and unreadable neighbours while looking", async () => {
    const { dir, cleanup } = project({
      "other.d.ts": `export {};`,
      "other.spec.ts": `@Component({ templateUrl: "./z.html" }) export class S {}`,
      "real.ts": `@Component({ selector: "r", templateUrl: "./z.html" })\nexport class Real { v = "r"; }\n`,
    });
    try {
      fs.mkdirSync(path.join(dir, "folder.ts"));
      expect(await build(dir, "z.html", `<i [attr.event]="v">x</i>`)).toContain("class Real");
    } finally {
      cleanup();
    }
  });

  it("a folder that cannot be listed has no neighbours", () => {
    expect(locateComponent("/no/such/folder/a.html")).toBeNull();
  });
});

describe("a parent and its child declared in the same file", () => {
  it("the parent's template calls the child's component function through the file itself", async () => {
    const source = `import { Component, Input } from "@angular/core";
@Component({ selector: "app-child", template: '<i>c</i>' })
export class Child { @Input() label = ""; }

@Component({ selector: "app-parent", template: '<app-child label="same.file.event"></app-child>' })
export class Parent {}
`;
    const [module] = await run(source, "/p/together.component.ts");
    expect(module.content).toContain("import { __eventraAngularComponent as __eventraChild1_0 }");
    expect(module.content).toContain('.prototype.Child({ label: "same.file.event" })');
    expect(module.content).toContain("export { Child as __eventraAngularComponent }");
  });

  it("a component does not call itself", async () => {
    const source = `import { Component, Input } from "@angular/core";
@Component({ selector: "app-rec", template: '<app-rec label="x"></app-rec>' })
export class Rec { @Input() label = ""; }
`;
    const [module] = await run(source, "/p/rec.component.ts");
    expect(module.content).not.toContain(".prototype.Rec(");
  });
});

describe("files an Angular template is built from", () => {
  it("tells the host CLI which component file the template module holds, so watch rescans the template when it changes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-plugin-angular-deps-"));
    try {
      fs.writeFileSync(path.join(dir, "layout.component.ts"), `@Component({ selector: "l", templateUrl: "./layout.component.html" })\nexport class L { v = "x"; }\n`);
      const result = await transformAngularTemplate({ path: path.join(dir, "layout.component.html"), source: `<i event="x">y</i>` });
      expect(result.dependsOn).toEqual([path.join(dir, "layout.component.ts")]);
      const orphan = await transformAngularTemplate({ path: path.join(dir, "nothing.html"), source: `<i event="x">y</i>` });
      expect(orphan.dependsOn).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a templateUrl that points at no file", () => {
  it("gets a note, in a file that has a template as well as in one that has none; an existing file gets none", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-plugin-angular-missing-"));
    try {
      fs.writeFileSync(path.join(dir, "here.html"), "<i></i>");
      const gone = await transformAngularTemplate({ path: path.join(dir, "gone.component.ts"), source: `@Component({ selector: "g", templateUrl: "./gone.html" })\nexport class G {}\n` });
      expect(gone.modules).toEqual([]);
      expect(gone.notes).toEqual(['templateUrl "./gone.html" was not found: what its template holds is not in the scan.']);
      const mixed = await transformAngularTemplate({ path: path.join(dir, "mixed.component.ts"), source: `@Component({ selector: "a", templateUrl: "./nope.html" })\nexport class A {}\n@Component({ selector: "b", template: '<i event="mixed.event">x</i>' })\nexport class B {}\n` });
      expect(mixed.notes).toEqual(['templateUrl "./nope.html" was not found: what its template holds is not in the scan.']);
      expect(mixed.modules[0].content).toContain("mixed.event");
      const fine = await transformAngularTemplate({ path: path.join(dir, "fine.component.ts"), source: `@Component({ selector: "f", templateUrl: "./here.html" })\nexport class F {}\n` });
      expect(fine.notes).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
