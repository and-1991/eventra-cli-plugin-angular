import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { buildVirtualModule } from "../src/build-virtual-module";
import { parseAngularTemplate } from "../src/parse-angular-template";
import { transformAngularTemplate } from "../src/transform";

const calls = (template: string) => parseAngularTemplate(template).templateCalls;

describe("template calls: where they are found", () => {
  it("reads (event) handlers, one call per statement", () => {
    expect(calls(`<button (click)="track('a')">x</button>`)).toEqual([`this.track("a");`]);
    expect(calls(`<button (click)="onClick(); track('b')">x</button>`)).toEqual([`this.track("b");`]);
  });

  it("reads {{ }} interpolations and [input] bindings", () => {
    expect(calls(`<p>{{ track('c') }}</p><b [title]="track('d')">x</b>`)).toEqual([`this.track("c");`, `this.track("d");`]);
  });

  it("reads *ngIf and the other attributes a structural directive is built from", () => {
    expect(calls(`<div *ngIf="track('e')"><i *ngFor="let x of list(1); trackBy: pick">x</i></div>`)).toEqual([
      `this.track("e");`,
      `this.list(1);`,
    ]);
  });

  it("reads @if / @else if, @switch / @case and @for", () => {
    expect(calls(`@if (track('f')) { a } @else if (track('g')) { b }`)).toEqual([`this.track("f");`, `this.track("g");`]);
    expect(calls(`@switch (track('h')) { @case (track('i')) { a } @default { b } }`)).toEqual([
      `this.track("h");`,
      `this.track("i");`,
    ]);
    expect(calls(`@for (x of track('j'); track x) { {{ x }} } @empty { e }`)).toEqual([`this.track("j");`]);
  });

  it("reads @let, the track expression of @for, and @defer conditions and its @placeholder / @loading / @error blocks", () => {
    expect(
      calls(
        `@let label = fmt('let:x');
         @defer (when ready('defer:when'); prefetch when pre('defer:prefetch')) { <b (click)="t('defer:main')">a</b> }
         @placeholder { <i (click)="t('defer:placeholder')">p</i> }
         @loading { <i (click)="t('defer:loading')">l</i> }
         @error { <i (click)="t('defer:error')">e</i> }
         @for (x of list(); track keyOf('for:track', x)) { {{ x }} }`,
      ),
    ).toEqual([
      `this.fmt("let:x");`,
      `this.ready("defer:when");`,
      `this.pre("defer:prefetch");`,
      `this.t("defer:main");`,
      `this.t("defer:placeholder");`,
      `this.t("defer:loading");`,
      `this.t("defer:error");`,
      `this.keyOf("for:track", this.x);`,
    ]);
  });

  it("reads a @defer hydrate condition and tolerates a @defer with no extra blocks", () => {
    expect(calls(`@defer (hydrate when go('defer:hydrate')) { <p>x</p> }`)).toEqual([`this.go("defer:hydrate");`]);
    expect(calls(`@defer { <p>plain</p> }`)).toEqual([]);
  });

  it("finds calls inside nested elements, blocks and the markup of an empty branch", () => {
    expect(calls(`<div><p (click)="track('k')">x</p></div>@if (a) { <i (click)="track('l')">x</i> }`)).toEqual([
      `this.track("k");`,
      `this.track("l");`,
    ]);
  });

  it("reports nothing for a template without calls, and ignores calls that pass no argument", () => {
    expect(calls(`<p>plain</p><b [title]="label">x</b><i (click)="open()">y</i>{{ name }}`)).toEqual([]);
  });

  it("collects calls nested in another call's arguments, and calls reached through other expressions", () => {
    expect(calls(`<p>{{ track(label('x')) }}</p>`)).toEqual([`this.track(this.label("x"));`, `this.label("x");`]);
    expect(calls(`<p>{{ ok ? track('m') : null }}</p>`)).toEqual([`this.track("m");`]);
  });
});

