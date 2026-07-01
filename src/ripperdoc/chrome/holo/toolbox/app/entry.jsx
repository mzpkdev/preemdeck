// entry.jsx — the holo client. Mounts the aliased MDX plan into #root, styled by
// holo's own barebones stylesheet. Vite's React Fast Refresh hot-updates the page
// when the source .mdx changes — no reload, no lost scroll.
import { createRoot } from "react-dom/client";
import "@holo-style";
import Plan from "@holo-plan";

createRoot(document.getElementById("root")).render(
  <article style={{ margin: "24px" }}>
    <Plan />
  </article>,
);
