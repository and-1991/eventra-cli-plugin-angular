import {
  Binary,
  Call,
  Conditional,
  ImplicitReceiver,
  KeyedRead,
  LiteralArray,
  LiteralMap,
  LiteralPrimitive,
  NonNullAssert,
  parseTemplate,
  PrefixNot,
  PropertyRead,
  RecursiveAstVisitor,
  SafeCall,
  SafeKeyedRead,
  SafePropertyRead,
  ThisReceiver,
  Unary,
} from "@angular/compiler";
import type { AST, TmplAstNode } from "@angular/compiler";

/** A single `event="..."` binding found on a tag in the template. */
export interface TemplateEventBinding {
  /** `literal`: the event name is a string constant. `dynamic`: a raw Angular expression, copied verbatim. */
  readonly kind: "literal" | "dynamic";
  readonly value: string;
}

/** A prop bound on an element: `track="x"` (a literal) or `[track]="expr"` (an expression, as code inside the class). */
export interface TemplateComponentProp {
  readonly name: string;
  readonly kind: "literal" | "expression";
  readonly value: string;
}

/** An element with its props: a use of a component, when the tag or an attribute is what that component's selector picks. */
export interface TemplateComponentUsage {
  readonly tag: string;
  /** Every attribute name on the element, bound or not, for attribute selectors (`[appTrack]`). */
  readonly attributes: readonly string[];
  readonly props: readonly TemplateComponentProp[];
}

export interface ParsedAngularTemplate {
  readonly templateEvents: readonly TemplateEventBinding[];
  /**
   * Every call with arguments in the template's expressions (`(click)="track('x')"`, `{{ track('x') }}`,
   * `[title]="track('x')"`, `*ngIf`, `@if`), as a TypeScript statement that reads like the call does
   * from inside the component class: a bare name is a member (`this.track('x')`). A call to a tracking
   * function in there is an event the component fires.
   */
  readonly templateCalls: readonly string[];
  /** Every element that carries attributes or bindings; the ones that are components are found by their selector. */
  readonly componentUsages: readonly TemplateComponentUsage[];
  readonly errors: readonly string[];
}

interface TextAttributeLike {
  readonly name: string;
  readonly value: string;
}

interface BoundAttributeLike {
  readonly name: string;
  // 0 is a property binding (`[track]`); attribute, class and style bindings are other kinds
  readonly type?: number;
  readonly value?: { readonly source?: string | null; readonly ast?: AST };
}

/** Duck-typed: every node kind this walk cares about is checked structurally, not by class name - a future `@angular/compiler` version adding a new block/element kind is still picked up as long as it carries the same `attributes`/`inputs`/`children` shape. */
interface WalkableNode {
  // Element: its tag name
  readonly name?: unknown;
  readonly attributes?: readonly TextAttributeLike[];
  readonly inputs?: readonly BoundAttributeLike[];
  // `(event)="handler"`
  readonly outputs?: readonly { readonly handler?: unknown }[];
  // the bound attributes a `*structural` directive was desugared from
  readonly templateAttrs?: readonly { readonly value?: unknown }[];
  // BoundText (`{{ ... }}`)
  readonly value?: unknown;
  // SwitchBlock, ForLoopBlock
  readonly expression?: unknown;
  // ForLoopBlock's `track` expression
  readonly trackBy?: unknown;
  // DeferredBlock: `@placeholder` / `@loading` / `@error` blocks, and the `when` conditions of its triggers
  readonly placeholder?: { readonly children?: readonly WalkableNode[] } | null;
  readonly loading?: { readonly children?: readonly WalkableNode[] } | null;
  readonly error?: { readonly children?: readonly WalkableNode[] } | null;
  readonly triggers?: { readonly when?: { readonly value?: unknown } };
  readonly prefetchTriggers?: { readonly when?: { readonly value?: unknown } };
  readonly hydrateTriggers?: { readonly when?: { readonly value?: unknown } };
  readonly children?: readonly WalkableNode[];
  // IfBlock
  readonly branches?: readonly { readonly expression?: unknown; readonly children?: readonly WalkableNode[] }[];
  // SwitchBlock
  readonly cases?: readonly { readonly expression?: unknown; readonly children?: readonly WalkableNode[] }[];
  // ForLoopBlock's `@empty` branch
  readonly empty?: { readonly children?: readonly WalkableNode[] } | null;
}

