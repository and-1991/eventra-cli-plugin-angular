import { buildInlineModule, buildVirtualModule } from "./build-virtual-module";
import { isComponentTemplate } from "./component-scope";
import { readComponentInfo } from "./component";
import { parseAngularTemplate } from "./parse-angular-template";
import type { CliPluginTransformInput, CliPluginTransformResult } from "./types";

/** Map `foo.component.html` → `foo.component.html.ts` (single virtual TS module for the compiler). */
export function virtualPath(htmlPath: string): string {
  return `${htmlPath}.ts`;
}

/**
 * A `.ts` file with `@Component({ template: "..." })`: the inline template is read like a `.html` one. The
 * result is the component file itself with the template's calls spliced in; a file without an inline
 * template gets no modules, which leaves it to be read as the plain TypeScript it is.
 */
async function transformComponentFile(input: CliPluginTransformInput): Promise<CliPluginTransformResult> {
  if (!/@Component\b/.test(input.source) || !/\btemplate\s*:/.test(input.source)) return { modules: [] };
  const template = readComponentInfo(input.source, input.path)?.inlineTemplate;
  if (!template) return { modules: [] };

  const { templateEvents, templateCalls, componentUsages, notes, errors } = parseAngularTemplate(template);
  if (errors.length > 0) {
    throw new Error(`Failed to parse the inline Angular template of ${input.path}: ${errors.join("; ")}`);
  }
  const content = buildInlineModule(input.path, input.source, templateEvents, templateCalls, componentUsages);
  return { modules: content === null ? [] : [{ path: input.path, content }], ...(notes.length > 0 ? { notes } : {}) };
}

export async function transformAngularTemplate(
  input: CliPluginTransformInput,
): Promise<CliPluginTransformResult> {
  if (/\.[cm]?ts$/i.test(input.path) && !/\.d\.[cm]?ts$/i.test(input.path)) {
    return transformComponentFile(input);
  }
  const { templateEvents, templateCalls, componentUsages, notes, errors } = parseAngularTemplate(input.source);

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
    ...(notes.length > 0 ? { notes } : {}),
  };
}
