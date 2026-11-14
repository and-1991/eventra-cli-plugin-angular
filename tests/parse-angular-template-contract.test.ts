import { describe, expect, it } from "vitest";

import { parseAngularTemplate } from "../src/parse-angular-template";

// Exact-output tests for the parts of the template walk that the broader tests only touch.

describe("event bindings", () => {
  it("trims a literal event name", () => {
    expect(parseAngularTemplate(`<a event="  lit  ">x</a>`).templateEvents).toEqual([{ kind: "literal", value: "lit" }]);
  });

  it("drops an empty or boolean event attribute", () => {
    expect(parseAngularTemplate(`<a event="">x</a><a event>y</a><a event="   ">z</a>`).templateEvents).toEqual([]);
  });

  it("trims a bound event expression, and keeps it raw", () => {
    expect(parseAngularTemplate(`<a [event]="  name  ">x</a>`).templateEvents).toEqual([{ kind: "dynamic", value: "name" }]);
    expect(parseAngularTemplate(`<a [event]="cond ? 'a' : b">x</a>`).templateEvents).toEqual([{ kind: "dynamic", value: "cond ? 'a' : b" }]);
  });

  it("does not take other attributes or bindings for an event", () => {
    expect(parseAngularTemplate(`<a name="x" data-event="y" [events]="z" [eventx]="w" (event)="go()">x</a>`).templateEvents).toEqual([]);
  });
});

describe("errors", () => {
  it("is empty for a valid template", () => {
    expect(parseAngularTemplate(`<p>{{ a }}</p>`).errors).toEqual([]);
  });

  it("carries the compiler's messages, with a 1-based line and column instead of template.html@0:5 (PL6)", () => {
    expect(parseAngularTemplate(`<div>{{ a | }}</div>`).errors).toEqual([
      "Parser Error: Unexpected end of input, expected identifier or keyword at the end of the expression [ a | ] (line 1, column 6)",
    ]);
  });

  it("lists every message in order", () => {
    expect(parseAngularTemplate(`<div (click)="foo(">x</div>`).errors).toEqual([
      "Parser Error: Unexpected end of expression: foo( at the end of the expression [foo(] (line 1, column 15)",
      "Parser Error: Missing expected ) at the end of the expression [foo(] (line 1, column 15)",
    ]);
  });

  it("gives the real line of an expression error further down the template", () => {
    expect(parseAngularTemplate("<div>\n<p>x</p>\n<button (click)=\"track('a'\">Go</button>\n</div>").errors).toEqual([
      "Parser Error: Missing expected ) at the end of the expression [track('a'] (line 3, column 18)",
    ]);
  });
});
