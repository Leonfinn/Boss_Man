import { useCallback, useRef } from "react";

/**
 * Up-and-down wheel input over a sideways-only scroller (the Kanban board) scrolls the page
 * (BOS-1915, third time after BOS-554 and BOS-962).
 *
 * Why this is needed: a real mouse or trackpad rarely sends a purely vertical wheel. A Magic Mouse,
 * a trackpad and many free-spinning wheels add a pixel or two of sideways movement. The browser
 * hands any event with a sideways part to the nearest element that can scroll sideways (the board),
 * and that element drops the vertical part. Safari on a Mac then latches the rest of the gesture
 * onto the board as well, so the page stops responding to the wheel until the hand stops.
 * `overflow-y: hidden` (the BOS-554 fix) cannot help: the board is still the sideways target.
 *
 * What it does: a wheel event that is mostly vertical (and not shift+wheel, which means "sideways",
 * or ctrl+wheel, which is pinch-zoom) is taken off the board and scrolls the page by its vertical
 * amount instead. A purely vertical event is left to the browser (it already scrolls the page, with
 * the browser's own smoothing), unless an event of the same gesture was just taken over, so one
 * gesture is never split between the browser and this code. Mostly-sideways input (a sideways
 * swipe, shift+wheel) is left alone, so the board still scrolls sideways.
 */
const GESTURE_GAP_MS = 250;

/** Pixels for one wheel event, whatever unit it came in (Firefox sends lines). */
function pixels(e: WheelEvent, delta: number): number {
  if (e.deltaMode === 1) return delta * 40;
  if (e.deltaMode === 2) return delta * window.innerHeight;
  return delta;
}

/** True when something between the pointer and the board can itself scroll in the wheel's direction (leave that to the browser). */
function innerCanScroll(target: EventTarget | null, board: HTMLElement, dy: number): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== board; el = el.parentElement) {
    if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight + 1) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== "auto" && oy !== "scroll") continue;
    if (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0) return true;
  }
  return false;
}

export function wheelToPage(board: HTMLElement): () => void {
  let takenAt = -Infinity;
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.shiftKey || e.defaultPrevented) return;
    const dx = pixels(e, e.deltaX);
    const dy = pixels(e, e.deltaY);
    if (Math.abs(dy) <= Math.abs(dx)) return; // sideways: the board's own scroll
    if (dx === 0 && e.timeStamp - takenAt > GESTURE_GAP_MS) return; // plain vertical: the browser already scrolls the page
    if (innerCanScroll(e.target, board, dy)) return;
    takenAt = e.timeStamp;
    e.preventDefault();
    window.scrollBy(0, dy);
  };
  // Not passive: preventDefault is what keeps the board from taking the event.
  board.addEventListener("wheel", onWheel, { passive: false });
  return () => board.removeEventListener("wheel", onWheel);
}

/** A callback ref for a sideways-only scroller: attach it as `ref={useWheelToPage()}`. */
export function useWheelToPage(): (el: HTMLElement | null) => void {
  const detach = useRef<(() => void) | null>(null);
  return useCallback((el: HTMLElement | null) => {
    detach.current?.();
    detach.current = el ? wheelToPage(el) : null;
  }, []);
}