function collectComponentUsage(node: WalkableNode, out: TemplateComponentUsage[]): void {
  if (typeof node.name !== "string") return;
  const attributes = node.attributes ?? [];
  const inputs = (node.inputs ?? []).filter((input) => input.type === 0);
  const props: TemplateComponentProp[] = [];
  for (const attribute of attributes) {
    if (attribute.value !== "") props.push({ name: attribute.name, kind: "literal", value: attribute.value });
  }
  for (const input of inputs) {
    // a bound attribute always carries its parsed expression; the type only says it may not
    /* v8 ignore next */
    if (input.value?.ast) props.push({ name: input.name, kind: "expression", value: render(input.value.ast) });
  }
  if (props.length > 0) out.push({ tag: node.name, attributes: [...attributes.map((attribute) => attribute.name), ...inputs.map((input) => input.name)], props });
}

function collectFromAttributes(attributes: readonly TextAttributeLike[] | undefined, out: TemplateEventBinding[]): void {
  for (const attribute of attributes ?? []) {
    if (attribute.name !== "event") continue;
    const literal = attribute.value.trim();
    if (literal) {
      out.push({ kind: "literal", value: literal });
    }
    // Empty `event=""` and boolean-shorthand `event` both parse to an empty
    // string value here - nothing to extract, same as the Vue/Svelte plugins.
  }
}

function collectFromInputs(inputs: readonly BoundAttributeLike[] | undefined, out: TemplateEventBinding[]): void {
  for (const input of inputs ?? []) {
    if (input.name !== "event") continue;
    const dynamic = input.value?.source?.trim();
    if (dynamic) {
      out.push({ kind: "dynamic", value: dynamic });
    }
  }
}

/** An expression as the compiler hands it over: the parsed tree plus its source text. */
interface ExpressionLike {
  readonly ast?: AST;
}

const isExpression = (value: unknown): value is ExpressionLike =>
  typeof value === "object" && value !== null && "ast" in value;

/** Nothing in a template expression can be copied as text (pipes, `;` chains), so it is rebuilt from its tree. */
// in parentheses: it can stand where a call is made (`(a | pipe)('x')`) as well as where a value is
const OPAQUE = "(undefined as any)";

