'use client';

import { Toaster, toast as sonnerToast } from 'sonner';

export function ToastProvider() {
  return (
    <Toaster 
      position="top-right"
      toastOptions={{
        style: {
          background: 'var(--toast-bg)',
          color: 'var(--toast-color)',
          border: '1px solid var(--toast-border)',
        },
      }}
    />
  );
}

export const toast = {
  success: (message: string, description?: string) => {
    sonnerToast.success(message, { description });
  },
  error: (message: string, description?: string) => {
    sonnerToast.error(message, { description });
  },
  warning: (message: string, description?: string) => {
    sonnerToast.warning(message, { description });
  },
  info: (message: string, description?: string) => {
    sonnerToast.info(message, { description });
  },
  promise: <T,>(
    promise: Promise<T>,
    messages: {
      loading: string;
      success: string;
      error: string;
    }
  ) => {
    return sonnerToast.promise(promise, {
      loading: messages.loading,
      success: messages.success,
      error: messages.error,
    });
  },
};
