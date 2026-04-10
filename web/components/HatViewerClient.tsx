"use client";

import dynamic from "next/dynamic";

const HatViewer = dynamic(
  () => import("@/components/HatViewer").then((m) => m.HatViewer),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100vh",
          background: "#0f0f12",
          color: "#a1a1aa",
          fontFamily: "system-ui, sans-serif",
          fontSize: 14,
        }}
      >
        Loading…
      </div>
    ),
  },
);

export function HatViewerClient() {
  return <HatViewer />;
}
