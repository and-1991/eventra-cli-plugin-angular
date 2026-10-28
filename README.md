<p align="center">
<img src="./assets/eventra-icon-animated.svg" width="120">
</p>

# Eventra CLI Plugin - Angular

<p align="center">
  <a href="https://www.npmjs.com/package/@eventra_dev/cli-plugin-angular"><img alt="npm version" src="https://img.shields.io/npm/v/@eventra_dev/cli-plugin-angular.svg?style=flat-square&color=blue"></a>
  <a href="https://www.npmjs.com/package/@eventra_dev/cli-plugin-angular"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@eventra_dev/cli-plugin-angular.svg?style=flat-square&color=blue"></a>
  <img alt="tests passing" src="https://img.shields.io/badge/tests-187%20passing-brightgreen?style=flat-square&logo=vitest&logoColor=white">
  <img alt="coverage" src="https://img.shields.io/badge/coverage-100%25-brightgreen?style=flat-square&logo=vitest&logoColor=white">
  <img alt="node" src="https://img.shields.io/node/v/@eventra_dev/cli-plugin-angular?style=flat-square&color=darkgreen&logo=node.js&logoColor=white">
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-blue?style=flat-square&logo=typescript&logoColor=white"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@eventra_dev/cli-plugin-angular?style=flat-square&color=lightgrey">
</p>

Official [**Eventra CLI**](https://www.npmjs.com/package/@eventra_dev/eventra-cli) plugin - extracts `track()` calls from Angular component templates (`.html`), so `eventra sync`/`check`/`watch` understand Angular code the same way they already understand plain TypeScript.

---

## Overview

The CLI core is framework-agnostic and only walks `.ts`/`.tsx`/`.js`/`.jsx` - it already sees an Angular component's own class body (a `.ts` file) without any plugin. What it can't see is the **template**: Angular keeps that in a separate `.html` file (`templateUrl`), which isn't TypeScript at all. This plugin teaches the CLI that file: it parses each template with the real Angular compiler ([`@angular/compiler`](https://www.npmjs.com/package/@angular/compiler)) - not a regex - and hands the CLI a virtual TypeScript module per template, so every existing detection rule (direct SDK calls, dynamic-name reporting) applies to Angular templates without any Angular-specific case in the core engine.

---

## Installation

```bash
npm install -D @eventra_dev/cli-plugin-angular @eventra_dev/eventra-cli
# or
pnpm add -D @eventra_dev/cli-plugin-angular @eventra_dev/eventra-cli
```

Enable it in `eventra.json`:

```json
{
  "plugins": ["@eventra_dev/cli-plugin-angular"],
  "sync": {
    "include": ["**/*.{ts,tsx,js,jsx}"],
    "exclude": ["node_modules", "dist", ".angular", ".git"]
  }
}
```

`sync.include` does **not** need `**/*.html` added manually - the plugin registers it via `includeGlobs`.

---

## What gets detected

### Component class (`.ts`)

Handled exactly like a regular `.ts` file - direct SDK calls, function wrappers, variables, ternaries, cross-file propagation all apply, with no plugin needed for this part at all:

```ts
import { Eventra } from "@eventra_dev/eventra-sdk";

@Component({ templateUrl: "./checkout.component.html" })
export class CheckoutComponent {
  private readonly tracker = new Eventra({ apiKey: "YOUR_PROJECT_API_KEY" });

  onSubmit(): void {
    this.tracker.track("checkout.started");
  }
}
```

### Template - literal event attributes

```html
<button event="checkout.cta">Pay</button>
```

### Template - dynamic event bindings

```html
<button [attr.event]="computedEventName">Pay</button>
```

**Use `[attr.event]`, not `[event]`, on a plain HTML element.** `[event]="expr"` is a *property* binding - Angular's real compiler (`ng build`, with the template type checking that's on by default) checks it against the target's known properties, and a native element like `<button>` has no `event` DOM property, so this fails to build with `NG8002: Can't bind to 'event' since it isn't a known property of 'button'`. `[attr.event]="expr"` is an *attribute* binding instead - it always compiles regardless of element or component, since it goes through `setAttribute` rather than a property-existence check. `[event]="expr"` still works, and is still detected, on a **custom Angular component that actually declares `@Input() event`** - but `[attr.event]` is safe everywhere and costs nothing on a component either, so it's the form to reach for by default. The plugin parses both forms identically (Angular's own AST reports the same binding name, `event`, for `[event]` and `[attr.event]` alike - only the binding *type* differs, which the plugin doesn't need to care about), so nothing else below changes based on which one is used.

The expression is copied as-is into a synthetic method appended to the component's own class, so `this` inside it really is that component instance. A **simple identifier or property chain** (`computedEventName`, `config.eventName`, `config?.eventName`, `map['key']`) is automatically qualified with `this.` - Angular template expressions never write `this` explicitly (it's a compile error in Angular's own syntax), so a bare name always means "this component's own field/getter". If it resolves to a real class property's literal initializer, the event name is detected normally; otherwise it's reported as a **dynamic occurrence** (same mechanism as `tracker.track(someVariable)` in plain TypeScript) instead of being silently dropped.

