import type { Widget } from "@coldstart/shared";

/** Narrows the shared discriminated-union `Widget` to one registry entry's
 * `type` literal, so each widget component gets its own typed `props`
 * without redefining the shape apps/platform/packages/shared already owns. */
export type WidgetOfType<T extends Widget["type"]> = Extract<Widget, { type: T }>;
