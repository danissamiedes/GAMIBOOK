"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Select } from "@/components/ui";

/**
 * Company switcher in the top bar (SPEC §3). It only writes a cookie; the
 * server re-checks membership on every request and every query still filters
 * by companyId.
 */
export function CompanySwitcher({
  companies,
  activeId,
  action,
}: {
  companies: { id: string; name: string; baseCurrency: string }[];
  activeId: string;
  action: (companyId: string) => Promise<void>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (companies.length <= 1) {
    const only = companies[0];
    return only ? (
      <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
        {only.name} <span className="text-slate-400">({only.baseCurrency})</span>
      </span>
    ) : null;
  }

  return (
    // The width lives on a wrapper, not on the Select. `Select` carries w-full
    // in its own base classes, and two width utilities on one element are
    // settled by stylesheet order rather than by which was written last — so a
    // `w-56` here quietly lost and the switcher stretched the whole header.
    // Sizing the parent and letting w-full fill it cannot be beaten that way.
    <div className="w-full max-w-64 sm:w-64">
      <Select
        aria-label="Active company"
        value={activeId}
        disabled={pending}
        onChange={(event) => {
          const companyId = event.target.value;
          startTransition(async () => {
            await action(companyId);
            router.refresh();
          });
        }}
      >
        {companies.map((company) => (
          <option key={company.id} value={company.id}>
            {company.name} ({company.baseCurrency})
          </option>
        ))}
      </Select>
    </div>
  );
}
