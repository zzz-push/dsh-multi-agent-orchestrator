import React, { type ReactElement } from 'react'
import {
  activeWindowAgents,
  agentLabel,
  agentLabelParts,
  minimizedWindowAgents,
  canRestoreDraft,
  clampWindowGeometry,
  currentSessionCwd,
  defaultWindowGeometry,
  evaluationLabel,
  partitionEvaluationAgents,
  projectTitle,
  recentWorkspacePath,
  reconcileExpandedIds,
  resizeWindowGeometry,
  resolveProjectCwd,
  type AgentLabelParts,
  type AgentView,
  type RoleView,
  type ResizeDirection,
  type SessionListLike,
  type WindowGeometry,
  type WorkspaceListLike,
} from './model.js'
import {
  currentActivity,
  EMPTY_CONVERSATION,
  loadPersistedWindows,
  mergeConversationPage,
  savePersistedWindows,
  toConversationEntries,
  type AgentActivity,
  type ConversationEntry,
  type ConversationPage,
  type ConversationState,
} from './conversation.js'
import { parseMarkdown, type InlineNode } from './markdown.js'


type StateResponse = {
  /** Canonical project directory the reply was scoped to; null when unscoped. */
  project?: string | null
  agents: AgentView[]
  roles: RoleView[]
}

/** Selector hook shape DSH hands to every root-scope slot component. */
type SelectorHook<State> = <Selected>(selector: (state: State) => Selected) => Selected

/**
 * Standard props DSH injects into `shell.overlay` entries. Both are optional
 * here so the surface still renders (unscoped) under a host that predates them.
 */
type SurfaceProps = {
  useSessions?: SelectorHook<SessionListLike>
  useWorkspaces?: SelectorHook<WorkspaceListLike>
}

/**
 * Read one string out of a DSH standard hook. The hook is either present for
 * the whole life of the slot or absent for all of it (the renderer binds the
 * standard kit once per host), so the branch never changes React's hook order.
 */
function useStandardSlice<State, Selected>(
  hook: SelectorHook<State> | undefined,
  selector: (state: State) => Selected | undefined,
): Selected | undefined {
  return hook === undefined ? undefined : hook(selector)
}

const sessionsById = (state: SessionListLike): SessionListLike['byId'] => state.byId


const API = '/plugins/dsh-agent-manager'
const POLL_MS = 1200
/** Conversation poll while nothing is happening; the window speeds up to POLL_MS while the agent works. */
const IDLE_POLL_MS = 4000
/** Vertical space the dock occupies at the bottom edge (inset + height + gap); new windows tile above it. */
const DOCK_RESERVED_PX = 44

