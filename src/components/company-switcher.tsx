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
    <Select
      aria-label="Active company"
      className="w-56"
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
  );
}
