import { parseMd } from "../lib/control";

function Inline({ text }: { text: string }) {
  // links, inline code, bold
  const parts = text.split(/(\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|https?:\/\/\S+)/g);
  return (
    <>
      {parts.map((p, i) => {
        const link = p.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (link) return <a key={i} href={link[2]} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">{link[1]}</a>;
        if (/^https?:\/\//.test(p)) return <a key={i} href={p} target="_blank" rel="noreferrer" className="break-all text-sky-400 hover:underline">{p}</a>;
        if (p.startsWith("`")) return <code key={i} className="rounded bg-zinc-800 px-1 font-mono text-[11px] text-zinc-200">{p.slice(1, -1)}</code>;
        if (p.startsWith("**")) return <strong key={i} className="text-zinc-100">{p.slice(2, -2)}</strong>;
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const blocks = parseMd(text);
  return (
    <div className={`space-y-1.5 text-[12px] leading-relaxed text-zinc-300 ${className}`}>
      {blocks.map((b, i) => {
        if (b.kind === "h") return <div key={i} className={`${b.level === 1 ? "text-sm" : "text-[13px]"} mt-2 font-semibold text-zinc-100`}><Inline text={b.text} /></div>;
        if (b.kind === "li") return <div key={i} className="flex gap-2 pl-1"><span className="text-zinc-600">•</span><span><Inline text={b.text} /></span></div>;
        if (b.kind === "code") return <pre key={i} className="overflow-auto rounded-lg bg-zinc-950 p-2 font-mono text-[11px] text-zinc-300">{b.text}</pre>;
        return <p key={i}><Inline text={b.text} /></p>;
      })}
    </div>
  );
}