const CSS = `
[data-dsh-agent-window-root] {
  position: fixed;
  inset: 0;
  z-index: 10000;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  --dsh-agent-dock-inset: 16px;
  /* The dock sits on DSH's bottom status line, below the composer, so it
     never covers the composer's send button. */
  --dsh-agent-dock-bottom: 6px;
  --dsh-agent-dock-height: 30px;
  --dsh-agent-dock-gap: 8px;
  /* One look for dock, list and windows, taken from the dock: a frosted
     surface, a crisp hairline, small bordered chips, and the dock's "open"
     treatment (darker edge plus a soft ring) for anything focused or active. */
  --dsh-agent-surface: color-mix(in srgb, var(--dsw-specific-menu, var(--dsw-alias-bg-overlay)) 94%, transparent);
  --dsh-agent-solid: var(--dsw-specific-menu, var(--dsw-alias-bg-overlay));
  --dsh-agent-line: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  --dsh-agent-hairline: var(--dsw-alias-border-l1);
  --dsh-agent-inset: var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-layer-1));
  --dsh-agent-hover: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  --dsh-agent-active-edge: color-mix(in srgb, var(--dsw-alias-brand-primary) 38%, var(--dsw-alias-border-l2));
  --dsh-agent-ring: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);
  --dsh-agent-danger: var(--dsw-alias-state-error-primary);
  --dsh-agent-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
[data-dsh-agent-window-root] * { box-sizing: border-box; }
[data-dsh-agent-window-dock], [data-dsh-agent-window-popover], [data-dsh-agent-window-window] { pointer-events: auto; }
[data-dsh-agent-window-dock] { z-index: 20001; }
[data-dsh-agent-window-popover] { z-index: 20000; }
[data-dsh-agent-window-messages], [data-dsh-agent-window-list], [data-dsh-agent-window-tool-output], [data-dsh-agent-window-md-code], [data-dsh-agent-window-md-table-wrap], [data-dsh-agent-window-input] {
  scrollbar-width: thin;
  scrollbar-color: var(--dsh-scrollbar-thumb, rgba(127, 127, 127, .35)) transparent;
}

/* ---- Dock ---- */
[data-dsh-agent-window-dock] {
  position: absolute;
  right: var(--dsh-agent-dock-inset);
  bottom: var(--dsh-agent-dock-bottom);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 96px;
  max-width: min(320px, calc(100vw - 32px));
  height: var(--dsh-agent-dock-height);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l2) 78%, transparent);
  border-radius: 9px;
  background: var(--dsh-agent-surface);
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-shadow-lv3), 0 1px 0 color-mix(in srgb, currentColor 12%, transparent) inset;
  backdrop-filter: blur(14px) saturate(1.15);
  cursor: pointer;
  padding: 0 9px 0 11px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
  transition: transform .16s ease, background-color .16s ease, border-color .16s ease, box-shadow .16s ease;
}
[data-dsh-agent-window-dock]:hover {
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 88%, transparent);
}
[data-dsh-agent-window-dock][aria-expanded="true"] {
  transform: translateY(-2px);
  border-color: var(--dsh-agent-active-edge);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 88%, transparent);
  box-shadow: var(--dsw-shadow-lv3), var(--dsh-agent-ring);
}
[data-dsh-agent-window-dock]:active { transform: translateY(0); }
[data-dsh-agent-window-dock-label] {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-agent-window-dock-status], [data-dsh-agent-window-status-dot] {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);
}
[data-dsh-agent-window-dock-status][data-active="false"] {
  background: var(--dsw-alias-label-secondary);
  box-shadow: none;
  opacity: .62;
}
[data-dsh-agent-window-status-dot][data-status="closing"], [data-dsh-agent-window-status-dot][data-status="opening"] {
  background: var(--dsw-alias-state-warn-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent);
}
[data-dsh-agent-window-status-dot][data-status="exited"], [data-dsh-agent-window-status-dot][data-status="failed"] {
  background: var(--dsh-agent-danger);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsh-agent-danger) 14%, transparent);
}
[data-dsh-agent-window-status-dot][data-evaluation="true"] {
  background: var(--dsw-alias-state-business-primary, #4176e6);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 14%, transparent);
}
[data-dsh-agent-window-dock-arrow] {
  width: 7px;
  height: 7px;
  flex: none;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg) translate(-1px, -1px);
  transition: transform .16s ease;
}
[data-dsh-agent-window-dock-arrow][data-open="true"] { transform: rotate(225deg) translate(-1px, -1px); }
[data-dsh-agent-window-dock]:focus-visible, [data-dsh-agent-window-row]:focus-visible, [data-dsh-agent-window-icon-button]:focus-visible, [data-dsh-agent-window-terminate]:focus-visible, [data-dsh-agent-window-send]:focus-visible, [data-dsh-agent-window-resize-handle]:focus-visible, [data-dsh-agent-window-tool] > summary:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}

/* ---- Chips: the dock's count badge, reused for every small label ---- */
[data-dsh-agent-window-count], [data-dsh-agent-window-chip] {
  /* inline-block, not flex: text-overflow only applies to a block's own text. */
  display: inline-block;
  flex: none;
  text-align: center;
  min-width: 20px;
  height: 20px;
  max-width: 100%;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px;
  background: var(--dsh-agent-inset);
  color: var(--dsw-alias-label-secondary);
  padding: 0 6px;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
[data-dsh-agent-window-chip] { height: 18px; border-radius: 6px; font-size: 10.5px; font-weight: 500; line-height: 16px; }
[data-dsh-agent-window-count] {
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent);
  color: var(--dsw-alias-brand-primary);
  padding: 0 5px;
}
[data-dsh-agent-window-count][data-count="0"] {
  border-color: var(--dsw-alias-border-l2);
  background: var(--dsh-agent-inset);
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-agent-window-chip][data-tone="warn"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);
  color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary));
}
[data-dsh-agent-window-chip][data-tone="info"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 32%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 9%, transparent);
  color: var(--dsw-alias-state-business-primary, #4176e6);
}

/* ---- List popover ---- */
[data-dsh-agent-window-popover] {
  position: absolute;
  display: flex;
  flex-direction: column;
  right: var(--dsh-agent-dock-inset);
  bottom: calc(var(--dsh-agent-dock-bottom) + var(--dsh-agent-dock-height) + var(--dsh-agent-dock-gap));
  width: min(340px, calc(100vw - 16px));
  max-height: min(440px, calc(100vh - 72px));
  overflow: hidden;
  border: 1px solid var(--dsh-agent-line);
  border-radius: 12px;
  background: var(--dsh-agent-surface);
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-shadow-lv3), 0 1px 0 color-mix(in srgb, currentColor 12%, transparent) inset;
  backdrop-filter: blur(14px) saturate(1.15);
  transform-origin: bottom right;
  animation: dsh-agent-popover-in .16s ease both;
}
@keyframes dsh-agent-popover-in {
  from { opacity: 0; transform: translateY(5px) scale(.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
[data-dsh-agent-window-popover] [data-dsh-agent-window-header] {
  min-height: 44px;
  padding: 12px 12px 6px 14px;
  border-bottom: 0;
}
[data-dsh-agent-window-list] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  overflow: auto;
  padding: 6px 10px 10px;
}
[data-dsh-agent-window-row] {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 40px;
  flex: none;
  border: 1px solid var(--dsh-agent-line);
  border-radius: 9px;
  background: var(--dsh-agent-solid);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  padding: 0 10px 0 12px;
  text-align: left;
  font: inherit;
  transition: background-color .14s ease, border-color .14s ease, box-shadow .14s ease;
}
[data-dsh-agent-window-row]:hover {
  border-color: var(--dsh-agent-active-edge);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 88%, transparent);
  box-shadow: var(--dsh-agent-ring);
}
[data-dsh-agent-window-row-label] {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  font-size: 12.5px;
  line-height: 18px;
}
[data-dsh-agent-window-name-role] {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 600;
}
/* Badges give way before the role name does. */
[data-dsh-agent-window-row] > [data-dsh-agent-window-chip] { flex: 0 100 auto; min-width: 28px; }
[data-dsh-agent-window-group] {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 6px 2px 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .02em;
}
[data-dsh-agent-window-group]::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--dsw-alias-border-l2);
}
[data-dsh-agent-window-empty] {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 18px 14px 20px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.6;
}
[data-dsh-agent-window-empty-icon] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--dsh-agent-line);
  border-radius: 10px;
  background: var(--dsh-agent-inset);
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
}
[data-dsh-agent-window-popover-hint] {
  padding: 0 14px 10px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  font-size: 11px;
  line-height: 16px;
}
[data-dsh-agent-window-popover-hint][data-error] { color: var(--dsh-agent-danger); overflow-wrap: anywhere; }

/* ---- Agent window ---- */
[data-dsh-agent-window-stack] {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
[data-dsh-agent-window-window] {
  position: absolute;
  display: flex;
  min-width: min(220px, calc(100vw - 32px));
  min-height: min(120px, calc(100vh - 32px));
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--dsh-agent-line);
  border-radius: 12px;
  background: var(--dsh-agent-solid);
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-shadow-lv3);
}
[data-dsh-agent-window-header] {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 46px;
  padding: 8px 8px 8px 14px;
  border-bottom: 1px solid var(--dsh-agent-hairline);
}
[data-dsh-agent-window-title] {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
}
[data-dsh-agent-window-title-text] { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
[data-dsh-agent-window-drag-handle] {
  cursor: move;
  user-select: none;
  touch-action: none;
}
[data-dsh-agent-window-resize-handle] {
  position: absolute;
  z-index: 2;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  padding: 0;
  touch-action: none;
}
[data-dsh-agent-window-resize-handle][data-direction="n"], [data-dsh-agent-window-resize-handle][data-direction="s"] {
  right: 10px;
  left: 10px;
  height: 10px;
  cursor: ns-resize;
}
[data-dsh-agent-window-resize-handle][data-direction="n"] { top: -4px; }
[data-dsh-agent-window-resize-handle][data-direction="s"] { bottom: -4px; }
[data-dsh-agent-window-resize-handle][data-direction="e"], [data-dsh-agent-window-resize-handle][data-direction="w"] {
  top: 10px;
  bottom: 10px;
  width: 10px;
  cursor: ew-resize;
}
[data-dsh-agent-window-resize-handle][data-direction="e"] { right: -4px; }
[data-dsh-agent-window-resize-handle][data-direction="w"] { left: -4px; }
[data-dsh-agent-window-resize-handle][data-direction="ne"], [data-dsh-agent-window-resize-handle][data-direction="nw"], [data-dsh-agent-window-resize-handle][data-direction="se"], [data-dsh-agent-window-resize-handle][data-direction="sw"] {
  width: 14px;
  height: 14px;
}
[data-dsh-agent-window-resize-handle][data-direction="ne"] { top: -4px; right: -4px; cursor: nesw-resize; }
[data-dsh-agent-window-resize-handle][data-direction="nw"] { top: -4px; left: -4px; cursor: nwse-resize; }
[data-dsh-agent-window-resize-handle][data-direction="se"] { right: -4px; bottom: -4px; cursor: nwse-resize; }
[data-dsh-agent-window-resize-handle][data-direction="sw"] { bottom: -4px; left: -4px; cursor: nesw-resize; }
[data-dsh-agent-window-resize-handle]:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); }
[data-dsh-agent-window-icon-button] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: none;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  padding: 0;
  transition: background-color .12s ease, color .12s ease, border-color .12s ease;
}
[data-dsh-agent-window-icon-button]:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsh-agent-hover); color: var(--dsw-alias-label-primary); }
[data-dsh-agent-window-icon-button]:disabled { cursor: default; opacity: .45; }
[data-dsh-agent-window-terminate] {
  display: inline-flex;
  align-items: center;
  height: 28px;
  flex: none;
  border: 1px solid color-mix(in srgb, var(--dsh-agent-danger) 32%, transparent);
  border-radius: 7px;
  background: transparent;
  color: var(--dsh-agent-danger);
  cursor: pointer;
  padding: 0 10px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  transition: background-color .12s ease, border-color .12s ease;
}
[data-dsh-agent-window-terminate]:hover { border-color: color-mix(in srgb, var(--dsh-agent-danger) 60%, transparent); background: color-mix(in srgb, var(--dsh-agent-danger) 8%, transparent); }
[data-dsh-agent-window-terminate]:disabled { cursor: default; opacity: .4; background: transparent; }

/* Conversation */
[data-dsh-agent-window-messages] {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: auto;
  padding: 14px 16px 10px;
}
/* A column that scrolls must not squeeze its entries to fit. */
[data-dsh-agent-window-messages] > * { flex-shrink: 0; }
[data-dsh-agent-window-messages] > [data-dsh-agent-window-empty] { margin: auto 0; }
[data-dsh-agent-window-message] {
  max-width: 100%;
  font-size: 13px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
[data-dsh-agent-window-message][data-role="user"] {
  align-self: flex-end;
  max-width: 85%;
  border-radius: 14px 14px 4px 14px;
  background: var(--dsw-specific-bubble, var(--dsh-agent-inset));
  color: var(--dsw-alias-label-primary);
  padding: 7px 12px;
  white-space: pre-wrap;
}
[data-dsh-agent-window-message][data-role="assistant"] { align-self: stretch; color: var(--dsw-alias-label-primary); }
[data-dsh-agent-window-message][data-role="system"] {
  align-self: stretch;
  border: 1px solid color-mix(in srgb, var(--dsh-agent-danger) 28%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsh-agent-danger) 6%, transparent);
  color: var(--dsh-agent-danger);
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
}
[data-dsh-agent-window-message] > :first-child { margin-top: 0; }
[data-dsh-agent-window-message] > :last-child { margin-bottom: 0; }
[data-dsh-agent-window-message] p { margin: 0 0 8px; }
[data-dsh-agent-window-message] h1, [data-dsh-agent-window-message] h2, [data-dsh-agent-window-message] h3 { margin: 14px 0 6px; font-weight: 600; line-height: 1.4; }
[data-dsh-agent-window-message] h1 { font-size: 15px; }
[data-dsh-agent-window-message] h2 { font-size: 14px; }
[data-dsh-agent-window-message] h3 { font-size: 13px; }
[data-dsh-agent-window-message] strong { font-weight: 600; }
[data-dsh-agent-window-message] hr { margin: 12px 0; border: 0; border-top: 1px solid var(--dsw-alias-border-l2); }
[data-dsh-agent-window-md-list] { margin: 0 0 8px; padding: 0; list-style: none; }
[data-dsh-agent-window-md-list] > li { display: flex; gap: 6px; }
[data-dsh-agent-window-md-list] > li + li { margin-top: 2px; }
[data-dsh-agent-window-md-marker] { flex: none; min-width: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
[data-dsh-agent-window-md-quote] {
  margin: 0 0 8px;
  border-left: 3px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  padding: 1px 0 1px 10px;
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-agent-window-md-inline-code] {
  border-radius: 4px;
  background: var(--dsw-alias-markdown-inline-code, var(--dsh-agent-inset));
  padding: 1px 4px;
  font-family: var(--dsh-agent-mono);
  font-size: .9em;
}
[data-dsh-agent-window-md-code] {
  margin: 0 0 8px;
  overflow: auto;
  border: 1px solid var(--dsh-agent-hairline);
  border-radius: 8px;
  background: var(--dsh-agent-inset);
  padding: 8px 10px;
  font-family: var(--dsh-agent-mono);
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre;
}
[data-dsh-agent-window-md-table-wrap] { margin: 0 0 8px; overflow: auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; }
[data-dsh-agent-window-md-table-wrap] table { width: 100%; border-collapse: collapse; font-size: 12px; line-height: 1.5; }
[data-dsh-agent-window-md-table-wrap] th, [data-dsh-agent-window-md-table-wrap] td { border-bottom: 1px solid var(--dsh-agent-hairline); padding: 5px 9px; text-align: left; vertical-align: top; }
[data-dsh-agent-window-md-table-wrap] th { background: var(--dsh-agent-inset); font-weight: 600; white-space: nowrap; }
[data-dsh-agent-window-md-table-wrap] tr:last-child td { border-bottom: 0; }

/* Tool calls */
[data-dsh-agent-window-tool] {
  align-self: stretch;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 9px;
  background: var(--dsh-agent-inset);
  font-size: 12px;
}
[data-dsh-agent-window-tool] > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 10px;
  cursor: pointer;
  list-style: none;
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-agent-window-tool] > summary::-webkit-details-marker { display: none; }
[data-dsh-agent-window-tool] > summary:hover { background: var(--dsh-agent-hover); }
[data-dsh-agent-window-tool-name] { flex: none; color: var(--dsw-alias-label-primary); font-weight: 600; }
[data-dsh-agent-window-tool-summary] {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dsh-agent-mono);
  font-size: 11px;
}
[data-dsh-agent-window-tool-status] { flex: none; margin-left: auto; font-size: 11px; }
[data-dsh-agent-window-tool][data-status="ok"] [data-dsh-agent-window-tool-status] { color: var(--dsw-alias-state-success-primary); }
[data-dsh-agent-window-tool][data-status="error"] [data-dsh-agent-window-tool-status] { color: var(--dsh-agent-danger); }
[data-dsh-agent-window-tool][data-status="running"] [data-dsh-agent-window-tool-status] { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary)); }
[data-dsh-agent-window-tool-chevron] {
  width: 6px;
  height: 6px;
  flex: none;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  opacity: .7;
  transform: rotate(-45deg);
  transition: transform .14s ease;
}
[data-dsh-agent-window-tool][open] [data-dsh-agent-window-tool-chevron] { transform: rotate(45deg); }
[data-dsh-agent-window-tool-output] {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  border-top: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsh-agent-solid);
  padding: 8px 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--dsh-agent-mono);
  font-size: 11px;
  line-height: 1.55;
}

/* What the agent is doing, between the conversation and the composer */
[data-dsh-agent-window-typing] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 16px 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
}
[data-dsh-agent-window-typing-dots] { display: inline-flex; gap: 3px; }
[data-dsh-agent-window-typing-dots] span { width: 5px; height: 5px; border-radius: 50%; background: currentColor; animation: dsh-agent-typing-blink 1.2s infinite ease-in-out; }
[data-dsh-agent-window-typing-dots] span:nth-child(2) { animation-delay: .2s; }
[data-dsh-agent-window-typing-dots] span:nth-child(3) { animation-delay: .4s; }
@keyframes dsh-agent-typing-blink { 0%, 60%, 100% { opacity: .25; } 30% { opacity: 1; } }
[data-dsh-agent-window-error] {
  max-height: 84px;
  overflow: auto;
  margin: 0 12px 6px;
  border: 1px solid color-mix(in srgb, var(--dsh-agent-danger) 28%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsh-agent-danger) 6%, transparent);
  color: var(--dsh-agent-danger);
  padding: 6px 10px;
  font-size: 11.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

/* Composer: one box like the dock, which takes the dock's open look on focus */
[data-dsh-agent-window-composer] { padding: 2px 12px 12px; }
[data-dsh-agent-window-composer-box] {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dsh-agent-line);
  border-radius: 12px;
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-base));
  transition: border-color .16s ease, box-shadow .16s ease;
}
[data-dsh-agent-window-composer-box]:focus-within { border-color: var(--dsh-agent-active-edge); box-shadow: var(--dsh-agent-ring); }
[data-dsh-agent-window-input] {
  width: 100%;
  min-height: 42px;
  max-height: 140px;
  resize: none;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  padding: 9px 12px 2px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
}
[data-dsh-agent-window-input]:focus { outline: none; }
[data-dsh-agent-window-input]::placeholder { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
[data-dsh-agent-window-input]:disabled { cursor: default; }
[data-dsh-agent-window-composer-bar] {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0 6px 6px 12px;
}
[data-dsh-agent-window-status] {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  font-size: 11px;
}
[data-dsh-agent-window-shortcut] {
  flex: none;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  font-size: 11px;
}
[data-dsh-agent-window-send] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: none;
  border: 0;
  border-radius: 50%;
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
  color: var(--dsw-alias-label-primary-inverted, #fff);
  cursor: pointer;
  padding: 0;
  transition: background-color .12s ease, transform .12s ease;
}
[data-dsh-agent-window-send]:hover { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); }
[data-dsh-agent-window-send]:active { transform: scale(.94); }
[data-dsh-agent-window-send]:disabled { cursor: default; transform: none; background: var(--dsw-alias-button-primary-dimmed, var(--dsh-agent-inset)); color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
[data-dsh-agent-window-send][data-busy="true"] svg { animation: dsh-agent-spin .9s linear infinite; }
@keyframes dsh-agent-spin { to { transform: rotate(360deg); } }

@media (max-width: 720px) {
  [data-dsh-agent-window-root] { --dsh-agent-dock-inset: 12px; }
  [data-dsh-agent-window-window] {
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 16px);
  }
  [data-dsh-agent-window-popover] { width: calc(100vw - 24px); max-width: none; }
  [data-dsh-agent-window-dock] { right: var(--dsh-agent-dock-inset); bottom: var(--dsh-agent-dock-bottom); }
}
@media (prefers-reduced-motion: reduce) {
  [data-dsh-agent-window-root] *, [data-dsh-agent-window-root] *::before, [data-dsh-agent-window-root] *::after { transition: none !important; animation: none !important; }
}
`

