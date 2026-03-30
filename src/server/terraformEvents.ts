/**
 * Server-side push event bus for web mode.
 *
 * In Electron mode, pushed events are delivered via:
 *   - window.webContents.send(channel, payload)  — for BrowserWindow-level events
 *   - event.sender.send(channel, payload)         — for per-request push events
 *
 * In web mode neither is available. This module provides a Node EventEmitter
 * bus that replaces both, plus helpers used by:
 *   1. makeMockWindow() — passed as getWindow() for BrowserWindow-level events
 *   2. makeMockEvent()  — passed as the IPC event object so event.sender.send works
 *   3. onEvent() / offEvent() — used by the /api/events WebSocket in index.ts
 */

import { EventEmitter } from 'node:events'

const bus = new EventEmitter()
bus.setMaxListeners(200)

export function broadcastEvent(channel: string, payload: unknown): void {
  bus.emit(channel, payload)
}

/** @deprecated use broadcastEvent */
export const broadcastTerraformEvent = broadcastEvent

export function onEvent(channel: string, handler: (payload: unknown) => void): void {
  bus.on(channel, handler)
}

/** @deprecated use onEvent */
export const onTerraformEvent = onEvent

export function offEvent(channel: string, handler: (payload: unknown) => void): void {
  bus.off(channel, handler)
}

/** @deprecated use offEvent */
export const offTerraformEvent = offEvent

/**
 * Mock BrowserWindow for handlers that call getWindow().webContents.send().
 */
export function makeMockWindow() {
  return {
    webContents: {
      send(channel: string, payload: unknown): void {
        broadcastEvent(channel, payload)
      }
    }
  }
}

/**
 * Mock IPC event for handlers that call event.sender.send().
 * Used by electronShim so ALL ipcMain.handle() callbacks get a real event object.
 */
export function makeMockEvent() {
  return {
    sender: {
      send(channel: string, payload: unknown): void {
        broadcastEvent(channel, payload)
      }
    },
    returnValue: undefined as unknown
  }
}
