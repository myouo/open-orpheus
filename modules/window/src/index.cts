// This module is the CJS entry point for the library.

import os from "node:os";

// The Rust addon.
import * as addon from "./load.cjs";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Use this declaration to assign types to the addon's exports,
// which otherwise by default are `any`.
declare module "./load.cjs" {
  function dragWindow(hwnd: Buffer): void;
  function isWayland(): boolean;
  function isX11(): boolean;
  function getLastCreatedWindowId(): string | null;
  function captureNextWindowFirstCursorEnter(
    callback: (x: number, y: number) => void
  ): void;
  function setInputRegion(
    windowHandle: string | Buffer,
    rects: Rect[] | null | undefined
  ): boolean;
}

export function dragWindow(hwnd: Buffer): void {
  addon.dragWindow(hwnd);
}

export function isWayland(): boolean {
  if (os.platform() !== "linux") {
    throw new Error("isWayland is only supported on Linux");
  }
  return addon.isWayland();
}

export function isX11(): boolean {
  if (os.platform() !== "linux") {
    throw new Error("isX11 is only supported on Linux");
  }
  return addon.isX11();
}

export function getLastCreatedWindowId(): string | null {
  if (os.platform() !== "linux") {
    throw new Error("getLastCreatedWindowId is only supported on Linux");
  }
  return addon.getLastCreatedWindowId();
}

export function captureNextWindowFirstCursorEnter(
  callback: (x: number, y: number) => void
): void {
  if (os.platform() !== "linux") {
    throw new Error(
      "captureNextWindowFirstCursorEnter is only supported on Linux"
    );
  }
  addon.captureNextWindowFirstCursorEnter(callback);
}

/**
 * Sets the input region for a given window.
 *
 * @param windowHandle - The window identifier (string for Wayland, Buffer for X11).
 * @param rects - An array of rectangles defining the input region. Pass `null` to reset the input region to the entire window.
 * @returns boolean indicating if the operation was successfully sent.
 */
export function setInputRegion(
  windowHandle: string | Buffer,
  rects: Rect[] | null
): boolean {
  if (os.platform() !== "linux") {
    throw new Error("setInputRegion is only supported on Linux");
  }
  return addon.setInputRegion(windowHandle, rects);
}
