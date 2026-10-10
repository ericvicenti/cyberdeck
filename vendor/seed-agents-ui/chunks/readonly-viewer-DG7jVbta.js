import { jsx as r, jsxs as D, Fragment as O } from "react/jsx-runtime";
import { c as U, M as V, u as W, a as q, b as G, h as X, d as j, R as F } from "./index-BlX-44g9.js";
import { useState as z, useRef as C, useEffect as I, useMemo as N, useCallback as $ } from "react";
import { L as B, g as K, T as Z, E as J, u as Q, b as L, h as Y } from "./BlockNoteEditor-Da14H26A.js";
import "react-dom/client";
import { createPortal as ee } from "react-dom";
/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */
const te = [
  ["circle", { cx: "18", cy: "5", r: "3", key: "gq8acd" }],
  ["circle", { cx: "6", cy: "12", r: "3", key: "w7nqdw" }],
  ["circle", { cx: "18", cy: "19", r: "3", key: "1xt0gg" }],
  ["line", { x1: "8.59", x2: "15.42", y1: "13.51", y2: "17.49", key: "47mynk" }],
  ["line", { x1: "15.41", x2: "8.59", y1: "6.51", y2: "10.49", key: "1n3mei" }]
], ne = U("share-2", te), H = "bn-block-hover-highlight", oe = 0, re = 8, _ = 4, ie = 40;
function ce(t, i) {
  return K(t.prosemirrorView.state?.doc, i);
}
function le({
  editor: t,
  onCopyBlockLink: i,
  onStartComment: l,
  isBlockReferenceable: c,
  getCommentCount: f,
  getCitationCount: b,
  onOpenCitations: d
}) {
  const h = !!(i || l || d), [o, p] = z({
    show: !1,
    blockId: null,
    referenceRect: null
  }), w = C(null), a = C(null);
  I(() => {
    const n = t.blockHoverActions;
    if (n)
      return n.onUpdate((u) => {
        w.current = u.referenceRect, p(u);
        const M = a.current;
        if (M && (M.classList.remove(H), a.current = null), u.show && u.blockId) {
          const s = t.prosemirrorView.dom.querySelector(`[data-id="${u.blockId}"]`);
          s && (s.classList.add(H), a.current = s);
        }
      });
  }, [t]), I(() => () => {
    a.current?.classList.remove(H);
  }, []), I(() => {
    if (!o.show) return;
    let n = 0;
    const u = () => {
      n || (n = requestAnimationFrame(() => {
        n = 0, t.blockHoverActions?.refresh();
      }));
    };
    return window.addEventListener("scroll", u, { capture: !0, passive: !0 }), window.addEventListener("resize", u), () => {
      n && cancelAnimationFrame(n), window.removeEventListener("scroll", u, { capture: !0 }), window.removeEventListener("resize", u);
    };
  }, [o.show, t]);
  const T = N(() => o.blockId ? c ? c(o.blockId) : !!ce(t, o.blockId) : !1, [o.blockId, t, c]), x = N(() => {
    if (!o.blockId) return;
    const n = t.prosemirrorView?.dom;
    if (n)
      return Array.from(n.querySelectorAll(".bn-supernumber-badge")).find(
        (u) => u instanceof HTMLElement && u.dataset.blockId === o.blockId
      );
  }, [o.blockId, t]);
  if (!h || !o.show || !o.referenceRect || !o.blockId)
    return null;
  const v = o.referenceRect, g = o.blockId, S = t.prosemirrorView?.dom.closest('[data-slot="scroll-area-viewport"]');
  if (S) {
    const n = S.getBoundingClientRect();
    if (v.top < n.top || v.top >= n.bottom) return null;
  }
  if (!T)
    return null;
  const E = f?.(g) ?? 0, y = b?.(g) ?? 0, P = !!x?.isConnected, k = P ? x.getBoundingClientRect() : v, A = typeof window < "u" ? window.innerWidth : 1 / 0, R = P ? k.left : v.right - oe + re, m = R + ie > A - _ ? {
    position: "fixed",
    top: k.top,
    right: _,
    zIndex: 10
  } : {
    position: "fixed",
    top: k.top,
    left: R,
    zIndex: 10
  };
  return /* @__PURE__ */ r(
    "div",
    {
      "data-bn-block-hover-actions": "true",
      style: m,
      onMouseDown: (n) => {
        n.preventDefault(), n.stopPropagation();
      },
      onPointerDown: (n) => {
        n.preventDefault(), n.stopPropagation();
      },
      onMouseEnter: () => t.blockHoverActions?.freeze(),
      onMouseLeave: () => {
        t.blockHoverActions?.unfreeze(), a.current?.classList.remove(H), a.current = null;
      },
      children: /* @__PURE__ */ D("div", { className: "bg-popover flex flex-col items-center gap-1 rounded-md border p-1 shadow-sm", children: [
        i && /* @__PURE__ */ r(
          "button",
          {
            type: "button",
            "aria-label": "Copy block link",
            title: "Copy block link",
            className: "text-muted-foreground hover:bg-accent hover:text-foreground rounded p-1",
            onClick: (n) => {
              n.stopPropagation(), i(g);
            },
            children: /* @__PURE__ */ r(B, { size: 14 })
          }
        ),
        l && /* @__PURE__ */ D("div", { className: "flex flex-col items-center gap-0.5", children: [
          /* @__PURE__ */ r(
            "button",
            {
              type: "button",
              "aria-label": "Start comment",
              title: "Start comment",
              className: "text-muted-foreground hover:bg-accent hover:text-foreground rounded p-1",
              onClick: (n) => {
                n.stopPropagation(), l(g);
              },
              children: /* @__PURE__ */ r(V, { size: 14 })
            }
          ),
          E > 0 ? /* @__PURE__ */ r("span", { className: "text-muted-foreground text-xs leading-none", "aria-label": `${E} comments`, children: E }) : null
        ] }),
        d && y > 0 ? /* @__PURE__ */ D(
          "button",
          {
            type: "button",
            "aria-label": `Open ${y} citations`,
            title: "Open citations",
            className: "text-muted-foreground hover:bg-accent hover:text-foreground flex flex-col items-center gap-0.5 rounded p-1",
            onClick: (n) => {
              n.stopPropagation(), d(g);
            },
            children: [
              /* @__PURE__ */ r(ne, { size: 14 }),
              /* @__PURE__ */ r("span", { className: "text-xs leading-none", children: y })
            ]
          }
        ) : null
      ] })
    }
  );
}
function se({
  editor: t
}) {
  const i = t.blockHoverActions, [l, c] = z(null), f = C(null);
  I(() => {
    if (i)
      return i.onConeDebug((a) => {
        a && (f.current = a), c(a ?? f.current);
      });
  }, [i]);
  const b = l ?? f.current;
  if (!b) return null;
  const { origin: d, cardTop: h, cardBottom: o } = b, p = `${d.x},${d.y} ${h.x},${h.y} ${o.x},${o.y}`, w = /* @__PURE__ */ D("svg", { className: "fixed inset-0 z-[9998] size-full", style: { pointerEvents: "none" }, "aria-hidden": "true", children: [
    /* @__PURE__ */ r(
      "polygon",
      {
        points: p,
        fill: "rgba(59, 130, 246, 0.08)",
        stroke: "rgba(59, 130, 246, 0.3)",
        strokeWidth: 1
      }
    ),
    /* @__PURE__ */ r("circle", { cx: d.x, cy: d.y, r: 4, fill: "rgba(59, 130, 246, 0.5)" }),
    /* @__PURE__ */ r("circle", { cx: h.x, cy: h.y, r: 3, fill: "rgba(59, 130, 246, 0.4)" }),
    /* @__PURE__ */ r("circle", { cx: o.x, cy: o.y, r: 3, fill: "rgba(59, 130, 246, 0.4)" })
  ] });
  return ee(w, document.body);
}
function ae({
  editor: t,
  onCopyFragmentLink: i,
  onComment: l
}) {
  const [c, f] = z({
    show: !1,
    blockId: null,
    rangeStart: null,
    rangeEnd: null,
    referenceRect: null
  }), b = C(null), d = C(0);
  if (I(() => {
    const e = t.rangeSelection;
    if (e)
      return e.onUpdate((m) => {
        b.current = m.referenceRect, f(m);
      });
  }, [t]), W(
    $(() => {
      f({ show: !1, blockId: null, rangeStart: null, rangeEnd: null, referenceRect: null });
    }, [])
  ), I(() => {
    if (typeof window > "u") return;
    const e = window.visualViewport;
    if (!e) return;
    const m = () => {
      f({ show: !1, blockId: null, rangeStart: null, rangeEnd: null, referenceRect: null });
    };
    return e.addEventListener("resize", m), () => {
      e.removeEventListener("resize", m);
    };
  }, []), !c.show || !c.referenceRect || !c.blockId || c.rangeStart === null || c.rangeEnd === null)
    return null;
  const h = c.referenceRect, { blockId: o, rangeStart: p, rangeEnd: w } = c, a = () => {
    f({ show: !1, blockId: null, rangeStart: null, rangeEnd: null, referenceRect: null }), pe(t);
  }, T = () => {
    i?.(o, p, w), a();
  }, x = () => {
    l?.(o, p, w), a();
  }, v = () => {
    d.current = Date.now();
  }, g = () => Date.now() - d.current < 700, S = typeof window < "u" ? window.visualViewport?.width ?? window.innerWidth ?? 1024 : 1024, E = typeof window < "u" ? window.visualViewport?.height ?? window.innerHeight ?? 768 : 768, y = h.left + h.width / 2, P = Math.min(Math.max(y, 60), Math.max(60, S - 60)), k = h.top - 8, R = {
    position: "fixed",
    top: Math.min(Math.max(k, 48), Math.max(48, E - 48)),
    left: P,
    transform: "translate(-50%, -100%)",
    zIndex: 50
  };
  return /* @__PURE__ */ r("div", { style: R, onMouseDown: ue, onTouchStart: de, children: /* @__PURE__ */ D("div", { className: "bg-popover flex items-center gap-1 rounded-md border p-1 shadow-md transition-all duration-150", children: [
    i && /* @__PURE__ */ r(
      "button",
      {
        type: "button",
        "aria-label": "Copy link to selection",
        title: "Copy Link",
        className: "text-muted-foreground hover:bg-accent hover:text-foreground rounded p-2",
        onMouseDown: (e) => {
          e.preventDefault(), e.stopPropagation();
        },
        onTouchStart: (e) => {
          e.preventDefault(), e.stopPropagation();
        },
        onTouchEnd: (e) => {
          e.preventDefault(), e.stopPropagation(), v(), T();
        },
        onClick: (e) => {
          e.stopPropagation(), !g() && T();
        },
        children: /* @__PURE__ */ r(B, { size: 16 })
      }
    ),
    l && /* @__PURE__ */ r(
      "button",
      {
        type: "button",
        "aria-label": "Comment on selection",
        title: "Comment",
        className: "text-muted-foreground hover:bg-accent hover:text-foreground rounded p-2",
        onMouseDown: (e) => {
          e.preventDefault(), e.stopPropagation();
        },
        onTouchStart: (e) => {
          e.preventDefault(), e.stopPropagation();
        },
        onTouchEnd: (e) => {
          e.preventDefault(), e.stopPropagation(), v(), x();
        },
        onClick: (e) => {
          e.stopPropagation(), !g() && x();
        },
        children: /* @__PURE__ */ r(V, { size: 16 })
      }
    )
  ] }) });
}
function ue(t) {
  t.stopPropagation();
}
function de(t) {
  t.stopPropagation();
}
function pe(t) {
  const i = t._tiptapEditor?.view;
  if (i && !i.isDestroyed) {
    const { state: l } = i, c = Math.min(Math.max(l.selection.to, 0), l.doc.content.size);
    try {
      i.dispatch(l.tr.setSelection(Z.create(l.doc, c)));
    } catch {
    }
  }
  typeof window < "u" && window.getSelection()?.removeAllRanges();
}
function fe({
  editor: t,
  children: i,
  className: l,
  ...c
}) {
  return /* @__PURE__ */ r(J, { editor: t._tiptapEditor || null, className: l, ...c, children: i ?? /* @__PURE__ */ r(O, {}) });
}
function xe({
  blocks: t,
  resourceId: i,
  resourceKind: l = "document",
  rootChildrenType: c,
  textUnit: f,
  layoutUnit: b,
  className: d,
  commentStyle: h,
  focusBlockId: o,
  blockRange: p,
  onCopyBlockLink: w,
  onStartComment: a,
  getBlockCommentCount: T,
  onCopyFragmentLink: x,
  onComment: v
}) {
  const g = q(), { hmUrlHref: S, openRouteNewWindow: E, origin: y, originHomeId: P, experiments: k } = G(), A = $(
    (s) => X(s, {
      hmUrlHref: S,
      origin: y,
      originHomeId: P
    }) || s,
    [S, y, P]
  ), R = N(() => {
    const s = j(t, {});
    return s.length > 0 ? s : [{ type: "paragraph" }];
  }, [t]), e = Q(
    {
      editable: !1,
      renderType: "viewer",
      blockSchema: Y,
      linkExtensionOptions: {
        openUrl: g,
        renderHref: A,
        handleModifiedClicks: !!E
      },
      // @ts-expect-error - EditorBlock/PartialBlock type mismatch
      initialContent: R,
      rootChildrenType: c || "Group"
    },
    [R, g, A, c]
  ), m = p && "start" in p ? p.start : null, n = p && "end" in p ? p.end : null;
  I(() => {
    const s = e._tiptapEditor?.view;
    s && (o && m != null && n != null ? s.dispatch(
      s.state.tr.setMeta(L, {
        type: "rangeFocus",
        blockId: o,
        start: m,
        end: n
      })
    ) : o ? s.dispatch(s.state.tr.setMeta(L, { type: "focus", blockId: o })) : s.dispatch(s.state.tr.setMeta(L, { type: "clear" })));
  }, [e, o, m, n]);
  const u = !!(w || a), M = !!(x || v);
  return /* @__PURE__ */ r(F, { resource: i ? { kind: l, id: i } : null, children: /* @__PURE__ */ r(
    "div",
    {
      style: {
        "--text-unit": `${f ?? 18}px`,
        "--layout-unit": `${b ?? 24}px`
      },
      className: [d ?? "", "hm-prose", h ? "comment-editor is-comment" : ""].filter(Boolean).join(" "),
      children: /* @__PURE__ */ r(fe, { editor: e, children: /* @__PURE__ */ D(O, { children: [
        u && /* @__PURE__ */ r(
          le,
          {
            editor: e,
            onCopyBlockLink: w,
            onStartComment: a,
            getCommentCount: T
          }
        ),
        M && /* @__PURE__ */ r(ae, { editor: e, onCopyFragmentLink: x, onComment: v }),
        k?.developerTools && k?.predictionConeDebug && /* @__PURE__ */ r(se, { editor: e })
      ] }) })
    }
  ) });
}
export {
  xe as ReadOnlyViewer
};
