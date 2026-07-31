import type { SupervisorEventType } from "../events.js";

/** How much this instance says about itself, and where it says it. */
export interface NotificationSettings {
  /** The one switch that silences the lot of them. */
  enabled: boolean;
  /** Where a notification is posted. Nowhere is a Supervisor that says nothing. */
  webhook?: string;
  /**
   * Which kinds of Event are worth a notification. An Event nobody has said
   * anything about is worth one: pointing an instance at a webhook is asking to
   * be told, so silence is the thing that has to be asked for by name.
   */
  on: Partial<Record<SupervisorEventType, boolean>>;
}
