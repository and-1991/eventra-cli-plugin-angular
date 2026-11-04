import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { buildInlineModule } from "../src/build-virtual-module";
import { readComponentInfo } from "../src/component";
import { transformAngularTemplate } from "../src/transform";

const CALLEE = "__eventra_angular_template_event__";

const component = (template: string, body = ""): string =>
  `import { Component } from "@angular/core";\n@Component({ selector: "app-x", template: ${template} })\nexport class XComponent {\n  name = "signup";\n${body}}\n`;

const run = async (source: string, file = "/p/x.component.ts") => (await transformAngularTemplate({ path: file, source })).modules;

describe("inline template: readComponentInfo", () => {
  it("reads a plain string, a backtick string and rejects one with ${}", () => {
    expect(readComponentInfo(component(`"<i>a</i>"`), "x.ts")?.inlineTemplate).toBe("<i>a</i>");
    expect(readComponentInfo(component("`<i>b</i>`"), "x.ts")?.inlineTemplate).toBe("<i>b</i>");
    expect(readComponentInfo(component("`<i>${x}</i>`"), "x.ts")?.inlineTemplate).toBeNull();
    expect(readComponentInfo(`@Component({ selector: "a", templateUrl: "./a.html" }) export class A {}`, "a.ts")?.inlineTemplate).toBeNull();
  });
});

describe("inline template: transform", () => {
  it("reads a literal event of the inline template under the file's own path", async () => {
    const modules = await run(component("`<button event=\"checkout.cta\">go</button>`"));
    expect(modules).toHaveLength(1);
    expect(modules[0].path).toBe("/p/x.component.ts");
    expect(modules[0].content).toContain(`${CALLEE}("checkout.cta")`);
    expect(modules[0].content).toContain("export class XComponent");
  });

  it("qualifies a bound event with this, so it resolves against the class", async () => {
    const [module] = await run(component(`'<button [event]="name">go</button>'`));
    expect(module.content).toContain(`${CALLEE}(this.name)`);
  });

  it("keeps the lines of the component's own code and puts the declaration after it", async () => {
    const source = component(`'<button event="a">go</button>'`, "  track() { return 1; }\n");
    const [module] = await run(source);
    const before = source.split("\n");
    const after = module.content.split("\n");
    // every line up to the class's closing brace is where it was
    expect(after.slice(0, before.indexOf("  track() { return 1; }") + 1)).toEqual(before.slice(0, before.indexOf("  track() { return 1; }") + 1));
    expect(module.content.trimEnd().split("\n").pop()).toContain(`declare function ${CALLEE}`);
  });

  it("follows calls written in the template", async () => {
    const [module] = await run(component(`'<button (click)="track(\\'x.clicked\\')">go</button>'`, "  track(n: string) {}\n"));
    expect(module.content).toContain("x.clicked");
    expect(module.content).toContain("angular template (auto-generated)");
  });

  it("returns no modules for a file that is not a component or has no inline template", async () => {
    expect(await run(`export const a = 1;`)).toEqual([]);
    expect(await run(`@Component({ selector: "a", templateUrl: "./a.html" }) export class A {}`)).toEqual([]);
    expect(await run(component("`<i>${x}</i>`"))).toEqual([]);
    expect(await run(component(`'<i>no events</i>'`))).toEqual([]);
    expect(await run(`// template: nothing @Component\nexport const b = 2;`)).toEqual([]);
  });

  it("does not read declaration files", async () => {
    expect(await run(component(`'<i event="x"></i>'`), "/p/x.d.ts")).not.toEqual([]);
  });

  it("fails on an inline template that does not parse, as a .html one does", async () => {
    await expect(run(component(`'<div [x]="a +">t</div>'`))).rejects.toThrow(/inline Angular template of \/p\/x\.component\.ts/);
  });

  it("returns null from buildInlineModule when there is nothing to add", () => {
    expect(buildInlineModule("/p/x.ts", component(`'<i>x</i>'`), [])).toBeNull();
  });
});

describe("inline template: components with inputs", () => {
  it("lets a parent follow an input into a child that has an inline template", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-plugin-angular-inline-"));
    try {
      const child = `import { Component, Input } from "@angular/core";\n@Component({ selector: "app-child", template: '<i></i>' })\nexport class ChildComponent {\n  @Input() track = "";\n  fire(sdk: { track(n: string): void }) { sdk.track(this.track); }\n}\n`;
      const parent = `import { Component } from "@angular/core";\nimport { ChildComponent } from "./child.component";\n@Component({ selector: "app-p", template: '<app-child track="child.event"></app-child>' })\nexport class ParentComponent {}\n`;
      fs.writeFileSync(path.join(root, "child.component.ts"), child);
      fs.writeFileSync(path.join(root, "parent.component.ts"), parent);
      const [module] = await run(parent, path.join(root, "parent.component.ts"));
      expect(module.content).toContain(`import { __eventraAngularComponent as __eventraChild0 } from "./child.component";`);
      expect(module.content).toContain(`__eventraChild0.prototype.ChildComponent({ track: "child.event" })`);

      const [childModule] = await run(child, path.join(root, "child.component.ts"));
      expect(childModule.content).toContain("export { ChildComponent as __eventraAngularComponent }");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
