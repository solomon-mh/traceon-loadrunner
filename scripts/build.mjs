// Builds the publishable artifacts into dist/:
//   - host.js     — the native-messaging host, fully bundled into one
//                   self-contained ESM file (engine + scheduler + pool +
//                   histogram inlined, zero imports) so install.ts can copy
//                   it to a stable location and rewrite its shebang.
//   - install.js  — the CLI / `bin` entry (has a shebang for direct exec).
//   - protocol.js / protocol.d.ts — the `traceon-loadrunner/protocol`
//                   subpath the extension imports its wire types from.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const common = { platform: "node", format: "esm", target: "node18", bundle: true };

// esbuild keeps an entry-point's own `#!` line and hoists it to the top, so
// both host.ts and install.ts carry their shebang through unchanged.
await build({ ...common, entryPoints: ["src/host.ts"], outfile: "dist/host.js", minify: true });
await build({ ...common, entryPoints: ["src/install.ts"], outfile: "dist/install.js" });
await build({ ...common, entryPoints: ["src/protocol.ts"], outfile: "dist/protocol.js" });

// esbuild doesn't emit declarations — tsc does, for the protocol module only.
execFileSync(
  "npx",
  ["tsc", "src/protocol.ts", "--declaration", "--emitDeclarationOnly", "--outDir", "dist", "--rootDir", "src"],
  { stdio: "inherit" },
);

console.log("built dist/{host,install,protocol}.js + dist/protocol.d.ts");
