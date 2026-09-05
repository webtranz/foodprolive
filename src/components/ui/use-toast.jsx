// Inspired by react-hot-toast library
import { useState, useEffect } from "react";

const TOAST_LIMIT = 20;
export const DEFAULT_TOAST_DURATION_MS = 5000;
export const DEFAULT_TOAST_DEDUPE_WINDOW_MS = 60000;

const actionTypes = {
  ADD_TOAST: "ADD_TOAST",
  UPDATE_TOAST: "UPDATE_TOAST",
  DISMISS_TOAST: "DISMISS_TOAST",
  REMOVE_TOAST: "REMOVE_TOAST",
};

let count = 0;

function genId() {
  count = (count + 1) % Number.MAX_VALUE;
  return count.toString();
}

const toastTimeouts = new Map();
const recentToastKeys = new Map();

const clearToastTimeout = (toastId) => {
  const timeout = toastTimeouts.get(toastId);
  if (!timeout) return;
  clearTimeout(timeout);
  toastTimeouts.delete(toastId);
};

const scheduleToastRemoval = (toastId, duration) => {
  clearToastTimeout(toastId);
  const delay = Number(duration);
  if (!Number.isFinite(delay) || delay <= 0) return;

  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId);
    dispatch({
      type: actionTypes.REMOVE_TOAST,
      toastId,
    });
  }, delay);

  toastTimeouts.set(toastId, timeout);
};

export const reducer = (state, action) => {
  switch (action.type) {
    case actionTypes.ADD_TOAST:
      return {
        ...state,
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      };

    case actionTypes.UPDATE_TOAST:
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t
        ),
      };

    case actionTypes.DISMISS_TOAST: {
      const { toastId } = action;
      return toastId === undefined
        ? { ...state, toasts: [] }
        : { ...state, toasts: state.toasts.filter((toast) => toast.id !== toastId) };
    }
    case actionTypes.REMOVE_TOAST:
      if (action.toastId === undefined) {
        return {
          ...state,
          toasts: [],
        };
      }
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      };
  }
};

const listeners = [];

let memoryState = { toasts: [] };

function dispatch(action) {
  memoryState = reducer(memoryState, action);
  listeners.forEach((listener) => {
    listener(memoryState);
  });
}

function removeToast(toastId) {
  if (toastId === undefined) {
    toastTimeouts.forEach((_timeout, id) => clearToastTimeout(id));
  } else {
    clearToastTimeout(toastId);
  }
  dispatch({ type: actionTypes.REMOVE_TOAST, toastId });
}

function createToastController(id) {
  const update = (props) => {
    dispatch({
      type: actionTypes.UPDATE_TOAST,
      toast: { ...props, id },
    });
    if (Object.hasOwn(props, 'duration')) {
      scheduleToastRemoval(id, props.duration);
    }
  };

  return {
    id,
    dismiss: () => removeToast(id),
    update,
  };
}

function toast({ duration = DEFAULT_TOAST_DURATION_MS, dedupeKey = '', ...props }) {
  const now = Date.now();
  recentToastKeys.forEach((entry, key) => {
    if (now - entry.shownAt >= DEFAULT_TOAST_DEDUPE_WINDOW_MS) recentToastKeys.delete(key);
  });
  const recentDuplicate = dedupeKey ? recentToastKeys.get(dedupeKey) : null;
  if (recentDuplicate) return createToastController(recentDuplicate.id);

  const id = genId();
  if (dedupeKey) recentToastKeys.set(dedupeKey, { id, shownAt: now });

  dispatch({
    type: actionTypes.ADD_TOAST,
    toast: {
      ...props,
      id,
      duration,
      dedupeKey,
    },
  });
  scheduleToastRemoval(id, duration);

  return createToastController(id);
}

function subscribeToToastState(listener) {
  listeners.push(listener);
  listener(memoryState);
  return () => {
    const index = listeners.indexOf(listener);
    if (index > -1) listeners.splice(index, 1);
  };
}

function useToast() {
  const [state, setState] = useState(memoryState);

  useEffect(() => subscribeToToastState(setState), []);

  return {
    ...state,
    toast,
    dismiss: removeToast,
  };
}

export { useToast, toast, subscribeToToastState };
