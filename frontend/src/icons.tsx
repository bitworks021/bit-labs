import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function icon(paths: ReactNode) {
  return function Icon(props: IconProps) {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        {paths}
      </svg>
    );
  };
}

export const CheckIcon = icon(<path d="M20 6 9 17l-5-5" />);
export const UploadIcon = icon(
  <>
    <path d="M5 12h14" />
    <path d="m13 6 6 6-6 6" />
  </>,
);
export const BookIcon = icon(
  <>
    <path d="M4 19.5V5a2 2 0 0 1 2-2h14v16H6.5A2.5 2.5 0 0 0 4 21.5v-2Z" />
    <path d="M8 7h8" />
  </>,
);
export const PaletteIcon = icon(
  <>
    <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.9 1.7-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.8-.5-1.2 0-1 .8-1.8 1.8-1.8H16a5 5 0 0 0 5-5c0-3.9-4-7-9-7Z" />
    <circle cx="7.5" cy="11" r="1" fill="currentColor" />
    <circle cx="10.5" cy="7" r="1" fill="currentColor" />
    <circle cx="15.5" cy="7.5" r="1" fill="currentColor" />
  </>,
);
export const UsbIcon = icon(
  <>
    <path d="M12 2v14" />
    <path d="m9 5 3-3 3 3" />
    <path d="M12 16a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z" />
    <path d="M12 12 7 9V7" />
    <path d="m12 10 5-3V5" />
  </>,
);
export const DownloadIcon = icon(
  <>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </>,
);
export const RefreshIcon = icon(
  <>
    <path d="M21 12a9 9 0 1 1-2.6-6.4" />
    <path d="M21 3v6h-6" />
  </>,
);
export const TerminalIcon = icon(
  <>
    <path d="m4 7 5 5-5 5" />
    <path d="M12 19h8" />
  </>,
);
export const MonitorIcon = icon(
  <>
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <path d="M8 21h8" />
    <path d="M7 9h4" />
    <path d="M7 12h7" />
  </>,
);
export const ChartIcon = icon(
  <>
    <path d="M3 3v18h18" />
    <path d="m7 15 4-5 3 3 5-7" />
  </>,
);
export const PlugIcon = icon(
  <>
    <path d="M9 2v5" />
    <path d="M15 2v5" />
    <path d="M6 7h12v4a6 6 0 0 1-12 0V7Z" />
    <path d="M12 17v5" />
  </>,
);
export const TrashIcon = icon(
  <>
    <path d="M4 7h16" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M6 7l1 13h10l1-13" />
    <path d="M9 7V4h6v3" />
  </>,
);
export const PauseIcon = icon(
  <>
    <path d="M9 5v14" />
    <path d="M15 5v14" />
  </>,
);
export const PlayIcon = icon(<path d="M7 4v16l13-8L7 4Z" />);
export const SendIcon = icon(
  <>
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
  </>,
);
export const FileIcon = icon(
  <>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
    <path d="M14 3v6h6" />
    <path d="M12 12v6M9 15h6" />
  </>,
);
export const FolderIcon = icon(
  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
);
export const SaveIcon = icon(
  <>
    <path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
    <path d="M7 3v5h8V3" />
    <path d="M7 21v-7h10v7" />
  </>,
);
export const ZoomInIcon = icon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5M11 8v6M8 11h6" />
  </>,
);
export const ZoomOutIcon = icon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5M8 11h6" />
  </>,
);
export const PlusIcon = icon(<path d="M12 5v14M5 12h14" />);
export const PackageIcon = icon(
  <>
    <path d="m21 8-9-5-9 5v8l9 5 9-5V8Z" />
    <path d="m3 8 9 5 9-5" />
    <path d="M12 13v8" />
  </>,
);
export const ChipIcon = icon(
  <>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
  </>,
);
