import { readComponentScope } from "./component-scope";
import type { TemplateEventBinding } from "./parse-angular-template";

export const TEMPLATE_EVENT_CALLEE = "__eventra_angular_template_event__";

const SIMPLE_EXPRESSION_RE = /^[a-zA-Z_$][\w$]*(\??\.[a-zA-Z_$][\w$]*|\[[^\]\r\n]*])*$/;

/**
 * Angular template expressions never write `this` explicitly - it's a
 * compile error in Angular's own template syntax - so a bare `computedName`
 * means "the component instance's own `computedName` field/getter". Only a
 * simple identifier/property-chain shape is rewritten this way; anything
 * else (calls, operators, pipes, literals) is left as-is and, if it doesn't
 * resolve on its own, safely falls back to a dynamic occurrence with no
 * value - the same honest fallback the Vue/Svelte/Astro plugins already rely
 * on for expressions outside what they specifically handle.
 */
export function qualifyWithThis(expression: string): string {
  return SIMPLE_EXPRESSION_RE.test(expression) ? `this.${expression}` : expression;
}

function escapeString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function renderCall(binding: TemplateEventBinding, qualify: boolean): string {
  if (binding.kind === "literal") {
    return `${TEMPLATE_EVENT_CALLEE}("${escapeString(binding.value)}");`;
  }
  return `${TEMPLATE_EVENT_CALLEE}(${qualify ? qualifyWithThis(binding.value) : binding.value});`;
}

/**
 * Builds one virtual TS module for an Angular template (`.html`) file.
 *
 * - No bindings at all: an empty module stub.
 * - No *dynamic* bindings: a plain top-level function (no need for a
 *   `this`-scope, so the paired component class is never read).
 * - At least one dynamic binding: the paired component class (see
 *   `readComponentScope`) is read from disk and a synthetic method is
 *   spliced into its body, so `this.field`-shaped expressions resolve
 *   through the same checker-based pipeline as any other TS expression.
 *   When no class can be found, falls back to the same plain top-level
 *   function used for the literal-only case - the dynamic bindings are
 *   still reported, just never resolved to a literal.
 */
export function buildVirtualModule(
  htmlPath: string,
  templateEvents: readonly TemplateEventBinding[],
  templateCalls: readonly string[] = [],
): string {
  if (templateEvents.length === 0 && templateCalls.length === 0) {
    return "export {}\n";
  }

  const declaration = `declare function ${TEMPLATE_EVENT_CALLEE}(name: string): void;`;
  // template calls are written against the component (`this.track(...)`), so they need its class too
  const needsClass = templateCalls.length > 0 || templateEvents.some((binding) => binding.kind === "dynamic");
  const scope = needsClass ? readComponentScope(htmlPath) : null;
  // the CLI reads this line as "the code below was generated from the template"; the end line
  // keeps the rest of the component file, which follows the method, out of that region
  const regionStart = templateCalls.length > 0 ? [`// --- angular template (auto-generated) ---`] : [];
  const regionEnd = templateCalls.length > 0 ? [`// --- end template ---`] : [];

  if (scope && scope.classEndOffset !== null) {
    const method = [
      "",
      ...regionStart.map((line) => `  ${line}`),
      "  __eventraAngularTemplate() {",
      ...templateEvents.map((binding) => `    ${renderCall(binding, true)}`),
      ...templateCalls.map((call) => `    ${call}`),
      "  }",
      ...regionEnd.map((line) => `  ${line}`),
    ].join("\n");
    const spliced = scope.content.slice(0, scope.classEndOffset) + method + "\n" + scope.content.slice(scope.classEndOffset);
    return [declaration, spliced].join("\n") + "\n";
  }

  const lines = [
    declaration,
    ...regionStart,
    "function __eventraAngularTemplate() {",
    ...templateEvents.map((binding) => `  ${renderCall(binding, false)}`),
    ...templateCalls.map((call) => `  ${call}`),
    "}",
    ...regionEnd,
  ];
  return lines.join("\n") + "\n";
}
