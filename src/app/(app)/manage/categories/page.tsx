import { SquareKanban, Tags } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { CategoryList } from "@/components/categories/category-list";
import { BackLink } from "@/components/tasks/back-link";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { LIMITS } from "@/lib/constants";
import { requireStaffUser } from "@/server/auth/session";
import { hasAllScope } from "@/server/permissions";
import { getManagedCategoryLists } from "@/server/queries/categories";

export const metadata: Metadata = { title: "Task categories" };

export default async function ManageCategoriesPage() {
  const actor = await requireStaffUser();
  const lists = await getManagedCategoryLists(actor);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <BackLink href="/manage/tasks">Tasks</BackLink>
      <PageHeader
        title="Task categories"
        description={
          hasAllScope(actor)
            ? "Group each subteam's tasks on the Task dashboard, e.g. Intake, Drivetrain, or Outreach."
            : "Group your subteam's tasks on the Task dashboard, e.g. Intake, Drivetrain, or CAD."
        }
      />

      {lists.length === 0 ? (
        <Card>
          <EmptyState icon={Tags} title="No categories to manage" description="Subteam leaders manage their own subteam's categories." />
        </Card>
      ) : (
        <div className="space-y-4">
          {lists.map((list) => (
            <Card key={list.key} id={list.key} className="scroll-mt-20">
              <CardHeader
                title={list.label}
                description={`${list.categories.length} of ${LIMITS.categoriesPerSubteamMax} categories · shown in this order on the dashboard`}
                actions={
                  <Link
                    href={`/tasks?subteam=${list.key}`}
                    className="-mr-2 inline-flex h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-brand-700 hover:bg-brand-50 hover:text-brand-800"
                  >
                    <SquareKanban className="size-4" aria-hidden />
                    View on dashboard
                  </Link>
                }
              />
              <CategoryList subteam={list.subteam ?? ""} label={list.label} categories={list.categories} />
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
