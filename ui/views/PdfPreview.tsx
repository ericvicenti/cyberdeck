import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { version } from "pdfjs-dist/package.json";
import { api, nodePath, rawUrl, token } from "../lib/api";
import { nodeName, readRoute, routeHash, updateParams, useRouteTitle } from "../lib/navigation";
import "./pdf-preview.css";

GlobalWorkerOptions.workerSrc = workerUrl;

function selection(params: URLSearchParams) {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = params.get(key) || "";
    const n = /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
  };
  return { page: integer("page", 1, 1, Number.MAX_SAFE_INTEGER),
    zoom: params.get("zoom") === "fit" ? "fit" : params.get("zoom") === "width" || !params.get("zoom") ? "width" : String(integer("zoom", 0, 25, 400) || "width"),
    rotation: [0, 90, 180, 270].includes(integer("rotate", 0, 0, 270)) ? integer("rotate", 0, 0, 270) : 0 };
}

type Failure = { title: string; message: string; status?: number };
function failure(error: unknown): Failure {
  const e = error as { name?: string; status?: number; message?: string };
  if (e.status === 404 && e.message === "unknown node") return { title: "Machine not found · PDF", message: "The machine in this link is not paired with this Cyberdeck." };
  if (e.status === 404) return { title: "PDF not found", message: "This file is no longer available on the selected machine.", status: e.status };
  if (e.status === 401 || e.status === 403) return { title: "PDF access denied", message: "The selected machine denied access to this PDF.", status: e.status };
  if (e.name === "InvalidPDFException") return { title: "Invalid PDF", message: "This file could not be read as a PDF." };
  return { title: "PDF unavailable", message: "The PDF could not be loaded. Retry or open the original file.", status: e.status };
}

/** Retained per node/path by EditorWorkspace. The parent is the only history
 * owner: neither a browser PDF plug-in nor a nested iframe can create entries. */
