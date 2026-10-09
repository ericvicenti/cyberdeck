// Minimal inline icon set (lucide-style strokes) for a VS Code-like chrome.
type P = { size?: number; className?: string };

const base = (props: P) => ({
  width: props.size ?? 20,
  height: props.size ?? 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className: props.className,
});

export const ShieldIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z" />
  </svg>
);

export const ServerIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="7" rx="1.5" />
    <rect x="3" y="13" width="18" height="7" rx="1.5" />
    <circle cx="7" cy="7.5" r="0.5" fill="currentColor" />
    <circle cx="7" cy="16.5" r="0.5" fill="currentColor" />
  </svg>
);

export const FolderIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </svg>
);

export const TerminalIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9l3 3-3 3M12 15h5" />
  </svg>
);

export const GitIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="6" cy="6" r="2.2" />
    <circle cx="6" cy="18" r="2.2" />
    <circle cx="18" cy="9" r="2.2" />
    <path d="M6 8.2v7.6M8 7.2l7.8 1.4M16 10.6c-1.5 2-4.5 3-7.7 3" />
  </svg>
);

export const ChevronRight = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const ChevronDown = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export const DotsIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="5" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="19" cy="12" r="1" fill="currentColor" />
  </svg>
);

export const PlayIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 5l12 7-12 7V5z" />
  </svg>
);

export const PauseIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 5v14M16 5v14" />
  </svg>
);

export const SkipBackIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M18 6l-8 6 8 6V6zM7 6v12" />
  </svg>
);

export const SkipFwdIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 6l8 6-8 6V6zM17 6v12" />
  </svg>
);

export const RepeatIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M17 2l4 4-4 4" />
    <path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4" />
    <path d="M21 13v1a4 4 0 0 1-4 4H3" />
  </svg>
);

export const ShuffleIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
  </svg>
);

export const LayersIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3l9 5-9 5-9-5 9-5z" />
    <path d="M3 13l9 5 9-5" />
  </svg>
);

export const BotIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="4" y="8" width="16" height="11" rx="2" />
    <path d="M12 4v4M8 4h8" />
    <circle cx="9" cy="13.5" r="1" fill="currentColor" />
    <circle cx="15" cy="13.5" r="1" fill="currentColor" />
    <path d="M9.5 16.5h5" />
  </svg>
);

export const PulseIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 12h4l2-6 4 12 2-6h6" />
  </svg>
);

export const CloudIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M17.5 19a4.5 4.5 0 0 0 .4-8.98A7 7 0 0 0 4.3 12.2 3.5 3.5 0 0 0 6 19h11.5z" />
  </svg>
);
export const GridIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);

export const MicIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
  </svg>
);

export const MusicIcon = (p: P) => (
  <svg {...base(p)}><path d="M9 18V5l12-2v13M9 9l12-2" /><ellipse cx="6" cy="18" rx="3" ry="3" /><ellipse cx="18" cy="16" rx="3" ry="3" /></svg>
);
