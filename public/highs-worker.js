/* global self, importScripts */

let highs = null;
let initPromise = null;

function initHighs() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    importScripts("/highs.js");
    const factory = self.Module;
    if (typeof factory !== "function") {
      throw new Error("HiGHS Module factory not available after importScripts");
    }
    highs = await factory();
    if (!highs || typeof highs.solve !== "function") {
      throw new Error("HiGHS module loaded but solve() is unavailable");
    }
  })();
  return initPromise;
}

self.onmessage = async function (event) {
  const { id, model, options } = event.data;
  try {
    await initHighs();
    const result = highs.solve(model, { presolve: "on", ...options });
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
