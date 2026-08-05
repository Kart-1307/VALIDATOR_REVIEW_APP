import { useEffect, useRef, useState } from 'react';
import { X, Calculator, AlertCircle } from 'lucide-react';

// --- Enhancement §1: embedded Desmos Graphing Calculator -------------------
// Loads the official Desmos API script on demand (only when a validator
// actually opens the modal, so Math-only reviewers don't pay the load cost
// on every other question) and mounts a GraphingCalculator instance into a
// div. Requires a free Desmos API key — see .env.example. Without a key the
// modal still opens and explains how to enable it, rather than failing silently.

declare global {
  interface Window {
    Desmos?: {
      GraphingCalculator: (el: HTMLElement, options?: Record<string, unknown>) => DesmosCalculatorInstance;
    };
  }
}

interface DesmosCalculatorInstance {
  setExpression: (expr: { id?: string; latex: string }) => void;
  destroy: () => void;
}

let desmosScriptPromise: Promise<void> | null = null;

function loadDesmosScript(apiKey: string): Promise<void> {
  if (window.Desmos) return Promise.resolve();
  if (desmosScriptPromise) return desmosScriptPromise;

  desmosScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://www.desmos.com/api/v1.9/calculator.js?apiKey=${encodeURIComponent(apiKey)}`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load the Desmos calculator script.'));
    document.head.appendChild(script);
  });
  return desmosScriptPromise;
}

// Best-effort conversion of the plain-text expressions extracted from a
// question into Desmos-friendly LaTeX-ish input. Desmos's calculator.js
// accepts a lot of plain math syntax directly (x^2, sqrt(x), fractions
// written as a/b), so this stays intentionally light-touch.
function toDesmosLatex(expr: string): string {
  return expr
    .replace(/\^(\d+)/g, '^{$1}')
    .replace(/sqrt\(([^)]+)\)/gi, '\\sqrt{$1}');
}

interface DesmosModalProps {
  open: boolean;
  onClose: () => void;
  initialExpressions?: string[];
  questionId?: string;
}

export default function DesmosModal({ open, onClose, initialExpressions = [], questionId }: DesmosModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const calculatorRef = useRef<DesmosCalculatorInstance | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'missing_key'>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const apiKey = (import.meta as any).env?.VITE_DESMOS_API_KEY as string | undefined;

  useEffect(() => {
    if (!open) return;

    if (!apiKey) {
      setStatus('missing_key');
      return;
    }

    let cancelled = false;
    setStatus('loading');
    setErrorMsg(null);

    loadDesmosScript(apiKey)
      .then(() => {
        if (cancelled || !containerRef.current || !window.Desmos) return;
        const calculator = window.Desmos.GraphingCalculator(containerRef.current, {
          keypad: true,
          expressionsTopbar: true,
          settingsMenu: true,
          zoomButtons: true,
          border: false
        });
        calculatorRef.current = calculator;

        initialExpressions.forEach((expr, i) => {
          try {
            calculator.setExpression({ id: `preload-${i}`, latex: toDesmosLatex(expr) });
          } catch {
            // Skip any expression Desmos can't parse rather than failing the whole modal
          }
        });

        setStatus('ready');
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setErrorMsg(err.message);
        setStatus('error');
      });

    return () => {
      cancelled = true;
      calculatorRef.current?.destroy();
      calculatorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, questionId]);

  // Close on Escape for keyboard accessibility
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Desmos Graphing Calculator"
    >
      <div
        className="w-full max-w-4xl h-[80vh] bg-[#fafafa] border border-[#e4e4e7] rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#e4e4e7] bg-white shrink-0">
          <span className="flex items-center gap-2 text-sm font-bold text-zinc-900">
            <Calculator className="w-4 h-4 text-[#4f46e5]" /> Desmos Graphing Calculator
          </span>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-900 hover:bg-[#e4e4e7] transition-all cursor-pointer"
            aria-label="Close calculator"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 relative bg-white">
          {status === 'missing_key' && (
            <div className="absolute inset-0 flex items-center justify-center p-6 bg-[#fafafa]">
              <div className="max-w-sm text-center text-xs text-zinc-500 flex flex-col items-center gap-2">
                <AlertCircle className="w-5 h-5 text-amber-700" />
                <p className="font-semibold text-zinc-700">Desmos API key not configured</p>
                <p>
                  Add a free key from desmos.com/api as <code className="text-zinc-600">VITE_DESMOS_API_KEY</code> in
                  your <code className="text-zinc-600">.env</code> file, then restart the dev server.
                </p>
              </div>
            </div>
          )}
          {status === 'error' && (
            <div className="absolute inset-0 flex items-center justify-center p-6 bg-[#fafafa]">
              <div className="max-w-sm text-center text-xs text-rose-600 flex flex-col items-center gap-2">
                <AlertCircle className="w-5 h-5" />
                <p>{errorMsg || 'Could not load the calculator.'}</p>
              </div>
            </div>
          )}
          {status === 'loading' && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#fafafa] text-xs text-zinc-500">
              Loading calculator…
            </div>
          )}
          <div ref={containerRef} className="w-full h-full" style={{ display: status === 'ready' ? 'block' : 'none' }} />
        </div>

        {initialExpressions.length > 0 && status === 'ready' && (
          <div className="px-4 py-2 border-t border-[#e4e4e7] bg-white text-[12px] text-zinc-500 shrink-0">
            Preloaded from this question: <span className="text-zinc-600 font-mono">{initialExpressions.join('  •  ')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
