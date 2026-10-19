import { PLAYER_SYSTEMS } from "../../shared/vault-player";

type Source = { item: string; archive?: string; region?: string };
/** Public indexes only. Restricted/unavailable items are not unlocked or authenticated. */
export const ARCHIVE_SOURCES: Record<string, Source> = {
  NES: { item: "nintendo-entertainment-system_20250402", archive: "Nintendo Entertainment System.zip" },
  SNES: { item: "FullSnes" },
  N64: { item: "20240601_20240601_1408", archive: "Nintendo 64 Entire Library.zip" },
  GBA: { item: "ef_gba_no-intro_2024-02-21" },
  Genesis: { item: "sega-genesis-romset-ultra-usa" },
  GB: { item: "game-boy-and-game-boy-color-complete-collection" },
  GBC: { item: "game-boy-and-game-boy-color-complete-collection" },
  SMS: { item: "sega-master-system-romset-ultra-us" },
  GG: { item: "sega-game-gear-romset-ultra-us" },
};
const key = (text: string) => text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
export function matchArchiveFile(names: string[], system: string, title: string, regions: string[], defaultRegion = "") {
  const extensions = [...(system === "GBC" ? ["gbc"] : PLAYER_SYSTEMS[system]?.extensions ?? []), "zip", "7z"];
  const requested = regions.length ? regions : ["USA", "World", "Europe", "Japan"];
  return names.map(name => {
    const leaf = name.split(/[\\/]/).pop()!;
    const extension = leaf.split(".").pop()?.toLowerCase() ?? "";
    const stem = leaf.slice(0, -(extension.length + 1));
    const tags = [...stem.matchAll(/\(([^)]+)\)/g)].map(m => m[1]);
    const rawTitle = stem.replace(/\s*\([^)]*\)/g, "").trim();
    if (!extensions.includes(extension) || key(rawTitle) !== key(title) || /\b(?:Beta|Proto|Demo|Hack|Translation|Unl)\b/i.test(tags.join(" "))) return null;
    const countries = (tags[0] ?? defaultRegion).split(/,\s*/);
    const rank = requested.findIndex(region => countries.some(c => key(c) === key(region)) || countries.includes("World"));
    if (regions.length && rank < 0) return null;
    return { name, score: (rank < 0 ? 50 : rank) * 10 + (/\b(?:Rev|v\d)/i.test(tags.join(" ")) ? 1 : 0) };
  }).filter((x): x is { name: string; score: number } => !!x).sort((a,b) => a.score-b.score || a.name.localeCompare(b.name))[0]?.name;
}
function archiveUrl(url: URL) {
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
    !(url.hostname === "archive.org" || /^ia\d+\.(?:us|eu)\.archive\.org$/.test(url.hostname)))
    throw new Error("The download source returned an unexpected address.");
}
export async function fetchArchive(url: string | URL, signal: AbortSignal, request: typeof fetch = fetch): Promise<Response> {
  let target = new URL(url);
  for (let redirects=0; redirects<5; redirects++) {
    archiveUrl(target);
    const response = await request(target, { signal, redirect: "manual", headers: { "User-Agent": "Cyberdeck-Vault/1.0" } });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("The download source returned an empty redirect.");
      target = new URL(location,target); continue;
    }
    return response;
  }
  throw new Error("The download source redirected too many times.");
}
async function readIndex(response: Response) {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("The alternative download source is temporarily unavailable."); }
  const reader=response.body.getReader(), chunks: Uint8Array[]=[]; let size=0;
  try {
    while(true) {
      const {value,done}=await reader.read();if(done)break;
      size+=value.length;if(size>8*1024*1024)throw new Error("The download index is too large.");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }finally{await reader.cancel().catch(()=>{});}
}
/** Index cache contains names/links only, never game files. One download request owns cancellation. */
export class ArchiveGames {
  private indexes=new Map<string,{expires:number;files:Map<string,string>}>();
  constructor(private request: typeof fetch = fetch) {}
  async file(system: string, title: string, regions: string[], signal: AbortSignal) {
    const source=ARCHIVE_SOURCES[system];
    if(!source)throw new Error("No automatic download source is available for this console yet.");
    let files=this.indexes.get(system);
    if(!files || files.expires<Date.now()) {
      const found=new Map<string,string>();
      const base=`https://archive.org/download/${encodeURIComponent(source.item)}/`;
      if(source.archive) {
        const prefix=base+encodeURIComponent(source.archive)+"/";
        const html=await readIndex(await fetchArchive(prefix,signal,this.request));
        for(const match of html.matchAll(/href="([^"]+)"/g)) {
          const url=new URL(match[1].replace(/&amp;/g,"&"),prefix);
          if(!url.href.startsWith(prefix) || url.search || url.hash)continue;
          try {
            const name=decodeURIComponent(url.href.slice(prefix.length));
            if(!name.endsWith("/"))found.set(name,url.href);
          }catch{}
        }
      }else {
        const metadata=JSON.parse(await readIndex(await fetchArchive(`https://archive.org/metadata/${encodeURIComponent(source.item)}`,signal,this.request)));
        if(metadata.is_dark || !Array.isArray(metadata.files))throw new Error("This download collection is unavailable.");
        for(const file of metadata.files) {
          if(typeof file.name !== "string" || file.private || Number(file.size)>128*1024*1024)continue;
          found.set(file.name,base+file.name.split("/").map(encodeURIComponent).join("/"));
        }
      }
      files={expires:Date.now()+3600000,files:found};this.indexes.set(system,files);
    }
    const name=matchArchiveFile([...files.files.keys()],system,title,regions,source.region);
    if(!name)throw new Error("This game and region aren't available from the current download sources.");
    return {response:await fetchArchive(files.files.get(name)!,signal,this.request),name:name.split("/").pop()!,source:"Internet Archive"};
  }
}
