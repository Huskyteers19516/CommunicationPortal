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
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}
