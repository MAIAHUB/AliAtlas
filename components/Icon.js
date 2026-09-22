const paths = {
  upload: (
    <>
      <path d="M12 16V3m-4 4 4-4 4 4" />
      <path d="M4 15v5h16v-5" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 10 5-10 5L2 8l10-5Zm-9 9 9 5 9-5M3 17l9 5 9-5" />
    </>
  ),
  scan: (
    <>
      <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />
      <path d="M7 8h10v8H7zM7 12h10" />
    </>
  ),
  pan: (
    <>
      <path d="M12 2v20M2 12h20m-13-7 3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3m14-6 3 3-3 3" />
    </>
  ),
  window: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4v16" />
      <path d="M12 4a8 8 0 0 1 0 16" fill="currentColor" stroke="none" />
    </>
  ),
  scroll: (
    <>
      <path d="m8 6 4-4 4 4M12 2v20m-4-4 4 4 4-4M3 9v6m18-6v6" />
    </>
  ),
  tag: (
    <>
      <path d="m3 3 9 0 9 9-9 9-9-9V3Z" />
      <circle cx="8" cy="8" r="1" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  reset: (
    <>
      <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v13m-4-4 4 4 4-4M4 17v4h16v-4" />
    </>
  ),
  chevron: <path d="m9 5 7 7-7 7" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 6 6" />
    </>
  ),
  sparkles: (
    <>
      <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4m-2-2h4" />
    </>
  ),
  folder: <path d="M3 5h7l2 3h9v12H3V5Z" />,
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10v1" />
    </>
  ),
  play: <path d="m8 4 12 8-12 8V4Z" />,
  pause: (
    <>
      <path d="M8 4v16m8-16v16" strokeWidth="4" />
    </>
  ),
  expand: (
    <>
      <path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6" />
    </>
  ),
  check: <path d="m4 12 5 5L20 6" />,
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />
    </>
  ),
  book: (
    <>
      <path d="M12 5C8 2 3 3 3 3v16s5-1 9 2c4-3 9-2 9-2V3s-5-1-9 2v16" />
    </>
  ),
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
};
export default function Icon({ name, size = 18, ...props }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name] || paths.scan}
    </svg>
  );
}
