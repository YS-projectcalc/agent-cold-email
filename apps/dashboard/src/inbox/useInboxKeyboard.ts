import { useEffect } from "react";

export interface InboxKeyboardHandlers {
  onMoveDown?: () => void;
  onMoveUp?: () => void;
  onOpen?: () => void;
  onArchive?: () => void;
  onFocusReply?: () => void;
  onOpenLabelPicker?: () => void;
  onToggleUnread?: () => void;
  onOpenPalette?: () => void;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/**
 * SPEC.md §19.6 keyboard-first desktop inbox: j/k move, Enter open, e
 * archive, r focus-reply, l label menu, u toggle unread, Cmd+K palette.
 * Single-letter shortcuts are suppressed while the user is typing anywhere
 * (composer, filter inputs, the label free-text field, the palette's own
 * search box) — Cmd+K stays live everywhere since it's a modifier chord, the
 * one shortcut a form field wouldn't otherwise use.
 */
export function useInboxKeyboard(handlers: InboxKeyboardHandlers, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        handlers.onOpenPalette?.();
        return;
      }

      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case "j":
          e.preventDefault();
          handlers.onMoveDown?.();
          break;
        case "k":
          e.preventDefault();
          handlers.onMoveUp?.();
          break;
        case "Enter":
          handlers.onOpen?.();
          break;
        case "e":
          handlers.onArchive?.();
          break;
        case "r":
          e.preventDefault();
          handlers.onFocusReply?.();
          break;
        case "l":
          handlers.onOpenLabelPicker?.();
          break;
        case "u":
          handlers.onToggleUnread?.();
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers is a fresh object every render by design; re-binding is cheap and always wants the latest closures
  }, [enabled, handlers]);
}
