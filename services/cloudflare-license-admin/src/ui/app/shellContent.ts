import type { AdminTab } from "./types";

export const tabs: ReadonlyArray<{ id: AdminTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "entitlements", label: "Entitlements" },
  { id: "policies", label: "Policies" },
  { id: "plans", label: "Plans" },
  { id: "webhooks", label: "Webhooks" },
  { id: "events", label: "Events" },
  { id: "customers", label: "Customers" },
  { id: "licenses", label: "Licenses" },
  { id: "fulfillment", label: "Fulfillment" },
  { id: "reports", label: "Reports" },
];

export const descriptions: Record<AdminTab, string> = {
  overview: "Your licensing workspace at a glance.",
  entitlements: "Create access, extend validity, and manage devices.",
  customers: "View customer accounts and their access.",
  licenses: "Find issued licenses and linked entitlements.",
  policies: "Define reusable rules for devices, seats, and trials.",
  plans: "Organize features and policies into plans.",
  webhooks: "Manage event destinations and delivery status.",
  events: "Review changes and their audit history.",
  fulfillment: "Track orders and subscription updates.",
  reports: "Review usage, capacity, and upcoming expirations.",
};
