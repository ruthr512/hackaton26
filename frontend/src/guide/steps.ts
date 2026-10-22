import type { MessageKey } from "@/i18n";
import type { Role } from "@/lib/api";

export interface GuideStep {
  /** The screen the step is about; the tour navigates there. */
  route: string;
  /** CSS selector of the element to highlight; "a || b" tries a first, then b. Without a match (hidden, or still
   * loading) the card is centred. */
  target: string;
  short: MessageKey;
  title: MessageKey;
  body: MessageKey;
  tip?: MessageKey;
}

/** The roles in the order the welcome screen lists them. */
export const GUIDE_ROLES: Role[] = ["intake", "approver", "lab_manager", "admin"];

/** Who may open each screen, as in the router (main.tsx): a tour of another role shows an explanation only. */
const ROUTE_ROLES: Record<string, Role[]> = {
  "/": ["intake", "lab_manager"],
  "/me": ["intake", "approver"],
  "/dashboard": ["lab_manager"],
  "/admin/users": ["admin"],
  "/rules": ["lab_manager", "admin"],
  "/patients": ["intake", "approver", "lab_manager", "admin"],
};

export const canOpen = (route: string, roles: Role[]) => (ROUTE_ROLES[route] ?? []).some((r) => roles.includes(r));

/** The roles that may open a screen, for the "only available to ..." note. */
export const rolesFor = (route: string): Role[] => ROUTE_ROLES[route] ?? [];

export const GUIDE_STEPS: Record<Role, GuideStep[]> = {
  intake: [
    {
      route: "/me",
      target: '[data-guide="queue-table"]',
      short: "guide.intake.1.short",
      title: "guide.intake.1.title",
      body: "guide.intake.1.body",
    },
    {
      route: "/",
      target: "#dropzone",
      short: "guide.intake.2.short",
      title: "guide.intake.2.title",
      body: "guide.intake.2.body",
      tip: "guide.intake.2.tip",
    },
    {
      route: "/",
      target: '[data-guide="step-processing"]',
      short: "guide.intake.3.short",
      title: "guide.intake.3.title",
      body: "guide.intake.3.body",
    },
    {
      route: "/",
      target: '[data-guide="step-review"]',
      short: "guide.intake.4.short",
      title: "guide.intake.4.title",
      body: "guide.intake.4.body",
      tip: "guide.intake.4.tip",
    },
    {
      route: "/me",
      target: '[data-guide="queue-kpis"]',
      short: "guide.intake.5.short",
      title: "guide.intake.5.title",
      body: "guide.intake.5.body",
    },
    {
      route: "/patients",
      target: '[data-guide="patients-search"]',
      short: "guide.intake.6.short",
      title: "guide.intake.6.title",
      body: "guide.intake.6.body",
    },
  ],
  approver: [
    {
      route: "/me",
      target: '[data-guide="approvals-table"]',
      short: "guide.approver.1.short",
      title: "guide.approver.1.title",
      body: "guide.approver.1.body",
    },
    {
      route: "/me",
      target: '[data-guide="approvals-actions"] || [data-guide="approvals-table"]',
      short: "guide.approver.2.short",
      title: "guide.approver.2.title",
      body: "guide.approver.2.body",
      tip: "guide.approver.2.tip",
    },
    {
      route: "/me",
      target: '[data-guide="approvals-bulk"]',
      short: "guide.approver.3.short",
      title: "guide.approver.3.title",
      body: "guide.approver.3.body",
    },
    {
      route: "/me",
      target: '[data-guide="approvals-history"]',
      short: "guide.approver.4.short",
      title: "guide.approver.4.title",
      body: "guide.approver.4.body",
    },
    {
      route: "/patients",
      target: '[data-guide="patients-search"]',
      short: "guide.approver.5.short",
      title: "guide.approver.5.title",
      body: "guide.approver.5.body",
    },
  ],
  lab_manager: [
    {
      route: "/dashboard",
      target: '[data-guide="dash-kpis"]',
      short: "guide.lab_manager.1.short",
      title: "guide.lab_manager.1.title",
      body: "guide.lab_manager.1.body",
    },
    {
      route: "/dashboard",
      target: '[data-guide="dash-reassign"]',
      short: "guide.lab_manager.2.short",
      title: "guide.lab_manager.2.title",
      body: "guide.lab_manager.2.body",
    },
    {
      route: "/",
      target: "#dropzone",
      short: "guide.lab_manager.3.short",
      title: "guide.lab_manager.3.title",
      body: "guide.lab_manager.3.body",
    },
    {
      route: "/rules",
      target: '[data-guide="rules-write"]',
      short: "guide.lab_manager.4.short",
      title: "guide.lab_manager.4.title",
      body: "guide.lab_manager.4.body",
    },
    {
      route: "/",
      target: '[data-guide="step-export"]',
      short: "guide.lab_manager.5.short",
      title: "guide.lab_manager.5.title",
      body: "guide.lab_manager.5.body",
    },
    {
      route: "/patients",
      target: '[data-guide="patients-search"]',
      short: "guide.lab_manager.6.short",
      title: "guide.lab_manager.6.title",
      body: "guide.lab_manager.6.body",
    },
  ],
  admin: [
    {
      route: "/admin/users",
      target: '[data-guide="users-new"]',
      short: "guide.admin.1.short",
      title: "guide.admin.1.title",
      body: "guide.admin.1.body",
    },
    {
      route: "/rules",
      target: '[data-guide="rules-write"]',
      short: "guide.admin.2.short",
      title: "guide.admin.2.title",
      body: "guide.admin.2.body",
    },
    {
      route: "/patients",
      target: '[data-guide="patients-search"]',
      short: "guide.admin.3.short",
      title: "guide.admin.3.title",
      body: "guide.admin.3.body",
    },
  ],
};

/** A rough reading time for the menu: about 20 seconds a step, at least a minute. */
export const minutesFor = (role: Role) => Math.max(1, Math.round((GUIDE_STEPS[role].length * 20) / 60));
