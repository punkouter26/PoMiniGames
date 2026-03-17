import { useState, useCallback, useRef } from 'react';
import './Toast.css';

export type ToastType = 'info' | 'error' | 'success' | 'warning';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

let _show: ((msg: string, type?: ToastType) => void) | null = null;

/** Call from anywhere to trigger a toast. Component must be mounted. */
export function showToast(message: string, type: ToastType = 'info') {
  _show?.(message, type);
}

export default function Toast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const addToast = useCallback((message: string, type: ToastType = 'info') => {
    const id = ++nextId.current;
    setToasts(prev => [...prev, { id, message, type }]);
    window.setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  }, []);

  // Register global handler after first render
  _show = addToast;

  const dismiss = (id: number) =>
    setToasts(prev => prev.filter(t => t.id !== id));

  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" role="log" aria-live="polite" aria-label="Notifications">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast--${t.type}`} role="alert">
          <span className="toast-msg">{t.message}</span>
          <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}
