import { describe, expect, it } from "vitest";

import { parseAngularTemplate } from "../src/parse-angular-template";

describe("parseAngularTemplate", () => {
  it("extracts a literal event attribute", () => {
    const { templateEvents, errors } = parseAngularTemplate(`<button event="checkout.cta">Pay</button>`);
    expect(errors).toEqual([]);
    expect(templateEvents).toEqual([{ kind: "literal", value: "checkout.cta" }]);
  });

  it("extracts a dynamic bound event attribute, raw expression text verbatim", () => {
    const { templateEvents } = parseAngularTemplate(`<button [event]="computedEventName"></button>`);
    expect(templateEvents).toEqual([{ kind: "dynamic", value: "computedEventName" }]);
  });

  it("extracts a dynamic property-chain expression verbatim", () => {
    const { templateEvents } = parseAngularTemplate(`<button [event]="config.eventName"></button>`);
    expect(templateEvents).toEqual([{ kind: "dynamic", value: "config.eventName" }]);
  });

  it("ignores attributes/inputs not named event", () => {
    const { templateEvents } = parseAngularTemplate(`<button [disabled]="isDisabled" title="hi"></button>`);
    expect(templateEvents).toEqual([]);
  });

  it("ignores an empty literal event=\"\"", () => {
    const { templateEvents } = parseAngularTemplate(`<button event=""></button>`);
    expect(templateEvents).toEqual([]);
  });

  it("ignores the boolean-shorthand event (no value)", () => {
    const { templateEvents } = parseAngularTemplate(`<button event></button>`);
    expect(templateEvents).toEqual([]);
  });

  it("ignores an empty bound [event]=\"\"", () => {
    const { templateEvents } = parseAngularTemplate(`<button [event]=""></button>`);
    expect(templateEvents).toEqual([]);
  });

  it("finds event bindings nested inside a *ngIf structural directive (desugared Template node)", () => {
    const { templateEvents } = parseAngularTemplate(`
      <div *ngIf="cond">
        <button event="nested.literal"></button>
        <button [event]="nested.dynamic"></button>
      </div>
    `);
    expect(templateEvents).toEqual([
      { kind: "literal", value: "nested.literal" },
      { kind: "dynamic", value: "nested.dynamic" },
    ]);
  });

  it("finds event bindings inside @if / @else if / @else blocks", () => {
    const { templateEvents } = parseAngularTemplate(`
      @if (a) {
        <span event="if_branch"></span>
      } @else if (b) {
        <span event="else_if_branch"></span>
      } @else {
        <span event="else_branch"></span>
      }
    `);
    expect(templateEvents.map((e) => e.value).sort()).toEqual(["else_branch", "else_if_branch", "if_branch"]);
  });

  it("finds event bindings inside @for, including its @empty branch", () => {
    const { templateEvents } = parseAngularTemplate(`
      @for (item of items; track item.id) {
        <span event="loop_item"></span>
      } @empty {
        <span event="empty_branch"></span>
      }
    `);
    expect(templateEvents.map((e) => e.value).sort()).toEqual(["empty_branch", "loop_item"]);
  });

  it("finds event bindings inside @switch / @case / @default", () => {
    const { templateEvents } = parseAngularTemplate(`
      @switch (val) {
        @case (1) { <span event="case_one"></span> }
        @default { <span event="case_default"></span> }
      }
    `);
    expect(templateEvents.map((e) => e.value).sort()).toEqual(["case_default", "case_one"]);
  });

  it("finds event bindings inside ng-container and ng-template", () => {
    const { templateEvents } = parseAngularTemplate(`
      <ng-container>
        <a [event]="containerVal"></a>
      </ng-container>
      <ng-template>
        <b event="tpl_literal"></b>
      </ng-template>
    `);
    expect(templateEvents.map((e) => e.value).sort()).toEqual(["containerVal", "tpl_literal"]);
  });

  it("reports parse errors from malformed markup", () => {
    const { errors } = parseAngularTemplate(`<div><span></div>`);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("returns no bindings for an empty template", () => {
    const { templateEvents, errors } = parseAngularTemplate("");
    expect(templateEvents).toEqual([]);
    expect(errors).toEqual([]);
  });
});