describe("template calls: how they are written", () => {
  const first = (template: string) => calls(template)[0];

  it("writes literals", () => {
    expect(first(`<p>{{ track('s', 1, true, null, undefined) }}</p>`)).toBe(
      `this.track("s", 1, true, null, undefined);`,
    );
  });

  it("writes members of the component, optional chaining and keyed reads", () => {
    expect(first(`<p>{{ track(a.b, c?.d, m['k'], n?.[0]) }}</p>`)).toBe(
      `this.track(this.a.b, this.c?.d, this.m["k"], this.n?.[0]);`,
    );
  });

  it("writes object and array literals", () => {
    expect(first(`<p>{{ track({ event: 'x', 'a-b': y }, [1, z]) }}</p>`)).toBe(
      `this.track(({ "event": "x", "a-b": this.y }), [1, this.z]);`,
    );
  });

  it("writes conditionals, operators, negations and non-null assertions", () => {
    expect(first(`<p>{{ track(a ? 'x' : 'y', 'p' + q, -r, !s, t!) }}</p>`)).toBe(
      `this.track((this.a ? "x" : "y"), ("p" + this.q), (-this.r), (!this.s), this.t);`,
    );
  });

  it("writes a pipe, which has no TypeScript form, as an opaque value", () => {
    expect(first(`<p>{{ track(a | upper) }}</p>`)).toBe(`this.track((undefined as any));`);
  });

  it("writes a call whose function is a pipe result as valid TypeScript", () => {
    expect(first(`<p (click)="(handler | pipe)('x')">x</p>`)).toBe(`(undefined as any)("x");`);
  });

  it("writes member calls, safe calls and calls on a computed receiver", () => {
    expect(first(`<p>{{ svc.analytics.track('x') }}</p>`)).toBe(`this.svc.analytics.track("x");`);
    expect(first(`<p>{{ svc?.track('x') }}</p>`)).toBe(`this.svc?.track("x");`);
    expect(first(`<p>{{ fns['t']('x') }}</p>`)).toBe(`this.fns["t"]("x");`);
    expect(first(`<p>{{ fn?.('x') }}</p>`)).toBe(`this.fn?.("x");`);
  });

  it("writes a call inside an argument as a call", () => {
    expect(first(`<p>{{ track(svc.name('x')) }}</p>`)).toBe(`this.track(this.svc.name("x"));`);
  });
});

describe("template calls: the virtual module", () => {
  function project() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ng-calls-"));
    return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }

  it("splices the calls into the component class, between region markers", () => {
    const { root, cleanup } = project();
    try {
      const html = path.join(root, "c.component.html");
      fs.writeFileSync(path.join(root, "c.component.ts"), `export class C {\n  track(n: string) {}\n}\n`);
      const module = buildVirtualModule(html, [], [`this.track("a");`]);
      expect(module).toContain("  // --- angular template (auto-generated) ---\n  __eventraAngularTemplate() {\n    this.track(\"a\");\n  }\n  // --- end template ---\n}");
      expect(module).toContain("track(n: string) {}");
    } finally {
      cleanup();
    }
  });

  it("falls back to a plain function, still marked, when there is no component class", () => {
    const module = buildVirtualModule("/nowhere/c.component.html", [{ kind: "literal", value: "x" }], [`this.track("a");`]);
    expect(module).toContain("// --- angular template (auto-generated) ---\nfunction __eventraAngularTemplate() {");
    expect(module).toContain(`  this.track("a");\n}\n// --- end template ---`);
    expect(module).toContain('__eventra_angular_template_event__("x");');
  });

  it("writes no markers when the template has no calls", () => {
    const module = buildVirtualModule("/nowhere/c.component.html", [{ kind: "literal", value: "x" }]);
    expect(module).not.toContain("auto-generated");
  });

  it("is an empty module when there is nothing at all", () => {
    expect(buildVirtualModule("/nowhere/c.component.html", [], [])).toBe("export {}\n");
  });

  it("is what transformAngularTemplate returns for a template with a call", async () => {
    const result = await transformAngularTemplate({
      path: "/nowhere/c.component.html",
      source: `<button (click)="track('a')">x</button>`,
    });
    expect(result.modules[0]?.content).toContain(`this.track("a");`);
  });
});
