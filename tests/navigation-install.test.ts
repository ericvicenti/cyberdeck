import { test as bunTest, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const installer = join(import.meta.dir, "../scripts/install-navigation.py");
const test = (name: string, fn: () => void) => bunTest(name, fn, 30000);

function fixture(mode: "pass" | "fail") {
  const root = mkdtempSync(join(tmpdir(), "navigation-install-")), target = join(root,"src"), pkg = join(root,"package"), bin = join(root,"bin");
  for (const p of ["src/ui","src/dist/ui/assets","package/before/ui","package/after/ui","bin"]) mkdirSync(join(root,p),{recursive:true});
  writeFileSync(join(target,"ui/test.ts"),"const owned = 1;\nconst unrelated = 'newer';\n");
  writeFileSync(join(pkg,"before/ui/test.ts"),"const owned = 1;\nconst unrelated = 'old';\n");
  writeFileSync(join(pkg,"after/ui/test.ts"),"const owned = 2;\nconst unrelated = 'old';\n");
  writeFileSync(join(pkg,"manifest.json"),JSON.stringify({files:["ui/test.ts"]}));
  writeFileSync(join(target,"dist/ui/index.html"),"old index"); writeFileSync(join(target,"dist/ui/assets/old.js"),"old asset");
  writeFileSync(join(bin,"bun"),`#!/usr/bin/env python3\nimport sys,pathlib\nif ${mode === "fail" ? "True" : "False"}:sys.exit(1)\nif '--outDir' in sys.argv:\n p=pathlib.Path(sys.argv[sys.argv.index('--outDir')+1]);(p/'assets').mkdir(parents=True);(p/'index.html').write_text('new index');(p/'assets/new.js').write_text('new asset')\n`); chmodSync(join(bin,"bun"),0o755);
  const exec = (args: string[]) => Bun.spawnSync(["python3",installer,...args],{env:{...process.env,PATH:bin+":"+process.env.PATH}});
  return {root,target,pkg,exec,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

test("overlay preserves newer adjacent code and old assets, supports verified rollback",()=>{
  const f=fixture("pass");
  try {
    writeFileSync(join(f.target,"ui/variant.ts"),"const stable = 1;\nconst optional = true;\n");
    writeFileSync(join(f.pkg,"manifest.json"),JSON.stringify({files:["ui/test.ts"],replacements:[
      {file:"ui/variant.ts",old:"const stable = 1;",new:"const stable = 2;"},
      {file:"ui/variant.ts",old:"const absent = true;",new:"const absent = false;",optional:true},
    ]}));
    const result=f.exec(["--package",f.pkg,"--target",f.target]); expect(result.exitCode).toBe(0);
    expect(readFileSync(join(f.target,"ui/test.ts"),"utf8")).toBe("const owned = 2;\nconst unrelated = 'newer';\n");
    expect(readFileSync(join(f.target,"ui/variant.ts"),"utf8")).toContain("const stable = 2;");
    expect(readFileSync(join(f.target,"dist/ui/index.html"),"utf8")).toBe("new index");
    expect(readFileSync(join(f.target,"dist/ui/assets/old.js"),"utf8")).toBe("old asset");
    const backup=join(f.root,"backups",readdirSync(join(f.root,"backups"))[0]);
    const rollback=f.exec(["--rollback",backup,"--target",f.target]); expect(rollback.exitCode).toBe(0);
    expect(readFileSync(join(f.target,"ui/test.ts"),"utf8")).toBe("const owned = 1;\nconst unrelated = 'newer';\n");
    expect(readFileSync(join(f.target,"ui/variant.ts"),"utf8")).toContain("const stable = 1;");
    expect(readFileSync(join(f.target,"dist/ui/index.html"),"utf8")).toBe("old index");
  } finally {f.cleanup();}
});

test("failed validation restores source and keeps the serving UI unchanged",()=>{
  const f=fixture("fail");
  try {
    expect(f.exec(["--package",f.pkg,"--target",f.target]).exitCode).not.toBe(0);
    expect(readFileSync(join(f.target,"ui/test.ts"),"utf8")).toBe("const owned = 1;\nconst unrelated = 'newer';\n");
    expect(readFileSync(join(f.target,"dist/ui/index.html"),"utf8")).toBe("old index");
  } finally {f.cleanup();}
});

test("conflicting edits refuse installation and rollback refuses a newer writer",()=>{
  const f=fixture("pass");
  try {
    writeFileSync(join(f.target,"ui/test.ts"),"const owned = 3;\n");
    expect(f.exec(["--package",f.pkg,"--target",f.target]).exitCode).not.toBe(0);
    expect(readFileSync(join(f.target,"ui/test.ts"),"utf8")).toBe("const owned = 3;\n");
    writeFileSync(join(f.target,"ui/test.ts"),"const owned = 1;\nconst unrelated = 'newer';\n");
    expect(f.exec(["--package",f.pkg,"--target",f.target]).exitCode).toBe(0);
    const backup=join(f.root,"backups",readdirSync(join(f.root,"backups"))[0]);
    writeFileSync(join(f.target,"ui/test.ts"),"a newer writer\n");
    expect(f.exec(["--rollback",backup,"--target",f.target]).exitCode).not.toBe(0);
    expect(readFileSync(join(f.target,"ui/test.ts"),"utf8")).toBe("a newer writer\n");
  } finally {f.cleanup();}
});