export default function PdfPreview({ params, visible, onLocked }: {
  params: URLSearchParams; visible: boolean; onLocked: () => void;
}) {
  const path = params.get("path") || "", node = params.get("node") || "";
  const name = path.split("/").pop() || path;
  const { page, zoom, rotation } = selection(params);
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [loadError, setLoadError] = useState<Failure>();
  const [renderError, setRenderError] = useState<Failure>();
  const [retry, setRetry] = useState(0);
  const [passwordPrompt, setPasswordPrompt] = useState(0);
  const [password, setPassword] = useState("");
  const passwordCallback = useRef<((password: string) => void) | undefined>(undefined);
  const [rendered, setRendered] = useState("");
  const [pageInput, setPageInput] = useState(String(page));
  const [viewport, setViewport] = useState({ width: 800, height: 600 });
  const container = useRef<HTMLDivElement>(null), paper = useRef<HTMLDivElement>(null);
  const active = useRef(visible); active.current = visible;
  const ownsRoute = () => {
    const route = readRoute();
    return active.current && route.view === "edit" && route.params.get("path") === path && (route.params.get("node") || "") === node;
  };
  const change = (values: Record<string, string | null>, mode: "push" | "replace" = "push") => {
    if (ownsRoute()) updateParams(values, mode);
  };

  useEffect(() => { setPageInput(String(page)); }, [page]);
  useEffect(() => {
    if (!visible || location.hash !== routeHash("edit", params)) return;
    const values = { page: page === 1 ? null : String(page), zoom: zoom === "width" ? null : zoom, rotate: rotation ? String(rotation) : null };
    if (Object.entries(values).some(([key, value]) => params.get(key) !== value)) change(values, "replace");
  }, [params, visible, page, zoom, rotation]);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    let task: PDFDocumentLoadingTask | undefined;
    setDocument(undefined); setLoadError(undefined); setRenderError(undefined); setPasswordPrompt(0); setPassword("");
    const assets = `${location.origin}/assets/pdfjs-${version}/`;
    void (async () => {
    // Older daemons return a generic 500 for a missing raw file. Their stat
    // endpoint has reliable missing-file semantics, and avoids loading a directory.
    const stat = await api<{ type: string; targetType?: string }>(`/api/fs/stat?${new URLSearchParams({ path })}`, { node, signal: controller.signal });
    if (disposed) return;
    if (stat.type === "dir" || stat.targetType === "dir") {
      setLoadError({ title: "PDF unavailable", message: "The selected path is a directory, not a PDF file." }); return;
    }
    task = getDocument({
      url: nodePath(node, `/api/fs/read?${new URLSearchParams({ path })}`),
      httpHeaders: { Authorization: `Bearer ${token()}` },
      cMapUrl: `${assets}cmaps/`, cMapPacked: true,
      standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/`, iccUrl: `${assets}iccs/`,
      // Document scripts/forms are never executed by this read-only preview.
      enableXfa: false,
    });
    task.onPassword = (update: (password: string) => void, reason: number) => {
      if (disposed) return;
      passwordCallback.current = update; setPassword(""); setPasswordPrompt(reason);
    };
    const pdf = await task.promise;
    if (!disposed) { setPasswordPrompt(0); passwordCallback.current = undefined; setDocument(pdf); }
    })().catch(error => { if (!disposed) setLoadError(failure(error)); });
    return () => { disposed = true; controller.abort(); passwordCallback.current = undefined; void task?.destroy().catch(() => {}); };
  }, [node, path, retry]);

  useEffect(() => {
    if (loadError?.status === 401 && !node && ownsRoute()) onLocked();
  }, [loadError, visible]);

  useEffect(() => {
    if (!visible || !container.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0)
        setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [visible]);

  const missingPage = !!document && page > document.numPages;
  const renderKey = `${page}/${zoom}/${rotation}/${viewport.width}/${viewport.height}/${retry}`;
  useEffect(() => {
    if (!document || !visible || missingPage || !paper.current) return;
    let disposed = false, render: RenderTask | undefined, text: TextLayer | undefined;
    const host = paper.current;
    // Each render gets its own canvas. A cancelled asynchronous render can never
    // draw over a newer selection, even during rapid Back/Forward or resizing.
    const canvas = window.document.createElement("canvas"), layer = window.document.createElement("div");
    layer.className = "pdf-text-layer";
    host.replaceChildren(canvas, layer); host.scrollIntoView({ block: "nearest" });
    setRendered(""); setRenderError(undefined);
    (async () => {
      try {
        const pdfPage = await document.getPage(page);
        if (disposed) return;
        const base = pdfPage.getViewport({ scale: 1, rotation: (pdfPage.rotate + rotation) % 360 });
        const widthScale = Math.max(0.1, (viewport.width - 32) / base.width);
        const scale = zoom === "width" ? widthScale : zoom === "fit" ? Math.min(widthScale, Math.max(0.1, (viewport.height - 32) / base.height)) : Number(zoom) / 100;
        const view = pdfPage.getViewport({ scale, rotation: base.rotation });
        // Bound bitmap memory for unusually large page dimensions and HiDPI.
        const outputScale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (view.width * view.height)));
        canvas.width = Math.max(1, Math.floor(view.width * outputScale)); canvas.height = Math.max(1, Math.floor(view.height * outputScale));
        canvas.style.width = `${view.width}px`; canvas.style.height = `${view.height}px`;
        canvas.setAttribute("aria-hidden", "true");
        host.style.width = `${view.width}px`; host.style.height = `${view.height}px`;
        host.style.setProperty("--total-scale-factor", String(scale));
        render = pdfPage.render({ canvas, viewport: view, transform: [outputScale, 0, 0, outputScale, 0, 0] });
        text = new TextLayer({ textContentSource: pdfPage.streamTextContent(), container: layer, viewport: view });
        await Promise.all([render.promise, text.render()]);
        if (!disposed) setRendered(renderKey);
      } catch (error) { if (!disposed) setRenderError(failure(error)); }
    })();
    return () => { disposed = true; render?.cancel(); text?.cancel(); };
  }, [document, visible, missingPage, renderKey]);

  const error = loadError || (missingPage ? { title: "PDF page not found", message: `Page ${page} does not exist. This PDF has ${document!.numPages} pages.` } : renderError);
  const label = error?.title || (passwordPrompt ? "PDF password required" : document ? `Page ${page} of ${document.numPages} · PDF` : "Loading PDF");
  useRouteTitle(visible ? `${name} · ${label}${node ? ` · ${nodeName(node)}` : ""}` : undefined);
  const goPage = (next: number) => change({ page: next === 1 ? null : String(next) });
  const step = (delta: number) => {
    if (!ownsRoute() || !document) return;
    goPage(Math.min(document.numPages, Math.max(1, selection(readRoute().params).page + delta)));
  };
  const button = "rounded border border-zinc-700 px-2 py-1 text-xs disabled:opacity-40 hover:bg-zinc-800";
  return <section className="flex min-h-0 flex-1 flex-col" data-testid="pdf-preview" aria-label={`PDF preview: ${name}`}>
    <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
      <button className={button} onClick={() => step(-1)} disabled={!document || page <= 1}>Previous page</button>
      <form className="flex items-center gap-1 text-xs" onSubmit={event => { event.preventDefault(); if (/^[1-9]\d*$/.test(pageInput) && Number.isSafeInteger(Number(pageInput))) goPage(Number(pageInput)); else setPageInput(String(page)); }}>
        <label>Page <input aria-label="PDF page" className="w-16 rounded border border-zinc-700 bg-zinc-950 px-1 py-1" inputMode="numeric" value={pageInput} onChange={event => setPageInput(event.target.value)} /></label>
        <span>of {document?.numPages ?? "…"}</span><button className={button}>Go</button>
      </form>
      <button className={button} onClick={() => step(1)} disabled={!document || page >= document.numPages}>Next page</button>
      <label className="text-xs">Zoom <select aria-label="PDF zoom" className="rounded border border-zinc-700 bg-zinc-950 p-1" value={zoom} onChange={event => change({ zoom: event.target.value === "width" ? null : event.target.value })}>
        <option value="width">Fit width</option><option value="fit">Fit page</option>
        {[...new Set([50, 75, 100, 125, 150, 200, ...(Number(zoom) ? [Number(zoom)] : [])])].sort((a,b) => a-b).map(n => <option key={n} value={String(n)}>{n}%</option>)}
      </select></label>
      <button className={button} onClick={() => { const next = (selection(readRoute().params).rotation + 90) % 360; change({ rotate: next ? String(next) : null }); }}>Rotate clockwise</button>
      <a className={`${button} ml-auto`} href={rawUrl("/api/fs/read", { path }, node)} target="_blank" rel="noopener noreferrer" title="Open the browser PDF viewer for printing, forms and full-document search">Open original</a>
    </div>
    {error && <div role="alert" className="m-4 text-sm text-red-300" data-testid="pdf-error">{error.message} <button className={button} onClick={() => { setRenderError(undefined); setRetry(n => n + 1); }}>Retry preview</button>{missingPage && <button className={`${button} ml-2`} onClick={() => goPage(1)}>First page</button>}</div>}
    {passwordPrompt > 0 && !error && <form className="m-4 flex items-center gap-2 text-sm" onSubmit={event => { event.preventDefault(); passwordCallback.current?.(password); setPassword(""); }}>
      <label>{passwordPrompt === 2 ? "Incorrect password. Try again:" : "PDF password"} <input type="password" autoComplete="off" aria-label="PDF password" className="rounded border border-zinc-700 bg-zinc-950 p-1" value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button className={button}>Unlock PDF</button>
    </form>}
    <div role="status" className="h-8 shrink-0 px-4 py-2 text-xs text-zinc-400">{!error && !passwordPrompt ? (!document || rendered !== renderKey ? "Loading PDF page…" : `Page ${page} of ${document.numPages}`) : ""}</div>
    <div ref={container} className="min-h-0 flex-1 overflow-auto bg-zinc-900 p-4" data-testid="pdf-scroll">
      <div ref={paper} className="pdf-paper relative mx-auto bg-white" data-testid="pdf-page" data-page={rendered === renderKey ? page : undefined} hidden={!!error || !!passwordPrompt || !document} />
    </div>
  </section>;
}
