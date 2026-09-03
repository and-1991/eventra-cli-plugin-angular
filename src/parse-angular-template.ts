import { parseTemplate } from "@angular/compiler";
import type { TmplAstNode } from "@angular/compiler";

/** A single `event="..."` binding found on a tag in the template. */
export interface TemplateEventBinding {
  /** `literal`: the event name is a string constant. `dynamic`: a raw Angular expression, copied verbatim. */
  readonly kind: "literal" | "dynamic";
  readonly value: string;
}

export interface ParsedAngularTemplate {
  readonly templateEvents: readonly TemplateEventBinding[];
  readonly errors: readonly string[];
}

interface TextAttributeLike {
  readonly name: string;
  readonly value: string;
}

interface BoundAttributeLike {
  readonly name: string;
  readonly value?: { readonly source?: string | null };
}

/** Duck-typed: every node kind this walk cares about is checked structurally, not by class name - a future `@angular/compiler` version adding a new block/element kind is still picked up as long as it carries the same `attributes`/`inputs`/`children` shape. */
interface WalkableNode {
  readonly attributes?: readonly TextAttributeLike[];
  readonly inputs?: readonly BoundAttributeLike[];
  readonly children?: readonly WalkableNode[];
  // IfBlock
  readonly branches?: readonly { readonly children?: readonly WalkableNode[] }[];
  // SwitchBlock
  readonly cases?: readonly { readonly children?: readonly WalkableNode[] }[];
  // ForLoopBlock's `@empty` branch
  readonly empty?: { readonly children?: readonly WalkableNode[] } | null;
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

function visit(node: WalkableNode, out: TemplateEventBinding[]): void {
  collectFromAttributes(node.attributes, out);
  collectFromInputs(node.inputs, out);

  for (const child of node.children ?? []) {
    visit(child, out);
  }
  for (const branch of node.branches ?? []) {
    // A real IfBlock branch's `children` is always an array (`[]` for an
    // empty `@if (a) {}` body, verified against the actual compiler output)
    // - the `?? []` is defensive against the wider optional type, not a
    // reachable second outcome.
    /* v8 ignore next */
    for (const child of branch.children ?? []) {
      visit(child, out);
    }
  }
  for (const templateCase of node.cases ?? []) {
    // Same as an IfBlock branch above: a real SwitchBlock case's `children`
    // is always an array, even for an empty `@case (1) {}` body.
    /* v8 ignore next */
    for (const child of templateCase.children ?? []) {
      visit(child, out);
    }
  }
  for (const child of node.empty?.children ?? []) {
    visit(child, out);
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
  for (const node of result.nodes as readonly TmplAstNode[] as readonly WalkableNode[]) {
    visit(node, templateEvents);
  }

  return { templateEvents, errors };
}