A more complex expression (a method call, an operator, a pipe, a literal) is **not** rewritten with `this.` - it's copied verbatim and, since it won't match anything in scope, correctly falls back to a dynamic occurrence with no resolved value, the same honest fallback as an expression the resolver doesn't otherwise recognize.

`event` is recognized on any tag - plain elements, components, `ng-container`, `ng-template`, `*ngIf`/`*ngFor` structural directives, and the newer `@if`/`@else if`/`@else`, `@for`/`@empty`, and `@switch`/`@case`/`@default` block syntax - since the plugin walks the whole template tree rather than special-casing specific block kinds.

### Template - calls in handlers, bindings and expressions

Calls in the template's own expressions are read: `(click)="track('x')"` (also several statements), `[title]="track('x')"`, `{{ track('x') }}`, `*ngIf`, `@if` / `@else if` / `@switch` / `@case`, `@for` (the iterated expression and `track`), `@let`, and `@defer` (its `when` conditions and its `@placeholder`, `@loading` and `@error` blocks). Each call with arguments is written against the component class, so `track('x')` becomes `this.track('x')`, and the call resolves to the component's own method (which may call the SDK) or to a service it holds (`svc.analytics.track('x')`). Literals, members (`a.b`, `a?.b`, `a[k]`), object and array literals, conditionals and operators in the arguments are kept; a pipe in an argument makes that argument dynamic. A call without arguments names no event and is skipped.

### Finding the component class

The template file is paired with its component by Angular CLI's own default naming convention: `foo.component.html` ↔ `foo.component.ts` in the same directory (the class decorated with `@Component` is used; if none carries that exact decorator - e.g. an aliased `Component` import - the file's first class is used instead). This covers the schematic-generated layout the overwhelming majority of Angular projects use. It does **not** yet resolve a `templateUrl` that points somewhere else, and it does **not** yet support an **inline** template (`template: "..."` written directly in the `@Component` decorator, with no separate `.html` file) - both are documented gaps, not silent failures: with no template file to match against `**/*.html` in the first place, an inline template's `event`/`[event]` bindings simply aren't seen (same as before this plugin existed).

When the paired `.ts` file can't be found (or has no class at all), literal `event="..."` bindings still resolve normally - they don't need any scope - and dynamic `[event]="..."` bindings are still reported as dynamic occurrences, just never resolved to a literal.

### Template parse errors

If `@angular/compiler` can't parse a template at all - most commonly a text node that starts with what looks like a control-flow block opener (`@if`, `@for`, `@switch`, ...) but isn't escaped, e.g. a button labeled literally `@if control-flow event` instead of `&#64;if control-flow event` - this plugin throws instead of silently treating the file as if it had zero event bindings. The host CLI reports it as `skip: <file> Plugin "angular" failed to transform <file>: Failed to parse Angular template <file>: <compiler diagnostic>` and continues scanning every other file; only that one template is excluded from the run.

Every `.html` file in the project is offered to this plugin, and many are not templates (generated API documentation, static pages). One that fails to parse and that no component names as its `templateUrl` (the sibling `.ts` file must mention one) is skipped without a message; the error is raised only for a real component template. A template counts as one when a `.ts` file in the same folder names it as a `templateUrl`, whatever the component is called.

---

### Inputs of a component, whatever they are called

The input does not have to be named `event`. If a component sends one of its inputs to a tracking call, every template that uses the component with a value for that input is an event:

```ts
import { Component, Input } from '@angular/core';
import { Eventra } from '@eventra_dev/eventra-sdk';

@Component({ selector: 'app-button', templateUrl: './button.component.html' })
export class ButtonComponent {
  private tracker = new Eventra({ apiKey: 'YOUR_KEY' });
  @Input() analyticsName!: string;
  onClick() { this.tracker.track(this.analyticsName); }
}
```

```html
<app-button analyticsName="checkout.cta">Pay</app-button>
<app-button [analyticsName]="name">Pay</app-button>
```

Read: `@Input()`, `@Input('alias')`, `@Input({ alias })`, setter inputs, `input()`, `input.required()` and `model()`; element selectors (`app-x`), `[attr]`, `tag[attr]` and comma lists; elements inside `*ngIf`, `*ngFor` and `@if` blocks; a bound expression with a pipe is an opaque value. The child is found by its `selector` among the files the template's component imports with a relative path and the `.ts` files in its own folder. An input handed on to another component is followed.

**Not followed** (those components are scanned as before, so nothing is lost, but an input that only they use is not found):

- A child with an inline `template:` (the plugin only receives `.html` files).
- A child reached only through an NgModule in another folder (the search covers the files the parent imports with a relative path and the `.ts` files in its own folder).
- Inputs declared in the `inputs: []` metadata array, and aliases that are not plain identifiers.
- Directives (`@Directive`).
- Class selectors (`.x`) and `:not()`.

