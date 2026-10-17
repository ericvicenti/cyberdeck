import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const installer = join(import.meta.dir, "../scripts/install-navigation-built.py");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "navigation-built-")), target = join(root, "src"), pkg = join(root, "pkg");
  const put = (name: string, value: string) => { const path = join(root, name); mkdirSync(join(path,".."), {recursive:true}); writeFileSync(path,value); };
  put("src/ui/view.ts", "old view"); put("src/ui/unrelated.ts", "richer player");
  put("src/dist/ui/index.html", "old index"); put("src/dist/ui/assets/old.js", "old chunk");
  put("pkg/after/ui/view.ts", "new view"); put("pkg/ui/index.html", "new index"); put("pkg/ui/assets/new.js", "new chunk");
  const beforeInputs = {"ui/view.ts":sha("old view"),"ui/unrelated.ts":sha("richer player")};
  put("pkg/manifest.json", JSON.stringify({files:["ui/view.ts"],beforeInputs,afterInputs:{...beforeInputs,"ui/view.ts":sha("new view")},installedIndex:sha("new index"),assets:{"index.html":sha("new index"),"assets/new.js":sha("new chunk")}}));
  const run = (...args: string[]) => Bun.spawnSync(["python3",installer,"--target",target,...args]);
  const install = () => run("--package",pkg);
  const read = (name: string) => readFileSync(join(root,name),"utf8");
  return {root,target,pkg,put,read,run,install,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test("prebuilt overlays retain richer source and open-tab chunks, then roll back atomically", () => {
  const f=fixture();try {
    const result=f.install();expect(result.exitCode).toBe(0);
    expect(f.read("src/ui/unrelated.ts")).toBe("richer player");
    expect(f.read("src/ui/view.ts")).toBe("new view");expect(f.read("src/dist/ui/index.html")).toBe("new index");
    expect(f.read("src/dist/ui/assets/old.js")).toBe("old chunk");
    const {backup}=JSON.parse(result.stdout.toString());
    expect(f.run("--rollback",backup).exitCode).toBe(0);
    expect(f.read("src/ui/view.ts")).toBe("old view");expect(f.read("src/dist/ui/index.html")).toBe("old index");
  } finally {f.cleanup();}
});
test("prebuilt activation refuses any newer compiler input, including an added file", () => {
  const f=fixture();try {
    f.put("src/ui/newer.ts","another session's work");
    expect(f.install().exitCode).not.toBe(0);
    expect(f.read("src/ui/view.ts")).toBe("old view");expect(f.read("src/dist/ui/index.html")).toBe("old index");
  } finally {f.cleanup();}
});
test("prebuilt activation refuses corrupted chunks before changing source", () => {
  const f=fixture();try {
    f.put("pkg/ui/assets/new.js","corrupted");expect(f.install().exitCode).not.toBe(0);
    expect(f.read("src/ui/view.ts")).toBe("old view");
  } finally {f.cleanup();}
});
test("prebuilt rollback refuses a newer UI deployment", () => {
  const f=fixture();try {
    const result=f.install();expect(result.exitCode).toBe(0);const {backup}=JSON.parse(result.stdout.toString());
    f.put("src/dist/ui/index.html","newer deployment");expect(f.run("--rollback",backup).exitCode).not.toBe(0);
    expect(f.read("src/dist/ui/index.html")).toBe("newer deployment");expect(f.read("src/ui/view.ts")).toBe("new view");
  } finally {f.cleanup();}
});
