/**
 * `@angular/compiler` is an ES module that this (CommonJS) plugin loads with `require()`, which Node only allows
 * from 20.19 and 22.12 on. Older versions died with a raw `ERR_REQUIRE_ESM` stack that said nothing about the
 * cause, so the version is checked first and the message says what to do.
 */
export function supportsAngularCompiler(version: string): boolean {
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (major >= 23) return true;
  if (major === 22) return minor >= 12;
  if (major === 20) return minor >= 19;
  return false;
}

export function assertSupportedNode(version: string = process.versions.node): void {
  if (!supportsAngularCompiler(version)) {
    throw new Error(
      `@eventra_dev/cli-plugin-angular needs Node.js 20.19+ or 22.12+ (this is ${version}), because the Angular compiler it uses is an ES module. ` +
        `Upgrade Node, or remove "@eventra_dev/cli-plugin-angular" from "plugins" in eventra.json (Angular templates are then not read).`,
    );
  }
}

assertSupportedNode();
