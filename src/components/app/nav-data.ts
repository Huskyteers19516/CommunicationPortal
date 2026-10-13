// Navigation model shared by the server layout (builds it) and client nav (renders it).
export type NavIcon =
  | "today"
  | "myTasks"
  | "dashboard"
  | "parts"
  | "sponsors"
  | "posters"
  | "workshop"
  | "fundraising"
  | "attendance"
  | "calendar"
  | "people"
  | "announcements"
  | "meetings"
  | "discussion"
  | "notebook"
  | "strategy"
  | "orders"
  | "questions"
  | "resources"
  | "overview"
  | "tasks"
  | "review"
  | "progress"
  | "approvals"
  | "users"
  | "emails"
  | "website"
  | "settings";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  count?: number;
  /** Match only the exact path (for section roots like /manage and /admin). */
  exact?: boolean;
  /** Sub-pages, shown under the item (opened in place) while you're anywhere in it. */
  children?: NavChild[];
}

/** A sub-page link. The one whose href is the longest prefix of the current path is active. */
export interface NavChild {
  href: string;
  label: string;
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}

/** A "do something" entry in the command palette: a create page, or a tool, the person is allowed to use. */
export interface NavAction {
  href: string;
  label: string;
  /** Extra words it should match, e.g. "add create". */
  keywords?: string;
  /** "tool" = listed under Tools (e.g. the overdue reminder) instead of Create. */
  kind?: "create" | "tool";
}
