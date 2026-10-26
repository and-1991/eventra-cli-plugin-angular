import { buildVirtualModule } from "./build-virtual-module";
import { isComponentTemplate } from "./component-scope";
import { parseAngularTemplate } from "./parse-angular-template";
import type { CliPluginTransformInput, CliPluginTransformResult } from "./types";

/** Map `foo.component.html` → `foo.component.html.ts` (single virtual TS module for the compiler). */
export function virtualPath(htmlPath: string): string {
  return `${htmlPath}.ts`;
}

export async function transformAngularTemplate(
  input: CliPluginTransformInput,
): Promise<CliPluginTransformResult> {
  const { templateEvents, templateCalls, componentUsages, errors } = parseAngularTemplate(input.source);

  if (errors.length > 0 && !isComponentTemplate(input.path)) {
    // Every .html file is offered to this plugin, and most of those in a repository are not templates
    // (generated docs, static pages): one that does not parse and that no component uses holds no events.
    return { modules: [{ path: virtualPath(input.path), content: buildVirtualModule(input.path, [], []) }] };
  }

  if (errors.length > 0) {
    // A parse error means `@angular/compiler` could not build a reliable
    // node tree - continuing would silently under-report (or miss
    // entirely) every event in this file, with nothing telling the user
    // why. Throwing surfaces it through the host CLI's existing per-file
    // "skip: <file> <message>" path (see scanProject) instead of returning
    // a template that looks like a legitimate zero-event file.
    throw new Error(
      `Failed to parse Angular template ${input.path}: ${errors.join("; ")}`,
    );
  }

  return {
    modules: [
      {
        path: virtualPath(input.path),
        content: buildVirtualModule(input.path, templateEvents, templateCalls, componentUsages),
      },
    ],
  };
}
