// Demo app placeholder (real app lands in M7 per BRIEF §15).
import { VERSION } from "subgroup-web";
import { webgpuSupported } from "subgroup-web/webgpu";

const app = document.querySelector<HTMLDivElement>("#app");
if (app) {
  app.innerHTML = `
    <h1>subgroup-web ${VERSION}</h1>
    <p>Privacy-preserving in-browser subgroup discovery — demo under construction (M7).</p>
    <p>WebGPU: ${webgpuSupported() ? "available" : "not available"} ·
       crossOriginIsolated: ${String(globalThis.crossOriginIsolated ?? false)}</p>
  `;
}
