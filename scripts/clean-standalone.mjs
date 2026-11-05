/** Remove runtime data/secrets that Next may copy into standalone output. */
import fs from "node:fs";
import path from "node:path";

const standalone = path.join(process.cwd(), ".next", "standalone");
if (!fs.existsSync(standalone)) process.exit(0);

for (const name of ["data", "backups"]) {
  fs.rmSync(path.join(standalone, name), { recursive: true, force: true });
}
for (const name of fs.readdirSync(standalone)) {
  if (/^\.env(?:\.|$)/.test(name)) fs.rmSync(path.join(standalone, name), { recursive: true, force: true });
}
console.log("Removed runtime data and environment files from standalone output.");