function renderLiteral(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function renderKey(key: { key: string; quoted?: boolean }): string {
  return JSON.stringify(key.key);
}

// a receiver the template never writes: `track(...)` means `this.track(...)`
const isImplicitReceiver = (ast: AST): boolean => ast instanceof ImplicitReceiver || ast instanceof ThisReceiver;

function render(ast: AST): string {
  if (ast instanceof LiteralPrimitive) return renderLiteral(ast.value);
  if (ast instanceof PropertyRead || ast instanceof SafePropertyRead) {
    const dot = ast instanceof SafePropertyRead ? "?." : ".";
    return isImplicitReceiver(ast.receiver) ? `this.${ast.name}` : `${render(ast.receiver)}${dot}${ast.name}`;
  }
  if (ast instanceof KeyedRead || ast instanceof SafeKeyedRead) {
    const dot = ast instanceof SafeKeyedRead ? "?." : "";
    return `${render(ast.receiver)}${dot}[${render(ast.key)}]`;
  }
  if (ast instanceof Call || ast instanceof SafeCall) {
    return `${render(ast.receiver)}${ast instanceof SafeCall ? "?." : ""}(${ast.args.map(render).join(", ")})`;
  }
  if (ast instanceof LiteralMap) {
    return `({ ${ast.keys.map((key, index) => `${renderKey(key)}: ${render(ast.values[index]!)}`).join(", ")} })`;
  }
  if (ast instanceof LiteralArray) return `[${ast.expressions.map(render).join(", ")}]`;
  if (ast instanceof Conditional) return `(${render(ast.condition)} ? ${render(ast.trueExp)} : ${render(ast.falseExp)})`;
  // before Binary: Unary is a subclass of it
  if (ast instanceof Unary) return `(${ast.operator}${render(ast.expr)})`;
  if (ast instanceof Binary) return `(${render(ast.left)} ${ast.operation} ${render(ast.right)})`;
  if (ast instanceof PrefixNot) return `(!${render(ast.expression)})`;
  if (ast instanceof NonNullAssert) return render(ast.expression);
  return OPAQUE;
}

class CallCollector extends RecursiveAstVisitor {
  readonly statements: string[] = [];

  override visitCall(ast: Call, context: unknown): void {
    this.add(ast);
    super.visitCall(ast, context);
  }

  override visitSafeCall(ast: SafeCall, context: unknown): void {
    this.add(ast);
    super.visitSafeCall(ast, context);
  }

  // a call without arguments names no event: nothing to follow
  private add(ast: Call | SafeCall): void {
    if (ast.args.length > 0) this.statements.push(`${render(ast)};`);
  }
}

function collectCalls(expression: unknown, out: string[]): void {
  if (!isExpression(expression) || !expression.ast) return;
  const collector = new CallCollector();
  expression.ast.visit(collector);
  out.push(...collector.statements);
}

function visit(node: WalkableNode, out: TemplateEventBinding[], calls: string[], usages: TemplateComponentUsage[]): void {
  collectComponentUsage(node, usages);
  collectFromAttributes(node.attributes, out);
  collectFromInputs(node.inputs, out);
  // `(click)="..."`, `[prop]="..."`, `{{ ... }}`, `*ngIf="..."`, `@if (...)`, `@switch (...)`, `@for (... of ...)`
  for (const output of node.outputs ?? []) collectCalls(output.handler, calls);
  for (const input of node.inputs ?? []) collectCalls(input.value, calls);
  for (const attribute of node.templateAttrs ?? []) collectCalls(attribute.value, calls);
  collectCalls(node.value, calls);
  collectCalls(node.expression, calls);
  collectCalls(node.trackBy, calls);
  collectCalls(node.triggers?.when?.value, calls);
  collectCalls(node.prefetchTriggers?.when?.value, calls);
  collectCalls(node.hydrateTriggers?.when?.value, calls);
  for (const branch of node.branches ?? []) collectCalls(branch.expression, calls);
  for (const templateCase of node.cases ?? []) collectCalls(templateCase.expression, calls);

  for (const child of node.children ?? []) {
    visit(child, out, calls, usages);
  }
  for (const branch of node.branches ?? []) {
    // A real IfBlock branch's `children` is always an array (`[]` for an
    // empty `@if (a) {}` body, verified against the actual compiler output)
    // - the `?? []` is defensive against the wider optional type, not a
    // reachable second outcome.
    /* v8 ignore next */
    for (const child of branch.children ?? []) {
      visit(child, out, calls, usages);
    }
  }
  for (const templateCase of node.cases ?? []) {
    // Same as an IfBlock branch above: a real SwitchBlock case's `children`
    // is always an array, even for an empty `@case (1) {}` body.
    /* v8 ignore next */
    for (const child of templateCase.children ?? []) {
      visit(child, out, calls, usages);
    }
  }
  for (const child of node.empty?.children ?? []) {
    visit(child, out, calls, usages);
  }
  // `@defer { ... } @placeholder { ... } @loading { ... } @error { ... }`
  for (const block of [node.placeholder, node.loading, node.error]) {
    for (const child of block?.children ?? []) {
      visit(child, out, calls, usages);
    }
  }
}

/**
 * Parse an Angular component template via the real `@angular/compiler`
 * (`parseTemplate`) - handles plain elements, `*ngIf`/`*ngFor` structural
 * directives (desugared to `Template` nodes), `ng-container`/`ng-template`,
 * and the newer `@if`/`@for`/`@switch` block syntax, since the walk recurses
 * through `children`/`branches`/`cases`/`empty` generically rather than
 * special-casing tag names.
 */
export function parseAngularTemplate(source: string): ParsedAngularTemplate {
  const result = parseTemplate(source, "template.html", { preserveWhitespaces: false });

  const errors = (result.errors ?? []).map((error) => error.msg);
  const templateEvents: TemplateEventBinding[] = [];
  const templateCalls: string[] = [];
  const componentUsages: TemplateComponentUsage[] = [];
  for (const node of result.nodes as readonly TmplAstNode[] as readonly WalkableNode[]) {
    visit(node, templateEvents, templateCalls, componentUsages);
  }

  return { templateEvents, templateCalls, componentUsages, errors };
}
