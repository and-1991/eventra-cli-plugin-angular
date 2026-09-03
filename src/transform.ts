import { buildVirtualModule } from "./build-virtual-module";
import { parseAngularTemplate } from "./parse-angular-template";
import type { CliPluginTransformInput, CliPluginTransformResult } from "./types";

/** Map `foo.component.html` → `foo.component.html.ts` (single virtual TS module for the compiler). */
export function virtualPath(htmlPath: string): string {
  return `${htmlPath}.ts`;
}

export function transformAngularTemplate(input: CliPluginTransformInput): Promise<CliPluginTransformResult> {
  const { templateEvents } = parseAngularTemplate(input.source);

  return Promise.resolve({
    modules: [
      {
        path: virtualPath(input.path),
        content: buildVirtualModule(input.path, templateEvents),
      },
    ],
  });
}
