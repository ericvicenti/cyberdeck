import { g as o, r as l, d as t } from "./chunk-6Q2QTUOP-BBqI9t-Y.js";
import { p as m } from "./chunk-JWPE2WC7-DDxkgUju.js";
import { _ as n, l as s } from "./mermaid.core-BsBEsqOu.js";
import { M as p, c as u } from "./cynefin-VYW2F7L2-2OnSwEZR.js";
var d = u().Railroad.parser.LangiumParser, a = /* @__PURE__ */ n((e) => {
  switch (e.$type) {
    case "RailroadTerminalExpr":
      return {
        type: "terminal",
        value: e.value
      };
    case "RailroadNonTerminalExpr":
      return {
        type: "nonterminal",
        name: e.name
      };
    case "RailroadSpecialExpr":
      return {
        type: "special",
        text: e.text
      };
    case "RailroadSequenceExpr": {
      const r = e.elements.map(a);
      return r.length === 1 ? r[0] : { type: "sequence", elements: r };
    }
    case "RailroadChoiceExpr": {
      const r = e.alternatives.map(a);
      return r.length === 1 ? r[0] : { type: "choice", alternatives: r };
    }
    case "RailroadOptionalExpr":
      return {
        type: "optional",
        element: a(e.element)
      };
    case "RailroadOneOrMoreExpr":
      return {
        type: "repetition",
        element: a(e.element),
        min: 1,
        max: 1 / 0
      };
    case "RailroadZeroOrMoreExpr":
      return {
        type: "repetition",
        element: a(e.element),
        min: 0,
        max: 1 / 0
      };
    default:
      throw new Error(`Unsupported railroad expression: ${e.$type}`);
  }
}, "transformExpression"), c = /* @__PURE__ */ n((e) => ({
  name: e.name,
  definition: a(e.definition)
}), "transformRule"), g = /* @__PURE__ */ n((e) => {
  m(e, t), e.title && t.setTitle(e.title), e.rules.map((r) => t.addRule(c(r)));
}, "populateDb"), y = {
  parse: /* @__PURE__ */ n((e) => {
    t.clear(), s.debug("[Railroad Parser] Starting Langium parse");
    const r = d.parse(e);
    if (r.lexerErrors.length > 0 || r.parserErrors.length > 0)
      throw new p(r);
    const i = r.value;
    s.debug("[Railroad Parser] Parsed rules:", i.rules.length), g(i), s.debug("[Railroad Parser] Parse complete");
  }, "parse"),
  parser: {
    yy: t
  }
}, h = {
  parser: y,
  db: t,
  renderer: l,
  styles: o
};
export {
  h as diagram
};
