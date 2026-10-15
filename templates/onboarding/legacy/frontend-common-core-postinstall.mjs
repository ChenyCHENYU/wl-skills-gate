import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const commonCoreRoot = path.join(
  projectRoot,
  "node_modules",
  "@jhlc",
  "common-core"
);
const commonCoreLib = path.join(commonCoreRoot, "lib");

function patchFile(fullPath, transform) {
  if (!fs.existsSync(fullPath)) return;

  const source = fs.readFileSync(fullPath, "utf8");
  const patched = transform(source);
  if (patched !== source) {
    fs.writeFileSync(fullPath, patched);
  }
}

if (fs.existsSync(commonCoreLib)) {
  const files = fs
    .readdirSync(commonCoreLib)
    .filter((file) => file.endsWith(".d.ts"));

  for (const file of files) {
    patchFile(path.join(commonCoreLib, file), (source) =>
      source
        .replace(
          /EpPropFinalized<\s*\[StringConstructor\],\s*,/g,
          "EpPropFinalized<[StringConstructor], unknown,"
        )
        .replace(
          /EpPropFinalized<\s*\[,\s*StringConstructor\],/g,
          "EpPropFinalized<[StringConstructor],"
        )
    );
  }
}

patchFile(
  path.join(commonCoreRoot, "src", "components", "form", "common", "type.ts"),
  (source) =>
    source.replace(
      /(export type defaultValueType =\r?\n)\s*"currentDept"\s*\|/,
      '$1  | "currentDept"'
    )
);
