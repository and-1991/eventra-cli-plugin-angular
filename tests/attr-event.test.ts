import { describe, expect, it } from "vitest";

import { parseAngularTemplate } from "../src/parse-angular-template";

describe("[event] and [attr.event] bindings", () => {
  it("reads [attr.event], which is how a plain element takes a bound event in Angular", () => {
    expect(parseAngularTemplate(`<button [attr.event]="name">go</button>`).templateEvents).toEqual([{ kind: "dynamic", value: "name" }]);
  });

  it("reads [event] on a component, where it is an input", () => {
    expect(parseAngularTemplate(`<app-x [event]="name"></app-x>`).templateEvents).toEqual([{ kind: "dynamic", value: "name" }]);
  });

  it("reads a literal event on any element", () => {
    expect(parseAngularTemplate(`<button event="a.b">go</button>`).templateEvents).toEqual([{ kind: "literal", value: "a.b" }]);
  });
});

describe("notes about [event] on a native element", () => {
  const notes = (template: string) => parseAngularTemplate(template).notes;

  it("tells the user that [event] on a native element fails Angular's own compile, once per tag", () => {
    expect(notes(`<button [event]="a">x</button><button [event]="b">y</button><a [event]="c">z</a>`)).toEqual([
      "[event] on <button> is a property binding that Angular rejects (NG8002) unless a directive declares an event input: write [attr.event] instead",
      "[event] on <a> is a property binding that Angular rejects (NG8002) unless a directive declares an event input: write [attr.event] instead",
    ]);
  });

  it("is quiet for a component, [attr.event], a literal event and the other bindings", () => {
    expect(notes(`<app-x [event]="a"></app-x><button [attr.event]="a" event="b" [title]="c">x</button><ng-container [ngIf]="d"></ng-container>`)).toEqual([]);
  });

  it("finds it inside blocks and structural directives", () => {
    expect(notes(`@if (ok) { <button [event]="a">x</button> }`)).toHaveLength(1);
    expect(notes(`<div *ngIf="ok"><i [event]="a"></i></div>`)).toHaveLength(1);
  });

  it("is passed on by the transform, and left out when there is nothing to say", async () => {
    const { transformAngularTemplate } = await import("../src/transform");
    const withNote = await transformAngularTemplate({ path: "/p/a.component.html", source: `<button [event]="a">x</button>` });
    expect(withNote.notes).toHaveLength(1);
    const without = await transformAngularTemplate({ path: "/p/a.component.html", source: `<button event="a">x</button>` });
    expect("notes" in without).toBe(false);

    const inline = await transformAngularTemplate({
      path: "/p/a.component.ts",
      source: `@Component({ selector: "app-a", template: '<button [event]="a">x</button>' }) export class A { a = "x"; }`,
    });
    expect(inline.notes).toHaveLength(1);
    const inlineQuiet = await transformAngularTemplate({
      path: "/p/b.component.ts",
      source: `@Component({ selector: "app-b", template: '<button event="a">x</button>' }) export class B {}`,
    });
    expect("notes" in inlineQuiet).toBe(false);
  });
});
