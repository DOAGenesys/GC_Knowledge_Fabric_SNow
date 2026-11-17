import type { Metadata } from "next";
import { NewSyncWizard } from "@/components/syncs/new-sync-wizard";

export const metadata: Metadata = { title: "New sync" };

export default function NewSyncPage() {
  return <NewSyncWizard />;
}
