import fs from "fs";
import path from "path";
import { createRequire } from "module";

type HighsColumn = {
  Primal?: number;
};

export type HighsSolveResult = {
  Status?: string;
  ObjectiveValue?: number;
  Columns?: Record<string, HighsColumn>;
  Rows?: unknown[];
};

type HighsModule = {
  solve: (problem: string, options?: Record<string, string | number | boolean>) => HighsSolveResult;
};

type HighsFactory = (options?: {
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    receiveInstance: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
  ) => unknown;
}) => Promise<HighsModule>;

const HIGHS_JS_PATH = path.join(process.cwd(), "public", "highs.js");
const HIGHS_WASM_PATH = path.join(process.cwd(), "public", "highs.wasm");
const nodeRequire = createRequire(import.meta.url);

let highsModulePromise: Promise<HighsModule> | null = null;

export async function solveWithHighs(
  model: string,
  options: Record<string, string | number | boolean> = {}
): Promise<HighsSolveResult> {
  const highs = await getHighsModule();
  return highs.solve(model, {
    presolve: "on",
    ...options,
  });
}

async function getHighsModule(): Promise<HighsModule> {
  if (highsModulePromise) {
    return highsModulePromise;
  }

  highsModulePromise = (async () => {
    if (!fs.existsSync(HIGHS_JS_PATH)) {
      throw new Error(`HiGHS solver JS asset missing at ${HIGHS_JS_PATH}`);
    }
    if (!fs.existsSync(HIGHS_WASM_PATH)) {
      throw new Error(`HiGHS solver WASM asset missing at ${HIGHS_WASM_PATH}`);
    }

    const highsFactory = nodeRequire("../public/highs.js") as HighsFactory;
    if (typeof highsFactory !== "function") {
      throw new Error("Unable to initialize HiGHS module factory");
    }

    const highs = await highsFactory({
      instantiateWasm(imports, receiveInstance) {
        const wasmBytes = fs.readFileSync(HIGHS_WASM_PATH);
        const module = new WebAssembly.Module(wasmBytes);
        const instance = new WebAssembly.Instance(module, imports);
        receiveInstance(instance, module);
        return instance.exports;
      },
    });

    if (!highs || typeof highs.solve !== "function") {
      throw new Error("HiGHS module loaded but solve() is unavailable");
    }
    return highs;
  })();

  return highsModulePromise;
}
