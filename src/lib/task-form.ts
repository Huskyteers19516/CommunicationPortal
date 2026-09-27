// Client-safe values shared by the task form and the tasks service.

/** `categoryId` form value meaning "create the category typed into `newCategory`". */
export const NEW_CATEGORY = "__new__";

/** "Who does it?": the leader picks people, or people sign themselves up on the Task dashboard. */
export type AssignMode = "assign" | "signup";
