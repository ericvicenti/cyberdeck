import { useEffect, useState } from "react";
import { installTVInput } from "../lib/tv/runtime";
import {
  ACTIONS,
  labelBinding,
  type Action,
  type Profile,
} from "../lib/tv/model";

export function Controls() {
  const runtime = installTVInput();
  const [, refresh] = useState(0),
    [notice, setNotice] = useState(""),
    [resetting, setResetting] = useState(false);
  useEffect(() => runtime.subscribe(() => refresh((n) => n + 1)), [runtime]);
  useEffect(() => () => runtime.cancelCapture(), [runtime]);
  const s = runtime.snapshot(),
    p = s.profile as Profile;
  const patch = (values: Partial<Profile>) =>
    runtime.setProfile({ ...p, ...values });
  const capture = (target: Action | "scrollX" | "scrollY") =>
    runtime.startCapture(target, setNotice);
  const b =
    "rounded-lg border border-zinc-600 bg-zinc-900 px-4 py-3 text-sm hover:border-lime-400";
  return (
    <section
      className="h-full overflow-auto p-5 sm:p-8"
      data-testid="controls-view"
    >
      <div className="mx-auto max-w-5xl">
        <p className="mb-2 text-xs uppercase tracking-widest text-lime-300">
          Made for the sofa
        </p>
        <h1 className="text-3xl font-semibold">Controller & keyboard</h1>
        <p className="mt-3 text-zinc-400">
          Arrows choose. Enter or Space opens. Escape / Back closes or returns.
          Select a text field for the on-screen keyboard.
        </p>
        <div className="mt-6 rounded-2xl border border-zinc-700 bg-zinc-900/70 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">
                {s.pad ? "Controller connected" : "Waiting for your controller"}
              </h2>
              <p className="mt-1 text-sm text-zinc-400">
                {s.pad
                  ? s.pad.id
                  : "Plug in its receiver or connect it, then press a button."}
              </p>
            </div>
            <span className="text-xs text-lime-300">
              {s.pad?.mapping === "standard"
                ? "Standard gamepad layout"
                : s.pad
                  ? "Custom layout · use Remap below"
                  : "Keyboard navigation is ready"}
            </span>
          </div>
          <svg
            viewBox="0 0 700 220"
            role="img"
            aria-label="Controller guide: D-pad moves focus, left joystick scrolls, A selects, B goes back"
            className="mx-auto mt-5 max-h-56 w-full"
          >
            <path
              d="M195 40 Q150 20 126 80 L95 168 Q90 207 120 204 L190 162 H510 L580 204 Q610 207 605 168 L574 80 Q550 20 505 40Z"
              fill="#172033"
              stroke="#52627b"
              strokeWidth="3"
            />
            <g fill="#32445b" stroke="#7b8da5">
              <rect x="174" y="72" width="28" height="80" rx="5" />
              <rect x="148" y="98" width="80" height="28" rx="5" />
            </g>
            <circle
              cx="282"
              cy="135"
              r="29"
              fill="#273b4a"
              stroke="#a3e635"
              strokeWidth="3"
            />
            <circle cx="282" cy="135" r="13" fill="#a3e635" />
            <circle cx="425" cy="135" r="25" fill="#253043" stroke="#52627b" />
            {[
              ["Y", 522, 66, 3],
              ["X", 494, 96, 2],
              ["B", 550, 96, 1],
              ["A", 522, 126, 0],
            ].map(([label, x, y, n]) => (
              <g key={label}>
                <circle
                  cx={Number(x)}
                  cy={Number(y)}
                  r="17"
                  fill={
                    (s.pad?.buttons[Number(n)] ?? 0) > 0.5
                      ? "#a3e635"
                      : "#32445b"
                  }
                />
                <text
                  x={Number(x)}
                  y={Number(y) + 5}
                  textAnchor="middle"
                  fill="#fff"
                  fontSize="14"
                >
                  {label}
                </text>
              </g>
            ))}
            <text x="30" y="30" fill="#e4e4e7" fontSize="16">
              D-pad → focus
            </text>
            <text x="240" y="204" fill="#a3e635" fontSize="16">
              Left stick → scroll
            </text>
            <text x="530" y="30" fill="#e4e4e7" fontSize="16">
              A → select · B → back
            </text>
          </svg>
          <p className="text-center text-xs text-zinc-400">
            Illustration shows the default standard layout. Your saved mappings
            below take priority.
          </p>
          {s.pad && (
            <div
              className="mt-4 flex flex-wrap gap-2"
              aria-label="Live controller inputs"
            >
              {s.pad.buttons.map((v: number, i: number) => (
                <span
                  key={i}
                  className={`rounded px-2 py-1 text-xs ${v > 0.5 ? "bg-lime-300 text-black" : "bg-zinc-800 text-zinc-400"}`}
                >
                  B{i}
                  {v > 0.5 ? " ●" : ""}
                </span>
              ))}
              {s.pad.axes.map((v: number, i: number) => (
                <span
                  key={`a${i}`}
                  className="rounded bg-zinc-800 px-2 py-1 font-mono text-xs"
                >
                  Axis {i}: {v.toFixed(2)}
                </span>
              ))}
            </div>
          )}
        </div>
        {(notice || s.error) && (
          <p
            role="status"
            className="sticky top-0 z-10 my-4 rounded-lg border border-lime-700 bg-zinc-950 p-4 text-lime-200"
          >
            {s.error || notice}
          </p>
        )}
        {s.capturing && (
          <button
            className={`${b} mt-3`}
            onClick={() => runtime.cancelCapture()}
          >
            Cancel remapping
          </button>
        )}
        <h2 className="mb-3 mt-8 text-xl font-semibold">Buttons</h2>
        <p className="mb-4 text-sm text-zinc-400">
          Choose Remap, release the button, then press the new control. If it is
          already assigned, the two assignments swap. Changes save automatically
          for this controller.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ACTIONS.map((a) => (
            <button
              key={a.id}
              className={`${b} text-left`}
              onClick={() => capture(a.id)}
              data-testid={`map-${a.id}`}
            >
              <span className="block font-semibold">{a.label}</span>
              <span className="mt-1 block text-sm text-lime-300">
                {labelBinding(p.bindings[a.id])} · Remap
              </span>
            </button>
          ))}
        </div>
        <h2 className="mb-3 mt-8 text-xl font-semibold">
          Left joystick scrolling
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-zinc-700 p-4">
            <p className="mb-3">
              Horizontal: axis {p.scrollX} · Vertical: axis {p.scrollY}
            </p>
            <div className="flex flex-wrap gap-3">
              <button className={b} onClick={() => capture("scrollX")}>
                Map horizontal stick
              </button>
              <button className={b} onClick={() => capture("scrollY")}>
                Map vertical stick
              </button>
              <button
                className={b}
                aria-pressed={p.invertX}
                onClick={() => patch({ invertX: !p.invertX })}
              >
                Reverse horizontal: {p.invertX ? "on" : "off"}
              </button>
              <button
                className={b}
                aria-pressed={p.invertY}
                onClick={() => patch({ invertY: !p.invertY })}
              >
                Reverse vertical: {p.invertY ? "on" : "off"}
              </button>
            </div>
          </div>
          <div className="rounded-xl border border-zinc-700 p-4">
            <p className="mb-3">
              Dead zone: {Math.round(p.deadzone * 100)}% · Scroll speed:{" "}
              {p.speed} px/s
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                className={b}
                onClick={() =>
                  patch({ deadzone: Math.max(0.08, p.deadzone - 0.04) })
                }
              >
                Smaller dead zone
              </button>
              <button
                className={b}
                onClick={() =>
                  patch({ deadzone: Math.min(0.6, p.deadzone + 0.04) })
                }
              >
                Larger dead zone
              </button>
              <button
                className={b}
                onClick={() => patch({ speed: Math.max(150, p.speed - 150) })}
              >
                Slower scrolling
              </button>
              <button
                className={b}
                onClick={() => patch({ speed: Math.min(2400, p.speed + 150) })}
              >
                Faster scrolling
              </button>
            </div>
            <p className="mt-3 text-xs text-zinc-400">
              Increase the dead zone if the page moves while the stick is
              centered.
            </p>
          </div>
        </div>
        <div className="my-8 flex flex-wrap items-center gap-3">
          {resetting ? (
            <>
              <span>Restore this controller’s default layout?</span>
              <button className={b} onClick={() => setResetting(false)}>
                Keep my controls
              </button>
              <button
                className={b}
                onClick={() => {
                  runtime.reset();
                  setResetting(false);
                  setNotice("Default controls restored.");
                }}
              >
                Restore defaults
              </button>
            </>
          ) : (
            <button className={b} onClick={() => setResetting(true)}>
              Reset controller mappings
            </button>
          )}
        </div>
        <p className="mb-8 text-sm text-zinc-400">
          Select edits sliders and lists; arrows choose the value. Back exits
          editing. The keyboard shortcuts remain available even after remapping.
          Start opens this screen and Select/Back opens Home in the default
          gamepad layout.
        </p>
      </div>
    </section>
  );
}
