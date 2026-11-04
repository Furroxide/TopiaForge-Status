import fs from "node:fs";
import { validateNotes } from "../src/domain.js";
const environments = JSON.parse(
  fs.readFileSync(new URL("../config/environments.json", import.meta.url)),
);
validateNotes(
  JSON.parse(
    fs.readFileSync(new URL("../config/incidents.json", import.meta.url)),
  ),
  environments,
);
for (const [key, value] of Object.entries(environments)) {
  if (
    !["production", "staging"].includes(key) ||
    value.origin !==
      `https://mp${key === "staging" ? "-staging" : ""}.topiaforge.dev` ||
    typeof value.launched !== "boolean" ||
    !/^\d+$/.test(value.build) ||
    !/^\d+$/.test(value.protocol)
  )
    throw new Error("Invalid environment");
}
for (const name of [
  "index.html",
  "app.js",
  "style.css",
  "wordmark.png",
  "favicon.png",
])
  if (!fs.existsSync(new URL(`../public/${name}`, import.meta.url)))
    throw new Error(`Missing asset ${name}`);
console.log(
  "Environment configuration, incident notes and static assets validated.",
);