type IconName = 'close' | 'send' | 'spinner' | 'agents'

/** Stroke icons drawn in `currentColor`, so they follow DSH's light and dark themes. */
function icon(name: IconName, size = 14): ReactElement {
  const paths: Record<IconName, ReactElement[]> = {
    close: [React.createElement('path', { key: 'p', d: 'M4 4l8 8M12 4l-8 8' })],
    send: [React.createElement('path', { key: 'p', d: 'M8 13V3.5M3.75 7.75L8 3.5l4.25 4.25' })],
    spinner: [React.createElement('path', { key: 'p', d: 'M8 2.5a5.5 5.5 0 1 1-5.5 5.5' })],
    agents: [
      React.createElement('rect', { key: 'a', x: 2.5, y: 3, width: 11, height: 8.5, rx: 2.5 }),
      React.createElement('path', { key: 'b', d: 'M6 7h.01M10 7h.01M6 13.5h4' }),
    ],
  }
  return React.createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: name === 'agents' ? 1.4 : 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: 'false',
  }, ...paths[name])
}

/** A small bordered label in the style of the dock's count badge. */
function chip(text: string, props: Record<string, unknown> = {}): ReactElement {
  return React.createElement('span', { 'data-dsh-agent-window-chip': true, ...props }, text)
}

