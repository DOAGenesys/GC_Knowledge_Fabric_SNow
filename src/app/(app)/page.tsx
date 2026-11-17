import type { Metadata } from "next";
import { Dashboard } from "@/components/dashboard";

export const metadata: Metadata = { title: "Syncs" };

export default function DashboardPage() {
  return <Dashboard />;
}
