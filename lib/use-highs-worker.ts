"use client";

import { useEffect, useRef, useState, useCallback } from "react";

import type { HighsSolveResult } from "./highs";
import type { SolverFunction } from "./planner";

type PendingResolve = {
  resolve: (result: HighsSolveResult) => void;
  reject: (error: Error) => void;
};

export type HighsWorkerState = {
  ready: boolean;
  error: string | null;
  solve: SolverFunction;
};

export default function useHighsWorker(): HighsWorkerState {
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef<Map<number, PendingResolve>>(new Map());
  const nextIdRef = useRef(1);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const worker = new Worker("/highs-worker.js");
    workerRef.current = worker;
    const rejectAllPending = (message: string) => {
      for (const pending of pendingRef.current.values()) {
        pending.reject(new Error(message));
      }
      pendingRef.current.clear();
    };

    worker.onmessage = (event: MessageEvent) => {
      const { id, result, error: errMsg } = event.data;
      const pending = pendingRef.current.get(id);
      if (!pending) return;
      pendingRef.current.delete(id);
      if (errMsg) {
        pending.reject(new Error(errMsg));
      } else {
        pending.resolve(result as HighsSolveResult);
      }
    };

    worker.onerror = (event) => {
      const message = event.message || "Worker error";
      setError(message);
      setReady(false);
      rejectAllPending(message);
    };
    worker.onmessageerror = () => {
      const message = "Worker message deserialization failed";
      setError(message);
      setReady(false);
      rejectAllPending(message);
    };

    // Send a tiny probe solve to confirm the worker is ready.
    const probeId = 0;
    const probePromise = new Promise<void>((resolve, reject) => {
      pendingRef.current.set(probeId, {
        resolve: () => {
          setReady(true);
          resolve();
        },
        reject: (err) => {
          setError(err.message);
          reject(err);
        },
      });
    });
    worker.postMessage({
      id: probeId,
      model: "Minimize\n obj: x\nSubject To\n c1: x >= 0\nEnd",
      options: {},
    });
    probePromise.catch(() => {});

    return () => {
      worker.terminate();
      workerRef.current = null;
      rejectAllPending("Worker terminated");
    };
  }, []);

  const solve: SolverFunction = useCallback(
    (model: string, options?: Record<string, string | number | boolean>) => {
      const worker = workerRef.current;
      if (!worker) {
        return Promise.reject(new Error("HiGHS worker not initialized"));
      }
      const id = nextIdRef.current++;
      return new Promise<HighsSolveResult>((resolve, reject) => {
        pendingRef.current.set(id, { resolve, reject });
        worker.postMessage({ id, model, options: options ?? {} });
      });
    },
    []
  );

  return { ready, error, solve };
}