function renderInline(nodes: readonly InlineNode[]): (ReactElement | string)[] {
  return nodes.map((node, index) => {
    if (node.type === 'text') return node.text
    if (node.type === 'code') return React.createElement('code', { key: index, 'data-dsh-agent-window-md-inline-code': true }, node.text)
    return React.createElement('strong', { key: index }, ...renderInline(node.children))
  })
}

/** Source lines joined with explicit breaks: chat replies mean their newlines. */
function renderLines(lines: readonly InlineNode[][]): (ReactElement | string)[] {
  return lines.flatMap((line, index) => index === 0
    ? renderInline(line)
    : [React.createElement('br', { key: `br${index}` }), ...renderInline(line)])
}

function renderMarkdown(text: string): ReactElement[] {
  return parseMarkdown(text).map((block, index) => {
    switch (block.type) {
      case 'paragraph':
        return React.createElement('p', { key: index }, ...renderLines(block.lines))
      case 'heading':
        return React.createElement(`h${block.level}`, { key: index }, ...renderInline(block.children))
      case 'code':
        return React.createElement('pre', { key: index, 'data-dsh-agent-window-md-code': true, 'data-lang': block.lang || undefined }, block.text)
      case 'quote':
        return React.createElement('blockquote', { key: index, 'data-dsh-agent-window-md-quote': true }, ...renderLines(block.lines))
      case 'rule':
        return React.createElement('hr', { key: index })
      case 'list':
        return React.createElement(block.ordered ? 'ol' : 'ul', { key: index, 'data-dsh-agent-window-md-list': true },
          ...block.items.map((item, itemIndex) => React.createElement('li', { key: itemIndex, style: item.depth === 0 ? undefined : { paddingLeft: item.depth * 16 } },
            React.createElement('span', { 'data-dsh-agent-window-md-marker': true, 'aria-hidden': true }, item.marker),
            React.createElement('span', null, ...renderInline(item.children)))))
      case 'table':
        return React.createElement('div', { key: index, 'data-dsh-agent-window-md-table-wrap': true },
          React.createElement('table', null,
            React.createElement('thead', null, React.createElement('tr', null,
              ...block.header.map((cell, cellIndex) => React.createElement('th', { key: cellIndex }, ...renderInline(cell))))),
            React.createElement('tbody', null,
              ...block.rows.map((row, rowIndex) => React.createElement('tr', { key: rowIndex },
                ...row.map((cell, cellIndex) => React.createElement('td', { key: cellIndex }, ...renderInline(cell))))))))
    }
  })
}

/** One conversation entry: a message bubble, a collapsible tool call, or an error line. */
function renderEntry(entry: ConversationEntry): ReactElement {
  if (entry.type === 'message') {
    // What the user typed is shown as typed; the agent's reply is Markdown.
    return entry.role === 'user'
      ? React.createElement('div', { key: entry.key, 'data-dsh-agent-window-message': true, 'data-role': 'user' }, entry.text)
      : React.createElement('div', { key: entry.key, 'data-dsh-agent-window-message': true, 'data-role': 'assistant' }, ...renderMarkdown(entry.text))
  }
  if (entry.type === 'error') {
    return React.createElement('div', { key: entry.key, 'data-dsh-agent-window-message': true, 'data-role': 'system', 'data-error': true }, entry.text)
  }
  return React.createElement('details', { key: entry.key, 'data-dsh-agent-window-tool': true, 'data-status': entry.status },
    React.createElement('summary', null,
      React.createElement('span', { 'data-dsh-agent-window-tool-name': true }, entry.name),
      entry.summary === '' ? null : React.createElement('span', { 'data-dsh-agent-window-tool-summary': true, title: entry.summary }, entry.summary),
      React.createElement('span', { 'data-dsh-agent-window-tool-status': true }, entry.status === 'running' ? '运行中' : entry.status === 'error' ? '失败' : '完成'),
      entry.output === undefined ? null : React.createElement('span', { 'data-dsh-agent-window-tool-chevron': true, 'aria-hidden': true })),
    entry.output === undefined ? null : React.createElement('pre', { 'data-dsh-agent-window-tool-output': true }, entry.output))
}

/** Status line for what the agent is doing out of sight. */
function activityText(activity: AgentActivity): string {
  if (activity.kind === 'thinking') return activity.tokens === undefined ? '正在思考…' : `正在思考…（约 ${activity.tokens} tokens）`
  if (activity.kind === 'retrying') return `模型请求失败，正在重试${activity.message === '' ? '' : `：${activity.message}`}`
  return '正在处理…'
}

type ComposerKeyEvent = {
  key: string
  shiftKey?: boolean
  keyCode?: number
  nativeEvent?: { isComposing?: boolean }
  preventDefault(): void
}

/**
 * Enter sends, Shift+Enter starts a new line. The Enter that confirms an input
 * method's candidate (Chinese, Japanese, …) does neither: the browser flags it
 * as composing, or reports keyCode 229 where `isComposing` is missing.
 */
function isSendKey(event: ComposerKeyEvent): boolean {
  return event.key === 'Enter' && event.shiftKey !== true && event.nativeEvent?.isComposing !== true && event.keyCode !== 229
}

/** `localStorage`, when the page may use it (it throws in some privacy modes). */
function browserStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false
  for (const value of left) if (!right.has(value)) return false
  return true
}

function sameGeometry(left: WindowGeometry | undefined, right: WindowGeometry): boolean {
  return left !== undefined
    && left.left === right.left
    && left.top === right.top
    && left.width === right.width
    && left.height === right.height
}

type PointerLikeEvent = {
  button?: number
  clientX: number
  clientY: number
  preventDefault(): void
  stopPropagation(): void
}

type KeyboardLikeEvent = {
  key: string
  shiftKey?: boolean
  preventDefault(): void
}

const RESIZE_HANDLES: readonly { direction: ResizeDirection; label: string }[] = [
  { direction: 'n', label: 'top edge' },
  { direction: 'ne', label: 'top-right corner' },
  { direction: 'e', label: 'right edge' },
  { direction: 'se', label: 'bottom-right corner' },
  { direction: 's', label: 'bottom edge' },
  { direction: 'sw', label: 'bottom-left corner' },
  { direction: 'w', label: 'left edge' },
  { direction: 'nw', label: 'top-left corner' },
]

