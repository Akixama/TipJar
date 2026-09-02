import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = fileURLToPath(new URL("../dist/", import.meta.url));

await mkdir(outputDirectory, { recursive: true });

const sourceHtml = await readFile(`${appDirectory}index.html`, "utf8");
const productionHtml = sourceHtml.replace("./dist/main.js", "./main.js");

await Promise.all([
  writeFile(`${outputDirectory}index.html`, productionHtml),
  copyFile(`${appDirectory}style.css`, `${outputDirectory}style.css`),
]);
