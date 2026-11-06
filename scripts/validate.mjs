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
if (Object.keys(environments).sort().join(",") !== "production,staging")
  throw new Error("Expected production and staging configuration");
for (const [key, value] of Object.entries(environments)) {
  if (
    value.origin !==
      `https://mp${key === "staging" ? "-staging" : ""}.topiaforge.dev` ||
    typeof value.label !== "string" ||
    !value.label.trim() ||
    typeof value.launched !== "boolean" ||
    typeof value.monitorEnabled !== "boolean" ||
    typeof value.stableClientPublished !== "boolean" ||
    (key === "staging" && value.stableClientPublished) ||
    (value.stableClientPublished && !value.launched) ||
    typeof value.build !== "string" ||
    !/^\d+$/.test(value.build) ||
    typeof value.protocol !== "string" ||
    !/^\d+$/.test(value.protocol)
  )
    throw new Error("Invalid environment");
}
for (const name of [
  "index.html",
  "_headers",
  "app.js",
  "history-chart.js",
  "style.css",
  "wordmark.png",
  "favicon.png",
])
  if (!fs.existsSync(new URL(`../public/${name}`, import.meta.url)))
    throw new Error(`Missing asset ${name}`);
console.log(
  "Environment configuration, incident notes and static assets validated.",
);