interface AgentWindowProps {
  agent: AgentView
  /** Plain-text name for tooltips and accessible labels. */
  label: string
  /** Role / harness halves rendered in the title bar. */
  labelParts: AgentLabelParts
  geometry: WindowGeometry
  zIndex: number
  initialDraft?: string
  onGeometryChange(agentId: string, geometry: WindowGeometry): void
  onFocus(agentId: string): void
  onDraftChange(agentId: string, draft: string): void
  onSendStart(agentId: string): number
  onSendSuccess(agentId: string, requestEpoch: number): boolean
  onSendFailure(agentId: string, text: string, requestEpoch: number): boolean
  onMinimize(agentId: string): void
  onCloseSuccess(agentId: string): void
  refreshState(): Promise<void>
}

function AgentWindow({ agent, label, labelParts, geometry, zIndex, initialDraft, onGeometryChange, onFocus, onDraftChange, onSendStart, onSendSuccess, onSendFailure, onMinimize, onCloseSuccess, refreshState }: AgentWindowProps): ReactElement {
  const [conversation, setConversation] = React.useState<ConversationState>(EMPTY_CONVERSATION)
  const conversationRef = React.useRef<ConversationState>(EMPTY_CONVERSATION)
  const [draft, setDraft] = React.useState(initialDraft ?? '')
  const [sendBusy, setSendBusy] = React.useState(false)
  const [closeBusy, setCloseBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // Another process may own this agent's channel; chat/terminate are
  // forwarded to it over its control socket and behave the same
  // as a local agent from here. `agent.external` is purely informational —
  // it labels the window, it does not disable anything. A forward that
  // fails (owner unreachable) surfaces through the normal `error` state.
  // An evaluation arm (one side of a running role comparison) is observe-only:
  // a message typed into it would change what is being measured. The server
  // refuses chat/close for it anyway; the window just says so up front.
  const observeOnly = agent.evaluation !== undefined
  const closedRef = React.useRef(false)
  const closeInFlightRef = React.useRef(false)
  const sendBusyRef = React.useRef(false)
  const mountedRef = React.useRef(true)
  const messagesRef = React.useRef<HTMLElement | null>(null)
  // Follow new messages only while the reader is already at the bottom; a
  // reader who scrolled up to look at history must not be yanked back down.
  const stickToBottomRef = React.useRef(true)
  const interactionCleanupRef = React.useRef<(() => void) | null>(null)

  const applyPage = React.useCallback((page: ConversationPage): void => {
    const next = mergeConversationPage(conversationRef.current, page)
    if (next === conversationRef.current) return
    conversationRef.current = next
    setConversation(next)
  }, [])

  const onMessagesScroll = React.useCallback((): void => {
    const node = messagesRef.current
    if (node === null) return
    stickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
  }, [])

  const clearInteraction = React.useCallback((): void => {
    interactionCleanupRef.current?.()
    interactionCleanupRef.current = null
  }, [])

  React.useEffect(() => clearInteraction, [clearInteraction])

  const beginDrag = React.useCallback((event: PointerLikeEvent): void => {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    clearInteraction()
    onFocus(agent.agentId)
    const startX = event.clientX
    const startY = event.clientY
    const startGeometry = geometry
    const move = (moveEvent: PointerEvent): void => {
      moveEvent.preventDefault()
      onGeometryChange(agent.agentId, {
        ...startGeometry,
        left: startGeometry.left + moveEvent.clientX - startX,
        top: startGeometry.top + moveEvent.clientY - startY,
      })
    }
    const finish = (): void => clearInteraction()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    interactionCleanupRef.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [agent.agentId, clearInteraction, geometry, onFocus, onGeometryChange])

  const beginResize = React.useCallback((direction: ResizeDirection, event: PointerLikeEvent): void => {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    clearInteraction()
    onFocus(agent.agentId)
    const startX = event.clientX
    const startY = event.clientY
    const startGeometry = geometry
    const move = (moveEvent: PointerEvent): void => {
      moveEvent.preventDefault()
      onGeometryChange(agent.agentId, resizeWindowGeometry(
        startGeometry,
        direction,
        moveEvent.clientX - startX,
        moveEvent.clientY - startY,
        window.innerWidth,
        window.innerHeight,
      ))
    }
    const finish = (): void => clearInteraction()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    interactionCleanupRef.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [agent.agentId, clearInteraction, geometry, onFocus, onGeometryChange])

  const resizeByKeyboard = React.useCallback((direction: ResizeDirection, event: KeyboardLikeEvent): void => {
    const step = event.shiftKey ? 48 : 16
    let deltaX = 0
    let deltaY = 0
    if (event.key === 'ArrowLeft') deltaX = -step
    else if (event.key === 'ArrowRight') deltaX = step
    else if (event.key === 'ArrowUp') deltaY = -step
    else if (event.key === 'ArrowDown') deltaY = step
    else return
    event.preventDefault()
    onFocus(agent.agentId)
    onGeometryChange(agent.agentId, resizeWindowGeometry(
      geometry,
      direction,
      deltaX,
      deltaY,
      window.innerWidth,
      window.innerHeight,
    ))
  }, [agent.agentId, geometry, onFocus, onGeometryChange])

  React.useEffect(() => {
    if (!sendBusyRef.current && mountedRef.current) setDraft(initialDraft ?? '')
  }, [initialDraft])

  /**
   * Read everything after the cursor, following `nextCursor` until caught up
   * (  incremental, instead of re-reading the first 100 events).
   */
  const refreshConversation = React.useCallback(async (isCancelled: () => boolean = () => false): Promise<void> => {
    try {
      for (let pages = 0; pages < 20; pages += 1) {
        const after = conversationRef.current.cursor
        const query = `agentId=${encodeURIComponent(agent.agentId)}${after === null ? '' : `&after=${encodeURIComponent(after)}`}`
        const response = await fetch(`${API}/conversation?${query}`, { cache: 'no-store' })
        if (!response.ok) throw new Error(`conversation request failed (${response.status})`)
        const page = await response.json() as ConversationPage
        if (isCancelled() || closedRef.current || !mountedRef.current) return
        applyPage(page)
        if (page.nextCursor === null) break
      }
      setError(null)
    } catch (cause) {
      if (!isCancelled() && !closedRef.current && mountedRef.current) setError(errorMessage(cause))
    }
  }, [agent.agentId, applyPage])

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Poll fast while the agent is working (a turn in flight, or it reports
  // thinking), slowly otherwise. Each poll only transfers what is new.
  const busyRef = React.useRef(false)
  const activity: AgentActivity = currentActivity(conversation.items, Date.now())
  busyRef.current = sendBusy || activity.kind !== 'idle'
  React.useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const tick = async (): Promise<void> => {
      await refreshConversation(() => cancelled)
      if (!cancelled) timer = window.setTimeout(() => void tick(), busyRef.current ? POLL_MS : IDLE_POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [refreshConversation])

  const entries = React.useMemo(() => toConversationEntries(conversation.items), [conversation.items])

  React.useEffect(() => {
    const node = messagesRef.current
    if (node !== null && stickToBottomRef.current) node.scrollTop = node.scrollHeight
  }, [entries, sendBusy])

  const send = async (): Promise<void> => {
    if (closedRef.current || closeInFlightRef.current || agent.status !== 'open' || draft.trim() === '' || sendBusyRef.current || closeBusy) return
    const text = draft.trim()
    const requestEpoch = onSendStart(agent.agentId)
    setDraft('')
    stickToBottomRef.current = true
    sendBusyRef.current = true
    setSendBusy(true)
    setError(null)
    try {
      const response = await fetch(`${API}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: agent.agentId, text }),
      })
      if (!response.ok) throw new Error(await response.text())
      if (closedRef.current || !onSendSuccess(agent.agentId, requestEpoch)) return
      await refreshConversation()
      if (closedRef.current || !mountedRef.current) return
      await refreshState()
    } catch (cause) {
      if (closedRef.current) return
      const restored = onSendFailure(agent.agentId, text, requestEpoch)
      if (restored && mountedRef.current) {
        setError(errorMessage(cause))
        setDraft(text)
      }
    } finally {
      sendBusyRef.current = false
      if (closedRef.current || !mountedRef.current) return
      setSendBusy(false)
    }
  }

  const close = async (): Promise<void> => {
    // Closing is intentionally independent from sendBusy: users can terminate
    // a process while a chat request is still waiting for its reply.
    if (closedRef.current || closeInFlightRef.current || agent.status === 'closing' || closeBusy) return
    closeInFlightRef.current = true
    setCloseBusy(true)
    setError(null)
    try {
      const response = await fetch(`${API}/close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: agent.agentId }),
      })
      if (!response.ok) throw new Error(await response.text())
      // Flip the guard before notifying the parent so any in-flight chat
      // cannot restore a draft after this process has been terminated.
      closedRef.current = true
      sendBusyRef.current = false
      onCloseSuccess(agent.agentId)
      await refreshState()
    } catch (cause) {
      if (!closedRef.current && mountedRef.current) setError(errorMessage(cause))
    } finally {
      closeInFlightRef.current = false
      if (!closedRef.current && mountedRef.current) setCloseBusy(false)
    }
  }

  return React.createElement(
    'section',
    {
      'data-dsh-agent-window-window': true,
      'aria-label': label,
      style: {
        left: geometry.left,
        top: geometry.top,
        width: geometry.width,
        height: geometry.height,
        zIndex,
      },
      onPointerDown: () => onFocus(agent.agentId),
    },
    React.createElement(
      'header',
      {
        'data-dsh-agent-window-header': true,
        'data-dsh-agent-window-drag-handle': true,
        'aria-label': `Move ${label} window`,
        title: '拖动标题栏移动窗口',
        onPointerDown: beginDrag,
      },
      React.createElement('span', {
        'data-dsh-agent-window-status-dot': true,
        'data-status': agent.status,
        'data-evaluation': String(observeOnly),
        'aria-hidden': true,
      }),
      React.createElement('div', { 'data-dsh-agent-window-title': true, title: label },
        React.createElement('span', { 'data-dsh-agent-window-title-text': true, 'data-dsh-agent-window-name-role': true }, labelParts.role),
        chip(labelParts.harness, { 'data-dsh-agent-window-name-harness': true }),
        observeOnly ? chip('评估中', { 'data-tone': 'info' }) : agent.external ? chip('外部', { 'data-tone': 'warn', title: `由另一个进程启动（pid ${agent.ownerPid}）` }) : null),
      // "终止" ends the agent process; the × only puts the window back in the
      // list. The destructive control is the one that does not look like a
      // window control, so a reflexive "close the window" click is safe.
      React.createElement('button', {
        type: 'button',
        'data-dsh-agent-window-terminate': true,
        title: observeOnly ? '评估中：只能观察。要停止，请结束运行对比的进程。' : '终止这个 Agent 进程',
        'aria-label': `Terminate ${label} process`,
        disabled: closeBusy || observeOnly,
        onPointerDown: (event: PointerLikeEvent) => event.stopPropagation(),
        onClick: () => void close(),
      }, closeBusy ? '终止中…' : '终止'),
      React.createElement('button', {
        type: 'button',
        'data-dsh-agent-window-icon-button': true,
        'data-dsh-agent-window-minimize': true,
        title: '收起到 Agent 列表（不会终止）',
        'aria-label': `Minimize ${label} to the Agent list`,
        onPointerDown: (event: PointerLikeEvent) => event.stopPropagation(),
        onClick: () => onMinimize(agent.agentId),
      }, icon('close')),
    ),
    React.createElement(
      'div',
      { 'data-dsh-agent-window-messages': true, ref: messagesRef, role: 'log', 'aria-live': 'polite', 'aria-label': `${label} conversation`, onScroll: onMessagesScroll },
      entries.length === 0
        ? React.createElement('div', { 'data-dsh-agent-window-empty': true }, observeOnly ? '等待对比任务的对话…' : '还没有对话，发一条消息开始吧')
        : entries.map(renderEntry),
    ),
    sendBusy || activity.kind !== 'idle'
      ? React.createElement('div', { 'data-dsh-agent-window-typing': true, 'data-activity': activity.kind, role: 'status', 'aria-live': 'polite' },
          React.createElement('span', { 'data-dsh-agent-window-typing-dots': true },
            React.createElement('span', null), React.createElement('span', null), React.createElement('span', null)),
          activityText(activity))
      : null,
    error === null
      ? null
      : React.createElement('div', { 'data-dsh-agent-window-error': true, role: 'alert' }, error),
    React.createElement(
      'div',
      { 'data-dsh-agent-window-composer': true },
      React.createElement(
        'div',
        { 'data-dsh-agent-window-composer-box': true },
        React.createElement('textarea', {
          'data-dsh-agent-window-input': true,
          value: draft,
          rows: 2,
          'aria-label': `Message ${label}`,
          placeholder: observeOnly ? '评估中：只能观察，不能发消息' : `给${labelParts.role}发消息…`,
          disabled: observeOnly || sendBusy || closeBusy || agent.status !== 'open',
          onChange: (event: { target: { value: string } }) => {
            setDraft(event.target.value)
            onDraftChange(agent.agentId, event.target.value)
          },
          onKeyDown: (event: ComposerKeyEvent) => {
            if (isSendKey(event)) {
              event.preventDefault()
              void send()
            }
          },
        }),
        React.createElement(
          'div',
          { 'data-dsh-agent-window-composer-bar': true },
          React.createElement('span', { 'data-dsh-agent-window-status': true, title: agent.agentId },
            observeOnly
              ? `${evaluationLabel(agent) ?? ''} · ${agent.agentId.slice(0, 8)}`
              : agent.external ? `${agent.agentId.slice(0, 8)} · pid ${agent.ownerPid}` : agent.agentId.slice(0, 8)),
          observeOnly ? null : React.createElement('span', { 'data-dsh-agent-window-shortcut': true, 'aria-hidden': true }, '↵ 发送 · ⇧↵ 换行'),
          React.createElement('button', {
            type: 'button',
            'data-dsh-agent-window-send': true,
            'data-busy': String(sendBusy),
            title: sendBusy ? '发送中…' : '发送',
            'aria-label': sendBusy ? 'Sending message' : 'Send message',
            disabled: observeOnly || sendBusy || closeBusy || draft.trim() === '' || agent.status !== 'open',
            onClick: () => void send(),
          }, icon(sendBusy ? 'spinner' : 'send')),
        ),
      ),
    ),
    ...RESIZE_HANDLES.map(({ direction, label: directionLabel }) => React.createElement('button', {
      key: direction,
      type: 'button',
      'data-dsh-agent-window-resize-handle': true,
      'data-direction': direction,
      'aria-label': `Resize ${label} window from ${directionLabel}`,
      title: `Resize from ${directionLabel}`,
      onPointerDown: (event: PointerLikeEvent) => beginResize(direction, event),
      onKeyDown: (event: KeyboardLikeEvent) => resizeByKeyboard(direction, event),
    })),
  )
}

function AgentWindowSurface(props: SurfaceProps): ReactElement {
  // Bind to the project the page is showing: the open session's cwd, else the
  // most recent Workspace.
  const sessionCwd = useStandardSlice(props.useSessions, currentSessionCwd)
  // DSH 0.2 ranks Workspaces by their Sessions' activity, so the fallback reads both.
  const sessions = useStandardSlice(props.useSessions, sessionsById)
  const workspacePath = useStandardSlice(props.useWorkspaces, (state: WorkspaceListLike) => recentWorkspacePath(state, sessions))
  const projectCwd = resolveProjectCwd(sessionCwd, workspacePath)
  const projectName = projectTitle(projectCwd)
  // The dock button is always just "Agent"; the popover it opens is titled
  // after the project it is bound to ("Agents" only while there is none).
  const dockTitle = projectName ?? 'Agents'
  const projectRef = React.useRef<string | undefined>(projectCwd)
  React.useEffect(() => {
    projectRef.current = projectCwd
  }, [projectCwd])

  const [state, setState] = React.useState<StateResponse>({ agents: [], roles: [] })
  const [popoverOpen, setPopoverOpen] = React.useState(false)
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(() => new Set())
  // Unsent drafts and window placement survive a page reload.
  const persisted = React.useMemo(() => loadPersistedWindows(browserStorage()), [])
  const [drafts, setDrafts] = React.useState<Record<string, string>>(persisted.drafts)
  // Keep a successful close out of the list until the next state response
  // confirms the process has transitioned away from an active status.
  const [locallyClosedIds, setLocallyClosedIds] = React.useState<Set<string>>(() => new Set())
  const [stateError, setStateError] = React.useState<string | null>(null)
  const [geometries, setGeometries] = React.useState<Record<string, WindowGeometry>>(persisted.geometries)
  // Saving before the first agent list arrives would prune everything as "gone".
  const [knownAgentIds, setKnownAgentIds] = React.useState<ReadonlySet<string> | null>(null)
  const [windowZIndices, setWindowZIndices] = React.useState<Record<string, number>>({})
  const draftEpochsRef = React.useRef<Record<string, number>>({})
  const closedIdsRef = React.useRef<Set<string>>(new Set())
  const nextZIndexRef = React.useRef(1000)

  const bumpDraftEpoch = React.useCallback((agentId: string): number => {
    const nextEpoch = (draftEpochsRef.current[agentId] ?? 0) + 1
    draftEpochsRef.current = { ...draftEpochsRef.current, [agentId]: nextEpoch }
    return nextEpoch
  }, [])

  const focusWindow = React.useCallback((agentId: string): void => {
    const nextZIndex = nextZIndexRef.current + 1
    nextZIndexRef.current = nextZIndex
    setWindowZIndices((current) => {
      if (current[agentId] === nextZIndex) return current
      return { ...current, [agentId]: nextZIndex }
    })
  }, [])

  const updateGeometry = React.useCallback((agentId: string, nextGeometry: WindowGeometry): void => {
    const bounded = clampWindowGeometry(nextGeometry, window.innerWidth, window.innerHeight)
    setGeometries((current) => {
      if (sameGeometry(current[agentId], bounded)) return current
      return { ...current, [agentId]: bounded }
    })
  }, [])

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const query = projectCwd === undefined ? '' : `?cwd=${encodeURIComponent(projectCwd)}`
      const response = await fetch(`${API}/state${query}`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`state request failed (${response.status})`)
      const next = await response.json() as StateResponse
      // The page may have moved to another project while this request was in
      // flight; its reply describes the old one and must not overwrite the list.
      if (projectRef.current !== projectCwd) return
      setState(next)
      setKnownAgentIds((current) => {
        const ids = new Set(next.agents.map((agent) => agent.agentId))
        return current !== null && sameIds(current, ids) ? current : ids
      })
      setExpandedIds((current) => {
        const reconciled = reconcileExpandedIds(current, next.agents)
        return sameIds(current, reconciled) ? current : reconciled
      })
      setLocallyClosedIds((current) => {
        const activeIds = new Set(activeWindowAgents(next.agents).map((agent) => agent.agentId))
        const reconciled = new Set([...current].filter((agentId) => activeIds.has(agentId)))
        return sameIds(current, reconciled) ? current : reconciled
      })
      setStateError(null)
    } catch (cause) {
      if (projectRef.current !== projectCwd) return
      setStateError(errorMessage(cause))
    }
  }, [projectCwd])

  // `refresh` is rebuilt whenever the bound project changes, so switching
  // projects re-polls immediately instead of waiting out the interval.
  React.useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  React.useEffect(() => {
    if (knownAgentIds === null) return
    savePersistedWindows(browserStorage(), { drafts, geometries }, knownAgentIds)
  }, [drafts, geometries, knownAgentIds])

  React.useEffect(() => {
    const onResize = (): void => {
      setGeometries((current) => {
        let changed = false
        const next: Record<string, WindowGeometry> = {}
        for (const [agentId, geometry] of Object.entries(current)) {
          const bounded = clampWindowGeometry(geometry, window.innerWidth, window.innerHeight)
          next[agentId] = bounded
          if (!sameGeometry(geometry, bounded)) changed = true
        }
        return changed ? next : current
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const activeAgents = activeWindowAgents(state.agents).filter((agent) => !locallyClosedIds.has(agent.agentId))
  const minimizedAgents = minimizedWindowAgents(activeAgents, expandedIds)
  const expandedAgents = activeAgents.filter((agent) => expandedIds.has(agent.agentId))
  const activeAgentCount = activeAgents.length

  const onDraftChange = React.useCallback((agentId: string, draft: string): void => {
    bumpDraftEpoch(agentId)
    setDrafts((current) => {
      if (draft === '') {
        if (!(agentId in current)) return current
        const next = { ...current }
        delete next[agentId]
        return next
      }
      if (current[agentId] === draft) return current
      return { ...current, [agentId]: draft }
    })
  }, [bumpDraftEpoch])

  const onSendStart = React.useCallback((agentId: string): number => {
    const requestEpoch = bumpDraftEpoch(agentId)
    setDrafts((current) => {
      if (!(agentId in current)) return current
      const next = { ...current }
      delete next[agentId]
      return next
    })
    return requestEpoch
  }, [bumpDraftEpoch])

  const onSendSuccess = React.useCallback((agentId: string, requestEpoch: number): boolean => {
    return canRestoreDraft(
      draftEpochsRef.current[agentId] ?? 0,
      requestEpoch,
      closedIdsRef.current.has(agentId),
    )
  }, [])

  const onSendFailure = React.useCallback((agentId: string, text: string, requestEpoch: number): boolean => {
    const canRestore = canRestoreDraft(
      draftEpochsRef.current[agentId] ?? 0,
      requestEpoch,
      closedIdsRef.current.has(agentId),
    )
    if (!canRestore) return false
    setDrafts((current) => ({ ...current, [agentId]: text }))
    return true
  }, [])

  const minimize = React.useCallback((agentId: string): void => {
    setExpandedIds((current) => {
      if (!current.has(agentId)) return current
      const next = new Set(current)
      next.delete(agentId)
      return next
    })
  }, [])

  const expand = React.useCallback((agentId: string): void => {
    setPopoverOpen(false)
    setGeometries((current) => {
      if (current[agentId] !== undefined) return current
      const index = expandedIds.size
      return {
        ...current,
        [agentId]: defaultWindowGeometry(index, index + 1, window.innerWidth, window.innerHeight - DOCK_RESERVED_PX),
      }
    })
    focusWindow(agentId)
    setExpandedIds((current) => {
      if (current.has(agentId)) return current
      const next = new Set(current)
      next.add(agentId)
      return next
    })
  }, [expandedIds.size, focusWindow])

  const closeSuccess = React.useCallback((agentId: string): void => {
    closedIdsRef.current.add(agentId)
    bumpDraftEpoch(agentId)
    setLocallyClosedIds((current) => {
      if (current.has(agentId)) return current
      const next = new Set(current)
      next.add(agentId)
      return next
    })
    setDrafts((current) => {
      if (!(agentId in current)) return current
      const next = { ...current }
      delete next[agentId]
      return next
    })
    setExpandedIds((current) => {
      if (!current.has(agentId)) return current
      const next = new Set(current)
      next.delete(agentId)
      return next
    })
    setGeometries((current) => {
      if (!(agentId in current)) return current
      const next = { ...current }
      delete next[agentId]
      return next
    })
    setWindowZIndices((current) => {
      if (!(agentId in current)) return current
      const next = { ...current }
      delete next[agentId]
      return next
    })
  }, [bumpDraftEpoch])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPopoverOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const dock = React.createElement(
    'button',
    {
      type: 'button',
      'data-dsh-agent-window-dock': true,
      'aria-label': `${popoverOpen ? 'Close' : 'Open'} Agent windows${projectName === undefined ? '' : ` for ${projectName}`}${activeAgentCount > 0 ? `, ${activeAgentCount} active` : ''}${expandedAgents.length > 0 ? `, ${expandedAgents.length} open as windows` : ''}`,
      'aria-expanded': popoverOpen,
      'aria-controls': 'dsh-agent-window-popover',
      title: `${popoverOpen ? '收起' : '展开'} Agent 列表${projectCwd === undefined ? '' : ` — ${projectCwd}`}`,
      onClick: () => setPopoverOpen((current) => !current),
    },
    React.createElement('span', {
      'data-dsh-agent-window-dock-status': true,
      'data-active': String(activeAgents.length > 0),
      'aria-hidden': true,
    }),
    React.createElement('span', { 'data-dsh-agent-window-dock-label': true }, 'Agent'),
    React.createElement('span', {
      'data-dsh-agent-window-count': true,
      'data-count': String(activeAgentCount),
      'aria-hidden': true,
    }, String(activeAgentCount)),
    React.createElement('span', {
      'data-dsh-agent-window-dock-arrow': true,
      'data-open': String(popoverOpen),
      'aria-hidden': true,
    }),
  )

  const popover = popoverOpen
    ? React.createElement(
        'section',
        {
          id: 'dsh-agent-window-popover',
          'data-dsh-agent-window-popover': true,
          'aria-label': 'Minimized Agent windows',
        },
        React.createElement(
          'header',
          { 'data-dsh-agent-window-header': true },
          React.createElement('div', { 'data-dsh-agent-window-title': true, title: projectCwd ?? dockTitle },
            React.createElement('span', { 'data-dsh-agent-window-title-text': true }, dockTitle)),
          // The list only holds minimized agents; this chip accounts for the
          // rest — the ones already floating as windows on the page.
          expandedAgents.length > 0
            ? chip(`${expandedAgents.length} 个窗口已打开`, {
                'data-dsh-agent-window-popover-meta': true,
                title: `${activeAgentCount} 个 Agent 中有 ${expandedAgents.length} 个已经作为浮动窗口打开`,
              })
            : null,
          React.createElement('span', {
            'data-dsh-agent-window-count': true,
            'data-count': String(activeAgentCount),
            title: `${activeAgentCount} 个运行中的 Agent`,
          }, String(activeAgentCount)),
        ),
        React.createElement(
          'div',
          { 'data-dsh-agent-window-list': true },
          minimizedAgents.length === 0
            ? React.createElement('div', { 'data-dsh-agent-window-empty': true },
                React.createElement('span', { 'data-dsh-agent-window-empty-icon': true }, icon('agents', 18)),
                activeAgents.length === 0
                  ? (projectName === undefined ? '没有运行中的 Agent' : '这个项目还没有运行中的 Agent')
                  : '所有 Agent 都已经打开成窗口')
            : (() => {
                const renderRow = (agent: AgentView): ReactElement => {
                const label = agentLabel(agent, state.roles)
                const labelParts = agentLabelParts(agent, state.roles)
                return React.createElement(
                  'button',
                  {
                    key: agent.agentId,
                    type: 'button',
                    'data-dsh-agent-window-row': true,
                    'aria-label': `Open ${label}`,
                    title: `双击打开 ${label}`,
                    onClick: (event: { detail: number }) => {
                      // Native keyboard activation reports detail=0; a
                      // pointer click remains inert until the required double click.
                      if (event.detail === 0) expand(agent.agentId)
                    },
                    onDoubleClick: () => expand(agent.agentId),
                    onKeyDown: (event: { key: string; preventDefault(): void }) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        expand(agent.agentId)
                      }
                    },
                  },
                  React.createElement('span', {
                    'data-dsh-agent-window-status-dot': true,
                    'data-status': agent.status,
                    'data-evaluation': String(agent.evaluation !== undefined),
                    'aria-hidden': true,
                  }),
                  React.createElement('span', { 'data-dsh-agent-window-row-label': true },
                    React.createElement('span', { 'data-dsh-agent-window-name-role': true }, labelParts.role),
                    chip(labelParts.harness, { 'data-dsh-agent-window-name-harness': true })),
                  agent.evaluation !== undefined
                    ? chip(evaluationLabel(agent) ?? '', {
                        'data-dsh-agent-window-row-evaluation': true,
                        'data-tone': 'info',
                        title: `对比 ${agent.evaluation.comparisonId} 的一臂；只能观察`,
                      })
                    : agent.external
                      ? chip('外部', {
                          'data-dsh-agent-window-row-external': true,
                          'data-tone': 'warn',
                          title: `由另一个进程启动（pid ${agent.ownerPid}）`,
                        })
                      : null,
                  // Every listed agent is live, so "open" carries no information;
                  // only the transient hand-shake phase gets a marker.
                  agent.status === 'opening'
                    ? chip('启动中', {
                        'data-dsh-agent-window-row-status': true,
                        'data-status': agent.status,
                        'data-tone': 'warn',
                        title: '进程正在启动，通道还没准备好',
                      })
                    : null,
                )
                }
                const { agents: ordinary, evaluating } = partitionEvaluationAgents(minimizedAgents)
                return [
                  ...ordinary.map(renderRow),
                  evaluating.length > 0
                    ? React.createElement('div', {
                        key: 'dsh-agent-window-group-evaluating',
                        'data-dsh-agent-window-group': true,
                        title: '正在进行的角色对比（role-eval）：只能观察',
                      }, '评估中', chip(String(evaluating.length)))
                    : null,
                  ...evaluating.map(renderRow),
                ]
              })(),
        ),
        stateError !== null
          ? React.createElement('div', { 'data-dsh-agent-window-popover-hint': true, 'data-error': true, role: 'status', 'aria-live': 'polite' }, stateError)
          : minimizedAgents.length > 0
            ? React.createElement('div', { 'data-dsh-agent-window-popover-hint': true }, '双击打开对话窗口')
            : null,
      )
    : null

  return React.createElement(
    'div',
    { 'data-dsh-agent-window-root': true, 'data-popover-open': popoverOpen },
    React.createElement(
      'div',
      { 'data-dsh-agent-window-stack': true, 'aria-label': 'Open Agent windows' },
      ...expandedAgents.map((agent, index) => {
        const geometry = geometries[agent.agentId]
          ?? defaultWindowGeometry(index, expandedAgents.length, window.innerWidth, window.innerHeight - DOCK_RESERVED_PX)
        return React.createElement(AgentWindow, {
          key: agent.agentId,
          agent,
          label: agentLabel(agent, state.roles),
          labelParts: agentLabelParts(agent, state.roles),
          geometry,
          zIndex: windowZIndices[agent.agentId] ?? 1000 + index,
          initialDraft: drafts[agent.agentId],
          onGeometryChange: updateGeometry,
          onFocus: focusWindow,
          onDraftChange,
          onSendStart,
          onSendSuccess,
          onSendFailure,
          onMinimize: minimize,
          onCloseSuccess: closeSuccess,
          refreshState: refresh,
        })
      }),
    ),
    popover,
    dock,
  )
}

/** The overlay component itself, for component tests; DSH mounts it through {@link apply}. */
export { AgentWindowSurface }

export function apply(ctx: { get(name: string): unknown; effect(callback: () => (() => void) | void, label?: string): unknown }): void {
  const slots = ctx.get('slots') as {
    inject(name: string, callback: () => unknown): () => void
    register(options: { name: string; id: string; order?: number; label?: string }, component: React.ComponentType): unknown
  } | undefined
  if (slots === undefined) return

  ctx.effect(() => {
    const cleanupStyle = stylesInsert(CSS)
    const cleanupSlot = slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'dsh-agent-manager-window', order: 40, label: 'Agent windows' },
      AgentWindowSurface,
    ))
    return () => {
      cleanupStyle()
      cleanupSlot()
    }
  }, 'dsh-agent-manager: Harness Agent windows')
}

function stylesInsert(css: string): () => void {
  const tag = document.createElement('style')
  tag.dataset.dshAgentManager = 'agent-window'
  tag.textContent = css
  document.head.appendChild(tag)
  return () => tag.remove()
}
