"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createBookingGroup, parsePickKey } from "@/lib/bookings/book";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Taking the booking (SPEC §17).
 *
 * In its own module because the form that calls it is a client component now —
 * the slot picking happens in the browser — and a client component may import a
 * server action but not define one.
 *
 * Nothing here trusts the form. The slug decides the venue, the rates decide
 * the price, and the unique index decides who gets the slot; the browser only
 * says which times it would like. That was true when this was an inline action
 * and it is the reason moving the selection client-side changes nothing about
 * who ends up with the court.
 */
export async function bookSlots(formData: FormData): Promise<void> {
  const slug = String(formData.get("slug") || "");
  const chosenDate = String(formData.get("date") || "");

  // A public endpoint that writes rows: throttled by address, because the cost
  // of abuse is a calendar full of holds nobody intends to pay for.
  const forwarded = (await headers()).get("x-forwarded-for") ?? "unknown";
  const limit = await rateLimit(`book:${forwarded.split(",")[0]!.trim()}`, 10, 900);
  if (!limit.ok) redirect(`/book/${slug}?error=throttled`);

  // Each pick carries its own day, because one booking may span several.
  const picks = formData
    .getAll("pick")
    .map((value) => parsePickKey(String(value)))
    .filter((pick): pick is NonNullable<typeof pick> => pick !== null);

  const result = await createBookingGroup({
    slug,
    picks,
    date: chosenDate,
    customerName: String(formData.get("customerName") || ""),
    customerEmail: String(formData.get("customerEmail") || ""),
    customerPhone: String(formData.get("customerPhone") || ""),
    note: String(formData.get("note") || ""),
  });

  if (!result.ok) {
    redirect(`/book/${slug}?date=${encodeURIComponent(chosenDate)}&error=${result.problem}`);
  }
  redirect(`/book/${slug}/${result.group.reference}`);
}