A value the CLI cannot resolve to a plain string (an `*ngFor` variable, an input of the parent itself) is listed under "Dynamic event names" instead of becoming an event. The same list shows the tracking call inside the component itself, one line per component, because what it tracks is whatever each caller passes; the callers that pass a literal are still found.

## Known limitations

- **`[event]="expr"` on a native element fails a real `ng build` (NG8002).** See "Template - dynamic event bindings" above - use `[attr.event]="expr"` instead, which the plugin detects identically.
- **Inline templates are unsupported.** Only `templateUrl`-based (external `.html` file) components are covered - see "Finding the component class" above.
- **The `this.`-qualification heuristic is simple-shape-only.** It recognizes a bare identifier or a chain of `.prop`/`?.prop`/`['key']` accessors - this covers both a plain class field (`EVENT_NAME = "x"`) and a **getter** (`get computedEventName() { return "x"; }`, including one with conditional `return`s, which resolves as a dynamic occurrence unioning every branch), since the host CLI's resolver checks both member kinds for `this.field`. Anything else is left as written and reported as an unresolved dynamic occurrence rather than partially rewritten - most notably **Angular Signals** (`[event]="mySignal()"`): the call syntax doesn't match the simple-shape regex, and even if it did, a signal isn't a plain function the resolver can walk into (its value lives in a separate reactive primitive, not a `return` statement) - resolving it would need dedicated Signals-aware logic this plugin doesn't have yet.
- **The paired component class is read from disk as a second copy.** If that class already has its own real `track()`/`tracker.track()` calls in its methods (unrelated to the template), those calls get scanned twice - once via the real `.ts` file (as always), once via this plugin's virtual copy of it. The final `events` list in `eventra.json` is unaffected (it's a set, duplicates collapse), but `eventra sync`'s "Dynamic event names" console output can list the same source line twice, once under each file path.

---

## Configuration

No plugin-specific config - it activates purely by being listed in `eventra.json`'s `plugins` array (see [Installation](#installation)).

---

## Plugin contract

```ts
export interface CliPluginAngular {
  readonly id: string;
  readonly version: string;
  readonly includeGlobs: readonly string[];
  readonly staticSinks?: readonly CliPluginStaticCalleeSink[];
  match(path: string): boolean;
  transform(input: { path: string; source: string }): Promise<{
    modules: Array<{ path: string; content: string }>;
  }>;
}
```

No dependency on `@eventra_dev/eventra-cli` - the CLI adapts this shape internally. `.html` → one virtual `.html.ts` module: either the paired component's own source with a synthetic method spliced into its class (when at least one dynamic binding needs a `this`-scope), or a small standalone function (when every binding is literal, or no component class could be found). `staticSinks` describes the synthetic calls it emits; the CLI builds its own sink detector from them. See [`@eventra_dev/eventra-cli`'s plugin docs](https://www.npmjs.com/package/@eventra_dev/eventra-cli#plugin-contract-for-authors) for the full external-plugin contract.

---

## Requirements

- Node.js `^20.19.0 || ^22.12.0 || >=24.0.0` (the version range required by `@angular/compiler` itself - higher than the `>=18` floor of this project's other framework plugins, since Angular's own tooling has moved past Node 18)
- `@eventra_dev/eventra-cli` as the host CLI

---

## Test Coverage

**100% statement/branch/function/line coverage** (v8 provider, `pnpm test:coverage`), enforced via a `coverage.thresholds` block in `vitest.config.ts`.

**187 unit tests** (vitest), covering:

| Area | Covers |
|---|---|
| Template parsing | Literal and dynamic `event` bindings, `[event]` and `[attr.event]` parsed identically, `*ngIf`/`*ngFor`, `@if`/`@else if`/`@else`, `@for`/`@empty`, `@switch`/`@case`/`@default`, `ng-container`/`ng-template`, empty/boolean-shorthand `event`, throws on a template the compiler can't parse (e.g. an unescaped `@if`-like text node) instead of silently reporting zero bindings |
| `this.`-qualification | Bare identifier, property chain, optional chaining, element access all prefixed; method calls, operators, and literals left untouched |
| Component-class pairing | `@Component`-decorated class found and used, undecorated-class fallback, decorated class preferred over an earlier undecorated one, no-class-in-file and missing-file fallbacks |
| Virtual module output | Synthetic method spliced inside the real class before its closing brace, top-level-function fallback for literal-only templates and unpaired templates, export stub for an empty template |
| Plugin contract | `match()`, `includeGlobs`, `staticSinks`, `transform()`, end-to-end dynamic-binding resolution through a real paired component class |

Run locally:

```bash
pnpm --filter @eventra_dev/cli-plugin-angular test
pnpm --filter @eventra_dev/cli-plugin-angular test:coverage
```

---

## License

MIT, copyright (c) 2026 [Yuriy Korolik](https://github.com/and-1991). See [LICENSE](LICENSE).
